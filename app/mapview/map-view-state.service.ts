import {viewIdSchema} from "./view-id";
import {setAllEntities} from "@ngrx/signals/entities";
import {computed} from "@angular/core";
import type {StateBinding} from "../shared/viewer-state";
import type {ViewId, ViewIdentity} from "./view-id";

import {Injectable, OnDestroy, Signal} from "@angular/core";
import {NavigationEnd, NavigationStart, Params, Router} from "@angular/router";
import {BehaviorSubject, skip, Subject, Subscription, take} from "rxjs";
import {filter} from "rxjs/operators";
import {Cartographic, GeoMath} from "../integrations/geo";
import {AppState, AppStateOptions, Boolish, MapViewState, StyleState} from "../shared/app-state";
import {z} from "zod";
import {
    PointCloudPolicy, DEFAULT_POINT_CLOUD_POLICY, pointCloudPolicySchema,
    pointCloudDetailSchema, pointCloudWorkingMemorySchema, pointCloudGpuMemorySchema
} from "../shared/point-cloud-policy";
import {MapTreeNode} from "../mapdata/map.tree.model";
import {ErdblickStyle} from "../styledata/style.service";
import {coreLib} from "../integrations/wasm";
import {InfoMessageService} from "../shared/info.service";
import type {FeatureWrapper} from "../mapdata/feature-inspection.model";
import type {DiagnosticsExportOptions, DiagnosticsLogFilter} from "../diagnostics/diagnostics.model";
import {
    BackgroundLayerConfig,
    clampBackgroundOpacity,
    DEFAULT_BACKGROUND_LAYER_ID,
    DEFAULT_BACKGROUND_OPACITY
} from "../shared/app-config.service";
import {
    createFeatureSearchStateEntry,
    FeatureSearchStateEntry,
    FeatureSearchStatePatch,
    FeatureSearchStateSchema,
    normalizeFeatureSearchState,
    serializeFeatureSearchState
} from "../shared/feature-search-state";
import {stripFeatureInspectionTarget} from "../shared/tile-feature-id";
import {
    ConnectionRetryPolicy, DEFAULT_CONNECTION_RETRY_POLICY,
    connectionRetryPolicySchema, retryDelaySchema, retryMultiplierSchema
} from "../shared/connection-retry-policy";
import type {LayerPresetRef} from "../styledata/layer-preset.model";
import {
    compressUrlCsvRuns,
    decodeLayerNamesV2,
    decodeMapNamesV2,
    decodeSelectionsV2,
    decodeStyleOptionsV2,
    encodeLayerNamesV2,
    encodeSelectionsV2,
    encodeStyleOptionsV2,
    featureSelectionLayerNames,
    firstParamValue,
    sourceDataSelectionMapIds
} from "../shared/url-state-codec";
import type {UrlV2MapTileKeyFactory} from "../shared/url-state-codec";
import {
    clampTileSubsetRenderWorkerCount
} from "../shared/tile-render-policy";
import {
    clampLod3TileThreshold,
    DEFAULT_LOD3_TILE_THRESHOLD
} from "../shared/lod-policy";
import {parseMapPartitionKey} from "../mapdata/partition.model";
import {AppStateService} from "../shared/appstate.service";
import {MAX_NUM_TILES_TO_LOAD, DEFAULT_MAP_ZOOM_STEP, DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS, VIEW_SYNC_PROJECTION, VIEW_SYNC_POSITION, VIEW_SYNC_MOVEMENT, VIEW_SYNC_LAYERS, CameraViewState, ViewSyncOptionDescriptor, roundCoordinateStateValue, clampMapZoomStep, clampFeatureZoomClearanceMeters} from "../shared/app-state.model";

export interface MapViewStateServiceValues {
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

/** Owns views values, validation, and user operations. */
@Injectable({providedIn: "root"})
export class MapViewStateService {


    private nextGeneration = 0;
    private readonly idSchema = z.array(viewIdSchema)
        .min(1).max(32).refine(ids => new Set(ids).size === ids.length, "View IDs must be unique");
    private readonly membership = this.stateService.values.bind<ViewId[]>(
        state => state.viewIds as ViewId[],
        (state, ids) => ({
            ...setAllEntities(this.idSchema.parse(ids).map(id =>
                state.viewEntityMap[id] ?? {id, generation: ++this.nextGeneration}), {collection: "view"})(state),
            views: {...state.views, focusedViewId: ids.includes(state.views.focusedViewId)
                ? state.views.focusedViewId : ids[0]}
        }),
        this.stateService.store.viewIds as () => ViewId[]
    );
    private readonly initialIds = this.createInitialIds();

    readonly viewIdsState = this.stateService.registerCodec({
        name: "viewIds", defaultValue: this.initialIds, schema: this.idSchema, urlParamName: "vid"
    }, this.membership);
    readonly viewIds = this.viewIdsState.signal;
    readonly identities = this.stateService.store.viewEntities;

    // The old persistence keys remain projections. Neither count nor a positional focus
    // is stored alongside the authoritative logical identities.
    readonly numViewsState = this.stateService.registerCodec<number>({
        name: "numberOfViews", defaultValue: 1, schema: z.coerce.number().int().min(1).max(32), urlParamName: "n"
    }, {
        signal: computed(() => this.viewIds().length),
        commits: this.membership.commits,
        read: () => this.membership.read().length,
        write: count => this.resizeViews(count)
    });

    private createInitialIds(): ViewId[] {
        const ids = [this.newViewId()];
        this.membership.write(ids);
        return ids;
    }

    private newViewId(): ViewId { return `view-${crypto.randomUUID()}`; }

    private resizeViews(count: number): void {
        z.number().int().min(1).max(32).parse(count);
        const current = this.membership.read();
        const next = current.slice(0, count);
        while (next.length < count) next.push(this.newViewId());
        this.membership.write(next);
    }

    /** Capture once before awaiting; generation rejects work from a removed/restored view. */
    captureView(index: number): ViewIdentity | undefined {
        const id = this.idAt(index);
        return id ? this.stateService.values.read(state => state.viewEntityMap[id],
            () => this.stateService.store.viewEntityMap()[id]) : undefined;
    }

    isCurrent(target: ViewIdentity): boolean {
        return this.stateService.values.read(state => state.viewEntityMap[target.id]?.generation,
            () => this.stateService.store.viewEntityMap()[target.id]?.generation) === target.generation;
    }

    idAt(index: number): ViewId | undefined { return this.membership.read()[index]; }
    indexOf(id: ViewId): number { return this.membership.read().indexOf(id); }

    /** Reorder only live IDs. Values and renderer lifetimes retain their logical owners. */
    reorderViews(ids: ViewId[]): void {
        const current = this.membership.read();
        this.idSchema.parse(ids);
        if (ids.length !== current.length || ids.some(id => !current.includes(id))) {
            throw new Error("A reorder must contain every current view exactly once");
        }
        this.membership.write(ids);
    }

    /** Commit captured camera poses before retiring selected view identities. */
    retainViews(indices: readonly number[], cameras: ReadonlyMap<number, CameraViewState>): void {
        const ids = indices.map(index => this.idAt(index));
        if (ids.some(id => !id)) throw new Error("Cannot retain an unavailable view");
        this.idSchema.parse(ids);
        this.stateService.transaction(() => {
            for (const [index, camera] of cameras) {
                if (indices.includes(index)) this.cameraViewDataState.next(index, camera);
            }
            this.membership.write(ids as ViewId[]);
        });
    }

    /** Resolve missing identity once, before any positional URL importer runs. */
    private prepareUrl(params: Params, resetMissing: boolean): Params {
        const hasIds = Object.prototype.hasOwnProperty.call(params, "vid");
        const count = params["n"] === undefined
            ? resetMissing ? 1 : this.numViews
            : z.coerce.number().int().min(1).max(32).parse(firstParamValue(params, "n"));
        let ids: ViewId[];
        if (hasIds) {
            const raw = params["vid"];
            if (Array.isArray(raw)) throw new Error("vid must occur once as an ordered CSV array");
            ids = this.idSchema.parse(String(raw).split(","));
            if (ids.length !== count) throw new Error("The view-ID count must match the effective number of views");
        } else {
            ids = Array.from({length: count}, () => this.newViewId());
        }
        return {...params, vid: ids.join(","), n: String(count)};
    }


    readonly markerState = this.stateService.register({
        name: 'marker',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm',
        urlIncludeInVisualizationOnly: false
    }, "views", "marker");


    readonly markedPositionState = this.stateService.register({
        name: 'markedPosition',
        defaultValue: [],
        schema: z.array(z.coerce.number()).max(3),
        toStorage: (value: number[]) => value.map(v => roundCoordinateStateValue(v)),
        fromStorage: (payload: any): number[] => (payload as number[]).map(v => roundCoordinateStateValue(v)),
        urlParamName: 'mp',
        urlIncludeInVisualizationOnly: false
    }, "views", "markedPosition");


    readonly focusedViewState = this.stateService.registerCodec<number>({
        name: "focus", defaultValue: 0, schema: z.coerce.number().int().nonnegative(),
        urlParamName: "f", urlIncludeInVisualizationOnly: false
    }, this.stateService.values.bind(
        state => Math.max(0, state.viewIds.indexOf(state.views.focusedViewId)),
        (state, index) => ({views: {...state.views,
            focusedViewId: String(state.viewIds[index] ?? state.viewIds[0])}}),
        () => Math.max(0, this.viewIds().indexOf(this.stateService.store.views.focusedViewId()))
    ));
    readonly focusedViewId = computed(() => this.viewIds()[this.focusedViewState.signal()]);


    readonly viewSyncState = this.stateService.register({
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
    }, "views", "viewSync");


    readonly cameraViewDataState = this.stateService.registerView({
        name: 'cameraView',
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
    }, "views", "cameraViewData");


    readonly mode2dState = this.stateService.registerView({
        name: 'mode2d',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm2d',
        urlIncludeInVisualizationOnly: false
    }, "views", "mode2d");


    readonly deckAntialiasingEnabledState = this.stateService.register({
        name: 'deckAntialiasingEnabled',
        defaultValue: true,
        schema: Boolish
    }, "views", "deckAntialiasingEnabled");


    readonly semanticCompositingEnabledState = this.stateService.register({
        name: 'semanticCompositingEnabled',
        defaultValue: true,
        schema: Boolish
    }, "views", "semanticCompositingEnabled");


    readonly contactShadingEnabledState = this.stateService.register({
        name: 'contactShadingEnabled',
        defaultValue: true,
        schema: Boolish
    }, "views", "contactShadingEnabled");


    readonly lod3TileThresholdState = this.stateService.register({
        name: 'lod3TileThreshold',
        defaultValue: DEFAULT_LOD3_TILE_THRESHOLD,
        schema: z.coerce.number().int(),
        toStorage: value => clampLod3TileThreshold(value, DEFAULT_LOD3_TILE_THRESHOLD),
        fromStorage: value => clampLod3TileThreshold(value, DEFAULT_LOD3_TILE_THRESHOLD)
    }, "views", "lod3TileThreshold");


    readonly tileSubsetRenderWorkerCountState = this.stateService.register({
        name: 'tileSubsetRenderWorkerCount',
        defaultValue: 0,
        schema: z.coerce.number().int(),
        toStorage: value => clampTileSubsetRenderWorkerCount(value),
        fromStorage: value => clampTileSubsetRenderWorkerCount(value)
    }, "views", "tileSubsetRenderWorkerCount");

    readonly pointCloudDownsamplingEnabledState = this.stateService.register({
        name: 'pointCloudDownsamplingEnabled', defaultValue: DEFAULT_POINT_CLOUD_POLICY.enabled, schema: Boolish
    }, "views", "pointCloudDownsamplingEnabled");

    readonly pointCloudDetailPixelsState = this.stateService.register({
        name: 'pointCloudDetailPixels', defaultValue: DEFAULT_POINT_CLOUD_POLICY.detailPixels,
        schema: pointCloudDetailSchema
    }, "views", "pointCloudDetailPixels");

    readonly pointCloudWorkingMemoryMiBState = this.stateService.register({
        name: 'pointCloudWorkingMemoryMiB', defaultValue: DEFAULT_POINT_CLOUD_POLICY.workingMemoryMiB,
        schema: pointCloudWorkingMemorySchema
    }, "views", "pointCloudWorkingMemoryMiB");

    readonly pointCloudGpuMemoryMiBState = this.stateService.register({
        name: 'pointCloudGpuMemoryMiB', defaultValue: DEFAULT_POINT_CLOUD_POLICY.gpuMemoryMiB,
        schema: pointCloudGpuMemorySchema
    }, "views", "pointCloudGpuMemoryMiB");


    /** Read the same validated policy for Preferences, rendering and worker admission. */
    get pointCloudPolicy(): PointCloudPolicy {
        return {
            enabled: this.pointCloudDownsamplingEnabledState.getValue(),
            detailPixels: this.pointCloudDetailPixelsState.getValue(),
            workingMemoryMiB: this.pointCloudWorkingMemoryMiBState.getValue(),
            gpuMemoryMiB: this.pointCloudGpuMemoryMiBState.getValue()
        };
    }


    /** Validate the whole preference edit before changing any persisted field. */
    setPointCloudPolicy(policy: PointCloudPolicy): void {
        return this.stateService.transaction(() => {
            const parsed = pointCloudPolicySchema.parse(policy);
            this.pointCloudDownsamplingEnabledState.next(parsed.enabled);
            this.pointCloudDetailPixelsState.next(parsed.detailPixels);
            this.pointCloudWorkingMemoryMiBState.next(parsed.workingMemoryMiB);
            this.pointCloudGpuMemoryMiBState.next(parsed.gpuMemoryMiB);
        });
    }


    readonly mapZoomStepState = this.stateService.register({
        name: 'mapZoomStep',
        defaultValue: DEFAULT_MAP_ZOOM_STEP,
        schema: z.coerce.number(),
        fromStorage: value => clampMapZoomStep(Number(value))
    }, "views", "mapZoomStep");


    readonly featureZoomClearanceMetersState = this.stateService.register({
        name: 'featureZoomClearanceMeters',
        defaultValue: DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS,
        schema: z.coerce.number(),
        fromStorage: value => clampFeatureZoomClearanceMeters(Number(value))
    }, "views", "featureZoomClearanceMeters");


    readonly tilesLoadLimitState = this.stateService.register({
        name: 'tilesLoadLimit',
        defaultValue: MAX_NUM_TILES_TO_LOAD,
        schema: z.coerce.number().nonnegative(),
        urlParamName: 'tll'
    }, "views", "tilesLoadLimit");


    /** Immutable view-sync option descriptors consumed by the split-view UI. */
    readonly syncOptions: readonly ViewSyncOptionDescriptor[] = [
        {name: "Position", code: VIEW_SYNC_POSITION, icon: "location_on", tooltip: "Sync camera position/orientation across views"},
        {name: "Movement", code: VIEW_SYNC_MOVEMENT, icon: "drag_pan", tooltip: "Sync camera movement delta across views"},
        {name: "Projection", code: VIEW_SYNC_PROJECTION, icon: "3d_rotation", tooltip: "Sync projection mode across views"},
        {name: "Layers", code: VIEW_SYNC_LAYERS, icon: "layers", tooltip: "Sync layer activation/style/background settings across views"},
    ];


    /** Copies synchronized view properties from the focused view to the others. */
    syncViews(): void {
        return this.stateService.transaction(() => {
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


    // -----------------
    // Public API below
    // -----------------

    get numViews() {return this.numViewsState.getValue();}

    set numViews(val: number) {
        this.stateService.transaction(() => {
            const previousViewCount = this.numViewsState.getValue();
            if (val === previousViewCount) {
                return;
            }
            this.numViewsState.next(val);
        });
    }

    get deckAntialiasingEnabled() {return this.deckAntialiasingEnabledState.getValue();}

    set deckAntialiasingEnabled(val: boolean) {
        this.stateService.transaction(() => {this.deckAntialiasingEnabledState.next(!!val);
        });
    }

    get semanticCompositingEnabled() {return this.semanticCompositingEnabledState.getValue();}

    set semanticCompositingEnabled(val: boolean) {
        this.stateService.transaction(() => {this.semanticCompositingEnabledState.next(!!val);
        });
    }

    get contactShadingEnabled() {return this.contactShadingEnabledState.getValue();}

    set contactShadingEnabled(val: boolean) {
        this.stateService.transaction(() => {this.contactShadingEnabledState.next(!!val);
        });
    }

    get lod3TileThreshold() {return this.lod3TileThresholdState.getValue();}

    set lod3TileThreshold(val: number) {
        this.stateService.transaction(() => {
            this.lod3TileThresholdState.next(clampLod3TileThreshold(val, DEFAULT_LOD3_TILE_THRESHOLD));
        });
    }

    get tileSubsetRenderWorkerCount() {
        return this.tileSubsetRenderWorkerCountState.getValue();
    }

    set tileSubsetRenderWorkerCount(val: number) {
        this.stateService.transaction(() => {
            this.tileSubsetRenderWorkerCountState.next(
                clampTileSubsetRenderWorkerCount(val)
            );
        });
    }

    get mapZoomStep() {return this.mapZoomStepState.getValue();}

    set mapZoomStep(val: number) {
        this.stateService.transaction(() => {this.mapZoomStepState.next(clampMapZoomStep(Number(val)));
        });
    }

    get featureZoomClearanceMeters() {
        return this.featureZoomClearanceMetersState.getValue();
    }

    set featureZoomClearanceMeters(val: number) {
        this.stateService.transaction(() => {
            this.featureZoomClearanceMetersState.next(
                clampFeatureZoomClearanceMeters(Number(val))
            );
        });
    }

    get marker() {return this.markerState.getValue();}

    set marker(val: boolean) {
        this.stateService.transaction(() => {this.markerState.next(val);
        });
    }

    get markedPosition() {return this.markedPositionState.getValue();}

    set markedPosition(val: number[]) {
        this.stateService.transaction(() => {this.markedPositionState.next(val.map(v => roundCoordinateStateValue(v)));
        });
    }

    get focusedView() {return this.focusedViewState.getValue();}

    set focusedView(val: number) {
        this.stateService.transaction(() => {this.focusedViewState.next(val);
        });
    }

    get tilesLoadLimit() {return this.tilesLoadLimitState.getValue();}

    set tilesLoadLimit(val: number) {
        this.stateService.transaction(() => {this.tilesLoadLimitState.next(val);
        });
    }

    get viewSync() {return this.viewSyncState.getValue();}

    set viewSync(val: string[]) {
        this.stateService.transaction(() => {
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
        });
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
    }


    /** Switches one view between 2D and 3D projection mode. */
    setProjectionMode(viewIndex: number, is2DMode: boolean) {
        return this.stateService.transaction(() => {
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


    /** Enables or disables the explicit location marker overlay. */
    setMarkerState(enabled: boolean) {
        return this.stateService.transaction(() => {
            this.markerState.next(enabled);
            if (!enabled) {
                this.setMarkerPosition(null, false);
            }
        });
    }


    /** Updates the explicit location marker position, optionally delaying URL sync. */
    setMarkerPosition(position: Cartographic | null, delayUpdate: boolean = false) {
        if (position) {
            const longitude = GeoMath.toDegrees(position.longitude);
            const latitude = GeoMath.toDegrees(position.latitude);
            this.markedPosition = [longitude, latitude, position.height];
        } else {
            this.markedPosition = [];
        }
        if (!delayUpdate) {
            this.stateService.pushNextUrl();
        }
    }


    /** Applies the selection emitted by the view-sync toggle UI and mirrors it into state. */
    updateSelectedSyncOptions(selectedCodes: string[]) {
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
    }
    constructor(private readonly stateService: AppStateService, private readonly infoMessageService: InfoMessageService) {
        this.focusedViewState.next(0);
        this.stateService.registerUrlNormalizer((params, resetMissing) => this.prepareUrl(params, resetMissing));
        this.stateService.beforeCommit(() => {
            const ids = this.membership.read();
            const focused = this.stateService.values.read(state => state.views.focusedViewId,
                () => this.stateService.store.views.focusedViewId());
            if (!ids.includes(focused)) this.focusedViewState.next(0);
        });
    }
}
