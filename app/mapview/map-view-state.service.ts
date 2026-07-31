import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import {MapInfoService} from "../mapdata/map-info.service";
import {coreLib} from "../integrations/wasm";
import {AppStateService, TileGridMode, VIEW_SYNC_LAYERS} from "../shared/appstate.service";
import {RenderRectangle} from "./render-view.model";
import {ViewVisualizationState} from "./view.visualization.model";
import {Viewport} from "../../build/libs/core/erdblick-core";
import {coarsenedTileLevel, tileGridVisibleCellCount} from "./tile-grid-visibility";

export enum ViewRecalculationReason {
    AutoLevel = "auto-level",
    BackgroundSync = "background-sync",
    FidelityThreshold = "fidelity-threshold",
    HoverPopover = "hover-popover",
    LayerLevel = "layer-level",
    NumViews = "num-views",
    StyleChange = "style-change",
    SyncOptions = "sync-options",
    TileBorder = "tile-border",
    TileGrid = "tile-grid",
    TileLimit = "tile-limit",
    Viewport = "viewport",
    Visibility = "visibility"
}

/**
 * Owns camera/view state and the unified per-view `ViewVisualizationState` instances.
 */
@Injectable({providedIn: "root"})
export class MapViewStateService {
    private static readonly AUTO_LAYER_LEVEL_MAX_VISIBLE_TILES = 64;
    private static readonly SEARCH_COVERAGE_TILE_LIMIT = 1 << 20;

    readonly viewStateChanged = new Subject<ViewRecalculationReason | string>();
    readonly moveToWgs84PositionTopic = new Subject<{ targetView: number, x: number, y: number, z?: number }>();
    readonly moveToRectangleTopic = new Subject<{ targetView: number, rectangle: RenderRectangle }>();
    readonly showLocationLabelTopic = new Subject<{ targetView: number, x: number, y: number, label: string }>();
    readonly viewVisualizationState: ViewVisualizationState[] = [];

    constructor(
        private readonly stateService: AppStateService,
        private readonly mapInfo: MapInfoService
    ) {
        this.stateService.numViewsState.subscribe(numViews => {
            const diff = numViews - this.viewVisualizationState.length;

            if (diff > 0) {
                this.viewVisualizationState.push(
                    ...Array.from({ length: diff }, () => new ViewVisualizationState()));
            } else if (diff < 0) {
                this.viewVisualizationState.splice(numViews);
            }

            this.mapInfo.reapplySyncOptionsForAllViews();
            this.requestViewRecalculation(ViewRecalculationReason.NumViews);
        });
        this.stateService.lowFiTileThresholdState.subscribe(() =>
            this.requestViewRecalculation(ViewRecalculationReason.FidelityThreshold));
        this.mapInfo.layerStateChanged.subscribe(reason => this.requestViewRecalculation(reason));
    }

    /** Returns the mutable visualization state for one view, if it exists. */
    viewStateFor(viewIndex: number): ViewVisualizationState | undefined {
        return this.viewVisualizationState[viewIndex];
    }

    /** Updates one view's viewport snapshot and schedules dependent stream/render refreshes. */
    setViewport(
        viewIndex: number,
        viewport: Viewport,
        canonicalCameraAltitudeMeters?: number
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
        this.requestViewRecalculation(ViewRecalculationReason.Viewport);
    }

    /** Recomputes visible tiles before notifying stream/render consumers. */
    requestViewRecalculation(reason: ViewRecalculationReason | string) {
        this.recalculateVisibleTiles();
        this.viewStateChanged.next(reason);
    }

    /** Recomputes visible tile ids and render policy for every view. */
    private recalculateVisibleTiles(): void {
        const tileLimit = this.stateService.tilesLoadLimit / this.stateService.numViews;
        this.viewVisualizationState.forEach((state, viewIndex) => {
            state.recalculateTileIds(
                tileLimit,
                this.visibleFeatureLevelsInView(viewIndex),
                state.canonicalCameraAltitudeMeters ??
                    this.stateService.cameraViewDataState
                        .getValue(viewIndex).destination.alt,
                this.stateService.lowFiTileThreshold
            );
        });
    }

    /** Returns whether a view currently wants high-fidelity geometry for a tile id. */
    prefersHighFidelityForTile(viewIndex: number, tileId: number): boolean {
        return this.viewVisualizationState[viewIndex]?.getTileRenderPolicy(tileId).targetFidelity === "high";
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
        const tileLimit = this.stateService.tilesLoadLimit / Math.max(1, this.stateService.numViews);
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
            MapViewStateService.SEARCH_COVERAGE_TILE_LIMIT
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
        if (!this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return;
        }
        if (this.mapInfo.syncBackgroundSettingsFromView(viewIndex)) {
            this.requestViewRecalculation(ViewRecalculationReason.BackgroundSync);
        }
    }

    /** Chooses the deepest advertised level whose tile density stays below the auto-level threshold. */
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
        const viewport = this.viewVisualizationState[viewIndex]?.viewport;
        if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
            return fallbackLevel === null
                ? advertisedLevels[advertisedLevels.length - 1]
                : this.clampLayerLevelToAdvertised(fallbackLevel, advertisedLevels);
        }
        for (let index = advertisedLevels.length - 1; index >= 0; index--) {
            const candidateLevel = advertisedLevels[index];
            const visibleTileCount = coreLib.getNumTileIdsForBounds(
                viewport.south,
                viewport.west,
                viewport.width,
                viewport.height,
                candidateLevel
            );
            if (visibleTileCount <= MapViewStateService.AUTO_LAYER_LEVEL_MAX_VISIBLE_TILES) {
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
}
