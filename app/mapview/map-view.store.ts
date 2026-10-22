import { Injectable } from "@angular/core";
import { Params } from "@angular/router";
import { z } from "zod";
import {
    BackgroundLayerConfig,
    clampBackgroundOpacity,
    DEFAULT_BACKGROUND_LAYER_ID,
    DEFAULT_BACKGROUND_OPACITY
} from "../config/background-layer.model";
import { roundCoordinateStateValue } from "../coords/coordinates-state.model";
import { Cartographic, GeoMath } from "../integrations/geo";
import { Boolish, MapViewState } from "../state/app-state";
import { cloneStateValue } from "../state/app-state.model";
import { AppStateService } from "../state/app-state.service";
import {
    BackgroundLayerViewState,
    CameraViewState,
    clampFeatureZoomClearanceMeters,
    clampMapZoomStep,
    clampTileGridOpacity,
    DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS,
    DEFAULT_MAP_ZOOM_STEP,
    DEFAULT_TILE_GRID_COLOR,
    DEFAULT_TILE_GRID_LEVEL,
    DEFAULT_TILE_GRID_OPACITY,
    normalizeTileGridColor,
    TileGridMode,
    VIEW_SYNC_LAYERS,
    VIEW_SYNC_MOVEMENT,
    VIEW_SYNC_POSITION,
    VIEW_SYNC_PROJECTION,
    viewIdSchema,
    ViewSyncOptionDescriptor
} from "./map-view-state.model";

/** Stable logical map identity; runtime renderers get a new generation when restored. */
export type ViewId = string;

export { viewIdSchema } from "./map-view-state.model";
export const viewCountSchema = z.coerce.number().int().min(1).max(32);
export const viewIdsSchema = z.array(viewIdSchema).min(1).max(32)
    .refine(ids => new Set(ids).size === ids.length, "View IDs must be unique.");

/** Other owners participate in membership edits while keeping their own state and invariants. */
interface ViewMembershipOwner {
    seed(previousCount: number, nextCount: number, sourceIndex: number): void;
    retain(indices: readonly number[]): void;
    import?(previous: readonly ViewId[], ids: readonly ViewId[]): void;
}

/**
 * Durable view identities, committed cameras and synchronized preferences.
 * Membership edits keep all per-view values coherent during hydration, when no
 * renderer exists yet. Live camera previews, renderer teardown and navigation
 * are coordinated by MapViewService.
 */
@Injectable({ providedIn: "root" })
export class MapViewStore {
    readonly viewIdsState = this.persistence.registerState<ViewId[]>({
        name: "viewIds",
        defaultValue: [crypto.randomUUID()],
        schema: z.array(viewIdSchema),
        fromStorage: value => viewIdsSchema.parse(value),
        normalize: value => viewIdsSchema.parse(value),
        urlParamName: "vid"
    });

    get viewIds(): readonly ViewId[] {
        return this.viewIdsState.value;
    }

    /** Resolves presentation order to durable identity only at the UI/renderer boundary. */
    viewIdAt(index: number): ViewId {
        const id = this.viewIds[index];
        if (id === undefined) throw new Error(`View ${index} is unavailable.`);
        return id;
    }

    /** Rejects removed identities; an old index must never accidentally target a replacement view. */
    indexOfView(id: ViewId): number {
        const index = this.viewIds.indexOf(id);
        if (index < 0) throw new Error(`View ${id} is unavailable.`);
        return index;
    }

    /** Resolves one identity mapping for every legacy positional importer. */
    prepareImportedViews(count: unknown, rawIds: unknown, replaceAbsent: boolean): ViewId[] {
        const effectiveCount = viewCountSchema.parse(count);
        if (rawIds !== undefined) {
            const ids = viewIdsSchema.parse(rawIds);
            if (ids.length !== effectiveCount) throw new Error("View ID count does not match the number of views.");
            return ids;
        }
        return Array.from({ length: effectiveCount }, (_, index) =>
            !replaceAbsent && this.viewIds[index] ? this.viewIds[index] : crypto.randomUUID());
    }

    /** A changed config-owned count keeps existing saved identities and adds only the new views. */
    resizeStoredViews(rawIds: unknown, count: unknown): ViewId[] {
        const ids = viewIdsSchema.parse(rawIds);
        const effectiveCount = viewCountSchema.parse(count);
        return Array.from({ length: effectiveCount }, (_, index) => ids[index] ?? crypto.randomUUID());
    }

    /** Installs import membership atomically, retaining live identities and omitted positional values. */
    importViews(ids: readonly ViewId[], inheritPositions = true): void {
        this.persistence.transaction(() => {
            viewIdsSchema.parse(ids);
            if (inheritPositions) {
                const previous = this.viewIds;
                for (const state of this.mapViewStates) state.rekey(previous, ids);
                for (const owner of this.membershipOwners) owner.import?.(previous, ids);
            }
            this.viewIdsState.next([...ids]);
            if (!ids.includes(this.focusedViewIdState.value)) this.focusedViewIdState.next(ids[0]);
        });
    }

    private readonly membershipOwners = new Set<ViewMembershipOwner>();

    /** Registers another owner's view-indexed values without a circular DI dependency. */
    registerMembershipOwner(owner: ViewMembershipOwner): () => void {
        this.membershipOwners.add(owner);
        return () => this.membershipOwners.delete(owner);
    }

    /** Only actual per-view values participate; positional splitter proportions belong to layout. */
    private get mapViewStates(): Array<MapViewState<unknown>> {
        return [
            this.cameraViewDataState,
            this.mode2dState,
            this.backgroundState,
            this.viewTileBordersState,
            this.viewTileGridModeState,
            this.viewTileGridLevelState,
            this.viewTileGridAutoLevelState,
            this.viewTileGridColorState,
            this.viewTileGridOpacityState
        ] as Array<MapViewState<unknown>>;
    }

    constructor(private readonly persistence: AppStateService) { }

    /** The deployed numeric key is a projection of membership, never another source of truth. */
    readonly numViewsState = this.persistence.registerProjection<number>({
        name: "numberOfViews",
        defaultValue: 1,
        schema: viewCountSchema,
        urlParamName: "n"
    }, {
        sourceState: this.viewIdsState,
        read: () => this.viewIds.length,
        write: count => this.numViews = count,
        changes: this.persistence.observe(() => this.viewIds.length)
    });

    /** Focus follows a logical view through reorder; its storage/URL codec stays numeric. */
    readonly focusedViewIdState = this.persistence.registerState<ViewId>({
        name: "focus",
        defaultValue: this.viewIds[0],
        schema: z.coerce.number().int().nonnegative(),
        toStorage: id => Math.max(0, this.viewIds.indexOf(id)),
        fromStorage: index => this.viewIds[Number(index)] ?? this.viewIds[0],
        urlParamName: "f",
        urlIncludeInVisualizationOnly: false
    });
    readonly focusedViewChanges = this.persistence.observe(() => this.focusedView);

    readonly viewSyncState = this.persistence.registerState<string[]>({
        name: 'viewSync',
        defaultValue: [],
        schema: z.array(z.union([
            z.literal(VIEW_SYNC_PROJECTION),
            z.literal(VIEW_SYNC_POSITION),
            z.literal(VIEW_SYNC_MOVEMENT),
            z.literal(VIEW_SYNC_LAYERS)
        ])),
        urlParamName: 'sync',
        urlIncludeInVisualizationOnly: false
    });

    readonly cameraViewDataState = this.persistence.registerMapViewState<CameraViewState>({
        name: 'cameraView',
        defaultValue: {
            destination: { lon: 22.837473, lat: 38.490817, alt: 16000000 },
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
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
        fromStorage: (payload: any, currentValue: CameraViewState) => ({
            destination: {
                lon: roundCoordinateStateValue(payload.lon ?? currentValue.destination.lon),
                lat: roundCoordinateStateValue(payload.lat ?? currentValue.destination.lat),
                alt: roundCoordinateStateValue(payload.alt ?? currentValue.destination.alt),
            },
            orientation: {
                heading: roundCoordinateStateValue(payload.h ?? currentValue.orientation.heading),
                pitch: roundCoordinateStateValue(payload.p ?? currentValue.orientation.pitch),
                roll: roundCoordinateStateValue(payload.r ?? currentValue.orientation.roll),
            },
            // Older URLs, local-storage entries, and snapshots have no map-centre offset.
            position: [
                roundCoordinateStateValue(payload.px ?? 0),
                roundCoordinateStateValue(payload.py ?? 0),
                roundCoordinateStateValue(payload.pz ?? 0)
            ]
        }),
        urlFormEncode: true
    }, () => this.viewIds);

    readonly mode2dState = this.persistence.registerMapViewState<boolean>({
        name: 'mode2d',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm2d',
        urlIncludeInVisualizationOnly: false
    }, () => this.viewIds);

    readonly mapZoomStepState = this.persistence.registerState<number>({
        name: 'mapZoomStep',
        defaultValue: DEFAULT_MAP_ZOOM_STEP,
        schema: z.coerce.number(),
        fromStorage: value => clampMapZoomStep(Number(value))
    });

    readonly featureZoomClearanceMetersState = this.persistence.registerState<number>({
        name: 'featureZoomClearanceMeters',
        defaultValue: DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS,
        schema: z.coerce.number(),
        fromStorage: value => clampFeatureZoomClearanceMeters(Number(value))
    });

    readonly backgroundState = this.persistence.registerMapViewState<BackgroundLayerViewState>({
        name: 'background',
        defaultValue: {
            layerId: DEFAULT_BACKGROUND_LAYER_ID,
            opacity: DEFAULT_BACKGROUND_OPACITY,
        },
        schema: z.string(),
        toStorage: (value: BackgroundLayerViewState) => `${encodeURIComponent(value.layerId ?? '')}~${clampBackgroundOpacity(value.opacity)}`,
        fromStorage: (payload: any, currentValue: BackgroundLayerViewState): BackgroundLayerViewState => {
            const parts = String(payload).split('~');
            const layerId = parts[0] ? decodeURIComponent(parts[0]) : null;
            const opacity = parts[1] === undefined ? currentValue.opacity : clampBackgroundOpacity(Number(parts[1]));
            return { layerId, opacity };
        },
        urlParamName: 'bg'
    }, () => this.viewIds);

    readonly viewTileBordersState = this.persistence.registerMapViewState<boolean>({
        name: "tileBorders",
        defaultValue: true,
        schema: Boolish,
        urlParamName: 'tb'
    }, () => this.viewIds);

    readonly viewTileGridModeState = this.persistence.registerMapViewState<TileGridMode>({
        name: "tileGridMode",
        defaultValue: "nds",
        schema: z.enum(["xyz", "nds"]),
        urlParamName: 'tgm'
    }, () => this.viewIds);

    readonly viewTileGridLevelState = this.persistence.registerMapViewState<number>({
        name: "tileGridLevel",
        defaultValue: DEFAULT_TILE_GRID_LEVEL,
        schema: z.coerce.number().int().min(0).max(22),
        urlParamName: "tgl"
    }, () => this.viewIds);

    readonly viewTileGridAutoLevelState = this.persistence.registerMapViewState<boolean>({
        name: "tileGridAutoLevel",
        defaultValue: false,
        schema: Boolish,
        urlParamName: "tga"
    }, () => this.viewIds);

    readonly viewTileGridColorState = this.persistence.registerMapViewState<string>({
        name: "tileGridColor",
        defaultValue: DEFAULT_TILE_GRID_COLOR,
        schema: z.string(),
        toStorage: (value: string) => normalizeTileGridColor(value),
        fromStorage: (payload: unknown) => normalizeTileGridColor(payload),
        urlParamName: "tgc"
    }, () => this.viewIds);

    readonly viewTileGridOpacityState = this.persistence.registerMapViewState<number>({
        name: "tileGridOpacity",
        defaultValue: DEFAULT_TILE_GRID_OPACITY,
        schema: z.coerce.number().min(0).max(100),
        toStorage: (value: number) => clampTileGridOpacity(value),
        fromStorage: (payload: unknown) => clampTileGridOpacity(payload),
        urlParamName: "tgo"
    }, () => this.viewIds);

    /** Immutable view-sync option descriptors consumed by the split-view UI. */
    readonly syncOptions: readonly ViewSyncOptionDescriptor[] = [
        {
            name: "Position",
            code: VIEW_SYNC_POSITION,
            icon: "location_on",
            tooltip: "Sync camera position/orientation across views"
        },
        {
            name: "Movement",
            code: VIEW_SYNC_MOVEMENT,
            icon: "drag_pan",
            tooltip: "Sync camera movement delta across views"
        },
        {
            name: "Projection",
            code: VIEW_SYNC_PROJECTION,
            icon: "3d_rotation",
            tooltip: "Sync projection mode across views"
        },
        {
            name: "Layers",
            code: VIEW_SYNC_LAYERS,
            icon: "layers",
            tooltip: "Sync layer activation/style/background settings across views"
        },
    ];

    /** Copies synchronized view properties from the focused view to the others. */
    syncViews(): void {
        this.persistence.transaction(() => {
            if (this.numViews < 2) {
                return;
            }
            if (this.viewSync.includes(VIEW_SYNC_POSITION)) {
                const camState = this.cameraViewDataState.getValue(this.focusedView);
                this.setView(this.focusedView,
                    Cartographic.fromDegrees(camState.destination.lon, camState.destination.lat, camState.destination.alt),
                    camState.orientation,
                    camState.position);
            }
            if (this.viewSync.includes(VIEW_SYNC_PROJECTION)) {
                this.setProjectionMode(this.focusedView, this.mode2dState.getValue(this.focusedView));
            }
        });
    }

    /** Seeds every new view from the explicitly selected source, or the preceding last view. */
    private seedAdditionalViews(previousViewCount: number, nextViewCount: number, sourceIndex = previousViewCount - 1): void {
        for (let target = previousViewCount; target < nextViewCount; target++) {
            for (const state of this.mapViewStates) state.next(target, cloneStateValue(state.getValue(sourceIndex)));
        }
        for (const owner of this.membershipOwners) owner.seed(previousViewCount, nextViewCount, sourceIndex);
    }

    /** Compacts surviving views after their renderers have stopped publishing state. */
    retainViews(indices: readonly number[], cameras: ReadonlyMap<number, CameraViewState>): void {
        if (!indices.length || new Set(indices).size !== indices.length ||
            indices.some(index => !Number.isInteger(index) || index < 0 || index >= this.numViews)) {
            throw new Error("Invalid retained view order.");
        }
        this.persistence.transaction(() => {
            const ids = indices.map(index => this.viewIdAt(index));
            for (const [index, camera] of cameras) this.cameraViewDataState.next(index, camera);
            for (const owner of this.membershipOwners) owner.retain(indices);
            for (const state of this.mapViewStates) state.retain(ids);
            this.importViews(ids, false);
        });
    }

    // -----------------
    // Public API below
    // -----------------

    get numViews(): number {
        return this.viewIds.length;
    }

    set numViews(count: number) {
        count = z.number().int().min(1).max(32).parse(count);
        const previous = this.numViews;
        if (count === previous) return;
        if (count < previous) {
            this.retainViews(Array.from({ length: count }, (_, index) => index), new Map());
            return;
        }
        this.persistence.transaction(() => {
            this.viewIdsState.next([...this.viewIds, ...Array.from({ length: count - previous }, () => crypto.randomUUID())]);
            this.seedAdditionalViews(previous, count);
        });
    }

    /** Adds one logical view and seeds every participating owner in the same commit. */
    addView(sourceId: ViewId): ViewId {
        const sourceIndex = this.indexOfView(sourceId);
        const previous = this.numViews;
        if (previous >= 32) throw new Error("The viewer supports at most 32 views.");
        const id = crypto.randomUUID();
        this.persistence.transaction(() => {
            this.viewIdsState.next([...this.viewIds, id]);
            this.seedAdditionalViews(previous, previous + 1, sourceIndex);
        });
        return id;
    }

    get mapZoomStep() {
        return this.mapZoomStepState.getValue();
    }

    set mapZoomStep(val: number) {
        this.mapZoomStepState.next(clampMapZoomStep(Number(val)));
    }

    get featureZoomClearanceMeters() {
        return this.featureZoomClearanceMetersState.getValue();
    }

    set featureZoomClearanceMeters(val: number) {
        this.featureZoomClearanceMetersState.next(
            clampFeatureZoomClearanceMeters(Number(val))
        );
    }

    get focusedView(): number {
        return Math.max(0, this.viewIds.indexOf(this.focusedViewIdState.value));
    }

    set focusedView(index: number) {
        this.focusedViewIdState.next(this.viewIdAt(index));
    }

    get viewSync() {
        return this.viewSyncState.getValue();
    }

    set viewSync(val: string[]) {
        const previous = new Set(this.viewSyncState.getValue());
        const uniqueValues = Array.from(new Set(val));
        const hasMovement = uniqueValues.includes(VIEW_SYNC_MOVEMENT);
        const hasPosition = uniqueValues.includes(VIEW_SYNC_POSITION);
        let sanitized = uniqueValues;

        if (hasMovement && hasPosition) {
            if (!previous.has(VIEW_SYNC_MOVEMENT)) {
                sanitized = uniqueValues.filter(value => value !== VIEW_SYNC_POSITION);
            } else if (!previous.has(VIEW_SYNC_POSITION)) {
                sanitized = uniqueValues.filter(value => value !== VIEW_SYNC_MOVEMENT);
            } else {
                sanitized = uniqueValues.filter(value => value !== VIEW_SYNC_POSITION);
            }
        }

        this.viewSyncState.next(sanitized);
    }

    /** Returns the persisted background-layer state for the given view. */
    getBackgroundState(viewIndex: number): BackgroundLayerViewState {
        const value = this.backgroundState.getValue(viewIndex);
        return {
            layerId: value.layerId,
            opacity: clampBackgroundOpacity(value.opacity),
        };
    }

    /** Returns the effective background-layer state after missing ids are mapped to the configured default. */
    resolveBackgroundState(viewIndex: number,
        availableLayers: readonly BackgroundLayerConfig[],
        defaultBackgroundLayerId: string | null): BackgroundLayerViewState {
        const rawState = this.getBackgroundState(viewIndex);
        if (rawState.layerId === null) {
            return rawState;
        }

        const availableLayerIds = new Set(availableLayers.map(layer => layer.id));
        if (availableLayerIds.has(rawState.layerId)) {
            return rawState;
        }

        const defaultLayer = defaultBackgroundLayerId
            ? availableLayers.find(layer => layer.id === defaultBackgroundLayerId)
            : undefined;
        if (defaultLayer) {
            return {
                layerId: defaultLayer.id,
                opacity: defaultLayer.defaultOpacity
            };
        }

        return {
            layerId: null,
            opacity: rawState.opacity
        };
    }

    /** Writes the selected background-layer id and opacity for one view. */
    setBackgroundState(viewIndex: number, layerId: string | null, opacity: number): void {
        this.backgroundState.next(viewIndex, {
            layerId,
            opacity: clampBackgroundOpacity(opacity),
        });
    }

    /** Returns the configured background opacity for the given view. */
    getBackgroundOpacity(viewIndex: number): number {
        return this.getBackgroundState(viewIndex).opacity;
    }

    /** Returns the persisted orientation for the given view. */
    getCameraOrientation(viewIndex: number) {
        return this.cameraViewDataState.getValue(viewIndex).orientation;
    }

    /** Returns the persisted camera destination for the given view. */
    getCameraPosition(viewIndex: number) {
        const destination = this.cameraViewDataState.getValue(viewIndex).destination;
        return Cartographic.fromDegrees(destination.lon, destination.lat, destination.alt);
    }

    /** Internal helper that writes a complete camera pose without extra synchronization policy. */
    private _setView(
        viewIndex: number,
        destination: Cartographic,
        orientation?: { heading: number, pitch: number, roll: number },
        position: readonly [number, number, number] = [0, 0, 0]
    ) {
        // Fall back to the current orientation if none was passed.
        orientation = orientation ?? this.cameraViewDataState.getValue(viewIndex).orientation;
        const view: CameraViewState = {
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
            position: position.map(roundCoordinateStateValue) as [number, number, number]
        };
        this.cameraViewDataState.next(viewIndex, view);
    }

    /** Persists a camera pose and applies the configured cross-view synchronization policy. */
    setView(
        viewIndex: number,
        destination: Cartographic,
        orientation?: { heading: number, pitch: number, roll: number },
        position: readonly [number, number, number] = [0, 0, 0]
    ) {
        this.persistence.transaction(() => {
            const syncPosition = this.viewSync.includes(VIEW_SYNC_POSITION);
            const syncMovement = this.viewSync.includes(VIEW_SYNC_MOVEMENT);

            if (syncPosition || syncMovement) {
                // Unfocused view is trying to update itself when the views are synchronized
                if (viewIndex !== this.focusedView) {
                    return;
                }

                if (syncPosition) {
                    for (let i = 0; i < this.numViews; i++) {
                        this._setView(i, destination, orientation, position);
                    }
                    return;
                }

                if (syncMovement) {
                    const previous = this.cameraViewDataState.getValue(viewIndex).destination;
                    const destLon = GeoMath.toDegrees(destination.longitude);
                    const destLat = GeoMath.toDegrees(destination.latitude);
                    const deltaLon = destLon - previous.lon;
                    const deltaLat = destLat - previous.lat;

                    this._setView(viewIndex, destination, orientation, position);

                    for (let i = 0; i < this.numViews; i++) {
                        if (i === viewIndex) {
                            continue;
                        }
                        const target = this.cameraViewDataState.getValue(i);
                        const newDestination = Cartographic.fromDegrees(
                            target.destination.lon + deltaLon,
                            target.destination.lat + deltaLat,
                            target.destination.alt
                        );
                        this._setView(i, newDestination, undefined, target.position);
                    }
                    return;
                }
            }

            this._setView(viewIndex, destination, orientation, position);
        });
    }

    /** Switches one view between 2D and 3D projection mode. */
    setProjectionMode(viewIndex: number, is2DMode: boolean) {
        this.persistence.transaction(() => {
            if (this.viewSync.includes(VIEW_SYNC_PROJECTION)) {
                // Unfocused view is trying to update itself when the views are synchronized
                if (viewIndex !== this.focusedView) {
                    return;
                }

                for (let i = 0; i < this.numViews; i++) {
                    this.mode2dState.next(i, is2DMode);
                }
                return;
            }
            this.mode2dState.next(viewIndex, is2DMode);
        });
    }

    /** Migrates legacy `osm` URL/storage payloads into the generic background-layer state once on startup. */
    migrateLegacyOsmState(params: Params): void {
        const hasBackgroundStorage = localStorage.getItem(this.backgroundState.appState.name) !== null;
        const hasBackgroundUrl = params[this.backgroundState.appState.urlParamName ?? this.backgroundState.appState.name] !== undefined;
        if (hasBackgroundStorage || hasBackgroundUrl) {
            return;
        }

        const legacyStorage = localStorage.getItem('osm');
        const legacyUrl = params['osm'];
        const legacyPayload = legacyUrl ?? legacyStorage;
        if (legacyPayload === undefined || legacyPayload === null) {
            return;
        }

        const serializedStates = typeof legacyPayload === 'string' && legacyPayload.trim().startsWith('[')
            ? this.parseLegacyOsmStorage(legacyPayload)
            : this.parseLegacyOsmUrl(String(legacyPayload));
        if (!serializedStates.length) {
            return;
        }

        this.persistence.transaction(() => {
            // Old links/storage can retain a second positional entry while only one
            // view is active. Migration must not create or address retired views.
            serializedStates.slice(0, this.numViews).forEach((state, viewIndex) => {
                this.setBackgroundState(viewIndex, state.layerId, state.opacity);
            });
        });
    }

    /** Parses the JSON-encoded local-storage payload used by the removed `osm` state slot. */
    private parseLegacyOsmStorage(rawPayload: string): BackgroundLayerViewState[] {
        try {
            const parsed = JSON.parse(rawPayload);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed.map(token => this.parseLegacyOsmToken(String(token)));
        } catch {
            return [];
        }
    }

    /** Parses the compact CSV URL form used by the removed `osm` query parameter. */
    private parseLegacyOsmUrl(rawPayload: string): BackgroundLayerViewState[] {
        if (!rawPayload.length) {
            return [];
        }
        return rawPayload.split(',').map(token => this.parseLegacyOsmToken(token));
    }

    /** Converts one legacy `enabled~opacity` token into the new background-layer state shape. */
    private parseLegacyOsmToken(rawToken: string): BackgroundLayerViewState {
        const parts = rawToken.split('~');
        const enabled = parts[0] === '1' || parts[0].toLowerCase() === 'true';
        const opacity = parts[1] === undefined ? 6 : clampBackgroundOpacity(Number(parts[1]));
        return {
            layerId: enabled ? 'osm' : null,
            opacity
        };
    }

    /** Applies the selection emitted by the view-sync toggle UI and mirrors it into state. */
    updateSelectedSyncOptions(selectedCodes: string[]) {
        this.persistence.transaction(() => {
            const previousSelection = new Set(this.viewSync);
            let nextSelection = Array.from(new Set(selectedCodes));
            const hasMovement = nextSelection.includes(VIEW_SYNC_MOVEMENT);
            const hasPosition = nextSelection.includes(VIEW_SYNC_POSITION);

            if (hasMovement && hasPosition) {
                let valueToRemove = VIEW_SYNC_POSITION;
                if (!previousSelection.has(VIEW_SYNC_POSITION) && previousSelection.has(VIEW_SYNC_MOVEMENT)) {
                    valueToRemove = VIEW_SYNC_MOVEMENT;
                } else if (!previousSelection.has(VIEW_SYNC_MOVEMENT) && previousSelection.has(VIEW_SYNC_POSITION)) {
                    valueToRemove = VIEW_SYNC_POSITION;
                } else if (!previousSelection.has(VIEW_SYNC_MOVEMENT)) {
                    valueToRemove = VIEW_SYNC_POSITION;
                } else if (!previousSelection.has(VIEW_SYNC_POSITION)) {
                    valueToRemove = VIEW_SYNC_MOVEMENT;
                }
                nextSelection = nextSelection.filter(code => code !== valueToRemove);
            }

            this.viewSync = nextSelection;
            this.syncViews();
        });
    }

    /** Removes retired dictionary entries without changing live membership or presentation order. */
    pruneRetiredViews(): void {
        this.persistence.transaction(() => {
            for (const state of this.mapViewStates) state.retain(this.viewIds);
        });
    }

}
