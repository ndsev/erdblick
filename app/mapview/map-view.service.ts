import {Injectable, inject} from "@angular/core";
import {Subject, distinctUntilChanged, filter, firstValueFrom, fromEvent, map, merge, startWith} from "rxjs";
import {z} from "zod";
import type {FeatureLayerStyle, Viewport} from "../../build/libs/core/erdblick-core";
import {appliedAction, rejectAction} from "../actions/action-utils";
import {AppActionService} from "../actions/app-action.service";
import type {ViewerActionInput, ViewerActionOutput} from "../actions/viewer-action.contract";
import {Cartographic} from "../integrations/geo";
import {coreLib} from "../integrations/wasm";
import {MapInfoService} from "../mapdata/map-info.service";
import {TileGridMode, tileGridMaxLevel} from "../mapdata/map-layer-state.model";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {AppConfigService} from "../shared/app-config.service";
import {AppStateService} from "../shared/appstate.service";
import {clampPresentationLod, clampStyleLod} from "../shared/lod-policy";
import {CameraViewState, VIEW_SYNC_LAYERS, VIEW_SYNC_MOVEMENT, VIEW_SYNC_POSITION} from "./map-view-state.model";
import {MapViewStateService} from "./map-view-state.service";
import {mapViewActions, mapViewControls} from "./map-view.service.declarations";
import {IRenderView, LocationArea, RenderRectangle, RenderViewCameraState} from "./render-view.model";
import {autoTileGridLevel, coarsenedTileLevel, tileGridVisibleCellCount} from "./tile-grid-visibility";
import type {ViewId} from "./view-id";
import {ViewVisualizationState} from "./view.visualization.model";

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
    private readonly persistence = inject(AppStateService);
    private readonly config = inject(AppConfigService);
    private readonly stream = inject(MapTileStreamService);

    static readonly controls = mapViewControls;
    static readonly actions = mapViewActions;

    private static readonly AUTO_LAYER_LEVEL_MAX_VISIBLE_TILES = 64;
    private static readonly SEARCH_COVERAGE_TILE_LIMIT = 1 << 20;

    readonly viewStateChanged = new Subject<ViewRecalculationReason | string>();
    /** Announces an accepted asynchronous navigation before its data/camera is ready. */
    readonly navigationStarted = new Subject<void>();
    readonly moveToWgs84PositionTopic = new Subject<{targetView: number; x: number; y: number; z?: number}>();
    readonly moveToRectangleTopic = new Subject<{targetView: number; rectangle: RenderRectangle}>();
    readonly moveToLocationAreaTopic = new Subject<{targetView: number; area: LocationArea}>();
    readonly clearLocationHighlightTopic = new Subject<number>();
    readonly locationBoundaryUnavailableTopic = new Subject<void>();
    readonly showLocationLabelTopic = new Subject<{targetView: number; x: number; y: number; label: string}>();
    readonly liveCameraViewStateTopic = new Subject<LiveCameraViewStateUpdate>();
    /** Presentation-only camera poses; consumers update both rendering and tile coverage. */
    readonly presentationCameraViewStateTopic = new Subject<{
        targetView: number;
        cameraViewData: CameraViewState;
    }>();
    private readonly visualizationByView = new Map<ViewId, {generation: number; state: ViewVisualizationState}>();
    get viewVisualizationState(): ViewVisualizationState[] {
        return this.viewStateOwner.viewIds().map((id) => this.visualizationByView.get(id)!.state);
    }
    /** Retiring components synchronously capture cameras and dispose before reindexing. */
    readonly beforeViewRemoval = new Subject<{
        retainedIndices: readonly number[];
        cameras: Map<number, RenderViewCameraState>;
    }>();
    private removingView = false;
    private readonly retainedCameras = new Map<ViewId, RenderViewCameraState>();
    private readonly renderViews = new Map<ViewId, IRenderView>();
    private layoutRevision = 0;

    get viewLayoutRevision(): number {
        return this.layoutRevision;
    }

    constructor(
        readonly viewStateOwner: MapViewStateService,
        private readonly mapInfo: MapInfoService
    ) {
        this.registerControls();

        const actions = inject(AppActionService);
        actions.registerAction(MapViewService.actions.viewer_manage_view, (input, context) => this.manageView(input));

        let previousOrder = this.viewStateOwner.viewIds();
        this.viewStateOwner.viewIdsState.subscribe((ids) => {
            if (ids !== previousOrder) {
                ++this.layoutRevision;
                previousOrder = ids;
            }
            for (const id of [...this.visualizationByView.keys()]) {
                if (!ids.includes(id)) this.visualizationByView.delete(id);
            }
            for (const target of this.viewStateOwner.identities()) {
                if (this.visualizationByView.get(target.id)?.generation !== target.generation) {
                    this.visualizationByView.set(target.id, {
                        generation: target.generation,
                        state: new ViewVisualizationState()
                    });
                }
            }
        });

        // A catalog replacement installs a newer MapLayerTree after this service.
        // Wait for every slot consumer to refresh its positional caches before
        // synchronization and coverage read those caches for the new view order.
        this.persistence.afterStatePublication.pipe(
            startWith(undefined),
            map(() => this.viewStateOwner.viewIds()),
            distinctUntilChanged()
        ).subscribe(() => {
            if (!this.removingView) {
                this.mapInfo.reapplySyncOptionsForAllViews();
                this.requestViewRecalculation(ViewRecalculationReason.NumViews);
            }
        });
        this.viewStateOwner.lod3TileThresholdState.subscribe(() =>
            this.requestViewRecalculation(ViewRecalculationReason.LodThreshold)
        );
        this.mapInfo.layerStateChanged.subscribe((reason) => this.requestViewRecalculation(reason));
    }

    /** Registers a renderer reference, not a second camera-state store; teardown is generation-safe. */
    registerRenderView(view: IRenderView): () => void {
        if (!this.viewStateOwner.isCurrent(view.identity)) throw new Error("Renderer view lifetime is stale");
        this.renderViews.set(view.identity.id, view);
        this.viewStateChanged.next(ViewRecalculationReason.RenderViewReady);
        return () => {
            if (this.renderViews.get(view.identity.id) === view) {
                this.renderViews.delete(view.identity.id);
            }
        };
    }

    /** Looks up a live renderer without touching the view's scene or tile collections. */
    renderViewFor(viewIndex: number): IRenderView | undefined {
        if (viewIndex < 0 || viewIndex >= this.viewStateOwner.numViews) return undefined;
        const id = this.viewStateOwner.idAt(viewIndex);
        const view = id ? this.renderViews.get(id) : undefined;
        return view && this.viewStateOwner.isCurrent(view.identity) && view.isAvailable() ? view : undefined;
    }

    /** Waits for live renderers to publish their current camera footprints, including after projection changes. */
    async waitForCurrentViewports(signal: AbortSignal): Promise<void> {
        await firstValueFrom(
            merge(this.viewStateChanged, fromEvent(signal, "abort")).pipe(
                startWith(null),
                filter(() => {
                    signal.throwIfAborted();
                    for (let index = 0; index < this.viewStateOwner.numViews; index++) {
                        const viewport = this.renderViewFor(index)?.computeViewport();
                        const published = this.viewStateFor(index)?.viewport;
                        if (
                            !viewport ||
                            !published ||
                            !(
                                ["south", "west", "width", "height", "camPosLon", "camPosLat", "orientation"] as const
                            ).every((key) => viewport[key] === published[key])
                        ) {
                            return false;
                        }
                    }
                    return true;
                })
            )
        );
    }

    /** Returns the mutable visualization state for one view, if it exists. */
    viewStateFor(viewIndex: number): ViewVisualizationState | undefined {
        const id = this.viewStateOwner.idAt(viewIndex);
        return id ? this.visualizationByView.get(id)?.state : undefined;
    }

    /** Removes either comparison view without applying synchronization to its survivor. */
    removeView(viewIndex: number): void {
        const count = this.viewStateOwner.numViews;
        if (this.removingView || count <= 1 || !Number.isInteger(viewIndex) || viewIndex < 0 || viewIndex >= count) {
            return;
        }
        const retainedIndices = Array.from({length: count}, (_, index) => index).filter((index) => index !== viewIndex);
        this.removingView = true;
        try {
            // Include an unconsumed handoff if another close happens during setup.
            const cameras = new Map(
                [...this.retainedCameras].map(([id, camera]) => [this.viewStateOwner.indexOf(id), camera])
            );
            this.beforeViewRemoval.next({retainedIndices, cameras});
            this.retainedCameras.clear();
            retainedIndices.forEach((index, target) => {
                const camera = cameras.get(index);
                if (camera) {
                    this.retainedCameras.set(this.viewStateOwner.idAt(index)!, camera);
                }
            });
            this.viewStateOwner.retainViews(
                retainedIndices,
                new Map([...cameras].map(([index, state]) => [index, state.camera]))
            );
        } finally {
            this.removingView = false;
        }
        // All count subscribers, including the map tree, now see compacted values.
        this.requestViewRecalculation(ViewRecalculationReason.NumViews);
    }

    /** Consumes a camera handoff only after the replacement renderer is ready. */
    takeRetainedCamera(viewIndex: number): RenderViewCameraState | undefined {
        const id = this.viewStateOwner.idAt(viewIndex);
        if (!id) return undefined;
        const camera = this.retainedCameras.get(id);
        this.retainedCameras.delete(id);
        return camera;
    }

    /**
     * Routes a transient camera pose to synchronized sibling renderers without
     * touching persisted AppState, storage, URL state, or Angular-bound consumers.
     */
    publishLiveCameraViewState(sourceView: number, sourceState: CameraViewState): void {
        if (
            this.viewStateOwner.numViews < 2 ||
            sourceView !== this.viewStateOwner.focusedView ||
            sourceView < 0 ||
            sourceView >= this.viewStateOwner.numViews
        ) {
            return;
        }

        const syncPosition = this.viewStateOwner.viewSync.includes(VIEW_SYNC_POSITION);
        const syncMovement = this.viewStateOwner.viewSync.includes(VIEW_SYNC_MOVEMENT);
        if (!syncPosition && !syncMovement) {
            return;
        }

        const persistedSource = this.viewStateOwner.cameraViewDataState.getValue(sourceView);
        const longitudeDelta = sourceState.destination.lon - persistedSource.destination.lon;
        const latitudeDelta = sourceState.destination.lat - persistedSource.destination.lat;

        for (let targetView = 0; targetView < this.viewStateOwner.numViews; targetView++) {
            if (targetView === sourceView) {
                continue;
            }
            const targetState = this.viewStateOwner.cameraViewDataState.getValue(targetView);
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
            state.canonicalCameraAltitudeMeters = Number(canonicalCameraAltitudeMeters);
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
        const tileLimit = this.viewStateOwner.tilesLoadLimit / this.viewStateOwner.numViews;
        this.viewVisualizationState.forEach((state, viewIndex) => {
            state.recalculateTileIds(
                tileLimit,
                this.visibleFeatureLevelsInView(viewIndex),
                state.canonicalCameraAltitudeMeters ??
                    this.viewStateOwner.cameraViewDataState.getValue(viewIndex).destination.alt
            );
        });
    }

    /** Resolve one stylesheet's LOD from canonical viewport density at a tile level. */
    styleLod(viewIndex: number, level: number, style: FeatureLayerStyle): number {
        const tileCount = this.styleVisibleTileCount(viewIndex, level);
        return clampStyleLod(style.lodForVisibleTileCount(tileCount, this.viewStateOwner.lod3TileThreshold));
    }

    /** Resolve the continuous GPU LOD used to fade retained style records. */
    stylePresentationLod(viewIndex: number, level: number, style: FeatureLayerStyle): number {
        return clampPresentationLod(
            style.presentationLodForVisibleTileCount(
                this.styleVisibleTileCount(viewIndex, level),
                this.viewStateOwner.lod3TileThreshold
            )
        );
    }

    /** Return the canonical density shared by planning and GPU presentation LOD. */
    private styleVisibleTileCount(viewIndex: number, level: number): number {
        const state = this.viewVisualizationState[viewIndex];
        const altitude =
            state?.canonicalCameraAltitudeMeters ??
            this.viewStateOwner.cameraViewDataState.getValue(viewIndex).destination.alt;
        return (
            state?.canonicalVisibleTileCountPerLevel.get(level) ??
            Number(coreLib.getNumTileIdsForCanonicalCamera(altitude, level))
        );
    }

    /** Returns whether search-result geometry should be rendered for one visible source tile. */
    prefersHighFidelityForSearchResultTile(
        viewIndex: number,
        searchId: string,
        tileId: number,
        maxVisibleTiles: number
    ): boolean {
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
        return (
            this.mapInfo.maps.getMapLayerVisibility(viewIndex, mapId, layerId) &&
            coreLib.getTileLevel(tileId) === this.getEffectiveMapLayerLevel(viewIndex, mapId, layerId)
        );
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
        const tileLimit = this.viewStateOwner.tilesLoadLimit / Math.max(1, this.viewStateOwner.numViews);
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
            const configuredLevel = this.mapInfo.maps.getViewTileGridLevel(viewIndex);
            this.mapInfo.setViewTileGridLevel(viewIndex, this.autoSelectedTileGridLevel(viewIndex, configuredLevel));
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
        const configuredLevel = this.mapInfo.maps.getViewTileGridLevel(viewIndex);
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
        if (!this.viewStateOwner.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return;
        }
        if (this.mapInfo.syncBackgroundSettingsFromView(viewIndex)) {
            this.requestViewRecalculation(ViewRecalculationReason.BackgroundSync);
        }
    }

    /** Chooses the automatic grid level solely from canonical camera altitude. */
    private autoSelectedTileGridLevel(viewIndex: number, fallbackLevel: number): number {
        const canonicalAltitude = this.viewVisualizationState[viewIndex]?.canonicalCameraAltitudeMeters;
        if (!Number.isFinite(canonicalAltitude)) {
            return fallbackLevel;
        }
        return autoTileGridLevel(Number(canonicalAltitude), this.mapInfo.maps.getViewTileGridMode(viewIndex));
    }

    /** Chooses the deepest advertised level whose canonical tile density stays below the threshold. */
    private autoSelectedMapLayerLevel(viewIndex: number, mapId: string, layerId: string, fallbackLevel: number): number;
    private autoSelectedMapLayerLevel(
        viewIndex: number,
        mapId: string,
        layerId: string,
        fallbackLevel: null
    ): number | null;
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
        const canonicalAltitude = this.viewVisualizationState[viewIndex]?.canonicalCameraAltitudeMeters;
        if (!Number.isFinite(canonicalAltitude)) {
            return fallbackLevel === null
                ? advertisedLevels[advertisedLevels.length - 1]
                : this.clampLayerLevelToAdvertised(fallbackLevel, advertisedLevels);
        }
        for (let index = advertisedLevels.length - 1; index >= 0; index--) {
            const candidateLevel = advertisedLevels[index];
            const visibleTileCount = coreLib.getNumTileIdsForCanonicalCamera(Number(canonicalAltitude), candidateLevel);
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
        return [
            ...new Set(
                layer.info.zoomLevels
                    .filter((level) => Number.isFinite(level))
                    .map((level) => Math.max(0, Math.min(22, Math.floor(level))))
            )
        ].sort((lhs, rhs) => lhs - rhs);
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

    /** Creates/removes comparison views using the same retained-camera/layout path as the UI. */
    manageView(input: ViewerActionInput<"viewer_manage_view">): ViewerActionOutput<"viewer_manage_view"> {
        const viewIndex = this.controlViewIndex(input.viewId);
        if (input.operation === "remove") {
            if (this.viewStateOwner.numViews === 1) rejectAction("Cannot remove the last view", "invalid_arguments");
            this.removeView(viewIndex);
        } else {
            if (this.viewStateOwner.numViews >= 32) rejectAction("The layout already has 32 views");
            this.viewStateOwner.createView(input.viewId);
        }
        return appliedAction();
    }

    private registerControls(): void {
        const actions = inject(AppActionService),
            controls = MapViewService.controls;
        actions.registerControl(controls.views, {read: () => this.viewSummary(), overview: () => [{}]});
        actions.registerControl(controls.camera, {
            read: ({viewId}) => MapViewService.controls.camera.valueSchema.parse(this.cameraControl(viewId)),
            write: ({viewId}, value) => this.setCameraControl(viewId, value),
            overview: () => this.viewStateOwner.viewIds().map((viewId) => ({viewId}))
        });
        actions.registerControl(controls.projection, {
            read: ({viewId}) => (this.viewStateOwner.mode2dState.getValue(this.controlViewIndex(viewId)) ? "2d" : "3d"),
            write: ({viewId}, value) => this.setProjectionControl(viewId, value)
        });
        actions.registerControl(controls.background, {
            read: ({viewId}) => this.mapInfo.layerState.getBackgroundState(this.controlViewIndex(viewId)),
            write: ({viewId}, value) => this.setBackgroundControl(viewId, value)
        });
        actions.registerControl(controls.grid, {
            read: ({viewId}) => this.gridControl(viewId),
            write: ({viewId}, value) => this.setGridControl(viewId, value)
        });
        actions.registerControl(controls.layer, {
            read: (selector) => ({
                ...this.mapInfo.requireLayer(selector.mapId, selector.layerId).viewConfig[
                    this.controlViewIndex(selector.viewId)
                ]
            }),
            write: (selector, value) => this.setLayerControl(selector, value)
        });
        actions.registerControl(controls.rendering, {
            read: () => this.renderingPreferences(),
            write: (_, value) => this.setRenderingPreferences(value)
        });
    }

    private controlViewIndex(viewId: string): number {
        return this.viewStateOwner.indexOf(this.viewStateOwner.requireView(viewId).id);
    }

    viewSummary() {
        return {
            focusedViewId: this.viewStateOwner.focusedViewId(),
            sync: [...this.viewStateOwner.viewSync],
            views: this.viewStateOwner.viewIds().map((viewId, index) => {
                const view = this.renderViewFor(index);
                return {
                    viewId,
                    projection: this.viewStateOwner.mode2dState.getValue(index) ? ("2d" as const) : ("3d" as const),
                    navigationMode: !view
                        ? ("unavailable" as const)
                        : view.isFirstPersonViewActive()
                          ? ("first_person" as const)
                          : ("map" as const)
                };
            })
        };
    }

    cameraControl(viewId: string) {
        const view = this.renderViewFor(this.controlViewIndex(viewId));
        if (!view) rejectAction("The renderer is unavailable", "not_available", "view_unavailable");
        const value = view.getLiveCameraState();
        if (!value) rejectAction("The view is in first-person mode", "not_available", "first_person");
        return value;
    }

    private requireIdleCameras(indices: number[]): void {
        for (const index of indices) {
            const view = this.renderViewFor(index);
            if (!view || view.isFirstPersonViewActive())
                rejectAction("Map camera is unavailable", "not_available", "first_person");
            if (view.isCameraInteractionActive()) rejectAction("A human camera gesture is active", "busy");
        }
    }

    setCameraControl(viewId: string, value: z.infer<typeof MapViewService.controls.camera.valueSchema>): void {
        const index = this.controlViewIndex(viewId);
        const synced =
            this.viewStateOwner.viewSync.includes(VIEW_SYNC_POSITION) ||
            this.viewStateOwner.viewSync.includes(VIEW_SYNC_MOVEMENT);
        this.requireIdleCameras(synced ? this.viewStateOwner.viewIds().map((_, i) => i) : [index]);
        if (
            this.viewStateOwner.mode2dState.getValue(index) &&
            (value.orientation.heading !== 0 ||
                value.orientation.pitch !== -Math.PI / 2 ||
                value.position?.some((component) => component !== 0))
        ) {
            rejectAction("2D camera requires heading 0, top-down pitch and zero offset", "invalid_arguments");
        }
        this.persistence.transaction(() => {
            this.viewStateOwner.focusedView = index;
            this.viewStateOwner.setView(
                index,
                Cartographic.fromDegrees(value.destination.lon, value.destination.lat, value.destination.alt),
                value.orientation,
                value.position ?? [0, 0, 0]
            );
        });
    }

    setProjectionControl(viewId: string, value: "2d" | "3d"): void {
        const index = this.controlViewIndex(viewId);
        this.requireIdleCameras(
            this.viewStateOwner.viewSync.includes("proj") ? this.viewStateOwner.viewIds().map((_, i) => i) : [index]
        );
        this.persistence.transaction(() => {
            this.viewStateOwner.focusedView = index;
            this.viewStateOwner.setProjectionMode(index, value === "2d");
        });
    }

    setBackgroundControl(viewId: string, value: z.infer<typeof MapViewService.controls.background.valueSchema>): void {
        const index = this.controlViewIndex(viewId);
        if (value.layerId && !this.config.getBackgroundLayers().some((layer) => layer.id === value.layerId))
            rejectAction("Unknown background", "invalid_arguments");
        this.persistence.transaction(() => {
            this.mapInfo.layerState.setBackgroundState(index, value.layerId, value.opacity);
            this.syncBackgroundSettings(index);
        });
    }

    gridControl(viewId: string) {
        const index = this.controlViewIndex(viewId),
            maps = this.mapInfo.maps;
        return {
            visible: maps.getViewTileBorderState(index),
            mode: maps.getViewTileGridMode(index),
            level: maps.getViewTileGridLevel(index),
            autoLevel: maps.getViewTileGridAutoLevel(index),
            color: maps.getViewTileGridColor(index),
            opacity: maps.getViewTileGridOpacity(index)
        };
    }

    setGridControl(viewId: string, value: z.infer<typeof MapViewService.controls.grid.valueSchema>): void {
        const index = this.controlViewIndex(viewId);
        if (value.level > tileGridMaxLevel(value.mode))
            rejectAction("Grid level exceeds its coordinate system's range", "invalid_arguments");
        this.persistence.transaction(() => {
            this.setViewTileGridMode(index, value.mode);
            this.setViewTileGridLevel(index, value.level);
            this.setViewTileGridAutoLevel(index, value.autoLevel);
            this.setViewTileGridColor(index, value.color);
            this.setViewTileGridOpacity(index, value.opacity);
            this.setViewTileBorderVisibility(index, value.visible);
        });
    }

    setLayerControl(
        selector: z.infer<typeof MapViewService.controls.layer.selectorSchema>,
        value: z.infer<typeof MapViewService.controls.layer.valueSchema>
    ): void {
        const index = this.controlViewIndex(selector.viewId);
        this.mapInfo.requireLayer(selector.mapId, selector.layerId);
        this.persistence.transaction(() => {
            this.setMapLayerLevel(index, selector.mapId, selector.layerId, value.level);
            this.setMapLayerAutoLevel(index, selector.mapId, selector.layerId, value.autoLevel);
            this.setMapLayerVisibility(index, selector.mapId, selector.layerId, value.visible);
        });
    }

    renderingPreferences() {
        return {
            antialiasing: this.viewStateOwner.deckAntialiasingEnabled,
            semanticCompositing: this.viewStateOwner.semanticCompositingEnabled,
            contactShading: this.viewStateOwner.contactShadingEnabled,
            tilePullCompression: this.stream.tilePullCompressionEnabled,
            tileLimit: this.viewStateOwner.tilesLoadLimit,
            renderWorkers: this.viewStateOwner.tileSubsetRenderWorkerCount
        };
    }

    setRenderingPreferences(value: z.infer<typeof MapViewService.controls.rendering.valueSchema>): void {
        this.persistence.transaction(() => {
            this.viewStateOwner.deckAntialiasingEnabled = value.antialiasing;
            this.viewStateOwner.semanticCompositingEnabled = value.semanticCompositing;
            this.viewStateOwner.contactShadingEnabled = value.contactShading;
            this.stream.tilePullCompressionEnabled = value.tilePullCompression;
            this.viewStateOwner.tilesLoadLimit = value.tileLimit;
            this.viewStateOwner.tileSubsetRenderWorkerCount = value.renderWorkers;
        });
    }
}
