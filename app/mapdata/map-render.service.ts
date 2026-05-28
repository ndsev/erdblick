import {Injectable, NgZone} from "@angular/core";
import {Subject} from "rxjs";
import {MapInfoService} from "./map-info.service";
import {MapTileStreamService} from "./map-tile-stream.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import {DeckTileVisualization} from "../mapview/deck/deck-tile.visualization.model";
import {DeckTileSearchVisualization} from "../mapview/deck/deck-tile-search.visualization.model";
import {
    configureDeckRenderWorkerSettings,
    getDeckRenderWorkerConcurrency,
    isDeckRenderWorkerPipelineEnabled
} from "../mapview/deck/deck-render.worker.pool";
import {FeatureTile, FeatureWrapper} from "./features.model";
import {RelationLocateRequest, RelationLocateResolution, RelationLocateResult} from "./relation-locate.model";
import {SearchResultTile} from "./search-result-tile.model";
import {coreLib} from "../integrations/wasm";
import {AppStateService} from "../shared/appstate.service";
import {StyleService, ErdblickStyle} from "../styledata/style.service";
import {StyleValidationIssue, StyleSourceRef} from "../styledata/style-validation.model";
import {StyleValidationReportService} from "../styledata/style-validation-report.service";
import {PointMergeService, MergedPointsTile} from "../mapview/pointmerge.service";
import {ViewVisualizationState} from "../mapview/view.visualization.model";
import {
    IRenderSceneHandle,
    ITileVisualization,
    type TileVisualizationTile
} from "../mapview/render-view.model";
import type {FeatureLayerStyle, HighlightMode} from "../../build/libs/core/erdblick-core";
import type {FeatureSearchDataPlaneRequest} from "./map-runtime.model";

export interface TileVisualizationRenderTask {
    visualization: ITileVisualization;
    onDone?: () => void;
}

interface SearchResultStyleSpec {
    fallbackColor: string;
    fallbackWidth: number;
    fallbackPointRadius: number;
    rules: FeatureSearchDataPlaneRequest["searchStyleRules"];
}

type FeatureLayerStyleWithFidelity = FeatureLayerStyle & {
    hasExplicitLowFidelityRules(): boolean;
};

/**
 * Owns render work scheduling, visualization lifecycle, style invalidation, and highlights.
 */
@Injectable({providedIn: "root"})
export class MapRenderService {
    private static readonly SEARCH_RESULT_STYLE_PREFIX = "__search_result__:";

    readonly tileVisualizationTopic = new Subject<TileVisualizationRenderTask>();
    readonly tileVisualizationDestructionTopic = new Subject<ITileVisualization>();
    readonly mergedTileVisualizationDestructionTopic = new Subject<MergedPointsTile>();

    private selectionVisualizations: ITileVisualization[] = [];
    private hoverVisualizations: ITileVisualization[] = [];
    private selectionHighlightSignature = "";
    private hoverHighlightSignature = "";
    private nextVisualizationViewIndex = 0;
    private inFlightVisualizationRendersByView: number[] = [];
    private inFlightBlockedTileIdsByView: Array<Map<bigint, number>> = [];
    private frameTimeMsEwma = 0;
    private lastAnimationFrameTimestampMs: number | null = null;
    private frameTimeSamplingStarted = false;
    private readonly frameTimeEwmaAlpha = 0.2;

    constructor(
        private readonly stateService: AppStateService,
        private readonly styleService: StyleService,
        private readonly mapInfo: MapInfoService,
        private readonly viewState: MapViewStateService,
        private readonly tileStream: MapTileStreamService,
        private readonly inspection: InspectionSelectionService,
        private readonly pointMergeService: PointMergeService,
        private readonly styleValidationReportService: StyleValidationReportService,
        private readonly ngZone: NgZone
    ) {
        const applyDeckWorkerSettings = () => {
            configureDeckRenderWorkerSettings({
                threadedRenderingEnabled: this.stateService.deckThreadedRenderingEnabled,
                workerCountOverride: this.stateService.deckStyleWorkersOverride
                    ? this.stateService.deckStyleWorkersCount
                    : null
            });
        };
        applyDeckWorkerSettings();
        this.stateService.deckThreadedRenderingEnabledState.subscribe(applyDeckWorkerSettings);
        this.stateService.deckStyleWorkersOverrideState.subscribe(applyDeckWorkerSettings);
        this.stateService.deckStyleWorkersCountState.subscribe(applyDeckWorkerSettings);
    }

    /** Starts subscriptions and the long-lived visualization pump. */
    initialize(): void {
        this.startFrameTimeSampling();
        this.processVisualizationTasks();

        this.styleService.styleRemovedForId.subscribe(styleId => {
            this.viewStates().forEach(state => {
                state.visualizationQueue.clear();
                for (const tileVisu of state.removeVisualizations(styleId)) {
                    this.tileVisualizationDestructionTopic.next(tileVisu);
                }
            });
            this.stateService.prune(this.mapInfo.maps.maps, this.styleService.styles);
        });
        this.styleService.styleAddedForId.subscribe(styleId => {
            this.viewStates().forEach((_, viewIndex) => {
                for (const tileLayer of this.tileStream.loadedTileLayers.values()) {
                    const style = this.styleService.styles.get(styleId);
                    if (style) {
                        this.renderTileLayerOnDemand(viewIndex, tileLayer, style);
                    }
                }
            });
        });
        this.mapInfo.styleOptionChanged.subscribe(([optionNode, viewIndex]) => {
            this.applyStyleOptionChange(optionNode, viewIndex);
        });
        this.viewState.viewStateChanged.subscribe(() => this.updateVisualizations());
        this.tileStream.tileCacheChanged.subscribe(() => this.updateVisualizations());
        this.tileStream.tileDataChanged.subscribe(change => {
            if (change.reason === "loaded") {
                const waitingUpdate = this.updateWaitingVisualizationsForTile(change.tile);
                if (waitingUpdate.visibleInAnyView && !waitingUpdate.foundExistingVisualization) {
                    this.createVisualizationsForTile(change.tile);
                }
                if (this.isTileSelectedOrHovered(change.tile.mapTileKey)) {
                    this.refreshHighlightVisualizationsForCurrentPolicies();
                }
            }
            if (change.reason === "evicted") {
                this.removeFeatureTileVisualizations(change.tile.mapTileKey);
            }
        });
        this.tileStream.searchRenderTileChanged.subscribe(tile => this.updateSearchResultVisualizationsForTile(tile));
        this.tileStream.searchRenderTileRemoved.subscribe(({searchId, sourceTileKey}) => {
            this.removeSearchResultVisualizations(searchId, sourceTileKey);
        });
        this.inspection.selectionTopic.subscribe(selectedPanels => {
            this.refreshHighlightVisualizationIfNeeded(coreLib.HighlightMode.SELECTION_HIGHLIGHT, selectedPanels);
            if (this.inspection.hoverTopic.getValue().length) {
                this.refreshHighlightVisualizationsForCurrentPolicies();
            }
        });
        this.inspection.hoverTopic.subscribe(hoveredFeatureWrappers => {
            this.refreshHighlightVisualizationIfNeeded(coreLib.HighlightMode.HOVER_HIGHLIGHT, [{features: hoveredFeatureWrappers}]);
        });
        this.stateService.numViewsState.subscribe(_ => {
            this.stateService.prune(this.mapInfo.maps.maps, this.styleService.styles);
        });
    }

    /** Returns the number of visualizations known to the service and how many are fully rendered. */
    getVisualizationCounts(): {total: number; done: number} {
        const result = {total: 0, done: 0};
        for (const view of this.viewStates()) {
            for (const visu of view.getVisualizations()) {
                result.total += 1;
                if (!visu.isDirty()) {
                    result.done += 1;
                }
            }
        }
        return result;
    }

    /** Returns the combined queued visualization count across all views. */
    getRenderQueueSize(): number {
        return this.visualizationQueueLength();
    }

    /** Returns the current EWMA frame time in milliseconds. */
    currentFrameTimeMs(): number {
        return Math.max(0, this.frameTimeMsEwma || 0);
    }

    /** Forces the next highlight refresh to rebuild even if the tracked signature stayed unchanged. */
    refreshHighlightVisualizations(): void {
        this.selectionHighlightSignature = "";
        this.hoverHighlightSignature = "";
        this.refreshHighlightVisualizationsForCurrentPolicies();
    }

    /**
     * Clean up all tile visualizations - used during viewer deletion.
     */
    clearAllTileVisualizations(viewIndex: number, sceneHandle: IRenderSceneHandle): void {
        if (viewIndex >= this.stateService.numViews) {
            return;
        }
        const state = this.viewStates()[viewIndex];
        for (const tileVisu of state.removeVisualizations()) {
            try {
                tileVisu.destroy(sceneHandle);
            } catch (error) {
                console.warn('Error destroying tile visualization:', error);
            }
        }
        state.visualizationQueue.clear();
        if (viewIndex >= 0 && viewIndex < this.inFlightVisualizationRendersByView.length) {
            this.inFlightVisualizationRendersByView[viewIndex] = 0;
        }
        if (viewIndex >= 0 && viewIndex < this.inFlightBlockedTileIdsByView.length) {
            this.inFlightBlockedTileIdsByView[viewIndex].clear();
        }
    }

    /** Continuously dispatches dirty visualizations under a small frame budget. */
    private processVisualizationTasks() {
        if (this.tileStream.tilePipelinePaused) {
            this.scheduleOutsideAngular(() => this.processVisualizationTasks(), 100);
            return;
        }
        const viewCount = this.viewStates().length;
        if (this.inFlightVisualizationRendersByView.length !== viewCount) {
            this.inFlightVisualizationRendersByView = Array.from(
                {length: viewCount},
                (_, index) => this.inFlightVisualizationRendersByView[index] ?? 0
            );
            this.nextVisualizationViewIndex = viewCount > 0
                ? this.nextVisualizationViewIndex % viewCount
                : 0;
        }
        if (this.inFlightBlockedTileIdsByView.length !== viewCount) {
            this.inFlightBlockedTileIdsByView = Array.from(
                {length: viewCount},
                (_, index) => this.inFlightBlockedTileIdsByView[index] ?? new Map<bigint, number>()
            );
        }
        const maxInFlightPerView = this.maxInFlightVisualizationRendersPerView();

        const startTime = Date.now();
        const timeBudget = 20;
        let currentQueueLength = this.visualizationQueueLength();
        let dispatchedAny = false;
        let blockedByInFlight = false;
        let blockedByNeighbor = false;

        while (currentQueueLength > 0 && viewCount > 0) {
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            let dispatchedInRound = false;
            blockedByInFlight = false;
            for (let inspectedViews = 0; inspectedViews < viewCount; inspectedViews++) {
                const viewIndex = (this.nextVisualizationViewIndex + inspectedViews) % viewCount;
                const viewState = this.viewStates()[viewIndex];
                if (!viewState.visualizationQueue.length) {
                    continue;
                }
                if (this.inFlightVisualizationRendersByView[viewIndex] >= maxInFlightPerView) {
                    blockedByInFlight = true;
                    continue;
                }
                const entry = this.dequeueNextRenderableVisualization(viewIndex, viewState);
                if (entry === undefined) {
                    blockedByNeighbor = true;
                    continue;
                }
                this.inFlightVisualizationRendersByView[viewIndex] += 1;
                this.markTileInFlightForView(viewIndex, entry.tile.tileId);
                let doneCalled = false;
                const onDone = () => {
                    if (doneCalled) {
                        return;
                    }
                    doneCalled = true;
                    if (this.shouldRequeueVisualizationAfterRender(viewIndex, entry)) {
                        entry.updateStatus(true);
                        this.queueVisualization(viewState, entry);
                    }
                    this.unmarkTileInFlightForView(viewIndex, entry.tile.tileId);
                    const inFlightCount = this.inFlightVisualizationRendersByView[viewIndex] ?? 0;
                    this.inFlightVisualizationRendersByView[viewIndex] = Math.max(0, inFlightCount - 1);
                };
                this.tileVisualizationTopic.next({visualization: entry, onDone});
                currentQueueLength--;
                dispatchedAny = true;
                dispatchedInRound = true;
                this.nextVisualizationViewIndex = (viewIndex + 1) % viewCount;
                break;
            }
            if (!dispatchedInRound) {
                break;
            }
        }

        const delay = currentQueueLength
            ? (dispatchedAny ? 0 : ((blockedByInFlight || blockedByNeighbor) ? 4 : 10))
            : 10;
        this.scheduleOutsideAngular(() => this.processVisualizationTasks(), delay);
    }

    /** Reconciles visible tiles and styles with the per-view visualization caches and queues. */
    private updateVisualizations() {
        let anyRenderPolicyChanged = false;
        this.viewStates().forEach((state, viewIndex) => {
            const mapViewLayerStyleIdsRequiringMergedPointReset = new Set<string>();
            const visibleTileByKey = new Map<string, boolean>();
            const isVisibleForView = (tile: FeatureTile): boolean => {
                const cached = visibleTileByKey.get(tile.mapTileKey);
                if (cached !== undefined) {
                    return cached;
                }
                const visible = !tile.disposed && this.tileStream.viewShowsFeatureTile(viewIndex, tile);
                visibleTileByKey.set(tile.mapTileKey, visible);
                return visible;
            };

            for (const styleId of state.getVisualizedStyleIds()) {
                const searchRequest = this.searchRequestForVisualizationStyle(styleId);
                let styleEnabled = !!searchRequest?.showResultsOnMap;
                if (!searchRequest && this.styleService.styles.has(styleId)) {
                    styleEnabled = this.styleService.styles.get(styleId)!.visible;
                }
                const removals: string[] = [];
                for (const tileVisu of state.getVisualizations(styleId)) {
                    if (searchRequest) {
                        this.updateExistingSearchVisualization(state, viewIndex, searchRequest, tileVisu, removals, styleEnabled);
                        continue;
                    }
                    if (!isVisibleForView(tileVisu.tile as FeatureTile)) {
                        this.tileVisualizationDestructionTopic.next(tileVisu);
                        removals.push(tileVisu.tile.mapTileKey);
                        continue;
                    }
                    if (styleId != "_builtin" && !styleEnabled) {
                        this.tileVisualizationDestructionTopic.next(tileVisu);
                        removals.push(tileVisu.tile.mapTileKey);
                        continue;
                    }
                    tileVisu.showTileBorder = this.mapInfo.maps.getViewTileBorderState(viewIndex);
                    const previousHighFidelityStage = tileVisu.highFidelityStage;
                    const previousPrefersHighFidelity = tileVisu.prefersHighFidelity;
                    const previousMaxLowFiLod = tileVisu.maxLowFiLod;
                    this.applyTileRenderPolicyToVisualization(viewIndex, tileVisu);
                    const styleEntry = this.styleService.styles.get(styleId);
                    const styleHasExplicitLowFidelityRules =
                        styleEntry
                            ? (styleEntry.featureLayerStyle as FeatureLayerStyleWithFidelity).hasExplicitLowFidelityRules()
                            : true;
                    const lowFiLodPolicyChanged =
                        styleHasExplicitLowFidelityRules && previousMaxLowFiLod !== tileVisu.maxLowFiLod;
                    if (previousHighFidelityStage !== tileVisu.highFidelityStage
                        || previousPrefersHighFidelity !== tileVisu.prefersHighFidelity
                        || lowFiLodPolicyChanged) {
                        const mapViewLayerStyleId = this.pointMergeService.makeMapViewLayerStyleId(
                            viewIndex,
                            tileVisu.tile.mapName,
                            tileVisu.tile.layerName,
                            tileVisu.styleId,
                            coreLib.HighlightMode.NO_HIGHLIGHT
                        );
                        if (this.shouldHardResetMergedPointsForPolicyChange(
                            previousPrefersHighFidelity,
                            previousMaxLowFiLod,
                            tileVisu,
                            styleHasExplicitLowFidelityRules
                        )) {
                            mapViewLayerStyleIdsRequiringMergedPointReset.add(mapViewLayerStyleId);
                        }
                    }
                }
                for (const tileKey of removals) {
                    state.removeVisualizations(styleId, tileKey).forEach(_ => _);
                }
            }

            for (const mapViewLayerStyleId of mapViewLayerStyleIdsRequiringMergedPointReset) {
                this.clearMergedPointsForMapViewLayerStyleId(mapViewLayerStyleId);
            }
            if (mapViewLayerStyleIdsRequiringMergedPointReset.size > 0) {
                anyRenderPolicyChanged = true;
            }

            const visibleTiles: FeatureTile[] = [];
            for (const tile of this.tileStream.loadedTileLayers.values()) {
                if (isVisibleForView(tile)) {
                    tile.setRenderOrder(state.getTileOrder(tile.tileId));
                    visibleTiles.push(tile);
                }
            }

            const visibleStyles = Array.from(this.styleService.styles.values()).filter(style => style.visible);
            const renderableStyles = visibleStyles.filter(style => {
                const wasmStyle = style.featureLayerStyle;
                return !!wasmStyle && wasmStyle.supportsHighlightMode(coreLib.HighlightMode.NO_HIGHLIGHT);
            });
            const visibleTilesByLayer = new Map<string, FeatureTile[]>();
            for (const tile of visibleTiles) {
                let tilesForLayer = visibleTilesByLayer.get(tile.layerName);
                if (!tilesForLayer) {
                    tilesForLayer = [];
                    visibleTilesByLayer.set(tile.layerName, tilesForLayer);
                }
                tilesForLayer.push(tile);
            }

            state.visualizationQueue.clear();
            for (const [layerName, tilesForLayer] of visibleTilesByLayer.entries()) {
                const applicableStyles: ErdblickStyle[] = [];
                for (const style of renderableStyles) {
                    if (style.featureLayerStyle.hasLayerAffinity(layerName)) {
                        applicableStyles.push(style);
                    }
                }
                for (const tile of tilesForLayer) {
                    for (const style of applicableStyles) {
                        this.renderTileLayer(viewIndex, tile, style);
                    }
                }
            }
            this.updateSearchResultVisualizationsForView(state, viewIndex);
        });
        if (anyRenderPolicyChanged
            || this.selectionVisualizations.length > 0
            || this.hoverVisualizations.length > 0
            || this.inspection.selectionTopic.getValue().length > 0
            || this.inspection.hoverTopic.getValue().length > 0) {
            this.refreshHighlightVisualizationsForCurrentPolicies();
        }
    }

    /** Applies current search-render policy to an existing search visualization, removing stale entries. */
    private updateExistingSearchVisualization(
        state: ViewVisualizationState,
        viewIndex: number,
        searchRequest: FeatureSearchDataPlaneRequest,
        tileVisu: ITileVisualization,
        removals: string[],
        styleEnabled: boolean
    ): void {
        if (!(tileVisu instanceof DeckTileSearchVisualization)) {
            this.tileVisualizationDestructionTopic.next(tileVisu);
            removals.push(tileVisu.tile.mapTileKey);
            return;
        }
        const highFidelityActive = this.prefersHighFidelityForSearchResultTile(
            viewIndex,
            searchRequest.searchId,
            tileVisu.tile.sourceTileId
        );
        const hasRenderTile = this.tileStream.hasSearchResultRenderTile(
            searchRequest.searchId,
            tileVisu.tile.sourceTileKey
        );
        if (!hasRenderTile || !this.viewShowsSearchResultTile(viewIndex, tileVisu.tile) || !styleEnabled) {
            this.tileVisualizationDestructionTopic.next(tileVisu);
            removals.push(tileVisu.tile.mapTileKey);
            return;
        }
        const renderPolicy = this.tileRenderPolicyForView(viewIndex, tileVisu.tile);
        tileVisu.highFidelityStage = this.mapInfo.getLayerHighFidelityStage(tileVisu.tile.mapName, tileVisu.tile.layerName);
        tileVisu.prefersHighFidelity = highFidelityActive;
        tileVisu.maxLowFiLod = renderPolicy.maxLowFiLod;
        if (tileVisu.isDirty()) {
            tileVisu.updateStatus(true);
            this.queueVisualization(state, tileVisu);
        }
    }

    /** Requeues existing visualizations for a tile that just received additional stage data. */
    private updateWaitingVisualizationsForTile(tileLayer: FeatureTile): {
        foundExistingVisualization: boolean;
        visibleInAnyView: boolean;
    } {
        const tileKey = tileLayer.mapTileKey;
        let foundExistingVisualization = false;
        let visibleInAnyView = false;

        for (let viewIndex = 0; viewIndex < this.viewStates().length; viewIndex++) {
            if (!this.tileStream.viewShowsFeatureTile(viewIndex, tileLayer)) {
                continue;
            }
            visibleInAnyView = true;

            const viewState = this.viewStates()[viewIndex];
            tileLayer.setRenderOrder(viewState.getTileOrder(tileLayer.tileId));
            for (const visu of viewState.getVisualizations(undefined, tileKey)) {
                if (visu instanceof DeckTileSearchVisualization) {
                    continue;
                }
                foundExistingVisualization = true;
                const style = this.styleService.styles.get(visu.styleId);
                if (style && !this.tileSatisfiesStyleStage(tileLayer, style.featureLayerStyle)) {
                    visu.updateStatus(false);
                    continue;
                }
                visu.showTileBorder = this.mapInfo.maps.getViewTileBorderState(viewIndex);
                this.applyTileRenderPolicyToVisualization(viewIndex, visu);
                if (!visu.isDirty()) {
                    continue;
                }

                visu.updateStatus(true);
                this.queueVisualization(viewState, visu);
            }
        }

        return {foundExistingVisualization, visibleInAnyView};
    }

    /** Creates all currently applicable style visualizations for a newly visible tile. */
    private createVisualizationsForTile(tileLayer: FeatureTile): void {
        for (let viewIndex = 0; viewIndex < this.viewStates().length; viewIndex++) {
            if (!this.tileStream.viewShowsFeatureTile(viewIndex, tileLayer)) {
                continue;
            }
            for (const [_, style] of this.styleService.styles) {
                this.renderTileLayerOnDemand(viewIndex, tileLayer, style);
            }
        }
    }

    /** Fast-path helper that creates a visualization only if the style is currently applicable. */
    private renderTileLayerOnDemand(viewIndex: number, tileLayer: FeatureTile, style: ErdblickStyle) {
        if (style.visible &&
            style.featureLayerStyle.hasLayerAffinity(tileLayer.layerName) &&
            style.featureLayerStyle.supportsHighlightMode(coreLib.HighlightMode.NO_HIGHLIGHT)) {
            this.renderTileLayer(viewIndex, tileLayer, style);
        }
    }

    /** Creates or refreshes one style visualization for a tile in a specific view. */
    private renderTileLayer(viewIndex: number, tileLayer: FeatureTile, style: ErdblickStyle) {
        const wasmStyle = style.featureLayerStyle;
        if (!wasmStyle || !style.visible || !wasmStyle.supportsHighlightMode(coreLib.HighlightMode.NO_HIGHLIGHT)) {
            return;
        }
        const stageReady = this.tileSatisfiesStyleStage(tileLayer, wasmStyle);

        const styleId = style.id;
        const mapName = tileLayer.mapName;
        const layerName = tileLayer.layerName;
        const tileKey = tileLayer.mapTileKey;
        const viewState = this.viewStates()[viewIndex];
        const renderPolicy = this.tileRenderPolicyForView(viewIndex, tileLayer);
        const highFidelityStage = this.mapInfo.getLayerHighFidelityStage(mapName, layerName);
        const requestedStageDiagnostic = Math.max(0, this.mapInfo.getLayerStageCount(mapName, layerName) - 1);
        const styleOrder = this.styleOrder(styleId);
        tileLayer.stats.set(`Rendering/Policy/View-${viewIndex}/RequestedMaxStage#value`, [requestedStageDiagnostic]);
        tileLayer.stats.set(`Rendering/Policy/View-${viewIndex}/HighFidelityStage#value`, [highFidelityStage]);
        tileLayer.stats.set(`Rendering/Policy/View-${viewIndex}/MaxLowFiLod#value`, [renderPolicy.maxLowFiLod ?? -1]);
        const existing = viewState.getVisualization(styleId, tileKey);
        if (existing) {
            existing.showTileBorder = this.mapInfo.maps.getViewTileBorderState(viewIndex);
            existing.highFidelityStage = highFidelityStage;
            existing.prefersHighFidelity = renderPolicy.prefersHighFidelity;
            existing.maxLowFiLod = renderPolicy.maxLowFiLod;
            existing.styleOrder = styleOrder;
            if (!stageReady) {
                existing.updateStatus(false);
                return;
            }
            if (existing.isDirty()) {
                existing.updateStatus(true);
                this.queueVisualization(viewState, existing);
            }
            return;
        }
        const visu = this.createTileVisualization(
            viewIndex,
            tileLayer,
            wasmStyle,
            style.source,
            highFidelityStage,
            renderPolicy.prefersHighFidelity,
            renderPolicy.maxLowFiLod,
            coreLib.HighlightMode.NO_HIGHLIGHT,
            [],
            "",
            this.mapInfo.maps.getViewTileBorderState(viewIndex),
            this.mapInfo.maps.getLayerStyleOptions(viewIndex, mapName, layerName, styleId),
            styleOrder,
            style.sourceRef
        );
        viewState.putVisualization(styleId, tileKey, visu);
        if (!stageReady) {
            visu.updateStatus(false);
            return;
        }
        visu.updateStatus(true);
        this.queueVisualization(viewState, visu);
    }

    /** Constructs the concrete deck-backed visualization object for one tile/style/highlight combination. */
    private createTileVisualization(
        viewIndex: number,
        tile: FeatureTile,
        style: FeatureLayerStyle,
        styleSource: string,
        highFidelityStage: number,
        prefersHighFidelity: boolean,
        maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null,
        highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
        featureIdSubset: string[] = [],
        layerKeySuffix = "",
        boxGrid = false,
        options: Record<string, boolean | number | string> = {},
        styleOrder: number = 0,
        styleSourceRef?: StyleSourceRef
    ): ITileVisualization {
        return new DeckTileVisualization(
            viewIndex,
            tile,
            this.pointMergeService,
            style,
            styleSource,
            highFidelityStage,
            prefersHighFidelity,
            maxLowFiLod,
            highlightMode,
            featureIdSubset,
            layerKeySuffix,
            boxGrid,
            options,
            styleOrder,
            (requests) => this.resolveRelationExternalTiles(requests),
            styleSourceRef,
            (issues) => this.recordStyleValidationIssues(issues)
        );
    }

    /** Schedules queued high-fidelity renderers for streamed search-result tiles in one view. */
    private updateSearchResultVisualizationsForView(state: ViewVisualizationState, viewIndex: number): void {
        for (const renderTile of this.tileStream.searchResultRenderTiles()) {
            const request = this.tileStream.activeFeatureSearchRequest(renderTile.searchId);
            if (!request?.showResultsOnMap || !this.viewShowsSearchResultTile(viewIndex, renderTile.tile)) {
                continue;
            }

            renderTile.tile.setRenderOrder(state.getTileOrder(renderTile.sourceTileId));
            this.upsertSearchResultVisualization(state, viewIndex, renderTile.tile, request);
        }
    }

    /** Updates only the visualizations affected by one streamed search-result tile. */
    private updateSearchResultVisualizationsForTile(tile: SearchResultTile): void {
        const request = this.tileStream.activeFeatureSearchRequest(tile.searchId);
        if (!request?.showResultsOnMap) {
            return;
        }
        for (let viewIndex = 0; viewIndex < this.viewStates().length; viewIndex++) {
            const state = this.viewStates()[viewIndex];
            if (!this.viewShowsSearchResultTile(viewIndex, tile)) {
                this.removeSearchResultVisualizations(tile.searchId, tile.sourceTileKey, state);
                continue;
            }
            tile.setRenderOrder(state.getTileOrder(tile.sourceTileId));
            this.upsertSearchResultVisualization(state, viewIndex, tile, request);
        }
    }

    /** Creates or updates one high-fidelity search result visualization for a view. */
    private upsertSearchResultVisualization(
        state: ViewVisualizationState,
        viewIndex: number,
        tile: SearchResultTile,
        request: FeatureSearchDataPlaneRequest
    ): void {
        const styleId = this.searchResultStyleId(tile.searchId);
        const highFidelityStage = this.mapInfo.getLayerHighFidelityStage(tile.sourceMapId, tile.sourceLayerId);
        const styleSpecJson = this.searchResultStyleSpec(request);
        const styleOrder = this.searchResultStyleOrder(tile.searchId);
        const renderPolicy = this.tileRenderPolicyForView(viewIndex, tile);
        const highFidelityActive = this.prefersHighFidelityForSearchResultTile(viewIndex, tile.searchId, tile.sourceTileId);
        const existing = state.getVisualization(styleId, tile.sourceTileKey);

        if (existing instanceof DeckTileSearchVisualization) {
            existing.updateSearchResultStyle(styleSpecJson, styleOrder);
            existing.highFidelityStage = highFidelityStage;
            existing.prefersHighFidelity = highFidelityActive;
            existing.maxLowFiLod = renderPolicy.maxLowFiLod;
            if (existing.isDirty()) {
                existing.updateStatus(true);
                this.queueVisualization(state, existing);
            }
            return;
        }

        if (existing) {
            this.tileVisualizationDestructionTopic.next(existing);
            state.removeVisualizations(styleId, tile.sourceTileKey).forEach(_ => _);
        }

        if (!highFidelityActive) {
            return;
        }

        const visualization = new DeckTileSearchVisualization(
            viewIndex,
            styleId,
            tile,
            this.mapInfo.tileLayerParser,
            styleSpecJson,
            highFidelityStage,
            true,
            renderPolicy.maxLowFiLod,
            styleOrder
        );
        state.putVisualization(styleId, tile.sourceTileKey, visualization);
        visualization.updateStatus(true);
        this.queueVisualization(state, visualization);
    }

    /** Removes search-result visualizations for one tile from all or one view. */
    private removeSearchResultVisualizations(searchId: string, sourceTileKey: string, onlyState?: ViewVisualizationState): void {
        const styleId = this.searchResultStyleId(searchId);
        const states = onlyState ? [onlyState] : this.viewStates();
        for (const state of states) {
            for (const visualization of state.removeVisualizations(styleId, sourceTileKey)) {
                this.tileVisualizationDestructionTopic.next(visualization);
            }
            state.visualizationQueue.retain(visualization =>
                visualization.styleId !== styleId || visualization.tile.mapTileKey !== sourceTileKey);
        }
    }

    /** Removes normal feature tile visualizations from all views. */
    private removeFeatureTileVisualizations(tileKey: string): void {
        for (const state of this.viewStates()) {
            for (const visualization of state.removeVisualizations(undefined, tileKey)) {
                this.tileVisualizationDestructionTopic.next(visualization);
            }
            state.visualizationQueue.retain(visualization => visualization.tile.mapTileKey !== tileKey);
        }
    }

    /** Rebuilds hover and selection highlights when fidelity policy changes affect their geometry. */
    private refreshHighlightVisualizationsForCurrentPolicies(): void {
        const selectionGroups = this.inspection.selectionTopic.getValue();
        this.refreshHighlightVisualizationIfNeeded(coreLib.HighlightMode.SELECTION_HIGHLIGHT, selectionGroups);
        const hoveredFeatureWrappers = this.inspection.hoverTopic.getValue();
        this.refreshHighlightVisualizationIfNeeded(coreLib.HighlightMode.HOVER_HIGHLIGHT, [{features: hoveredFeatureWrappers}]);
    }

    /** Rebuilds one highlight family only when its signature differs from the last emitted one. */
    private refreshHighlightVisualizationIfNeeded(
        mode: HighlightMode,
        groups: {features: FeatureWrapper[], color?: string, id?: number}[]
    ): void {
        const nextSignature = this.buildHighlightVisualizationSignature(mode, groups);
        if (nextSignature === this.getHighlightVisualizationSignature(mode)) {
            return;
        }
        this.visualizeHighlights(mode, groups, nextSignature);
    }

    /** Recreates all highlight visualizations for the supplied hover or selection groups. */
    private visualizeHighlights(
        mode: HighlightMode,
        groups: {features: FeatureWrapper[], color?: string, id?: number}[],
        signature: string = this.buildHighlightVisualizationSignature(mode, groups)
    ) {
        let visualizationCollection: ITileVisualization[];
        switch (mode) {
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT:
                visualizationCollection = this.selectionVisualizations;
                break;
            case coreLib.HighlightMode.HOVER_HIGHLIGHT:
                visualizationCollection = this.hoverVisualizations;
                break;
            default:
                console.error(`Bad visualization mode ${mode}!`);
                return;
        }

        while (visualizationCollection.length) {
            const visualization = visualizationCollection.pop();
            if (visualization) {
                this.tileVisualizationDestructionTopic.next(visualization);
            }
        }

        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex];
            const groupKey = mode.value === coreLib.HighlightMode.SELECTION_HIGHLIGHT.value
                ? `selection-${group.id ?? groupIndex}`
                : `hover-${group.id ?? groupIndex}`;
            const featureWrappersForTile = new Map<FeatureTile, FeatureWrapper[]>();
            for (const wrapper of group.features) {
                if (!featureWrappersForTile.has(wrapper.featureTile)) {
                    featureWrappersForTile.set(wrapper.featureTile, []);
                }
                featureWrappersForTile.get(wrapper.featureTile)!.push(wrapper);
            }

            for (const [featureTile, features] of featureWrappersForTile) {
                const featureIds = features.map(fw => fw.featureId);
                for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                    if (!this.tileStream.viewShowsFeatureTile(viewIndex, featureTile, true)) {
                        continue;
                    }
                    for (const [_, style] of this.styleService.styles) {
                        if (style.visible &&
                            style.featureLayerStyle.hasLayerAffinity(featureTile.layerName) &&
                            this.tileSatisfiesStyleStage(featureTile, style.featureLayerStyle) &&
                            style.featureLayerStyle.supportsHighlightMode(mode)) {
                            const styleOptions = {
                                ...(this.mapInfo.maps.getLayerStyleOptions(
                                    viewIndex,
                                    featureTile.mapName,
                                    featureTile.layerName,
                                    style.id
                                ) ?? {})
                            };
                            if (group.color) {
                                styleOptions["selectableFeatureHighlightColor"] = group.color;
                            }
                            const renderPolicy = this.tileRenderPolicyForView(viewIndex, featureTile);
                            const visualization = this.createTileVisualization(
                                viewIndex,
                                featureTile,
                                style.featureLayerStyle,
                                style.source,
                                this.mapInfo.getLayerHighFidelityStage(featureTile.mapName, featureTile.layerName),
                                renderPolicy.prefersHighFidelity,
                                renderPolicy.maxLowFiLod,
                                mode,
                                featureIds,
                                groupKey,
                                false,
                                styleOptions,
                                this.styleOrder(style.id),
                                style.sourceRef
                            );
                            this.tileVisualizationTopic.next({visualization});
                            visualizationCollection.push(visualization);
                        }
                    }
                }
            }
        }
        this.setHighlightVisualizationSignature(mode, signature);
    }

    /** Builds a stable signature for highlight inputs and render policies. */
    private buildHighlightVisualizationSignature(
        mode: HighlightMode,
        groups: {features: FeatureWrapper[], color?: string, id?: number}[]
    ): string {
        const signatureParts = [`mode:${mode.value}`, `views:${this.stateService.numViews}`];
        const visibleStyles = Array.from(this.styleService.styles.values())
            .filter(style => style.visible)
            .sort((lhs, rhs) => lhs.id.localeCompare(rhs.id));

        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex];
            signatureParts.push(`group:${group.id ?? groupIndex}:${group.color ?? ""}`);
            const featureWrappersForTile = new Map<FeatureTile, FeatureWrapper[]>();
            for (const wrapper of group.features) {
                let wrappers = featureWrappersForTile.get(wrapper.featureTile);
                if (!wrappers) {
                    wrappers = [];
                    featureWrappersForTile.set(wrapper.featureTile, wrappers);
                }
                wrappers.push(wrapper);
            }
            const tiles = Array.from(featureWrappersForTile.entries())
                .sort((lhs, rhs) => lhs[0].mapTileKey.localeCompare(rhs[0].mapTileKey));

            for (const [featureTile, features] of tiles) {
                const featureIds = features.map(feature => feature.featureId).sort();
                signatureParts.push(`tile:${featureTile.mapTileKey}:${featureTile.dataVersion}:${featureTile.highestLoadedStage() ?? -1}:${featureIds.join(",")}`);

                for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                    if (!this.tileStream.viewShowsFeatureTile(viewIndex, featureTile, true)) {
                        continue;
                    }
                    const renderPolicy = this.tileRenderPolicyForView(viewIndex, featureTile);
                    signatureParts.push(`view:${viewIndex}:${renderPolicy.prefersHighFidelity ? 1 : 0}:${renderPolicy.maxLowFiLod ?? -1}`);

                    for (const style of visibleStyles) {
                        const wasmStyle = style.featureLayerStyle;
                        if (!wasmStyle.hasLayerAffinity(featureTile.layerName)
                            || !this.tileSatisfiesStyleStage(featureTile, wasmStyle)
                            || !wasmStyle.supportsHighlightMode(mode)) {
                            continue;
                        }
                        const styleOptions = {
                            ...(this.mapInfo.maps.getLayerStyleOptions(
                                viewIndex,
                                featureTile.mapName,
                                featureTile.layerName,
                                style.id
                            ) ?? {})
                        };
                        if (group.color) {
                            styleOptions["selectableFeatureHighlightColor"] = group.color;
                        }
                        signatureParts.push(`style:${viewIndex}:${style.id}:${style.source}:${JSON.stringify(styleOptions)}`);
                    }
                }
            }
        }

        return signatureParts.join("|");
    }

    /** Reapplies one changed style option to all existing visualizations of the affected layer. */
    private applyStyleOptionChange(optionNode: {mapId: string; layerId: string; styleId: string; id: string; value: (boolean|number|string)[]}, viewIndex: number) {
        if (viewIndex >= this.viewStates().length || optionNode.value.length <= viewIndex) {
            return;
        }

        const viewState = this.viewStates()[viewIndex];
        if (!viewState.hasVisualizations(optionNode.styleId)) {
            return;
        }

        const mapViewLayerStyleId = this.pointMergeService.makeMapViewLayerStyleId(
            viewIndex,
            optionNode.mapId,
            optionNode.layerId,
            optionNode.styleId,
            coreLib.HighlightMode.NO_HIGHLIGHT);
        this.clearMergedPointsForMapViewLayerStyleId(mapViewLayerStyleId);

        viewState.visualizationQueue.retain(visu =>
            visu.styleId !== optionNode.styleId ||
            visu.tile.mapName !== optionNode.mapId ||
            visu.tile.layerName !== optionNode.layerId
        );

        const optionValue = optionNode.value[viewIndex];
        for (const visu of viewState.getVisualizations(optionNode.styleId)) {
            if (visu.tile.mapName === optionNode.mapId && visu.tile.layerName === optionNode.layerId) {
                const changed = visu.setStyleOption(optionNode.id, optionValue);
                if (changed || visu.isDirty()) {
                    visu.updateStatus(true);
                    this.queueVisualization(viewState, visu);
                }
            }
        }
    }

    /** Resolves relation targets via `/locate` and ensures the referenced tiles are loaded. */
    private async resolveRelationExternalTiles(requests: RelationLocateRequest[]): Promise<RelationLocateResult> {
        if (requests.length === 0) {
            return {responses: [], tiles: []};
        }
        let response: Response | undefined;
        try {
            response = await fetch("locate", {
                body: JSON.stringify({requests}, (_, value) => typeof value === "bigint" ? Number(value) : value),
                method: "POST"
            });
        } catch (error) {
            console.error(`Error during /locate call for relation targets: ${error}`);
            return {responses: [], tiles: []};
        }
        if (!response.ok) {
            console.error(`Locate request for relation targets failed with status ${response.status}.`);
            return {responses: [], tiles: []};
        }
        const locateResponse = await response.json() as {responses?: RelationLocateResolution[][]};
        const tileKeys = new Set<string>();
        for (const resolutions of locateResponse.responses ?? []) {
            for (const resolution of resolutions) {
                if (typeof resolution.tileId === "string" && resolution.tileId.length > 0) {
                    tileKeys.add(resolution.tileId);
                }
            }
        }
        if (tileKeys.size === 0) {
            return {responses: locateResponse.responses ?? [], tiles: []};
        }
        const loadedTiles = await this.tileStream.loadTiles(tileKeys);
        const seenTileKeys = new Set<string>();
        const relationTiles: FeatureTile[] = [];
        for (const tileKey of tileKeys) {
            const tile = loadedTiles.get(tileKey) ?? null;
            if (!tile || !tile.hasData() || seenTileKeys.has(tile.mapTileKey)) {
                continue;
            }
            seenTileKeys.add(tile.mapTileKey);
            relationTiles.push(tile);
        }
        return {responses: locateResponse.responses ?? [], tiles: relationTiles};
    }

    /** Returns the current fidelity policy that a view wants for a given tile. */
    private tileRenderPolicyForView(viewIndex: number, tile: TileVisualizationTile): {
        prefersHighFidelity: boolean;
        maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
    } {
        const viewPolicy = this.viewStates()[viewIndex].getTileRenderPolicy(tile.tileId);
        return {prefersHighFidelity: viewPolicy.targetFidelity === "high", maxLowFiLod: viewPolicy.maxLowFiLod};
    }

    /** Copies the current view policy into an existing visualization instance. */
    private applyTileRenderPolicyToVisualization(viewIndex: number, visualization: ITileVisualization): void {
        const policy = this.tileRenderPolicyForView(viewIndex, visualization.tile);
        visualization.highFidelityStage = this.mapInfo.getLayerHighFidelityStage(visualization.tile.mapName, visualization.tile.layerName);
        visualization.prefersHighFidelity = policy.prefersHighFidelity;
        visualization.maxLowFiLod = policy.maxLowFiLod;
    }

    /** Returns whether search-result geometry should be rendered for one visible source tile. */
    /** Returns whether high-fidelity search-result geometry should currently be rendered for one tile. */
    prefersHighFidelityForSearchResultTile(viewIndex: number, searchId: string, tileId: bigint): boolean {
        const request = this.tileStream.activeFeatureSearchRequest(searchId);
        if (!request?.showResultsOnMap || !request.renderStrategy.showHighFiGeometry) {
            return false;
        }
        return this.viewState.prefersHighFidelityForSearchResultTile(
            viewIndex,
            searchId,
            tileId,
            request.renderStrategy.highFidelityMaxVisibleTiles
        );
    }

    /** Returns whether a search-result source tile is visible in one view and layer context. */
    private viewShowsSearchResultTile(viewIndex: number, tile: SearchResultTile): boolean {
        return !tile.disposed
            && this.viewState.showsFeatureTileInView(
                viewIndex,
                tile.sourceMapId,
                tile.sourceLayerId,
                tile.sourceTileId
            );
    }

    /** Returns whether a tile has enough stage data for a style to render. */
    private tileSatisfiesStyleStage(tile: FeatureTile, style: FeatureLayerStyle): boolean {
        const requiredStage = this.styleMinimumStage(style);
        const highestLoadedStage = tile.highestLoadedStage();
        if (highestLoadedStage === null) {
            return false;
        }
        if (highestLoadedStage >= requiredStage) {
            return true;
        }
        return tile.isComplete(this.mapInfo.getLayerStageCount(tile.mapName, tile.layerName));
    }

    /** Normalizes the style's requested minimum stage to a non-negative integer. */
    private styleMinimumStage(style: FeatureLayerStyle): number {
        const rawValue = style.minimumStage();
        if (!Number.isFinite(rawValue)) {
            return 0;
        }
        return Math.max(0, Math.floor(rawValue));
    }

    /** Returns the stable current ordering index of one visible style contribution. */
    private styleOrder(styleId: string): number {
        let index = 0;
        for (const [id] of this.styleService.styles) {
            if (id === styleId) {
                return index;
            }
            index += 1;
        }
        return 0;
    }

    /** Returns the style id namespace used for queued high-fidelity search-result visualizations. */
    private searchResultStyleId(searchId: string): string {
        return `${MapRenderService.SEARCH_RESULT_STYLE_PREFIX}${searchId}`;
    }

    /** Extracts a search id from a search-result visualization style id. */
    private searchIdFromSearchResultStyleId(styleId: string): string | null {
        return styleId.startsWith(MapRenderService.SEARCH_RESULT_STYLE_PREFIX)
            ? styleId.slice(MapRenderService.SEARCH_RESULT_STYLE_PREFIX.length)
            : null;
    }

    /** Looks up the active search request represented by a visualization style id. */
    private searchRequestForVisualizationStyle(styleId: string): FeatureSearchDataPlaneRequest | undefined {
        const searchId = this.searchIdFromSearchResultStyleId(styleId);
        return searchId ? this.tileStream.activeFeatureSearchRequest(searchId) : undefined;
    }

    /** Serializes search-result styling for the native renderer's direct result-value evaluator. */
    private searchResultStyleSpec(request: FeatureSearchDataPlaneRequest): string {
        const spec: SearchResultStyleSpec = {
            fallbackColor: request.pinColor?.trim() || "#ea4336",
            fallbackWidth: 4,
            fallbackPointRadius: 6,
            rules: request.searchStyleRules ?? []
        };
        return JSON.stringify(spec);
    }

    /** Keeps search-result layers above normal map styles while preserving session order. */
    private searchResultStyleOrder(searchId: string): number {
        const orderedSearchIds = this.tileStream.activeFeatureSearchRequestsSnapshot()
            .map(request => request.searchId)
            .sort();
        const index = orderedSearchIds.indexOf(searchId);
        return 10_000 + Math.max(0, index);
    }

    /** Returns true when a finished render should immediately be queued again because it became dirty meanwhile. */
    private shouldRequeueVisualizationAfterRender(viewIndex: number, visualization: ITileVisualization): boolean {
        const viewState = this.viewStates()[viewIndex];
        if (!viewState) {
            return false;
        }
        if (viewState.getVisualization(visualization.styleId, visualization.tile.mapTileKey) !== visualization) {
            return false;
        }
        const style = this.styleService.styles.get(visualization.styleId);
        const searchRequest = this.searchRequestForVisualizationStyle(visualization.styleId);
        if (searchRequest) {
            if (!(visualization instanceof DeckTileSearchVisualization)) {
                return false;
            }
            const hasRenderTile = this.tileStream.hasSearchResultRenderTile(
                searchRequest.searchId,
                visualization.tile.sourceTileKey
            );
            if (!hasRenderTile || !searchRequest.showResultsOnMap || !this.viewShowsSearchResultTile(viewIndex, visualization.tile)) {
                return false;
            }
            visualization.prefersHighFidelity = this.prefersHighFidelityForSearchResultTile(
                viewIndex,
                searchRequest.searchId,
                visualization.tile.sourceTileId
            );
            return visualization.isDirty();
        }
        if (visualization.tile.disposed || !this.tileStream.viewShowsFeatureTile(viewIndex, visualization.tile as FeatureTile)) {
            return false;
        }
        if (!searchRequest && visualization.styleId !== "_builtin" && (!style || !style.visible)) {
            return false;
        }
        return visualization.isDirty();
    }

    /** Decides whether a fidelity-policy change invalidates merged low-fi point state outright. */
    private shouldHardResetMergedPointsForPolicyChange(
        previousPrefersHighFidelity: boolean,
        previousMaxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null,
        visualization: ITileVisualization,
        styleHasExplicitLowFidelityRules: boolean
    ): boolean {
        if (visualization.prefersHighFidelity) {
            return false;
        }
        if (previousPrefersHighFidelity) {
            return true;
        }
        return styleHasExplicitLowFidelityRules && previousMaxLowFiLod !== visualization.maxLowFiLod;
    }

    /** Destroys cached merged-point artifacts for one view/layer/style family. */
    private clearMergedPointsForMapViewLayerStyleId(mapViewLayerStyleId: string): void {
        for (const removedMergedPointsTile of this.pointMergeService.clear(mapViewLayerStyleId)) {
            this.mergedTileVisualizationDestructionTopic.next(removedMergedPointsTile);
        }
    }

    /** Publishes runtime style issues collected during tile rendering. */
    private recordStyleValidationIssues(issues: StyleValidationIssue[]): void {
        for (const issue of issues) {
            this.styleValidationReportService.recordIssue(issue);
        }
    }

    /** Returns the cached signature for one highlight family. */
    private getHighlightVisualizationSignature(mode: HighlightMode): string {
        switch (mode) {
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT:
                return this.selectionHighlightSignature;
            case coreLib.HighlightMode.HOVER_HIGHLIGHT:
                return this.hoverHighlightSignature;
            default:
                return "";
        }
    }

    /** Stores the cached signature for one highlight family. */
    private setHighlightVisualizationSignature(mode: HighlightMode, signature: string): void {
        switch (mode) {
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT:
                this.selectionHighlightSignature = signature;
                break;
            case coreLib.HighlightMode.HOVER_HIGHLIGHT:
                this.hoverHighlightSignature = signature;
                break;
            default:
                break;
        }
    }

    /** Returns whether the tile participates in the current selection or hover state. */
    private isTileSelectedOrHovered(tileKey: string): boolean {
        return this.inspection.selectionTopic.getValue().some(panel =>
            panel.features.some(feature => feature.mapTileKey === tileKey))
            || this.inspection.hoverTopic.getValue().some(feature => feature.mapTileKey === tileKey);
    }

    /** Returns the mutable per-view visualization state owned by MapViewStateService. */
    private viewStates(): ViewVisualizationState[] {
        return this.viewState.viewVisualizationState;
    }

    /** Returns the combined queued visualization count across all views. */
    private visualizationQueueLength(): number {
        return this.viewStates().reduce((sum, state) => sum + state.visualizationQueue.length, 0);
    }

    /** Returns the per-view render concurrency allowed by the deck worker pipeline configuration. */
    private maxInFlightVisualizationRendersPerView(): number {
        if (!isDeckRenderWorkerPipelineEnabled()) {
            return 1;
        }
        const configuredConcurrency = getDeckRenderWorkerConcurrency();
        if (!Number.isFinite(configuredConcurrency) || configuredConcurrency < 1) {
            return 1;
        }
        return Math.max(1, Math.floor(configuredConcurrency));
    }

    /** Returns the tile plus its Moore neighborhood for render deduplication around tile seams. */
    private tileNeighborhoodForConcurrentRenderBlock(tileId: bigint): bigint[] {
        const blockedTileIds = new Set<bigint>();
        blockedTileIds.add(tileId);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                try {
                    blockedTileIds.add(BigInt(coreLib.getTileNeighbor(tileId, dx, dy)));
                } catch (_error) {
                    // Keep rendering robust at tile-grid boundaries.
                }
            }
        }
        return Array.from(blockedTileIds.values());
    }

    /** Marks one tile neighborhood as in-flight so concurrent renders do not overlap seam work. */
    private markTileInFlightForView(viewIndex: number, tileId: bigint): void {
        const blockedByView = this.inFlightBlockedTileIdsByView[viewIndex];
        if (!blockedByView) {
            return;
        }
        for (const blockedTileId of this.tileNeighborhoodForConcurrentRenderBlock(tileId)) {
            blockedByView.set(blockedTileId, (blockedByView.get(blockedTileId) ?? 0) + 1);
        }
    }

    /** Releases the in-flight neighborhood block once a visualization finished rendering. */
    private unmarkTileInFlightForView(viewIndex: number, tileId: bigint): void {
        const blockedByView = this.inFlightBlockedTileIdsByView[viewIndex];
        if (!blockedByView) {
            return;
        }
        for (const blockedTileId of this.tileNeighborhoodForConcurrentRenderBlock(tileId)) {
            const remaining = (blockedByView.get(blockedTileId) ?? 0) - 1;
            if (remaining <= 0) {
                blockedByView.delete(blockedTileId);
            } else {
                blockedByView.set(blockedTileId, remaining);
            }
        }
    }

    /** Pops the next visualization whose tile is not currently blocked by a neighbor render. */
    private dequeueNextRenderableVisualization(viewIndex: number, viewState: ViewVisualizationState): ITileVisualization | undefined {
        return viewState.visualizationQueue.dequeueNext(this.inFlightBlockedTileIdsByView[viewIndex]);
    }

    /** Enqueues a visualization through the per-view queue helper so ordering invariants stay centralized. */
    private queueVisualization(viewState: ViewVisualizationState, visualization: ITileVisualization): void {
        viewState.visualizationQueue.enqueue(visualization);
    }

    /** Starts a RAF loop that keeps an EWMA frame-time estimate for diagnostics. */
    private startFrameTimeSampling() {
        if (this.frameTimeSamplingStarted) {
            return;
        }
        this.frameTimeSamplingStarted = true;
        const sampleFrameTime = (timestampMs: number) => {
            if (!this.frameTimeSamplingStarted) {
                return;
            }
            if (this.lastAnimationFrameTimestampMs !== null) {
                const deltaMs = timestampMs - this.lastAnimationFrameTimestampMs;
                if (Number.isFinite(deltaMs) && deltaMs > 0 && deltaMs < 1000) {
                    if (this.frameTimeMsEwma <= 0) {
                        this.frameTimeMsEwma = deltaMs;
                    } else {
                        this.frameTimeMsEwma = this.frameTimeEwmaAlpha * deltaMs
                            + (1 - this.frameTimeEwmaAlpha) * this.frameTimeMsEwma;
                    }
                }
            }
            this.lastAnimationFrameTimestampMs = timestampMs;
            this.requestAnimationFrameOutsideAngular(sampleFrameTime);
        };
        this.requestAnimationFrameOutsideAngular(sampleFrameTime);
    }

    /** Schedules timer work outside Angular so frequent render churn does not trigger global change detection. */
    private scheduleOutsideAngular(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
        return this.ngZone.runOutsideAngular(() => setTimeout(callback, delay));
    }

    /** Schedules a RAF callback outside Angular for performance sampling. */
    private requestAnimationFrameOutsideAngular(callback: (timestamp: number) => void): number {
        return this.ngZone.runOutsideAngular(() => window.requestAnimationFrame(callback));
    }
}
