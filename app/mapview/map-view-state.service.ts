import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import {MapInfoService} from "../mapdata/map-info.service";
import {coreLib} from "../integrations/wasm";
import {AppStateService, TileGridMode, VIEW_SYNC_LAYERS} from "../shared/appstate.service";
import {RenderRectangle} from "./render-view.model";
import {ViewVisualizationState} from "./view.visualization.model";
import {Viewport} from "../../build/libs/core/erdblick-core";
import {tileGridVisibleCellCount} from "./tile-grid-visibility";

export enum ViewRecalculationReason {
    AutoLevel = "auto-level",
    BackgroundSync = "background-sync",
    HoverPopover = "hover-popover",
    LayerLevel = "layer-level",
    NumViews = "num-views",
    PinLowFi = "pin-lowfi",
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

    readonly viewStateChanged = new Subject<ViewRecalculationReason | string>();
    readonly moveToWgs84PositionTopic = new Subject<{ targetView: number, x: number, y: number, z?: number }>();
    readonly moveToRectangleTopic = new Subject<{ targetView: number, rectangle: RenderRectangle }>();
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
        this.stateService.pinLowFiToMaxLodState.subscribe(() => this.requestViewRecalculation(ViewRecalculationReason.PinLowFi));
        this.mapInfo.layerStateChanged.subscribe(reason => this.requestViewRecalculation(reason));
    }

    /** Returns the mutable visualization state for one view, if it exists. */
    viewStateFor(viewIndex: number): ViewVisualizationState | undefined {
        return this.viewVisualizationState[viewIndex];
    }

    /** Updates one view's viewport snapshot and schedules dependent stream/render refreshes. */
    setViewport(viewIndex: number, viewport: Viewport) {
        const maxIndex = this.viewVisualizationState.length - 1;
        if (viewIndex > maxIndex) {
            console.warn(`Attempted to write @ viewIndex: ${viewIndex} but it is out of bounds (${maxIndex})`);
            return;
        }
        this.viewVisualizationState[viewIndex].viewport = viewport;
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
                this.stateService.cameraViewDataState.getValue(viewIndex).destination.alt,
                this.stateService.pinLowFiToMaxLod
            );
        });
    }

    /** Returns whether a view currently wants high-fidelity geometry for a tile id. */
    prefersHighFidelityForTile(viewIndex: number, tileId: bigint): boolean {
        return this.viewVisualizationState[viewIndex]?.getTileRenderPolicy(tileId).targetFidelity === "high";
    }

    /** Returns whether search-result geometry should be rendered for one visible source tile. */
    prefersHighFidelityForSearchResultTile(viewIndex: number, searchId: string, tileId: bigint, maxVisibleTiles: number): boolean {
        return this.visibleSearchGridCellCountForLevel(viewIndex, tileId) <= maxVisibleTiles;
    }

    /** Counts actual visible grid cells at the tile's level for search-specific fidelity decisions. */
    visibleSearchGridCellCountForLevel(viewIndex: number, tileId: bigint): number {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState) {
            return Number.MAX_SAFE_INTEGER;
        }
        const level = Number(coreLib.getTileLevel(tileId));
        return tileGridVisibleCellCount(level, viewState.viewport, this.mapInfo.maps.getViewTileGridMode(viewIndex));
    }

    /** Returns whether a feature tile id is currently inside one view's visible tile set and layer state. */
    showsFeatureTileInView(viewIndex: number, mapId: string, layerId: string, tileId: bigint): boolean {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState || !viewState.visibleTileIds.has(tileId)) {
            return false;
        }
        return this.mapInfo.maps.getMapLayerVisibility(viewIndex, mapId, layerId)
            && coreLib.getTileLevel(tileId) === this.getEffectiveMapLayerLevel(viewIndex, mapId, layerId);
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
    private autoSelectedMapLayerLevel(
        viewIndex: number,
        mapId: string,
        layerId: string,
        fallbackLevel: number
    ): number {
        const advertisedLevels = this.advertisedLayerLevels(mapId, layerId);
        if (!advertisedLevels.length) {
            return fallbackLevel;
        }
        const viewport = this.viewVisualizationState[viewIndex]?.viewport;
        if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
            return this.clampLayerLevelToAdvertised(fallbackLevel, advertisedLevels);
        }
        for (let index = advertisedLevels.length - 1; index >= 0; index--) {
            const candidateLevel = advertisedLevels[index];
            const visibleTileCount = coreLib.getNumTileIds(viewport, candidateLevel);
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
