import {AppActionService} from "../actions/app-action.service";
import {ActionInput, ActionOutput, ControlSelector, ControlValue, applied, rejectAction} from "../actions/app-action";
import {mapViewActions, mapViewControls} from "./map-view.service.declarations";
import {mapControls} from "../mapdata/map-info.service.declarations";
import {AppConfigService} from "../shared/app-config.service";
import {Cartographic} from "../integrations/geo";
import {tileGridMaxLevel} from "../shared/app-state.model";
import { Injectable } from "@angular/core";
import { Subject,filter,firstValueFrom,fromEvent,merge,startWith } from "rxjs";
import type {
FeatureLayerStyle,
Viewport
} from "../../build/libs/core/erdblick-core";
import { coreLib } from "../integrations/wasm";
import { MapInfoService } from "../mapdata/map-info.service";
import {
AppStateService,
CameraViewState,
TileGridMode,
VIEW_SYNC_LAYERS,
VIEW_SYNC_MOVEMENT,
VIEW_SYNC_POSITION
} from "../shared/appstate.service";
import {
clampPresentationLod,
clampStyleLod
} from "../shared/lod-policy";
import { MapViewStateService, ViewId } from "./map-view-state.service";
import { RenderPreferencesService } from "./render-preferences.service";
import { IRenderView,LocationArea,RenderRectangle,RenderViewCameraState } from "./render-view.model";
import {
autoTileGridLevel,
coarsenedTileLevel,
tileGridVisibleCellCount
} from "./tile-grid-visibility";
import { ViewVisualizationState } from "./view.visualization.model";

export enum ViewRecalculationReason {
    AutoLevel = "auto-level",
    BackgroundSync = "background-sync",
    LodThreshold = "lod-threshold",
    HoverPopover = "hover-popover",
    LayerLevel = "layer-level",
    NumViews = "num-views",
    RenderViewReady = "render-view-ready",
    StyleChange = "style-change",
    SyncOptions = "sync-options",
    TileBorder = "tile-border",
    TileGrid = "tile-grid",
    TileLimit = "tile-limit",
    Viewport = "viewport",
    Visibility = "visibility"
}

/** One renderer-local camera preview routed from the focused view to a sibling. */
export interface LiveCameraViewStateUpdate {
    sourceView: number;
    targetView: number;
    cameraViewData: CameraViewState;
}

/**
 * Owns camera/view state and the unified per-view `ViewVisualizationState` instances.
 */
@Injectable({providedIn: "root"})
export class MapViewService {
    private static readonly AUTO_LAYER_LEVEL_MAX_VISIBLE_TILES = 64;
    private static readonly SEARCH_COVERAGE_TILE_LIMIT = 1 << 20;

    readonly viewStateChanged = new Subject<ViewRecalculationReason | string>();
    /** Announces an accepted asynchronous navigation before its data/camera is ready. */
    readonly navigationStarted = new Subject<void>();
    readonly moveToWgs84PositionTopic = new Subject<{ targetView: number, x: number, y: number, z?: number }>();
    readonly moveToRectangleTopic = new Subject<{ targetView: number, rectangle: RenderRectangle }>();
    readonly moveToLocationAreaTopic = new Subject<{targetView: number; area: LocationArea}>();
    readonly clearLocationHighlightTopic = new Subject<number>();
    readonly locationBoundaryUnavailableTopic = new Subject<void>();
    readonly showLocationLabelTopic = new Subject<{ targetView: number, x: number, y: number, label: string }>();
    readonly liveCameraViewStateTopic = new Subject<LiveCameraViewStateUpdate>();
    /** Presentation-only camera poses; consumers update both rendering and tile coverage. */
    readonly presentationCameraViewStateTopic = new Subject<{
        targetView: number;
        cameraViewData: CameraViewState;
    }>();
    private readonly visualizationById = new Map<ViewId, ViewVisualizationState>();
    get viewVisualizationState(): ViewVisualizationState[] {
        return this.viewSettings.viewIds.map(id => this.visualizationById.get(id)!);
    }
    /** Retiring components synchronously capture cameras and dispose before reindexing. */
    readonly beforeViewRemoval = new Subject<{
        retainedIndices: readonly number[];
        cameras: Map<number, RenderViewCameraState>;
    }>();
    private removingView = false;
    private readonly retainedCameras = new Map<ViewId, RenderViewCameraState>();
    private readonly renderViews = new Map<ViewId, {view: IRenderView; generation: number}>();
    private nextRendererGeneration = 0;
    private layoutRevision = 0;

    get viewLayoutRevision(): number { return this.layoutRevision; }

    constructor(
        private readonly stateService: AppStateService,
        private readonly mapInfo: MapInfoService,
        public readonly renderPreferences: RenderPreferencesService,
        public readonly viewSettings: MapViewStateService,
        private readonly config: AppConfigService
    ) {
        let previousIds: readonly string[] = [];
        this.stateService.observe(() => this.viewSettings.viewIds).subscribe(ids => {
            if (ids !== previousIds) ++this.layoutRevision;
            previousIds = ids;
            for (const id of [...this.visualizationById.keys()]) {
                if (!ids.includes(id)) {
                    this.visualizationById.delete(id);
                    this.renderViews.delete(id);
                }
            }
            for (const id of ids) {
                if (!this.visualizationById.has(id)) this.visualizationById.set(id, new ViewVisualizationState());
            }
            if (this.removingView) return;
            this.mapInfo.reapplySyncOptionsForAllViews();
            this.requestViewRecalculation(ViewRecalculationReason.NumViews);
        });
        this.renderPreferences.lod3TileThresholdState.subscribe(() =>
            this.requestViewRecalculation(ViewRecalculationReason.LodThreshold));
        this.mapInfo.layerStateChanged.subscribe(reason => this.requestViewRecalculation(reason));
    }

    /** Registers a renderer reference, not a second camera-state store; teardown is generation-safe. */
    registerRenderView(view: IRenderView): () => void {
        this.viewSettings.indexOfView(view.viewId);
        const registration = {view, generation: ++this.nextRendererGeneration};
        this.renderViews.set(view.viewId, registration);
        this.viewStateChanged.next(ViewRecalculationReason.RenderViewReady);
        return () => {
            if (this.renderViews.get(view.viewId) === registration) this.renderViews.delete(view.viewId);
        };
    }

    /** Captures logical identity and one renderer lifetime for asynchronous operations. */
    captureView(view: number | ViewId): {viewId: ViewId; generation: number} | undefined {
        const id = typeof view === "number" ? this.viewSettings.viewIds[view] : view;
        const registration = id === undefined ? undefined : this.renderViews.get(id);
        return registration?.view.isAvailable() ? {viewId: id!, generation: registration.generation} : undefined;
    }

    /** Removed/restored IDs never validate a token from an earlier renderer generation. */
    resolveCapturedView(target: {viewId: ViewId; generation: number}): IRenderView | undefined {
        const registration = this.renderViews.get(target.viewId);
        return registration?.generation === target.generation && this.viewSettings.viewIds.includes(target.viewId)
            && registration.view.isAvailable() ? registration.view : undefined;
    }

    /** Resolves an index only at the presentation boundary. */
    renderViewFor(view: number | ViewId): IRenderView | undefined {
        const id = typeof view === "number" ? this.viewSettings.viewIds[view] : view;
        const renderer = id === undefined ? undefined : this.renderViews.get(id)?.view;
        return renderer?.isAvailable() && this.viewSettings.viewIds.includes(id!) ? renderer : undefined;
    }

    /** Waits for live renderers to publish their current camera footprints, including after projection changes. */
    async waitForCurrentViewports(signal: AbortSignal): Promise<void> {
        await firstValueFrom(merge(this.viewStateChanged, fromEvent(signal, "abort")).pipe(
            startWith(null),
            filter(() => {
                signal.throwIfAborted();
                for (let index = 0; index < this.viewSettings.numViews; index++) {
                    const viewport = this.renderViewFor(index)?.computeViewport();
                    const published = this.viewStateFor(index)?.viewport;
                    if (!viewport || !published || !([
                        "south", "west", "width", "height", "camPosLon", "camPosLat", "orientation"
                    ] as const).every(key => viewport[key] === published[key])) {
                        return false;
                    }
                }
                return true;
            })
        ));
    }

    /** Returns the mutable visualization state for one view, if it exists. */
    viewStateFor(viewIndex: number): ViewVisualizationState | undefined {
        return this.viewVisualizationState[viewIndex];
    }

    /** Removes either comparison view without applying synchronization to its survivor. */
    removeView(viewIndex: number): void {
        const count = this.viewSettings.numViews;
        if (this.removingView || count <= 1 || !Number.isInteger(viewIndex) || viewIndex < 0 || viewIndex >= count) {
            return;
        }
        const retainedIndices = Array.from({length: count}, (_, index) => index)
            .filter(index => index !== viewIndex);
        this.retainViews(retainedIndices);
    }

    /** Reorders or removes logical views, keeping renderer camera handoff explicit. */
    retainViews(retainedIndices: readonly number[]): void {
        const count = this.viewSettings.numViews;
        if (!retainedIndices.length || new Set(retainedIndices).size !== retainedIndices.length ||
            retainedIndices.some(index => !Number.isInteger(index) || index < 0 || index >= count)) {
            throw new Error("Invalid retained view order.");
        }
        this.removingView = true;
        try {
            // Include an unconsumed handoff if another close happens during setup.
            const cameras = new Map([...this.retainedCameras].map(([id, camera]) => [this.viewSettings.indexOfView(id), camera]));
            this.beforeViewRemoval.next({retainedIndices, cameras});
            this.retainedCameras.clear();
            retainedIndices.forEach((index, target) => {
                const camera = cameras.get(index);
                if (camera) {
                    this.retainedCameras.set(this.viewSettings.viewIdAt(index), camera);
                }
            });
            this.viewSettings.retainViews(retainedIndices,
                new Map([...cameras].map(([index, state]) => [index, state.camera])));
        } finally {
            this.removingView = false;
        }
        // All count subscribers, including the map tree, now see compacted values.
        this.requestViewRecalculation(ViewRecalculationReason.NumViews);
    }

    /** Consumes a camera handoff only after the replacement renderer is ready. */
    takeRetainedCamera(viewIndex: number): RenderViewCameraState | undefined {
        const id = this.viewSettings.viewIdAt(viewIndex);
        const camera = this.retainedCameras.get(id);
        this.retainedCameras.delete(id);
        return camera;
    }

    /**
     * Routes a transient camera pose to synchronized sibling renderers without
     * touching persisted AppState, storage, URL state, or Angular-bound consumers.
     */
    publishLiveCameraViewState(sourceView: number, sourceState: CameraViewState): void {
        if (this.viewSettings.numViews < 2 ||
            sourceView !== this.viewSettings.focusedView ||
            sourceView < 0 || sourceView >= this.viewSettings.numViews) {
            return;
        }

        const syncPosition = this.viewSettings.viewSync.includes(VIEW_SYNC_POSITION);
        const syncMovement = this.viewSettings.viewSync.includes(VIEW_SYNC_MOVEMENT);
        if (!syncPosition && !syncMovement) {
            return;
        }

        const persistedSource = this.viewSettings.cameraViewDataState.getValue(sourceView);
        const longitudeDelta = sourceState.destination.lon - persistedSource.destination.lon;
        const latitudeDelta = sourceState.destination.lat - persistedSource.destination.lat;

        for (let targetView = 0; targetView < this.viewSettings.numViews; targetView++) {
            if (targetView === sourceView) {
                continue;
            }
            const targetState = this.viewSettings.cameraViewDataState.getValue(targetView);
            const cameraViewData: CameraViewState = syncPosition
                ? {
                    destination: {...sourceState.destination},
                    orientation: {...sourceState.orientation},
                    position: [...(sourceState.position ?? [0, 0, 0])]
                }
                : {
                    destination: {
                        lon: targetState.destination.lon + longitudeDelta,
                        lat: targetState.destination.lat + latitudeDelta,
                        alt: targetState.destination.alt
                    },
                    orientation: {...targetState.orientation},
                    position: [...(targetState.position ?? [0, 0, 0])]
                };
            this.liveCameraViewStateTopic.next({sourceView, targetView, cameraViewData});
        }
    }

    /** Updates one view's viewport snapshot and schedules dependent stream/render refreshes. */
    setViewport(
        viewIndex: number,
        viewport: Viewport,
        canonicalCameraAltitudeMeters?: number,
        metersPerPixel?: number
    ) {
        const maxIndex = this.viewVisualizationState.length - 1;
        if (viewIndex > maxIndex) {
            console.warn(`Attempted to write @ viewIndex: ${viewIndex} but it is out of bounds (${maxIndex})`);
            return;
        }
        const state = this.viewVisualizationState[viewIndex];
        state.viewport = viewport;
        if (Number.isFinite(canonicalCameraAltitudeMeters)) {
            state.canonicalCameraAltitudeMeters =
                Number(canonicalCameraAltitudeMeters);
        }
        if (Number.isFinite(metersPerPixel)) {
            state.metersPerPixel = Number(metersPerPixel);
        }
        this.requestViewRecalculation(ViewRecalculationReason.Viewport);
    }

    /** Recomputes visible tiles before notifying stream/render consumers. */
    requestViewRecalculation(reason: ViewRecalculationReason | string) {
        if (this.removingView) {
            return;
        }
        this.recalculateVisibleTiles();
        this.viewStateChanged.next(reason);
    }

    /** Recomputes visible tile ids and render policy for every view. */
    private recalculateVisibleTiles(): void {
        const tileLimit = this.renderPreferences.tilesLoadLimit / this.viewSettings.numViews;
        this.viewVisualizationState.forEach((state, viewIndex) => {
            state.recalculateTileIds(
                tileLimit,
                this.visibleFeatureLevelsInView(viewIndex),
                state.canonicalCameraAltitudeMeters ??
                    this.viewSettings.cameraViewDataState
                        .getValue(viewIndex).destination.alt
            );
        });
    }

    /** Resolve one stylesheet's LOD from canonical viewport density at a tile level. */
    styleLod(
        viewIndex: number,
        level: number,
        style: FeatureLayerStyle
    ): number {
        const tileCount = this.styleVisibleTileCount(viewIndex, level);
        return clampStyleLod(style.lodForVisibleTileCount(
            tileCount,
            this.renderPreferences.lod3TileThreshold
        ));
    }

    /** Resolve the continuous GPU LOD used to fade retained style records. */
    stylePresentationLod(
        viewIndex: number,
        level: number,
        style: FeatureLayerStyle
    ): number {
        return clampPresentationLod(style.presentationLodForVisibleTileCount(
            this.styleVisibleTileCount(viewIndex, level),
            this.renderPreferences.lod3TileThreshold
        ));
    }

    /** Return the canonical density shared by planning and GPU presentation LOD. */
    private styleVisibleTileCount(viewIndex: number, level: number): number {
        const state = this.viewVisualizationState[viewIndex];
        const altitude = state?.canonicalCameraAltitudeMeters ??
            this.viewSettings.cameraViewDataState
                .getValue(viewIndex).destination.alt;
        return state?.canonicalVisibleTileCountPerLevel.get(level) ??
            Number(coreLib.getNumTileIdsForCanonicalCamera(altitude, level));
    }

    /** Returns whether search-result geometry should be rendered for one visible source tile. */
    prefersHighFidelityForSearchResultTile(viewIndex: number, searchId: string, tileId: number, maxVisibleTiles: number): boolean {
        return this.visibleSearchGridCellCountForLevel(viewIndex, tileId) <= maxVisibleTiles;
    }

    /** Counts actual visible grid cells at the tile's level for search-specific fidelity decisions. */
    visibleSearchGridCellCountForLevel(viewIndex: number, tileId: number): number {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState) {
            return Number.MAX_SAFE_INTEGER;
        }
        const level = Number(coreLib.getTileLevel(tileId));
        return tileGridVisibleCellCount(level, viewState.viewport, this.mapInfo.maps.getViewTileGridMode(viewIndex));
    }

    /** Returns viewport tile ids for one level, even when no currently visible map layer uses that level. */
    visibleTileIdsForLevel(viewIndex: number, level: number): number[] {
        return this.ensureVisibleTileIdsForLevel(viewIndex, level);
    }

    /** Returns full viewport tile ids for search coverage without applying the regular tile-load limit. */
    visibleSearchTileIdsForLevel(viewIndex: number, level: number): number[] {
        return this.ensureVisibleSearchTileIdsForLevel(viewIndex, level);
    }

    /** Chooses the automatic source level used by searches without an explicit level selection. */
    autoSearchTileLevel(viewIndex: number, mapId: string, layerId: string): number | null {
        return this.autoSelectedMapLayerLevel(viewIndex, mapId, layerId, null);
    }

    /** Returns viewport tile ids as a set for hot-path source-tile visibility checks. */
    visibleTileIdSetForLevel(viewIndex: number, level: number): Set<number> {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState || !Number.isFinite(level)) {
            return new Set<number>();
        }
        const normalizedLevel = Math.max(0, Math.floor(level));
        const cachedSet = viewState.visibleTileIdSetsPerLevel.get(normalizedLevel);
        if (cachedSet) {
            return cachedSet;
        }
        const visibleTileIds = this.ensureVisibleTileIdsForLevel(viewIndex, normalizedLevel);
        const visibleTileIdSet = new Set<number>(visibleTileIds);
        viewState.visibleTileIdSetsPerLevel.set(normalizedLevel, visibleTileIdSet);
        return visibleTileIdSet;
    }

    /**
     * Selects a low-fidelity search density level from the same visible grid-cell budget used by tile-grid overlays.
     *
     * Search dots are cheaper than full result geometry, so the caller may request a one-level finer aggregate than
     * the strict coarsened level while still capping the result at the source tile level.
     */
    searchResultDensityTargetLevel(
        viewIndex: number,
        sourceLevel: number,
        maxVisibleCells: number,
        preferOneLevelFiner = true
    ): number {
        if (!Number.isFinite(sourceLevel) || sourceLevel <= 0) {
            return 0;
        }
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState) {
            return Math.max(0, Math.floor(sourceLevel));
        }
        const normalizedLevel = Math.max(0, Math.floor(sourceLevel));
        const coarsenedLevel = coarsenedTileLevel(
            normalizedLevel,
            viewState.viewport,
            maxVisibleCells,
            this.mapInfo.maps.getViewTileGridMode(viewIndex)
        );
        return Math.min(normalizedLevel, coarsenedLevel + (preferOneLevelFiner ? 1 : 0));
    }

    /** Returns whether a feature tile id is currently inside one view's visible tile set and layer state. */
    showsFeatureTileInView(viewIndex: number, mapId: string, layerId: string, tileId: number): boolean {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState || !viewState.visibleTileIds.has(tileId)) {
            return false;
        }
        return this.mapInfo.maps.getMapLayerVisibility(viewIndex, mapId, layerId)
            && coreLib.getTileLevel(tileId) === this.getEffectiveMapLayerLevel(viewIndex, mapId, layerId);
    }

    /** Returns whether a search-result source tile is in view, without consulting Map Panel visibility. */
    showsFeatureSearchTileInView(viewIndex: number, _mapId: string, _layerId: string, tileId: number): boolean {
        const level = Number(coreLib.getTileLevel(tileId));
        return this.visibleSearchTileIdSetForLevel(viewIndex, level).has(tileId);
    }

    /** Materializes and caches viewport tile ids for one level when regular feature rendering did not need it yet. */
    private ensureVisibleTileIdsForLevel(viewIndex: number, level: number): number[] {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState || !Number.isFinite(level)) {
            return [];
        }
        const normalizedLevel = Math.max(0, Math.floor(level));
        const cached = viewState.visibleTileIdsPerLevel.get(normalizedLevel);
        if (cached) {
            return cached;
        }
        const tileLimit = this.renderPreferences.tilesLoadLimit / Math.max(1, this.viewSettings.numViews);
        const visibleTileIds = coreLib.getTileIds(viewState.viewport, normalizedLevel, tileLimit) as number[];
        viewState.visibleTileIdsPerLevel.set(normalizedLevel, visibleTileIds);
        viewState.visibleTileIdSetsPerLevel.set(normalizedLevel, new Set<number>(visibleTileIds));
        return visibleTileIds;
    }

    /** Returns full search coverage as a cached set for visibility checks on search-result tiles. */
    private visibleSearchTileIdSetForLevel(viewIndex: number, level: number): Set<number> {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState || !Number.isFinite(level)) {
            return new Set<number>();
        }
        const normalizedLevel = Math.max(0, Math.floor(level));
        const cachedSet = viewState.searchVisibleTileIdSetsPerLevel.get(normalizedLevel);
        if (cachedSet) {
            return cachedSet;
        }
        const visibleTileIds = this.ensureVisibleSearchTileIdsForLevel(viewIndex, normalizedLevel);
        const visibleTileIdSet = new Set<number>(visibleTileIds);
        viewState.searchVisibleTileIdSetsPerLevel.set(normalizedLevel, visibleTileIdSet);
        return visibleTileIdSet;
    }

    /** Materializes search coverage at the native ceiling instead of the user-facing tile-load limit. */
    private ensureVisibleSearchTileIdsForLevel(viewIndex: number, level: number): number[] {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState || !Number.isFinite(level)) {
            return [];
        }
        const normalizedLevel = Math.max(0, Math.floor(level));
        const cached = viewState.searchVisibleTileIdsPerLevel.get(normalizedLevel);
        if (cached) {
            return cached;
        }
        const visibleTileIds = coreLib.getTileIds(
            viewState.viewport,
            normalizedLevel,
            MapViewService.SEARCH_COVERAGE_TILE_LIMIT
        ) as number[];
        viewState.searchVisibleTileIdsPerLevel.set(normalizedLevel, visibleTileIds);
        viewState.searchVisibleTileIdSetsPerLevel.set(normalizedLevel, new Set<number>(visibleTileIds));
        return visibleTileIds;
    }

    /** Returns the set of feature levels that are currently visible in one view across all layers. */
    visibleFeatureLevelsInView(viewIndex: number): Set<number> {
        const levels = new Set<number>();
        for (const [mapId, mapInfo] of this.mapInfo.maps.maps.entries()) {
            for (const layerInfo of mapInfo.layers.values()) {
                if (layerInfo.type === "SourceData") {
                    continue;
                }
                if (!this.mapInfo.maps.getMapLayerVisibility(viewIndex, mapId, layerInfo.id)) {
                    continue;
                }
                levels.add(this.getEffectiveMapLayerLevel(viewIndex, mapId, layerInfo.id));
            }
        }
        return levels;
    }

    /** Persists map/layer visibility changes and requests the resulting viewport refresh. */
    setMapLayerVisibility(viewIndex: number, mapOrGroupId: string, layerId: string = "", state: boolean) {
        this.mapInfo.setMapLayerVisibility(viewIndex, mapOrGroupId, layerId, state);
        this.mapInfo.syncViewsIfEnabled(viewIndex);
        this.requestViewRecalculation(ViewRecalculationReason.Visibility);
    }

    /** Toggles the diagnostic tile-border overlay in one view. */
    toggleViewTileBorderVisibility(viewIndex: number) {
        this.mapInfo.toggleViewTileBorderVisibility(viewIndex);
        this.mapInfo.syncViewsIfEnabled(viewIndex);
        this.requestViewRecalculation(ViewRecalculationReason.TileBorder);
    }

    /** Sets diagnostic tile-border overlay visibility in one view. */
    setViewTileBorderVisibility(viewIndex: number, enabled: boolean) {
        this.mapInfo.setViewTileBorderVisibility(viewIndex, enabled);
        this.mapInfo.syncViewsIfEnabled(viewIndex);
        this.requestViewRecalculation(ViewRecalculationReason.TileBorder);
    }

    /** Sets the tile-grid coordinate mode and refreshes affected overlays. */
    setViewTileGridMode(viewIndex: number, mode: TileGridMode) {
        this.mapInfo.setViewTileGridMode(viewIndex, mode);
        this.mapInfo.syncViewsIfEnabled(viewIndex);
        this.requestViewRecalculation(ViewRecalculationReason.TileGrid);
    }

    /** Sets the independent tile-grid level and refreshes affected overlays. */
    setViewTileGridLevel(viewIndex: number, level: number): void {
        this.mapInfo.setViewTileGridLevel(viewIndex, level);
        this.mapInfo.syncViewsIfEnabled(viewIndex);
        this.requestViewRecalculation(ViewRecalculationReason.TileGrid);
    }

    /** Enables or disables viewport-based automatic tile-grid level selection. */
    setViewTileGridAutoLevel(viewIndex: number, autoLevel: boolean): void {
        if (autoLevel) {
            const configuredLevel =
                this.mapInfo.maps.getViewTileGridLevel(viewIndex);
            this.mapInfo.setViewTileGridLevel(
                viewIndex,
                this.autoSelectedTileGridLevel(viewIndex, configuredLevel)
            );
        }
        this.mapInfo.setViewTileGridAutoLevel(viewIndex, autoLevel);
        this.mapInfo.syncViewsIfEnabled(viewIndex);
        this.requestViewRecalculation(ViewRecalculationReason.TileGrid);
    }

    /** Returns whether the tile grid follows the viewport-based auto-level heuristic. */
    isViewTileGridAutoLevelEnabled(viewIndex: number): boolean {
        return this.mapInfo.isViewTileGridAutoLevelEnabled(viewIndex);
    }

    /** Returns the configured grid level or its viewport-derived value in auto mode. */
    getEffectiveViewTileGridLevel(viewIndex: number): number {
        const configuredLevel =
            this.mapInfo.maps.getViewTileGridLevel(viewIndex);
        if (!this.mapInfo.maps.getViewTileGridAutoLevel(viewIndex)) {
            return configuredLevel;
        }
        return this.autoSelectedTileGridLevel(viewIndex, configuredLevel);
    }

    /** Sets the tile-grid line colour and refreshes affected overlays. */
    setViewTileGridColor(viewIndex: number, color: string): void {
        this.mapInfo.setViewTileGridColor(viewIndex, color);
        this.mapInfo.syncViewsIfEnabled(viewIndex);
        this.requestViewRecalculation(ViewRecalculationReason.TileGrid);
    }

    /** Sets the tile-grid opacity percentage and refreshes affected overlays. */
    setViewTileGridOpacity(viewIndex: number, opacity: number): void {
        this.mapInfo.setViewTileGridOpacity(viewIndex, opacity);
        this.mapInfo.syncViewsIfEnabled(viewIndex);
        this.requestViewRecalculation(ViewRecalculationReason.TileGrid);
    }

    /** Persists an explicit layer level for one view and refreshes visible tiles. */
    setMapLayerLevel(viewIndex: number, mapId: string, layerId: string, level: number) {
        this.mapInfo.setMapLayerLevel(viewIndex, mapId, layerId, level);
        this.mapInfo.syncViewsIfEnabled(viewIndex);
        this.requestViewRecalculation(ViewRecalculationReason.LayerLevel);
    }

    /** Enables or disables auto-level, normalizing the stored level when auto mode is turned on. */
    setMapLayerAutoLevel(viewIndex: number, mapId: string, layerId: string, autoLevel: boolean) {
        if (autoLevel) {
            const configuredLevel = this.mapInfo.maps.getMapLayerLevel(viewIndex, mapId, layerId);
            const normalizedLevel = this.autoSelectedMapLayerLevel(viewIndex, mapId, layerId, configuredLevel);
            this.mapInfo.setMapLayerLevel(viewIndex, mapId, layerId, normalizedLevel);
        }
        this.mapInfo.setMapLayerAutoLevel(viewIndex, mapId, layerId, autoLevel);
        this.mapInfo.syncViewsIfEnabled(viewIndex);
        this.requestViewRecalculation(ViewRecalculationReason.AutoLevel);
    }

    /** Returns whether a map layer currently follows the auto-level heuristic in the given view. */
    isMapLayerAutoLevelEnabled(viewIndex: number, mapId: string, layerId: string): boolean {
        return this.mapInfo.isMapLayerAutoLevelEnabled(viewIndex, mapId, layerId);
    }

    /** Returns the currently active level, substituting the auto-selected level when needed. */
    getEffectiveMapLayerLevel(viewIndex: number, mapId: string, layerId: string): number {
        const configuredLevel = this.mapInfo.maps.getMapLayerLevel(viewIndex, mapId, layerId);
        if (!this.mapInfo.maps.getMapLayerAutoLevel(viewIndex, mapId, layerId)) {
            return configuredLevel;
        }
        return this.autoSelectedMapLayerLevel(viewIndex, mapId, layerId, configuredLevel);
    }

    /** Enables or disables one view as the source for cross-view option synchronization. */
    setSyncOptionsForView(viewIndex: number, enabled: boolean) {
        this.mapInfo.setSyncOptionsForView(viewIndex, enabled);
        if (enabled) {
            this.mapInfo.applySyncOptionsForView(viewIndex);
            this.requestViewRecalculation(ViewRecalculationReason.SyncOptions);
        }
    }

    /** Returns whether the given view currently drives option synchronization. */
    isSyncOptionsForViewEnabled(viewIndex: number): boolean {
        return this.mapInfo.isSyncOptionsForViewEnabled(viewIndex);
    }

    /** Public entry point that syncs background-layer settings only when layer sync is globally active. */
    syncBackgroundSettings(viewIndex: number) {
        if (!this.viewSettings.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return;
        }
        if (this.mapInfo.syncBackgroundSettingsFromView(viewIndex)) {
            this.requestViewRecalculation(ViewRecalculationReason.BackgroundSync);
        }
    }

    /** Chooses the automatic grid level solely from canonical camera altitude. */
    private autoSelectedTileGridLevel(
        viewIndex: number,
        fallbackLevel: number
    ): number {
        const canonicalAltitude =
            this.viewVisualizationState[viewIndex]?.canonicalCameraAltitudeMeters;
        if (!Number.isFinite(canonicalAltitude)) {
            return fallbackLevel;
        }
        return autoTileGridLevel(
            Number(canonicalAltitude),
            this.mapInfo.maps.getViewTileGridMode(viewIndex)
        );
    }

    /** Chooses the deepest advertised level whose canonical tile density stays below the threshold. */
    private autoSelectedMapLayerLevel(viewIndex: number, mapId: string, layerId: string, fallbackLevel: number): number;
    private autoSelectedMapLayerLevel(viewIndex: number, mapId: string, layerId: string, fallbackLevel: null): number | null;
    private autoSelectedMapLayerLevel(
        viewIndex: number,
        mapId: string,
        layerId: string,
        fallbackLevel: number | null
    ): number | null {
        const advertisedLevels = this.advertisedLayerLevels(mapId, layerId);
        if (!advertisedLevels.length) {
            return fallbackLevel;
        }
        const canonicalAltitude =
            this.viewVisualizationState[viewIndex]?.canonicalCameraAltitudeMeters;
        if (!Number.isFinite(canonicalAltitude)) {
            return fallbackLevel === null
                ? advertisedLevels[advertisedLevels.length - 1]
                : this.clampLayerLevelToAdvertised(fallbackLevel, advertisedLevels);
        }
        for (let index = advertisedLevels.length - 1; index >= 0; index--) {
            const candidateLevel = advertisedLevels[index];
            const visibleTileCount = coreLib.getNumTileIdsForCanonicalCamera(
                Number(canonicalAltitude),
                candidateLevel
            );
            if (visibleTileCount <= MapViewService.AUTO_LAYER_LEVEL_MAX_VISIBLE_TILES) {
                return candidateLevel;
            }
        }
        return advertisedLevels[0];
    }

    /** Returns the sorted unique zoom levels declared for a layer, clamped to sane bounds. */
    private advertisedLayerLevels(mapId: string, layerId: string): number[] {
        const mapItem = this.mapInfo.maps.maps.get(mapId);
        const layer = mapItem?.layers.get(layerId);
        if (!layer) {
            return [];
        }
        return [...new Set(
            layer.info.zoomLevels
                .filter(level => Number.isFinite(level))
                .map(level => Math.max(0, Math.min(22, Math.floor(level))))
        )].sort((lhs, rhs) => lhs - rhs);
    }

    /** Clamps an arbitrary level down to the nearest advertised level that does not exceed it. */
    private clampLayerLevelToAdvertised(level: number, advertisedLevels: number[]): number {
        let clampedLevel = advertisedLevels[0];
        for (const advertisedLevel of advertisedLevels) {
            if (advertisedLevel > level) {
                break;
            }
            clampedLevel = advertisedLevel;
        }
        return clampedLevel;
    }


    registerActions(actions: AppActionService): void {
        actions.registerAction(mapViewActions.manageView, input => this.manageView(input));
        actions.registerControl(mapViewControls.views, {read: () => this.viewSummary(), defaultTargets: () => [{}]});
        actions.registerControl(mapViewControls.camera, {
            read: ({viewId}) => this.readCamera(viewId), write: ({viewId}, value) => this.assignCamera(viewId, value),
            defaultTargets: () => this.viewSettings.viewIds.slice(0, 14).map(viewId => ({viewId}))
        });
        actions.registerControl(mapViewControls.projection, {
            read: ({viewId}) => this.viewSettings.mode2dState.getValue(this.requireViewIndex(viewId)) ? "2d" : "3d",
            write: ({viewId}, value) => this.assignProjection(viewId, value)
        });
        actions.registerControl(mapViewControls.background, {
            read: ({viewId}) => this.viewSettings.getBackgroundState(this.requireViewIndex(viewId)),
            write: ({viewId}, value) => {
                const index = this.requireViewIndex(viewId);
                if (value.layerId && !this.config.getBackgroundLayers().some(layer => layer.id === value.layerId)) rejectAction("Unknown background", "invalid_arguments");
                this.stateService.transaction(() => {
                    this.viewSettings.setBackgroundState(index, value.layerId, value.opacity);
                    this.syncBackgroundSettings(index);
                });
            }
        });
        actions.registerControl(mapViewControls.grid, {
            read: ({viewId}) => this.gridSettings(viewId), write: ({viewId}, value) => this.assignGrid(viewId, value)
        });
        actions.registerControl(mapControls.layer, {
            read: target => this.mapInfo.layerConfiguration(target),
            write: (target, value) => this.assignLayer(target, value)
        });
    }

    /** Resolve logical scope at the boundary; presentation indices stay internal. */
    requireViewIndex(viewId: string): number {
        const index = this.viewSettings.viewIds.indexOf(viewId);
        if (index < 0) rejectAction("The requested view is unavailable", "not_available", "view_unavailable");
        return index;
    }

    viewSummary(): ControlValue<typeof mapViewControls.views> {
        return {focusedViewId: this.viewSettings.focusedViewIdState.value, sync: [...this.viewSettings.viewSync],
            views: this.viewSettings.viewIds.map(viewId => {
                const renderer = this.renderViewFor(viewId);
                return {viewId, projection: this.viewSettings.mode2dState.getValue(viewId) ? "2d" : "3d",
                    navigationMode: !renderer ? "unavailable" : renderer.isFirstPersonViewActive() ? "first_person" : "map"};
            })};
    }

    manageView(input: ActionInput<typeof mapViewActions.manageView>): ActionOutput<typeof mapViewActions.manageView> {
        const index = this.requireViewIndex(input.viewId);
        if (input.operation === "remove") {
            if (this.viewSettings.numViews === 1) rejectAction("Cannot remove the last view", "invalid_arguments");
            this.removeView(index);
        } else {
            if (this.viewSettings.numViews >= 2) rejectAction("The comparison layout already has two views");
            this.stateService.transaction(() => {
                this.viewSettings.focusedView = index;
                this.viewSettings.numViews += 1;
            });
        }
        return applied();
    }

    readCamera(viewId: string): ControlValue<typeof mapViewControls.camera> {
        this.requireViewIndex(viewId);
        const renderer = this.renderViewFor(viewId);
        if (!renderer) rejectAction("The renderer is unavailable", "not_available", "view_unavailable");
        const camera = renderer.getLiveCameraState();
        if (!camera) rejectAction("Map camera is unavailable in first-person mode", "not_available", "first_person");
        return mapViewControls.camera.valueSchema.parse(camera);
    }

    /** Validate every synchronized renderer before focus or a durable camera can change. */
    assignCamera(viewId: string, value: ControlValue<typeof mapViewControls.camera>): void {
        const index = this.requireViewIndex(viewId);
        const synchronized = this.viewSettings.viewSync.includes(VIEW_SYNC_POSITION) || this.viewSettings.viewSync.includes(VIEW_SYNC_MOVEMENT);
        const affected = synchronized ? this.viewSettings.viewIds : [viewId];
        this.requireIdleMapCameras(affected);
        if (this.viewSettings.mode2dState.getValue(viewId) && (value.orientation.heading !== 0 ||
            value.orientation.pitch !== -Math.PI / 2 || value.position?.some(component => component !== 0))) {
            rejectAction("2D camera requires heading 0, top-down pitch and zero offset", "invalid_arguments");
        }
        this.stateService.transaction(() => {
            this.viewSettings.focusedView = index;
            this.viewSettings.setView(index, Cartographic.fromDegrees(value.destination.lon, value.destination.lat, value.destination.alt),
                value.orientation, value.position ?? [0, 0, 0]);
        });
    }

    requireIdleMapCameras(ids: readonly string[]): void {
        for (const id of ids) {
            const view = this.renderViewFor(id);
            if (!view) rejectAction("A target renderer is unavailable", "not_available", "view_unavailable");
            if (view.isFirstPersonViewActive()) rejectAction("Map navigation is unavailable in first-person mode", "not_available", "first_person");
            if (view.isCameraInteractionActive()) rejectAction("A human camera gesture is active", "busy");
        }
    }

    assignProjection(viewId: string, projection: "2d" | "3d"): void {
        const index = this.requireViewIndex(viewId);
        this.requireIdleMapCameras(this.viewSettings.viewSync.includes("proj") ? this.viewSettings.viewIds : [viewId]);
        this.stateService.transaction(() => {
            this.viewSettings.focusedView = index;
            this.viewSettings.setProjectionMode(index, projection === "2d");
        });
    }

    gridSettings(viewId: string): ControlValue<typeof mapViewControls.grid> {
        const index = this.requireViewIndex(viewId);
        return {visible: this.mapInfo.maps.getViewTileBorderState(index), mode: this.mapInfo.maps.getViewTileGridMode(index),
            level: this.mapInfo.maps.getViewTileGridLevel(index), autoLevel: this.mapInfo.maps.getViewTileGridAutoLevel(index),
            color: this.mapInfo.maps.getViewTileGridColor(index), opacity: this.mapInfo.maps.getViewTileGridOpacity(index)};
    }

    assignGrid(viewId: string, value: ControlValue<typeof mapViewControls.grid>): void {
        const index = this.requireViewIndex(viewId);
        if (value.level > tileGridMaxLevel(value.mode)) rejectAction("Grid level exceeds its coordinate system's range", "invalid_arguments");
        this.stateService.transaction(() => {
            this.setViewTileGridMode(index, value.mode);
            this.setViewTileGridLevel(index, value.level);
            this.setViewTileGridAutoLevel(index, value.autoLevel);
            this.setViewTileGridColor(index, value.color);
            this.setViewTileGridOpacity(index, value.opacity);
            this.setViewTileBorderVisibility(index, value.visible);
        });
    }

    assignLayer(target: ControlSelector<typeof mapControls.layer>, value: ControlValue<typeof mapControls.layer>): void {
        const index = this.requireViewIndex(target.viewId);
        this.mapInfo.layerConfiguration(target);
        this.stateService.transaction(() => {
            this.setMapLayerLevel(index, target.mapId, target.layerId, value.level);
            this.setMapLayerAutoLevel(index, target.mapId, target.layerId, value.autoLevel);
            this.setMapLayerVisibility(index, target.mapId, target.layerId, value.visible);
        });
    }


}
