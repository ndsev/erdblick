import {getState, signalStoreFeature, type, withComputed, withMethods, withProps} from "@ngrx/signals";
import {z} from "zod";
import {computed} from "@angular/core";
import type {Params} from "@angular/router";
import {NamedEntityState, setAllEntities} from "@ngrx/signals/entities";
import {control} from "../actions/control";
import {rejectAction} from "../actions/action-utils";
import {Cartographic, GeoMath} from "../integrations/geo";
import type {ConnectionValues} from "../mapdata/map-tile-stream.store-feature";
import {synchronizeLayerViews} from "../mapdata/map-layer.store-feature";
import type {MapLayerValues} from "../mapdata/map-layer.store-feature";
import type {FeatureSearchValues} from "../search/feature-search.store-feature";
import {
    patchAppState,
    perView,
    persistenceDescriptors,
    PersistenceDescriptor,
    transient,
    withPersistedState,
} from "../shared/persisted-state";
import {StateCodec} from "../shared/state-codec";
import {firstParamValue} from "../shared/url-state-codec";
import {pointCloudPolicySchema, PointCloudPolicy} from "../shared/point-cloud-policy";
import {viewIdSchema, ViewIdentity} from "./view-id";
import {roundCoordinateStateValue} from "../coords/coordinate-state";
import {Boolish} from "../shared/state-value";
import {clampLod3TileThreshold, DEFAULT_LOD3_TILE_THRESHOLD} from "../shared/lod-policy";
import {
    DEFAULT_POINT_CLOUD_POLICY,
    pointCloudDetailSchema,
    pointCloudGpuMemorySchema,
    pointCloudWorkingMemorySchema
} from "../shared/point-cloud-policy";
import {AppStateOptions, deepCopy} from "../shared/state-value";
import {clampTileSubsetRenderWorkerCount} from "../shared/tile-render-policy";
import {
    CameraViewState,
    clampFeatureZoomClearanceMeters,
    clampMapZoomStep,
    DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS,
    DEFAULT_MAP_ZOOM_STEP,
    MAX_NUM_TILES_TO_LOAD,
    VIEW_SYNC_LAYERS,
    VIEW_SYNC_MOVEMENT,
    VIEW_SYNC_POSITION,
    VIEW_SYNC_PROJECTION
} from "./map-view-state.model";
import type {ViewId} from "./view-id";

const tabSelectorSchema = z.strictObject({});
const syncSchema = z.array(z.enum(["pos", "mov", "proj", "lay"])).max(4);
const markerSchema = z.strictObject({
    enabled: z.boolean(),
    position: z
        .strictObject({
            lon: z.number().min(-180).max(180),
            lat: z.number().min(-90).max(90),
            alt: z.number()
        })
        .nullable()
});
const navigationPreferencesSchema = z.strictObject({
    zoomStep: z.number().min(0.001).max(1),
    featureZoomClearance: z.number().min(0).max(100)
});

export const viewStateControls = {
    focusedView: {
        name: "app.focusedView",
        description: "Focused source view; identified by its stable view ID.",
        selectorSchema: tabSelectorSchema,
        valueSchema: viewIdSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "none"
    },
    viewSync: {
        name: "app.viewSync",
        description:
            "Cross-view synchronization: pos keeps camera positions equal; mov synchronizes relative camera movement; choose at most one of pos and mov. proj synchronizes projection; lay synchronizes layers. Omit lay to keep different map layers in each view.",
        selectorSchema: tabSelectorSchema,
        valueSchema: syncSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "none"
    },
    marker: {
        name: "app.marker",
        description: "Coordinate marker visibility and WGS84 position.",
        selectorSchema: tabSelectorSchema,
        valueSchema: markerSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "none"
    },
    navigation: {
        name: "app.preferences.navigation",
        description: "Zoom step and feature-fit clearance in metres.",
        selectorSchema: tabSelectorSchema,
        valueSchema: navigationPreferencesSchema,
        readable: true,
        writable: true,
        persistence: "local-storage",
        synchronization: "none"
    }
} as const;

/**
 * Camera and projection values are keyed by logical view ID. Moving a pane to a
 * different position in the layout therefore keeps its own camera and settings.
 * The ordered `viewIds` entity list supplies positions only when the UI or a
 * released persistence format needs them.
 */
export interface MapViewValues {
    /** Advances only when a new logical view lifetime is created. */
    nextGeneration: number;
    /** Requests a new browser-history entry for explicit marker navigation. */
    pushUrlRevision: number;
    marker: boolean;
    markedPosition: number[];
    focusedViewId: ViewId;
    viewSync: string[];
    cameraViewData: Record<string, CameraViewState>;
    mode2d: Record<string, boolean>;
    deckAntialiasingEnabled: boolean;
    semanticCompositingEnabled: boolean;
    contactShadingEnabled: boolean;
    lod3TileThreshold: number;
    tileSubsetRenderWorkerCount: number;
    pointCloudDownsamplingEnabled: boolean;
    pointCloudDetailPixels: number;
    pointCloudWorkingMemoryMiB: number;
    pointCloudGpuMemoryMiB: number;
    mapZoomStep: number;
    featureZoomClearanceMeters: number;
    tilesLoadLimit: number;
}

/**
 * These declarations retain the deployed storage keys, URL parameters and defaults.
 * `withPersistedState` turns them into native signals such as `store.views.marker()`;
 * camera and projection declarations are wrapped with `perView` below because their
 * saved arrays must be projected onto logical view IDs in the running application.
 */
export const ownerState = {
    marker: {
        name: "marker",
        defaultValue: false,
        schema: Boolish,
        urlParamName: "m",
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<MapViewValues["marker"]>,

    markedPosition: {
        name: "markedPosition",
        defaultValue: [],
        schema: z.array(z.coerce.number()).max(3),
        toStorage: (value: number[]) => value.map((v) => roundCoordinateStateValue(v)),
        fromStorage: (payload: any): number[] => (payload as number[]).map((v) => roundCoordinateStateValue(v)),
        urlParamName: "mp",
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<MapViewValues["markedPosition"]>,

    viewSync: {
        name: "viewSync",
        defaultValue: [],
        schema: z.array(
            z.union([
                z.literal(VIEW_SYNC_PROJECTION),
                z.literal(VIEW_SYNC_POSITION),
                z.literal(VIEW_SYNC_MOVEMENT),
                z.literal(VIEW_SYNC_LAYERS)
            ])
        ),
        urlParamName: "sync",
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<MapViewValues["viewSync"]>,

    cameraViewData: {
        name: "cameraView",
        defaultValue: {
            destination: {lon: 22.837473, lat: 38.490817, alt: 16000000},
            orientation: {heading: 0, pitch: -Math.PI / 2, roll: 0},
            position: [0, 0, 0]
        },
        schema: z.object({
            lon: z.coerce.number().optional(),
            lat: z.coerce.number().optional(),
            alt: z.coerce.number().optional(),
            h: z.coerce.number().optional(),
            p: z.coerce.number().optional(),
            r: z.coerce.number().optional(),
            px: z.coerce.number().optional(),
            py: z.coerce.number().optional(),
            pz: z.coerce.number().optional()
        }),
        toStorage: (value: any) => ({
            lon: roundCoordinateStateValue(value.destination.lon),
            lat: roundCoordinateStateValue(value.destination.lat),
            alt: roundCoordinateStateValue(value.destination.alt),
            h: roundCoordinateStateValue(value.orientation.heading),
            p: roundCoordinateStateValue(value.orientation.pitch),
            r: roundCoordinateStateValue(value.orientation.roll),
            px: roundCoordinateStateValue(value.position?.[0] ?? 0),
            py: roundCoordinateStateValue(value.position?.[1] ?? 0),
            pz: roundCoordinateStateValue(value.position?.[2] ?? 0)
        }),
        fromStorage: (payload: any, currentValue: CameraViewState): CameraViewState => ({
            destination: {
                lon: roundCoordinateStateValue(payload.lon ?? currentValue.destination.lon),
                lat: roundCoordinateStateValue(payload.lat ?? currentValue.destination.lat),
                alt: roundCoordinateStateValue(payload.alt ?? currentValue.destination.alt)
            },
            orientation: {
                heading: roundCoordinateStateValue(payload.h ?? currentValue.orientation.heading),
                pitch: roundCoordinateStateValue(payload.p ?? currentValue.orientation.pitch),
                roll: roundCoordinateStateValue(payload.r ?? currentValue.orientation.roll)
            },
            // Older URLs, local-storage entries, and snapshots have no map-centre offset.
            position: [
                roundCoordinateStateValue(payload.px ?? 0),
                roundCoordinateStateValue(payload.py ?? 0),
                roundCoordinateStateValue(payload.pz ?? 0)
            ]
        }),
        urlFormEncode: true
    } satisfies AppStateOptions<MapViewValues["cameraViewData"][string]>,

    mode2d: {
        name: "mode2d",
        defaultValue: false,
        schema: Boolish,
        urlParamName: "m2d",
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<MapViewValues["mode2d"][string]>,

    deckAntialiasingEnabled: {
        name: "deckAntialiasingEnabled",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<MapViewValues["deckAntialiasingEnabled"]>,

    semanticCompositingEnabled: {
        name: "semanticCompositingEnabled",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<MapViewValues["semanticCompositingEnabled"]>,

    contactShadingEnabled: {
        name: "contactShadingEnabled",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<MapViewValues["contactShadingEnabled"]>,

    lod3TileThreshold: {
        name: "lod3TileThreshold",
        defaultValue: DEFAULT_LOD3_TILE_THRESHOLD,
        schema: z.coerce.number().int(),
        toStorage: (value) => clampLod3TileThreshold(value, DEFAULT_LOD3_TILE_THRESHOLD),
        fromStorage: (value) => clampLod3TileThreshold(value, DEFAULT_LOD3_TILE_THRESHOLD)
    } satisfies AppStateOptions<MapViewValues["lod3TileThreshold"]>,

    tileSubsetRenderWorkerCount: {
        name: "tileSubsetRenderWorkerCount",
        defaultValue: 0,
        schema: z.coerce.number().int(),
        toStorage: (value) => clampTileSubsetRenderWorkerCount(value),
        fromStorage: (value) => clampTileSubsetRenderWorkerCount(value)
    } satisfies AppStateOptions<MapViewValues["tileSubsetRenderWorkerCount"]>,

    pointCloudDownsamplingEnabled: {
        name: "pointCloudDownsamplingEnabled",
        defaultValue: DEFAULT_POINT_CLOUD_POLICY.enabled,
        schema: Boolish
    } satisfies AppStateOptions<MapViewValues["pointCloudDownsamplingEnabled"]>,

    pointCloudDetailPixels: {
        name: "pointCloudDetailPixels",
        defaultValue: DEFAULT_POINT_CLOUD_POLICY.detailPixels,
        schema: pointCloudDetailSchema
    } satisfies AppStateOptions<MapViewValues["pointCloudDetailPixels"]>,

    pointCloudWorkingMemoryMiB: {
        name: "pointCloudWorkingMemoryMiB",
        defaultValue: DEFAULT_POINT_CLOUD_POLICY.workingMemoryMiB,
        schema: pointCloudWorkingMemorySchema
    } satisfies AppStateOptions<MapViewValues["pointCloudWorkingMemoryMiB"]>,

    pointCloudGpuMemoryMiB: {
        name: "pointCloudGpuMemoryMiB",
        defaultValue: DEFAULT_POINT_CLOUD_POLICY.gpuMemoryMiB,
        schema: pointCloudGpuMemorySchema
    } satisfies AppStateOptions<MapViewValues["pointCloudGpuMemoryMiB"]>,

    mapZoomStep: {
        name: "mapZoomStep",
        defaultValue: DEFAULT_MAP_ZOOM_STEP,
        schema: z.coerce.number(),
        fromStorage: (value) => clampMapZoomStep(Number(value))
    } satisfies AppStateOptions<MapViewValues["mapZoomStep"]>,

    featureZoomClearanceMeters: {
        name: "featureZoomClearanceMeters",
        defaultValue: DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS,
        schema: z.coerce.number(),
        fromStorage: (value) => clampFeatureZoomClearanceMeters(Number(value))
    } satisfies AppStateOptions<MapViewValues["featureZoomClearanceMeters"]>,

    tilesLoadLimit: {
        name: "tilesLoadLimit",
        defaultValue: MAX_NUM_TILES_TO_LOAD,
        schema: z.coerce.number().nonnegative(),
        urlParamName: "tll"
    } satisfies AppStateOptions<MapViewValues["tilesLoadLimit"]>
};

export const viewIdsSchema = z.array(viewIdSchema)
    .min(1)
    .max(32)
    .refine(ids => new Set(ids).size === ids.length, "View IDs must be unique");
type ViewRoot = NamedEntityState<ViewIdentity, "view"> & {
    views: MapViewValues;
    layers: MapLayerValues;
    searches: FeatureSearchValues;
};

/**
 * Existing links and local storage contain a view count. The store derives that
 * count from its ordered IDs; importing it prepares IDs for the later membership
 * calculation instead of maintaining a second count value.
 */
class ViewCountPersistence extends PersistenceDescriptor<number> {
    constructor() {
        super("", "viewIds", new StateCodec({
            name: "numberOfViews",
            defaultValue: 1,
            schema: z.coerce.number().int().min(1).max(32),
            urlParamName: "n",
        }));
    }

    override read(state: object): number {
        return (state as ViewRoot).viewIds.length;
    }

    override replace<S extends object>(state: S, count: number): S {
        const root = state as unknown as ViewRoot;
        const ids = root.viewIds.slice(0, count);
        while (ids.length < count) {
            ids.push(`view-${crypto.randomUUID()}`);
        }
        return {...state, viewIds: ids};
    }
}

/** The released focus value is a pane position; native focus follows its stable ID. */
class FocusPersistence extends PersistenceDescriptor<number> {
    constructor() {
        super("views", "focusedViewId", new StateCodec({
            name: "focus",
            defaultValue: 0,
            schema: z.coerce.number().int().nonnegative(),
            urlParamName: "f",
            urlIncludeInVisualizationOnly: false,
        }));
    }

    override read(state: object): number {
        const root = state as ViewRoot;
        return Math.max(0, root.viewIds.indexOf(root.views.focusedViewId));
    }
    override replace<S extends object>(state: S, index: number): S {
        const root = state as unknown as ViewRoot;
        return {
            ...state,
            views: {
                ...root.views,
                focusedViewId: String(root.viewIds[index] ?? root.viewIds[0]),
            },
        };
    }
}

/**
 * Logical membership is one domain operation. Before NgRx publishes it we prepare
 * every keyed camera/layer/style/search value and all entity lifetimes. A closed
 * pane therefore cannot briefly remain selected by a search or inherit another
 * pane's camera because its numerical position changed.
 *
 * An existing ID retains its generation through a reorder. An ID introduced after
 * removal receives a new generation, so an asynchronous result captured for the old
 * pane cannot be applied to the new lifetime, even if its ID is reused by an import.
 */
export function prepareViewMembership<State extends ViewRoot>(
    state: State,
    ids: string[],
    fields: readonly PersistenceDescriptor[],
    copySourceId?: string,
    positionalFallback = false,
    previousIds: readonly (string | number)[] = state.viewIds,
): State {
    viewIdsSchema.parse(ids);
    let nextGeneration = state.views.nextGeneration;
    const identities = ids.map(id => state.viewEntityMap[id] ?? {id, generation: ++nextGeneration});
    let next: State = {
        ...state,
        ...setAllEntities(identities, {collection: "view"})(state),
        views: {
            ...state.views,
            nextGeneration,
            focusedViewId: ids.includes(state.views.focusedViewId) ? state.views.focusedViewId : ids[0],
        },
    };

    // New panes copy an explicitly selected source, the imported positional value,
    // or the previous last pane. Existing IDs always keep their own keyed values.
    const sourceFor = (id: string, index: number) =>
        copySourceId ??
        (positionalFallback ? previousIds[index] : undefined) ??
        previousIds.at(-1);
    for (const field of fields) {
        if (!field.perViewDefault) {
            continue;
        }
        const root = next as unknown as Record<string, Record<string, unknown>>;
        const records = root[field.slice][field.key] as Record<string, unknown>;
        const values = Object.fromEntries(ids.map((id, index) => [
            id,
            records[id] ?? deepCopy(records[String(sourceFor(id, index))] ?? field.perViewDefault!.value),
        ]));
        next = {
            ...next,
            [field.slice]: {...root[field.slice], [field.key]: values},
        };
    }

    // Style options have their own compact codec, so they need the same membership
    // projection explicitly rather than through the ordinary per-view descriptors.
    const options = new Map([...next.layers.options].map(([key, records]) => [
        key,
        Object.fromEntries(ids.map((id, index) => [
            id,
            records[id] ?? records[String(sourceFor(id, index))] ?? false,
        ])),
    ]));
    const featureSearch = next.searches.featureSearch.map(entry => {
        const selected = new Set(entry.selectedViewIds.filter(id => ids.includes(id)));
        if (copySourceId && entry.selectedViewIds.includes(copySourceId)) {
            ids.filter(id => !state.viewIds.includes(id)).forEach(id => selected.add(id));
        }
        return {...entry, selectedViewIds: ids.filter(id => selected.has(id))};
    });
    return {
        ...next,
        layers: {...next.layers, options},
        searches: {...next.searches, featureSearch},
    };
}

/**
 * Resolves legacy counts and explicit IDs before camera or layer arrays are decoded.
 * Partial imports preserve the current membership when neither field is supplied;
 * complete replacement supplies the default membership when those fields are absent.
 */
export function normalizeViewSnapshot(
    snapshot: Record<string, unknown>,
    currentIds: readonly (string | number)[],
    replaceMissing: boolean,
): Record<string, unknown> {
    const hasIds = Object.prototype.hasOwnProperty.call(snapshot, "viewIds");
    const hasCount = Object.prototype.hasOwnProperty.call(snapshot, "numberOfViews");
    if (!hasIds && !hasCount && !replaceMissing) {
        return snapshot;
    }
    const ids = hasIds ? viewIdsSchema.parse(snapshot["viewIds"]) : undefined;
    const count = hasCount
        ? z.coerce.number().int().min(1).max(32).parse(snapshot["numberOfViews"])
        : ids?.length ?? (replaceMissing ? 1 : currentIds.length);
    if (ids && ids.length !== count) {
        throw new Error("The view-ID count must match numberOfViews");
    }
    const resolved = ids ?? (replaceMissing ? [] : currentIds.slice(0, count).map(String));
    while (resolved.length < count) {
        resolved.push(`view-${crypto.randomUUID()}`);
    }
    return {...snapshot, viewIds: resolved, numberOfViews: count};
}

/** Applies the same membership rules to the `vid` and legacy `n` URL parameters. */
export function normalizeViewUrl(
    params: Params,
    currentIds: readonly (string | number)[],
    replaceMissing: boolean,
): Params {
    const rawIds = params["vid"];
    if (Array.isArray(rawIds)) {
        throw new Error("vid must occur once as an ordered CSV array");
    }
    const snapshot = normalizeViewSnapshot({
        ...(rawIds !== undefined ? {viewIds: String(rawIds).split(",")} : {}),
        ...(params["n"] !== undefined ? {numberOfViews: firstParamValue(params, "n")} : {}),
    }, currentIds, replaceMissing);
    const ids = snapshot["viewIds"] as string[] | undefined;
    return ids ? {...params, vid: ids.join(","), n: String(ids.length)} : params;
}

/** Converts a renderer's geographic pose into the rounded values saved by the store. */
function cameraPose(
    current: CameraViewState,
    destination: Cartographic,
    orientation = current.orientation,
    position: readonly [number, number, number] = [0, 0, 0],
): CameraViewState {
    return {
        destination: {
            lon: roundCoordinateStateValue(GeoMath.toDegrees(destination.longitude)),
            lat: roundCoordinateStateValue(GeoMath.toDegrees(destination.latitude)),
            alt: roundCoordinateStateValue(destination.height),
        },
        orientation: {
            heading: roundCoordinateStateValue(orientation.heading),
            pitch: roundCoordinateStateValue(orientation.pitch),
            roll: roundCoordinateStateValue(orientation.roll),
        },
        position: position.map(roundCoordinateStateValue) as [number, number, number],
    };
}

/**
 * Enabling synchronization copies the focused pane's selected presentation settings.
 * Position synchronization starts all cameras at that pose; movement synchronization
 * keeps their existing relative positions and is applied later by `setView`.
 */
function synchronizeViews<State extends ViewRoot>(state: State): State {
    const source = state.views.focusedViewId;
    const sync = state.views.viewSync;
    return {
        ...state,
        views: {
            ...state.views,
            cameraViewData: sync.includes(VIEW_SYNC_POSITION)
                ? Object.fromEntries(state.viewIds.map(id => [id, deepCopy(state.views.cameraViewData[source])]))
                : state.views.cameraViewData,
            mode2d: sync.includes(VIEW_SYNC_PROJECTION)
                ? Object.fromEntries(state.viewIds.map(id => [id, state.views.mode2d[source]]))
                : state.views.mode2d,
        },
        layers: {
            ...(sync.includes(VIEW_SYNC_LAYERS)
                ? synchronizeLayerViews(state.layers, state.viewIds, source)
                : state.layers),
            layerSyncOptions: Object.fromEntries(state.viewIds.map(id => [id, sync.includes(VIEW_SYNC_LAYERS)])),
        },
    };
}

/**
 * Owns view values, persistence declarations and operations that keep panes consistent.
 * A signal such as `store.views.cameraViewData()` reads the current native record.
 * Methods prepare ordinary objects and publish once; renderer services react to that
 * publication and remain responsible for the actual camera and rendering resources.
 */
export function withMapViewState() {
    return signalStoreFeature(
        {
            state: type<NamedEntityState<ViewIdentity, "view"> & {
                layers: MapLayerValues;
                searches: FeatureSearchValues;
                connection: ConnectionValues;
            }>(),
        },
        withPersistedState<"views", MapViewValues>("views", {
            ...ownerState,
            cameraViewData: perView<MapViewValues["cameraViewData"][string]>(ownerState.cameraViewData),
            mode2d: perView<MapViewValues["mode2d"][string]>(ownerState.mode2d),
            focusedViewId: transient(""),
            nextGeneration: transient(0),
            pushUrlRevision: transient(0),
        }),
        withProps(() => ({
            viewIdsPersistence: new PersistenceDescriptor("", "viewIds", new StateCodec<string[]>({
                name: "viewIds",
                defaultValue: [],
                schema: viewIdsSchema,
                urlParamName: "vid",
            })),
            viewCountPersistence: new ViewCountPersistence(),
            focusPersistence: new FocusPersistence(),
            syncOptions: [
                {
                    name: "Position",
                    code: VIEW_SYNC_POSITION,
                    icon: "location_on",
                    tooltip: "Sync camera position/orientation across views",
                },
                {
                    name: "Movement",
                    code: VIEW_SYNC_MOVEMENT,
                    icon: "drag_pan",
                    tooltip: "Sync camera movement delta across views",
                },
                {
                    name: "Projection",
                    code: VIEW_SYNC_PROJECTION,
                    icon: "3d_rotation",
                    tooltip: "Sync projection mode across views",
                },
                {
                    name: "Layers",
                    code: VIEW_SYNC_LAYERS,
                    icon: "layers",
                    tooltip: "Sync layer activation/style/background settings across views",
                },
            ],
        })),
        withComputed(store => ({
            numViews: computed(() => store.viewIds().length),
            focusedView: computed(() => Math.max(0, store.viewIds().indexOf(store.views.focusedViewId()))),
            focusedViewId: computed(() => store.views.focusedViewId()),
            pointCloudPolicy: computed<PointCloudPolicy>(() => ({
                enabled: store.views.pointCloudDownsamplingEnabled(),
                detailPixels: store.views.pointCloudDetailPixels(),
                workingMemoryMiB: store.views.pointCloudWorkingMemoryMiB(),
                gpuMemoryMiB: store.views.pointCloudGpuMemoryMiB(),
            })),
        })),
        withMethods(store => {
            function idAt(index: number): string | undefined {
                return store.viewIds()[index]?.toString();
            }

            function requireView(id: string): ViewIdentity {
                const target = store.viewEntityMap()[id];
                if (!target) {
                    rejectAction("The requested view is unavailable", "not_available", "view_unavailable");
                }
                return target;
            }

            function setViewValue<Key extends keyof MapViewValues>(key: Key, value: MapViewValues[Key]) {
                let normalized: MapViewValues[Key] = value;
                if (key === "lod3TileThreshold") {
                    normalized = clampLod3TileThreshold(Number(value), DEFAULT_LOD3_TILE_THRESHOLD) as MapViewValues[Key];
                }
                if (key === "tileSubsetRenderWorkerCount") {
                    normalized = clampTileSubsetRenderWorkerCount(Number(value)) as MapViewValues[Key];
                }
                if (key === "mapZoomStep") {
                    normalized = clampMapZoomStep(Number(value)) as MapViewValues[Key];
                }
                if (key === "featureZoomClearanceMeters") {
                    normalized = clampFeatureZoomClearanceMeters(Number(value)) as MapViewValues[Key];
                }
                patchAppState(store, {views: {...store.views(), [key]: normalized}});
            }

            function setMembership(ids: string[], source?: string) {
                patchAppState(store, prepareViewMembership(getState(store), ids, persistenceDescriptors(store), source));
            }

            function setFocusedView(index: number) {
                const id = idAt(index);
                if (!id) {
                    throw new Error(`View index ${index} is unavailable`);
                }
                setViewValue("focusedViewId", id);
            }

            /** Validate the policy and copy its affected values before publishing it. */
            function setSynchronization(value: string[]) {
                if (value.includes(VIEW_SYNC_POSITION) && value.includes(VIEW_SYNC_MOVEMENT)) {
                    rejectAction("Position and movement sync are mutually exclusive", "invalid_arguments");
                }
                const viewSync = ownerState.viewSync.schema.parse(value);
                patchAppState(store, synchronizeViews({
                    ...getState(store),
                    views: {...store.views(), viewSync},
                }));
            }

            function markerControl() {
                const position = store.views.markedPosition();
                return {
                    enabled: store.views.marker(),
                    position: position.length >= 2
                        ? {lon: position[0], lat: position[1], alt: position[2] ?? 0}
                        : null,
                };
            }

            function setMarkerControl(value: z.infer<typeof viewStateControls.marker.valueSchema>) {
                patchAppState(store, {
                    views: {
                        ...store.views(),
                        marker: value.enabled,
                        markedPosition: value.enabled && value.position
                            ? [value.position.lon, value.position.lat, value.position.alt].map(roundCoordinateStateValue)
                            : [],
                        pushUrlRevision: store.views.pushUrlRevision() + 1,
                    },
                });
            }

            function setNavigationPreferences(value: z.infer<typeof viewStateControls.navigation.valueSchema>) {
                patchAppState(store, {
                    views: {
                        ...store.views(),
                        mapZoomStep: clampMapZoomStep(value.zoomStep),
                        featureZoomClearanceMeters: clampFeatureZoomClearanceMeters(value.featureZoomClearance),
                    },
                });
            }

            return {
                idAt,
                requireView,
                setFocusedView,
                setSynchronization,
                markerControl,
                setMarkerControl,
                setNavigationPreferences,

                initializeViews() {
                    if (!store.viewIds().length) {
                        setMembership([`view-${crypto.randomUUID()}`]);
                    }
                },

                indexOf(id: string) {
                    return store.viewIds().indexOf(id);
                },

                /** Capture identity before asynchronous work so completion can reject a retired pane. */
                captureView(index: number): ViewIdentity | undefined {
                    const id = idAt(index);
                    return id ? store.viewEntityMap()[id] : undefined;
                },

                isCurrent(target: ViewIdentity) {
                    return store.viewEntityMap()[target.id]?.generation === target.generation;
                },

                requireCurrentView(target: ViewIdentity) {
                    if (store.viewEntityMap()[target.id]?.generation !== target.generation) {
                        rejectAction("The target view was removed", "cancelled");
                    }
                    return store.viewIds().indexOf(target.id);
                },

                /** Copy a chosen pane into a new lifetime with its settings and selected searches. */
                createView(sourceId: string) {
                    requireView(sourceId);
                    if (store.viewIds().length >= 32) {
                        rejectAction("The layout already has 32 views", "invalid_arguments");
                    }
                    const id = `view-${crypto.randomUUID()}`;
                    const state = {
                        ...getState(store),
                        views: {...store.views(), focusedViewId: sourceId},
                    };
                    patchAppState(store, prepareViewMembership(
                        state,
                        [...store.viewIds().map(String), id],
                        persistenceDescriptors(store),
                        sourceId,
                    ));
                    return id;
                },

                setNumViews(count: number) {
                    z.number().int().min(1).max(32).parse(count);
                    const ids = store.viewIds().slice(0, count).map(String);
                    while (ids.length < count) {
                        ids.push(`view-${crypto.randomUUID()}`);
                    }
                    setMembership(ids, store.viewIds().at(-1)?.toString());
                },

                /** Reordering changes the ordered ID list while each pane keeps its keyed values. */
                reorderViews(ids: string[]) {
                    if (ids.length !== store.viewIds().length || ids.some(id => !store.viewIds().includes(id))) {
                        throw new Error("A reorder must contain every current view exactly once");
                    }
                    setMembership(ids);
                },

                /** Save renderer camera snapshots and remove the other panes in the same publication. */
                retainViews(indices: readonly number[], cameras: ReadonlyMap<number, CameraViewState>) {
                    const ids = indices.map(index => idAt(index));
                    if (ids.some(id => !id)) {
                        throw new Error("Cannot retain an unavailable view");
                    }
                    const cameraViewData = {...store.views.cameraViewData()};
                    for (const [index, camera] of cameras) {
                        if (indices.includes(index)) {
                            cameraViewData[idAt(index)!] = camera;
                        }
                    }
                    const state = {
                        ...getState(store),
                        views: {...store.views(), cameraViewData},
                    };
                    patchAppState(store, prepareViewMembership(state, ids as string[], persistenceDescriptors(store)));
                },
                setDeckAntialiasingEnabled(value: MapViewValues["deckAntialiasingEnabled"]): void {
                    setViewValue("deckAntialiasingEnabled", value);
                },

                setSemanticCompositingEnabled(value: MapViewValues["semanticCompositingEnabled"]): void {
                    setViewValue("semanticCompositingEnabled", value);
                },

                setContactShadingEnabled(value: MapViewValues["contactShadingEnabled"]): void {
                    setViewValue("contactShadingEnabled", value);
                },

                setLod3TileThreshold(value: MapViewValues["lod3TileThreshold"]): void {
                    setViewValue("lod3TileThreshold", value);
                },

                setTileSubsetRenderWorkerCount(value: MapViewValues["tileSubsetRenderWorkerCount"]): void {
                    setViewValue("tileSubsetRenderWorkerCount", value);
                },

                setPointCloudDownsamplingEnabled(value: MapViewValues["pointCloudDownsamplingEnabled"]): void {
                    setViewValue("pointCloudDownsamplingEnabled", value);
                },

                setPointCloudDetailPixels(value: MapViewValues["pointCloudDetailPixels"]): void {
                    setViewValue("pointCloudDetailPixels", value);
                },

                setPointCloudWorkingMemoryMiB(value: MapViewValues["pointCloudWorkingMemoryMiB"]): void {
                    setViewValue("pointCloudWorkingMemoryMiB", value);
                },

                setPointCloudGpuMemoryMiB(value: MapViewValues["pointCloudGpuMemoryMiB"]): void {
                    setViewValue("pointCloudGpuMemoryMiB", value);
                },

                setMapZoomStep(value: MapViewValues["mapZoomStep"]): void {
                    setViewValue("mapZoomStep", value);
                },

                setFeatureZoomClearanceMeters(value: MapViewValues["featureZoomClearanceMeters"]): void {
                    setViewValue("featureZoomClearanceMeters", value);
                },

                setTilesLoadLimit(value: MapViewValues["tilesLoadLimit"]): void {
                    setViewValue("tilesLoadLimit", value);
                },

                /** Apply the rendering dialog's view and transport preferences together. */
                setRenderingPreferences(value: {
                    antialiasing: boolean;
                    semanticCompositing: boolean;
                    contactShading: boolean;
                    tilePullCompression: boolean;
                    tileLimit: number;
                    renderWorkers: number;
                }): void {
                    const tilesLoadLimit = ownerState.tilesLoadLimit.schema.parse(value.tileLimit);
                    patchAppState(store, {
                        views: {
                            ...store.views(),
                            deckAntialiasingEnabled: value.antialiasing,
                            semanticCompositingEnabled: value.semanticCompositing,
                            contactShadingEnabled: value.contactShading,
                            tilesLoadLimit,
                            tileSubsetRenderWorkerCount: clampTileSubsetRenderWorkerCount(value.renderWorkers),
                        },
                        connection: {
                            ...store.connection(),
                            tilePullCompressionEnabled: value.tilePullCompression,
                        },
                    });
                },

                /** Validate all point-cloud limits before the renderer observes the new policy. */
                setPointCloudPolicy(value: PointCloudPolicy) {
                    const parsed = pointCloudPolicySchema.parse(value);
                    patchAppState(store, {
                        views: {
                            ...store.views(),
                            pointCloudDownsamplingEnabled: parsed.enabled,
                            pointCloudDetailPixels: parsed.detailPixels,
                            pointCloudWorkingMemoryMiB: parsed.workingMemoryMiB,
                            pointCloudGpuMemoryMiB: parsed.gpuMemoryMiB,
                        },
                    });
                },

                setCameraViewData(index: number, value: CameraViewState) {
                    const id = idAt(index);
                    if (!id) {
                        throw new Error(`View index ${index} is unavailable`);
                    }
                    setViewValue("cameraViewData", {...store.views.cameraViewData(), [id]: value});
                },

                getCameraOrientation(index: number) {
                    return store.views.cameraViewData()[idAt(index)!].orientation;
                },

                getCameraPosition(index: number) {
                    const destination = store.views.cameraViewData()[idAt(index)!].destination;
                    return Cartographic.fromDegrees(destination.lon, destination.lat, destination.alt);
                },

                /**
                 * Records one camera movement and any synchronized peer changes together.
                 * With synchronization active, only the focused pane drives updates; this
                 * prevents renderer callbacks from other panes feeding the movement back.
                 */
                setView(
                    index: number,
                    destination: Cartographic,
                    orientation?: CameraViewState["orientation"],
                    position: readonly [number, number, number] = [0, 0, 0],
                    focus = false,
                ) {
                    const id = idAt(index);
                    if (!id) {
                        throw new Error(`View index ${index} is unavailable`);
                    }
                    const views = focus ? {...store.views(), focusedViewId: id} : store.views();
                    const syncPosition = views.viewSync.includes(VIEW_SYNC_POSITION);
                    const syncMovement = views.viewSync.includes(VIEW_SYNC_MOVEMENT);
                    if ((syncPosition || syncMovement) && id !== views.focusedViewId) {
                        return;
                    }
                    const cameras = {...views.cameraViewData};
                    const previous = cameras[id].destination;
                    cameras[id] = cameraPose(cameras[id], destination, orientation, position);
                    for (const targetId of store.viewIds()) {
                        if (targetId === id) {
                            continue;
                        }
                        if (syncPosition) {
                            cameras[targetId] = cameraPose(cameras[targetId], destination, orientation, position);
                        } else if (syncMovement) {
                            // Relative movement shifts longitude and latitude while each
                            // peer keeps its own altitude, orientation and map-centre offset.
                            const target = cameras[targetId];
                            cameras[targetId] = cameraPose(
                                target,
                                Cartographic.fromDegrees(
                                    target.destination.lon + GeoMath.toDegrees(destination.longitude) - previous.lon,
                                    target.destination.lat + GeoMath.toDegrees(destination.latitude) - previous.lat,
                                    target.destination.alt,
                                ),
                                undefined,
                                target.position,
                            );
                        }
                    }
                    patchAppState(store, {views: {...views, cameraViewData: cameras}});
                },

                /** The selected pane controls 2D/3D mode for all panes when projection sync is on. */
                setProjectionMode(index: number, value: boolean, focus = false) {
                    const id = idAt(index);
                    if (!id) {
                        throw new Error(`View index ${index} is unavailable`);
                    }
                    const sync = store.views.viewSync().includes(VIEW_SYNC_PROJECTION);
                    if (sync && !focus && id !== store.views.focusedViewId()) {
                        return;
                    }
                    const mode2d = sync
                        ? Object.fromEntries(store.viewIds().map(viewId => [viewId, value]))
                        : {...store.views.mode2d(), [id]: value};
                    patchAppState(store, {
                        views: {
                            ...store.views(),
                            mode2d,
                            focusedViewId: focus ? id : store.views.focusedViewId(),
                        },
                    });
                },

                setMarkerState(enabled: boolean) {
                    patchAppState(store, {
                        views: {
                            ...store.views(),
                            marker: enabled,
                            markedPosition: enabled ? store.views.markedPosition() : [],
                        },
                    });
                },

                /** Repeated pointer movement may defer the explicit URL-history request. */
                setMarkerPosition(position: Cartographic | null, delayUpdate = false) {
                    patchAppState(store, {
                        views: {
                            ...store.views(),
                            markedPosition: position
                                ? [
                                    GeoMath.toDegrees(position.longitude),
                                    GeoMath.toDegrees(position.latitude),
                                    position.height,
                                ].map(roundCoordinateStateValue)
                                : [],
                            pushUrlRevision: store.views.pushUrlRevision() + (delayUpdate ? 0 : 1),
                        },
                    });
                },

                /** When a UI selection includes both camera modes, keep the newly chosen one. */
                updateSelectedSyncOptions(value: string[]) {
                    const next = [...new Set(value)];
                    if (next.includes(VIEW_SYNC_POSITION) && next.includes(VIEW_SYNC_MOVEMENT)) {
                        const remove = store.views.viewSync().includes(VIEW_SYNC_MOVEMENT) ? VIEW_SYNC_MOVEMENT : VIEW_SYNC_POSITION;
                        setSynchronization(next.filter(code => code !== remove));
                    } else {
                        setSynchronization(next);
                    }
                },

                syncViews() {
                    patchAppState(store, synchronizeViews(getState(store)));
                },
            };
        }),
        withProps(store => ({
            focusedViewControl: control(viewStateControls.focusedView, {
                read: () => store.focusedViewId(),
                write: (_, id) => store.setFocusedView(store.indexOf(store.requireView(id).id)),
            }),
            viewSyncControl: control(viewStateControls.viewSync, {
                read: () => viewStateControls.viewSync.valueSchema.parse(store.views.viewSync()),
                write: (_, value) => store.setSynchronization(value),
            }),
            markerStateControl: control(viewStateControls.marker, {
                read: () => store.markerControl(),
                write: (_, value) => store.setMarkerControl(value),
            }),
            navigationPreferencesControl: control(viewStateControls.navigation, {
                read: () => ({
                    zoomStep: store.views.mapZoomStep(),
                    featureZoomClearance: store.views.featureZoomClearanceMeters(),
                }),
                write: (_, value) => store.setNavigationPreferences(value),
            }),
        })),
    );
}
