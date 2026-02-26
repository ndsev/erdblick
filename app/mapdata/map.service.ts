import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {
    MapTileRequestStatus,
    MapTileStreamClient,
} from "./tilestream";
import type {MapTileStreamStatusPayload, MapTileStreamTransportCompressionStats} from "./tilestream";
import {FeatureTile, FeatureWrapper, featureSetContains, featureSetsEqual} from "./features.model";
import {coreLib, uint8ArrayToWasm, } from "../integrations/wasm";
import {CesiumTileVisualization} from "../mapview/cesium/cesium-tile.visualization.model";
import {DeckTileVisualization} from "../mapview/deck/deck-tile.visualization.model";
import {configureDeckRenderWorkerSettings} from "../mapview/deck/deck-render.worker.pool";
import {BehaviorSubject, distinctUntilChanged, firstValueFrom, skip, Subject} from "rxjs";
import {ErdblickStyle, StyleService} from "../styledata/style.service";
import {Feature, FeatureLayerStyle, HighlightMode, Viewport, TileLayerParser} from '../../build/libs/core/erdblick-core';
import {
    AppStateService,
    InspectionPanelModel,
    TileFeatureId,
    VIEW_SYNC_LAYERS
} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {MergedPointsTile, PointMergeService} from "../mapview/pointmerge.service";
import {KeyboardService} from "../shared/keyboard.service";
import {MapInfoItem, MapLayerTree, StyleOptionNode, SyncViewsResult} from "./map.tree.model";
import {ViewVisualizationState} from "../mapview/view.visualization.model";
import {Cartesian3} from "../integrations/cesium";
import {deepEquals} from "../shared/app-state";
import {IRenderSceneHandle, ITileVisualization, RenderRectangle, RenderVector3} from "../mapview/render-view.model";

interface SelectionTileRequest {
    remoteRequest: {
        mapId: string,
        layerId: string,
        tileIds: Array<number>
    };
    tileKey: string;
    resolve: null | ((tile: FeatureTile) => void);
    reject: null | ((why: any) => void);
}

export interface BackendRequestProgress {
    done: number;
    total: number;
    allDone: boolean;
    requestId?: number;
}

export interface TileLoadingHudStats {
    backend: BackendRequestProgress;
    downstreamBytesPerSecond: number;
    pullResponses: number;
    pullGzipResponses: number;
    pullUncompressedBytes: number;
    pullCompressedBytesKnown: number;
    pullCompressionRatioPct: number | null;
    pullCompressionCoveragePct: number;
    features: number;
    vertices: number;
    parseQueueSize: number;
    renderQueueSize: number;
    viewportRenderSeconds: number;
}

/**
 * Erdblick map service class. This class is responsible for keeping track
 * of the following objects:
 *  (1) available maps
 *  (2) currently loaded tiles
 *  (3) rendered visualizations per view and affine style sheets.
 *
 * As the viewport changes, it requests new tiles from the mapget server
 * and triggers their conversion to Cesium tiles according to the active
 * style sheets.
 */
@Injectable({providedIn: 'root'})
export class MapDataService {

    public loadedTileLayers: Map<string, FeatureTile>;
    public legalInformationPerMap = new Map<string, Set<string>>();
    public legalInformationUpdated = new Subject<boolean>();
    private tileStream: MapTileStreamClient|null = null;
    private selectionVisualizations: ITileVisualization[];
    private hoverVisualizations: ITileVisualization[];
    private viewVisualizationState: ViewVisualizationState[] = [];
    private GeometryType?: typeof coreLib.GeomType;
    private updateTimer: ReturnType<typeof setTimeout> | null = null;
    private updateInProgress: boolean = false;
    private updatePending: boolean = false;
    private updateRequestedWhilePaused: boolean = false;
    private blockedTileLoadInfoShown: boolean = false;
    private readonly updateDebounceMs: number = 50;
    private lastUpdateAt: number = 0;
    private dataSourceInfoJson: string | null = null;
    private backendRequestProgress: BackendRequestProgress = {done: 0, total: 0, allDone: true};
    private viewportLoadStartedAtMs: number | null = null;
    private viewportRenderCompletedAtMs: number | null = null;
    readonly tilePipelinePaused$ = new BehaviorSubject<boolean>(false);

    tileVisualizationTopic: Subject<ITileVisualization>;
    tileVisualizationDestructionTopic: Subject<ITileVisualization>;
    mergedTileVisualizationDestructionTopic: Subject<MergedPointsTile>;
    moveToWgs84PositionTopic: Subject<{ targetView: number, x: number, y: number, z?: number }>;
    moveToRectangleTopic: Subject<{ targetView: number, rectangle: RenderRectangle }>;
    originAndNormalForFeatureZoomTopic: Subject<{ targetView: number, origin: RenderVector3, normal: RenderVector3}> = new Subject();
    hoverTopic = new BehaviorSubject<FeatureWrapper[]>([]);
    selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
    styleOptionChangedTopic: Subject<[StyleOptionNode, number]> = new Subject<[StyleOptionNode, number]>();

    maps$: BehaviorSubject<MapLayerTree> = new BehaviorSubject<MapLayerTree>(new MapLayerTree([], this.selectionTopic, this.stateService, this.styleService));
    get maps() {
        return this.maps$.getValue();
    }

    get tilePipelinePaused(): boolean {
        return this.tilePipelinePaused$.getValue();
    }

    getDataSourceInfoJson(): string | null {
        return this.dataSourceInfoJson;
    }

    selectionTileRequests: SelectionTileRequest[] = [];
    statsDialogNeedsUpdate: Subject<void> = new Subject<void>();
    selectionTileUpdated: Subject<string> = new Subject<string>();
    private selectedTileKeys: Set<string> = new Set<string>();

    constructor(public styleService: StyleService,
                public stateService: AppStateService,
                private httpClient: HttpClient,
                private messageService: InfoMessageService,
                private pointMergeService: PointMergeService,
                private keyboardService: KeyboardService) {
        this.loadedTileLayers = new Map();
        this.selectionVisualizations = [];
        this.hoverVisualizations = [];
        this.viewVisualizationState = [];

        // Triggered when a tile layer is freshly rendered and should be added to the frontend.
        this.tileVisualizationTopic = new Subject<ITileVisualization>();

        // Triggered when a tile layer is being removed.
        this.tileVisualizationDestructionTopic = new Subject<ITileVisualization>();
        this.mergedTileVisualizationDestructionTopic = new Subject<MergedPointsTile>();

        // Triggered when the user requests to zoom to a map layer.
        this.moveToWgs84PositionTopic = new Subject<{ targetView: number, x: number, y: number, z?: number }>();
        this.moveToRectangleTopic = new Subject<{ targetView: number, rectangle: RenderRectangle }>();

        const applyDeckWorkerSettings = () => {
            configureDeckRenderWorkerSettings({
                enabled: this.stateService.deckStyleWorkersEnabled,
                workerCountOverride: this.stateService.deckStyleWorkersOverride
                    ? this.stateService.deckStyleWorkersCount
                    : null
            });
        };
        applyDeckWorkerSettings();
        this.stateService.deckStyleWorkersEnabledState.subscribe(applyDeckWorkerSettings);
        this.stateService.deckStyleWorkersOverrideState.subscribe(applyDeckWorkerSettings);
        this.stateService.deckStyleWorkersCountState.subscribe(applyDeckWorkerSettings);
        this.stateService.tilePullCompressionEnabledState.subscribe(enabled => {
            this.tileStream?.setPullCompressionEnabled(enabled);
        });

        this.stateService.numViewsState.subscribe(numViews => {
            const diff = numViews - this.viewVisualizationState.length;

            if (diff > 0) {
                this.viewVisualizationState.push(
                    ...Array.from({ length: diff }, () => new ViewVisualizationState()));
            } else if (diff < 0) {
                this.viewVisualizationState.splice(diff);
            }

            this.reapplySyncOptionsForAllViews();
        });
    }

    public async initialize() {
        this.GeometryType = coreLib.GeomType;

        // Setup TileLayerStream
        this.tileStream = new MapTileStreamClient("/tiles");
        this.tileStream.setPullCompressionEnabled(this.stateService.tilePullCompressionEnabled);
        this.tileStream.setFrameProcessingPaused(this.tilePipelinePaused);
        this.tileStream.onFeatures = (payload) => this.addTileFeatureLayer(payload);
        this.tileStream.onStatus = (status) => this.handleTilesRequestStatus(status);
        this.tileStream.onError = (event) => {
            console.error("Tile WebSocket error.", event);
        };

        // Initial call to processVisualizationTasks: will keep calling itself.
        this.processVisualizationTasks();

        this.styleService.styleRemovedForId.subscribe(styleId => {
            this.viewVisualizationState.forEach(state => {
                state.visualizationQueue = [];
                for (const tileVisu of state.removeVisualizations(styleId)) {
                    this.tileVisualizationDestructionTopic.next(tileVisu);
                }
            });
            this.stateService.prune(this.maps.maps, this.styleService.styles);
        });
        this.styleService.styleAddedForId.subscribe(styleId => {
            this.viewVisualizationState.forEach((state, viewIndex) => {
                for (let [_, tileLayer] of this.loadedTileLayers) {
                    const style = this.styleService.styles.get(styleId);
                    if (style) {
                        this.renderTileLayerOnDemand(viewIndex, tileLayer, style);
                    }
                }
            });
        });
        this.styleOptionChangedTopic.subscribe(([optionNode, viewIndex]) => {
            this.applyStyleOptionChange(optionNode, viewIndex);

            if (this.isSyncOptionsForViewEnabled(viewIndex)) {
                const syncedOptions = this.maps.syncLayers(viewIndex, optionNode.mapId, optionNode.layerId);
                for (const syncedOption of syncedOptions) {
                    this.applyStyleOptionChange(syncedOption, viewIndex);
                }
            }

            const syncResult = this.syncViewsIfEnabled(viewIndex);
            if (syncResult?.viewConfigChanged) {
                this.scheduleUpdate();
            }
        });

        await this.reloadDataSources();

        let layerSyncEnabled = this.stateService.viewSync.includes(VIEW_SYNC_LAYERS);
        this.stateService.viewSyncState.subscribe(syncModes => {
            const enabled = syncModes.includes(VIEW_SYNC_LAYERS);
            if (enabled && !layerSyncEnabled) {
                const result = this.syncViewsIfEnabled(this.stateService.focusedView);
                if (result?.viewConfigChanged) {
                    this.scheduleUpdate();
                }
            }
            layerSyncEnabled = enabled;
        });

        this.stateService.numViewsState.pipe(distinctUntilChanged(), skip(1)).subscribe(_ => {
            this.stateService.prune(this.maps.maps, this.styleService.styles);
        });
        this.stateService.selectionState.subscribe(async selected => {
            const convertedSelections: InspectionPanelModel<FeatureWrapper>[] = [];
            for (const selection of selected) {
                // Only push a new panel if the selection changed. Otherwise,
                // just reuse the old panel so that the inspection trees in existing
                // opened panels are not recalculated.
                const existing = this.selectionTopic.getValue().find(p => p.id === selection.id);
                if (existing && featureSetsEqual(selection.features, existing.features) && deepEquals(existing.sourceData, selection.sourceData)) {
                    existing.locked = selection.locked;
                    existing.color = selection.color;
                    existing.size = selection.size;
                    existing.undocked = selection.undocked ?? false;
                    existing.inspectionDialogLayoutEntry = selection.inspectionDialogLayoutEntry;
                    convertedSelections.push(existing);
                    continue;
                }
                const features = await this.loadFeatures(selection.features);
                convertedSelections.push({
                    id: selection.id,
                    locked: selection.locked,
                    size: selection.size,
                    features: features,
                    sourceData: selection.sourceData,
                    color: selection.color,
                    undocked: selection.undocked ?? false,
                    inspectionDialogLayoutEntry: selection.inspectionDialogLayoutEntry
                });
            }
            this.selectionTopic.next(convertedSelections);
        });
        this.selectionTopic.subscribe(selectedPanels => {
            const nextSelectedTileKeys = new Set<string>();
            for (const panel of selectedPanels) {
                for (const feature of panel.features) {
                    nextSelectedTileKeys.add(feature.mapTileKey);
                }
                const sourceDataTileKey = panel.sourceData?.mapTileKey;
                if (sourceDataTileKey) {
                    nextSelectedTileKeys.add(sourceDataTileKey);
                }
            }
            this.selectedTileKeys = nextSelectedTileKeys;

            // TODO: Consider only visualizing updated selections/features and not the whole set of the panels
            this.visualizeHighlights(coreLib.HighlightMode.SELECTION_HIGHLIGHT, selectedPanels);
            // If a hovered feature is selected, eliminate it from the hover highlights.
            const hoveredFeatures = this.hoverTopic.getValue();
            if (hoveredFeatures.length) {
                this.hoverTopic.next(hoveredFeatures.filter(hoveredFeature =>
                    !selectedPanels.some(panel =>
                        panel.features.some(feature => feature.equals(hoveredFeature)))));
            }
        });
        this.hoverTopic.subscribe(hoveredFeatureWrappers => {
            this.visualizeHighlights(coreLib.HighlightMode.HOVER_HIGHLIGHT, [{
                features: hoveredFeatureWrappers}]);
        });
    }

    private processVisualizationTasks() {
        if (this.tilePipelinePaused) {
            setTimeout((_: any) => this.processVisualizationTasks(), 100);
            return;
        }

        const startTime = Date.now();
        const timeBudget = 20; // milliseconds
        let currentQueueLength = this.visualizationQueueLength();

        let nextViewIndexToProcess = 0;
        while (currentQueueLength > 0) {
            // Check if the time budget is exceeded.
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            const viewState = this.viewVisualizationState[nextViewIndexToProcess];
            const entry = viewState.visualizationQueue.shift();
            if (entry !== undefined) {
                this.tileVisualizationTopic.next(entry);
                currentQueueLength--;
            }
            nextViewIndexToProcess++;
            nextViewIndexToProcess %= this.viewVisualizationState.length;
        }

        // Continue visualizing tiles with a delay.
        const delay = currentQueueLength ? 0 : 10;
        this.tryFinalizeViewportRenderDuration();
        setTimeout((_: any) => this.processVisualizationTasks(), delay);
    }

    public get tileLayerParser(): TileLayerParser {
        return this.tileStream!.parser;
    }

    public getVisualizationCounts(): {total: number; done: number} {
        const result = {
            total: 0,
            done: 0
        };

        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            const view = this.viewVisualizationState[viewIndex];
            for (const [_, style] of this.styleService.styles) {
                if (!style.visible) {
                    continue;
                }
                const wasmStyle = style.featureLayerStyle;
                if (!wasmStyle || !wasmStyle.supportsHighlightMode(coreLib.HighlightMode.NO_HIGHLIGHT)) {
                    continue;
                }
                for (const tile of this.loadedTileLayers.values()) {
                    if (!this.viewShowsFeatureTile(viewIndex, tile)) {
                        continue;
                    }
                    if (!wasmStyle.hasLayerAffinity(tile.layerName)) {
                        continue;
                    }
                    ++result.total;
                    if (!this.tileSatisfiesStyleStage(tile, wasmStyle)) {
                        continue;
                    }
                    const visu = view.getVisualization(style.id, tile.mapTileKey);
                    if (visu && !visu.isDirty()) {
                        ++result.done;
                    }
                }
            }
        }

        return result;
    }

    public getBackendRequestProgress(): BackendRequestProgress {
        return {...this.backendRequestProgress};
    }

    public getTileLoadingHudStats(): TileLoadingHudStats {
        let features = 0;
        let vertices = 0;
        for (const tile of this.loadedTileLayers.values()) {
            if (!tile.hasData()) {
                continue;
            }
            const tileFeatures = Number(tile.numFeatures);
            if (Number.isFinite(tileFeatures) && tileFeatures > 0) {
                features += Math.floor(tileFeatures);
            }
            vertices += this.vertexCountFromTileStats(tile);
        }

        const downstreamBytesPerSecond = this.tileStream?.getDownstreamBytesPerSecond() ?? 0;
        const compressionStats = this.getTileStreamTransportCompressionStats();
        const parseQueueSize = this.tileStream?.getPendingFrameQueueSize() ?? 0;
        const renderQueueSize = this.visualizationQueueLength();
        const viewportRenderSeconds = this.currentViewportRenderSeconds();
        return {
            backend: this.getBackendRequestProgress(),
            downstreamBytesPerSecond,
            pullResponses: compressionStats.totalPullResponses,
            pullGzipResponses: compressionStats.totalPullGzipResponses,
            pullUncompressedBytes: compressionStats.totalUncompressedBytes,
            pullCompressedBytesKnown: compressionStats.knownCompressedBytes,
            pullCompressionRatioPct: compressionStats.compressionRatioPct,
            pullCompressionCoveragePct: compressionStats.knownCompressedCoveragePct,
            features,
            vertices,
            parseQueueSize,
            renderQueueSize,
            viewportRenderSeconds
        };
    }

    public getTileStreamTransportCompressionStats(): MapTileStreamTransportCompressionStats {
        return this.tileStream?.getTransportCompressionStats() ?? {
            totalPullResponses: 0,
            totalPullGzipResponses: 0,
            totalUncompressedBytes: 0,
            knownCompressedBytes: 0,
            knownCompressedUncompressedBytes: 0,
            responsesWithKnownCompressedBytes: 0,
            compressionRatioPct: null,
            compressionSavingsPct: null,
            knownCompressedCoveragePct: 0,
        };
    }

    private currentViewportRenderSeconds(): number {
        if (this.viewportLoadStartedAtMs === null) {
            return 0;
        }
        const endTime = this.viewportRenderCompletedAtMs ?? performance.now();
        return Math.max(0, (endTime - this.viewportLoadStartedAtMs) / 1000);
    }

    private visualizationQueueLength(): number {
        return this.viewVisualizationState.reduce(
            (sum, state) => sum + state.visualizationQueue.length,
            0
        );
    }

    private tryFinalizeViewportRenderDuration() {
        if (!this.backendRequestProgress.allDone) {
            return;
        }
        if (this.viewportLoadStartedAtMs === null || this.viewportRenderCompletedAtMs !== null) {
            return;
        }
        if (this.visualizationQueueLength() > 0) {
            return;
        }
        const rendered = this.getVisualizationCounts();
        if (rendered.total > 0 && rendered.done < rendered.total) {
            return;
        }
        this.viewportRenderCompletedAtMs = performance.now();
    }

    private vertexCountFromTileStats(tile: FeatureTile): number {
        return tile.vertexCount();
    }

    public isTileStreamConnected(): boolean {
        return this.tileStream?.isOpen() ?? false;
    }

    pauseTilePipeline(source: 'diagnostics' | string = 'diagnostics') {
        if (this.tilePipelinePaused) {
            return;
        }
        this.tilePipelinePaused$.next(true);
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        this.updateRequestedWhilePaused = this.updateRequestedWhilePaused || this.updatePending;
        this.tileStream?.setFrameProcessingPaused(true);
        this.messageService.showInfo('Tile pipeline paused');
        console.info(`Tile pipeline paused (${source})`);
    }

    resumeTilePipeline(source: 'diagnostics' | string = 'diagnostics') {
        if (!this.tilePipelinePaused) {
            return;
        }
        this.tilePipelinePaused$.next(false);
        this.blockedTileLoadInfoShown = false;
        this.tileStream?.setFrameProcessingPaused(false);
        this.messageService.showInfo('Tile pipeline resumed');
        console.info(`Tile pipeline resumed (${source})`);

        const needsUpdate = this.updatePending
            || this.updateRequestedWhilePaused
            || this.selectionTileRequests.length > 0;
        this.updateRequestedWhilePaused = false;
        if (needsUpdate) {
            setTimeout(() => this.scheduleUpdate(), 0);
        }
    }

    toggleTilePipelinePause(source: 'diagnostics' | string = 'diagnostics') {
        if (this.tilePipelinePaused) {
            this.resumeTilePipeline(source);
        } else {
            this.pauseTilePipeline(source);
        }
    }

    private handleTilesRequestStatus(status: MapTileStreamStatusPayload) {
        if (!status || status.type !== "mapget.tiles.status") {
            return;
        }
        const requests = status.requests || [];
        const statusMessage = status.message || "";
        if (statusMessage.includes("Replaced by a new /tiles WebSocket request")) {
            return;
        }
        if (statusMessage) {
            console.info("/tiles status:", statusMessage);
        }
        if (!requests.length) {
            if (status.allDone && this.backendRequestProgress.total > 0 && !this.backendRequestProgress.allDone) {
                this.backendRequestProgress = {
                    ...this.backendRequestProgress,
                    done: this.backendRequestProgress.total,
                    allDone: true,
                    requestId: status.requestId ?? this.backendRequestProgress.requestId
                };
                this.tryFinalizeViewportRenderDuration();
            }
            return;
        }
        const doneRequests = requests.filter(req => req.status !== MapTileRequestStatus.Open).length;
        this.backendRequestProgress = {
            done: doneRequests,
            total: requests.length,
            allDone: !!status.allDone,
            requestId: status.requestId
        };
        this.tryFinalizeViewportRenderDuration();

        if (!status.allDone) {
            return;
        }
        const failures = requests.filter(req =>
            req.status !== MapTileRequestStatus.Success && req.status !== MapTileRequestStatus.Open);
        if (!failures.length) {
            return;
        }
        const summary = failures
            .map(req => `${req.mapId}/${req.layerId}: ${req.statusText}`)
            .join(", ");
        const detail = statusMessage ? ` (${statusMessage})` : "";
        this.messageService.showError(`Tile request failed: ${summary}${detail}`);
    }

    public scheduleUpdate() {
        this.updatePending = true;
        if (this.tilePipelinePaused) {
            this.updateRequestedWhilePaused = true;
            return;
        }
        if (this.updateTimer) {
            return;
        }
        const elapsed = Date.now() - this.lastUpdateAt;
        const delay = Math.max(0, this.updateDebounceMs - elapsed);
        this.updateTimer = setTimeout(() => {
            this.updateTimer = null;
            this.runUpdate().then();
        }, delay);
    }

    private async runUpdate() {
        if (this.tilePipelinePaused) {
            this.updatePending = true;
            this.updateRequestedWhilePaused = true;
            return;
        }
        if (this.updateInProgress) {
            this.updatePending = true;
            return;
        }
        this.updateInProgress = true;
        this.updatePending = false;
        try {
            // Get the tile IDs for the current viewport for each view.
            const loadLimit = this.stateService.tilesLoadLimit / this.stateService.numViews;
            const visualizeLimit = this.stateService.tilesVisualizeLimit / this.stateService.numViews;
            this.viewVisualizationState.forEach((state, viewIndex) => {
                state.recalculateTileIds(loadLimit, visualizeLimit, this.maps.allLevels(viewIndex));
            });

            await this.updateMapDataRequest();
            if (this.tilePipelinePaused) {
                this.updatePending = true;
                this.updateRequestedWhilePaused = true;
                return;
            }
            this.updateEvictLoadedLayers();
            this.updateVisualizations();
        } finally {
            this.updateInProgress = false;
            this.lastUpdateAt = Date.now();
            if (this.updatePending) {
                this.scheduleUpdate();
            }
        }
    }


    getLayerStageCount(mapId: string, layerId: string): number {
        const layerStages = this.maps.maps.get(mapId)?.layers.get(layerId)?.info?.stages;
        if (typeof layerStages === "number" && Number.isFinite(layerStages) && layerStages > 0) {
            return Math.max(1, Math.floor(layerStages));
        }
        return 1;
    }

    private styleMinimumStage(style: FeatureLayerStyle): number {
        const styleWithMinimumStage = style as FeatureLayerStyle & { minimumStage?: () => number };
        if (typeof styleWithMinimumStage.minimumStage !== "function") {
            return 0;
        }
        const rawValue = styleWithMinimumStage.minimumStage();
        if (!Number.isFinite(rawValue)) {
            return 0;
        }
        return Math.max(0, Math.floor(rawValue));
    }

    private tileSatisfiesStyleStage(tile: FeatureTile, style: FeatureLayerStyle): boolean {
        const tileWithStages = tile as FeatureTile & { highestLoadedStage?: () => number | null };
        const highestLoadedStage = typeof tileWithStages.highestLoadedStage === "function"
            ? tileWithStages.highestLoadedStage()
            : (tile.hasData() ? 0 : null);
        if (highestLoadedStage === null) {
            return false;
        }
        return highestLoadedStage >= this.styleMinimumStage(style);
    }

    public isTileInspectionDataComplete(tile: FeatureTile): boolean {
        const maybeTile = tile as FeatureTile & { isComplete?: (stageCount: number) => boolean };
        if (typeof maybeTile.isComplete === "function") {
            return maybeTile.isComplete(this.getLayerStageCount(tile.mapName, tile.layerName));
        }
        return tile.hasData();
    }

    private tileMinimumMissingStage(mapId: string, layerId: string, tileId: bigint): number | undefined {
        const tileKey = coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
        const tile = this.loadedTileLayers.get(tileKey);
        if (!tile) {
            return 0;
        }
        const tileWithStages = tile as FeatureTile & { nextMissingStage?: (stageCount: number) => number | undefined };
        if (typeof tileWithStages.nextMissingStage === "function") {
            return tileWithStages.nextMissingStage(this.getLayerStageCount(mapId, layerId));
        }
        return tile.hasData() ? undefined : 0;
    }

    private canonicalizeMapTileKey(tileKey: string): string {
        const parsed = this.parseMapTileKeySafe(tileKey);
        if (!parsed) {
            return tileKey;
        }
        const [mapId, layerId, tileId] = parsed;
        return coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
    }

    private parseMapTileKeySafe(tileKey: string): [string, string, bigint] | null {
        try {
            const [mapId, layerId, tileId] = coreLib.parseMapTileKey(tileKey);
            return [mapId, layerId, BigInt(tileId as any)];
        } catch (_error) {
            const parts = tileKey.split('/');
            if (parts.length < 3) {
                return null;
            }
            try {
                return [parts[0], parts[1], BigInt(parts[2])];
            } catch (_parseError) {
                return null;
            }
        }
    }

    private ensureTilePlaceholder(mapId: string, layerId: string, tileId: bigint, preventCulling: boolean): boolean {
        const tileKey = coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
        const existing = this.loadedTileLayers.get(tileKey);
        if (existing) {
            if (preventCulling) {
                existing.preventCulling = true;
            }
            return false;
        }

        const placeholder = new FeatureTile(this.tileLayerParser, null, preventCulling, {
            mapTileKey: tileKey,
            mapName: mapId,
            layerName: layerId,
            tileId: tileId,
        });
        this.loadedTileLayers.set(tileKey, placeholder);

        return true;
    }

    private applyStyleOptionChange(optionNode: StyleOptionNode, viewIndex: number) {
        if (viewIndex >= this.viewVisualizationState.length) {
            return;
        }
        if (optionNode.value.length <= viewIndex) {
            return;
        }

        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState.hasVisualizations(optionNode.styleId)) {
            return;
        }

        const mapViewLayerStyleId = this.pointMergeService.makeMapViewLayerStyleId(
            viewIndex,
            optionNode.mapId,
            optionNode.layerId,
            optionNode.styleId,
            coreLib.HighlightMode.NO_HIGHLIGHT);
        for (const removedMergedPointsTile of this.pointMergeService.clear(mapViewLayerStyleId)) {
            this.mergedTileVisualizationDestructionTopic.next(removedMergedPointsTile);
        }

        viewState.visualizationQueue = viewState.visualizationQueue.filter(visu =>
            visu.styleId !== optionNode.styleId ||
            visu.tile.mapName !== optionNode.mapId ||
            visu.tile.layerName !== optionNode.layerId
        );

        const optionValue = optionNode.value[viewIndex];
        for (const visu of viewState.getVisualizations(optionNode.styleId)) {
            console.assert(
                visu.viewIndex === viewIndex,
                `The viewIndex of the visualization must correspond to its visualization collection index. Expected ${viewIndex}, got ${visu.viewIndex}.`
            );
            if (visu.tile.mapName === optionNode.mapId && visu.tile.layerName === optionNode.layerId) {
                const changed = visu.setStyleOption(optionNode.id, optionValue);
                if (changed || visu.isDirty()) {
                    visu.updateStatus(true);
                    viewState.visualizationQueue.unshift(visu);
                }
            }
        }
    }

    public setSyncOptionsForView(viewIndex: number, enabled: boolean) {
        const current = this.stateService.getLayerSyncOption(viewIndex);
        if (current !== enabled) {
            this.stateService.setLayerSyncOption(viewIndex, enabled);
        }
        if (!enabled) {
            return;
        }

        this.applySyncOptionsForView(viewIndex);
    }

    public isSyncOptionsForViewEnabled(viewIndex: number): boolean {
        return this.stateService.getLayerSyncOption(viewIndex);
    }

    private syncViewsIfEnabled(viewIndex: number): SyncViewsResult | null {
        if (!this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return null;
        }
        const result = this.maps.syncViews(viewIndex);
        for (const [optionNode, targetIndex] of result.styleOptionChanges) {
            this.applyStyleOptionChange(optionNode, targetIndex);
        }

        this.syncOsmSettingsFromView(viewIndex);

        return result;
    }

    private applySyncOptionsForView(viewIndex: number) {
        for (const layer of this.maps.allFeatureLayers()) {
            const syncedOptions = this.maps.syncLayers(viewIndex, layer.mapId, layer.id);
            for (const syncedOption of syncedOptions) {
                this.applyStyleOptionChange(syncedOption, viewIndex);
            }
        }
        const result = this.syncViewsIfEnabled(viewIndex);
        if (result?.viewConfigChanged) {
            this.scheduleUpdate();
        }
    }

    private reapplySyncOptionsForAllViews() {
        const numViews = this.stateService.numViews;
        for (let viewIndex = 0; viewIndex < numViews; viewIndex++) {
            if (this.stateService.getLayerSyncOption(viewIndex)) {
                this.applySyncOptionsForView(viewIndex);
            }
        }
    }

    private syncOsmSettingsFromView(viewIndex: number): boolean {
        const numViews = this.stateService.numViews;
        if (viewIndex < 0 || viewIndex >= numViews) {
            return false;
        }
        const sourceOsmEnabled = this.stateService.osmEnabledState.getValue(viewIndex);
        const sourceOsmOpacity = this.stateService.osmOpacityState.getValue(viewIndex);
        let changed = false;
        for (let targetIndex = 0; targetIndex < numViews; targetIndex++) {
            if (targetIndex === viewIndex) {
                continue;
            }
            if (this.stateService.osmEnabledState.getValue(targetIndex) !== sourceOsmEnabled) {
                this.stateService.osmEnabledState.next(targetIndex, sourceOsmEnabled);
                changed = true;
            }
            if (this.stateService.osmOpacityState.getValue(targetIndex) !== sourceOsmOpacity) {
                this.stateService.osmOpacityState.next(targetIndex, sourceOsmOpacity);
                changed = true;
            }
        }
        return changed;
    }

    public syncOsmSettings(viewIndex: number) {
        if (!this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return;
        }
        this.syncOsmSettingsFromView(viewIndex);
    }

    async reloadDataSources() {
        try {
            const result = await firstValueFrom(this.httpClient.get<Array<MapInfoItem>>("/sources"));
            const maps = result.filter(m => !m.addOn).map(mapInfo => mapInfo);
            this.maps$.next(new MapLayerTree(maps, this.selectionTopic, this.stateService, this.styleService));
            this.reapplySyncOptionsForAllViews();

            const jsonString = JSON.stringify(result);
            this.dataSourceInfoJson = jsonString;
            this.tileStream!.setDataSourceInfoJson(jsonString);
        } catch (err) {
            console.error("Failed to load data source info.", err);
        }
    }

    private updateEvictLoadedLayers() {
        // Evict present non-required tile layers.
        const evictTileLayer = (tileLayer: FeatureTile) => {
            // Is the tile needed to visualize the selection?
            if (tileLayer.preventCulling || this.selectionTopic.getValue().some(v =>
                v.features.some(feature => feature.featureTile.mapTileKey == tileLayer.mapTileKey))) {
                return false;
            }
            // Is the tile needed for any view?
            return this.viewVisualizationState.every((_, viewIndex) => {
                return !this.viewShowsFeatureTile(viewIndex, tileLayer);
            });
        }
        let newTileLayers = new Map();
        for (let tileLayer of this.loadedTileLayers.values()) {
            if (evictTileLayer(tileLayer)) {
                tileLayer.dispose();
            } else {
                newTileLayers.set(tileLayer.mapTileKey, tileLayer);
            }
        }
        this.loadedTileLayers = newTileLayers;
    }

    private updateVisualizations() {
        // Update visualizations - first, delete stale visualizations.
        this.viewVisualizationState.forEach((state, viewIndex) => {
            for (const styleId of state.getVisualizedStyleIds()) {
                let styleEnabled = false;
                if (this.styleService.styles.has(styleId)) {
                    styleEnabled = this.styleService.styles.get(styleId)!.visible;
                }
                const removals: string[] = [];
                for (const tileVisu of state.getVisualizations(styleId)) {
                    if (tileVisu.tile.disposed || !this.viewShowsFeatureTile(viewIndex, tileVisu.tile)) {
                        this.tileVisualizationDestructionTopic.next(tileVisu);
                        removals.push(tileVisu.tile.mapTileKey);
                        continue;
                    }
                    if (styleId != "_builtin" && !styleEnabled) {
                        this.tileVisualizationDestructionTopic.next(tileVisu);
                        removals.push(tileVisu.tile.mapTileKey);
                        continue;
                    }
                    tileVisu.showTileBorder = this.maps.getViewTileBorderState(viewIndex);
                    tileVisu.isHighDetail = state.highDetailTileIds.has(tileVisu.tile.tileId) || tileVisu.tile.preventCulling;
                }
                for (const tileKey of removals) {
                    state.removeVisualizations(styleId, tileKey).forEach(_ => _);
                }
            }
        });

        // Update Tile Visualization Queue.
        this.viewVisualizationState.forEach((state, viewIndex) => {
            state.visualizationQueue = [];
            // Schedule new or dirty visualizations.
            for (const [_, style] of this.styleService.styles) {
                for (let [_, tile] of this.loadedTileLayers) {
                    if (this.viewShowsFeatureTile(viewIndex, tile)) {
                        this.renderTileLayerOnDemand(viewIndex, tile, style);
                    }
                }
            }
        });
    }

    private async updateMapDataRequest() {
        if (this.tilePipelinePaused) {
            return;
        }

        type LayerRequestEntry = {
            mapId: string;
            layerId: string;
            tileIdToNextMissingStage: Map<number, number>;
        };
        const requestByLayer = new Map<string, LayerRequestEntry>();
        let placeholdersAdded = false;
        const queueTile = (mapId: string, layerId: string, tileId: number, nextMissingStage: number) => {
            const key = `${mapId}/${layerId}`;
            let entry = requestByLayer.get(key);
            if (!entry) {
                entry = {
                    mapId,
                    layerId,
                    tileIdToNextMissingStage: new Map<number, number>(),
                };
                requestByLayer.set(key, entry);
            }
            const previousStage = entry.tileIdToNextMissingStage.get(tileId);
            if (previousStage === undefined || nextMissingStage < previousStage) {
                entry.tileIdToNextMissingStage.set(tileId, nextMissingStage);
            }
        };
        for (const selectionTileRequest of this.selectionTileRequests) {
            // Do not go forward with the selection tile request, if it
            // pertains to a map layer that is not available anymore.
            const mapLayerItem = this.maps.maps
                .get(selectionTileRequest.remoteRequest.mapId)?.layers
                .get(selectionTileRequest.remoteRequest.layerId);
            if (mapLayerItem) {
                for (const tileId of selectionTileRequest.remoteRequest.tileIds) {
                    placeholdersAdded = this.ensureTilePlaceholder(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId,
                        BigInt(tileId),
                        true) || placeholdersAdded;
                    const nextMissingStage = this.tileMinimumMissingStage(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId,
                        BigInt(tileId));
                    if (nextMissingStage !== undefined) {
                        queueTile(
                            selectionTileRequest.remoteRequest.mapId,
                            selectionTileRequest.remoteRequest.layerId,
                            tileId,
                            nextMissingStage);
                    }
                }
            } else {
                selectionTileRequest.reject!("Map layer is not available.");
            }
        }

        for (const [mapName, map] of this.maps.maps) {
            for (const layer of map.allFeatureLayers()) {
                for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                    if (!this.maps.getMapLayerVisibility(viewIndex, mapName, layer.id)) {
                        continue;
                    }
                    let level = this.maps.getMapLayerLevel(viewIndex, mapName, layer.id);
                    let tileIds = this.viewVisualizationState[viewIndex].visibleTileIdsPerLevel.get(level);
                    if (tileIds === undefined) {
                        continue;
                    }
                    for (let tileId of tileIds!) {
                        const tileMapLayerKey = coreLib.getTileFeatureLayerKey(mapName, layer.id, tileId);
                        const existingTile = this.loadedTileLayers.get(tileMapLayerKey);
                        if (!existingTile) {
                            placeholdersAdded = this.ensureTilePlaceholder(mapName, layer.id, tileId, false) || placeholdersAdded;
                        }
                        const nextMissingStage = this.tileMinimumMissingStage(mapName, layer.id, tileId);
                        if (nextMissingStage !== undefined) {
                            queueTile(mapName, layer.id, Number(tileId), nextMissingStage);
                        }
                    }
                }
            }
        }

        const requests = Array.from(requestByLayer.values()).map(entry => {
            let maxRequestedStage = 0;
            for (const nextMissingStage of entry.tileIdToNextMissingStage.values()) {
                if (nextMissingStage > maxRequestedStage) {
                    maxRequestedStage = nextMissingStage;
                }
            }
            const tileIdsByNextStage = Array.from(
                {length: Math.max(1, maxRequestedStage + 1)},
                () => new Array<number>());
            for (const [tileId, nextMissingStage] of entry.tileIdToNextMissingStage.entries()) {
                tileIdsByNextStage[nextMissingStage].push(tileId);
            }
            if (tileIdsByNextStage.length <= 1) {
                return {
                    mapId: entry.mapId,
                    layerId: entry.layerId,
                    tileIds: tileIdsByNextStage[0],
                };
            }
            return {
                mapId: entry.mapId,
                layerId: entry.layerId,
                tileIdsByNextStage,
            };
        });

        if (placeholdersAdded) {
            this.statsDialogNeedsUpdate.next();
        }

        if (this.tilePipelinePaused) {
            return;
        }
        const requestSent = await this.tileStream!.updateRequest(requests);
        if (requestSent) {
            const previousProgress = this.backendRequestProgress;
            const hasPreviousProgress = previousProgress.total > 0;
            const newTotal = requests.length;
            this.backendRequestProgress = {
                done: newTotal === 0 && hasPreviousProgress
                    ? previousProgress.total
                    : 0,
                total: newTotal === 0 && hasPreviousProgress
                    ? previousProgress.total
                    : newTotal,
                allDone: newTotal === 0
            };
            this.viewportLoadStartedAtMs = performance.now();
            this.viewportRenderCompletedAtMs = newTotal === 0
                ? this.viewportLoadStartedAtMs
                : null;
        }
    }

    addTileFeatureLayer(tileLayerBlob: any, style: ErdblickStyle | null = null, preventCulling: boolean = false) {
        const mapTileMetadata = uint8ArrayToWasm((wasmBlob: any) => {
            return this.tileLayerParser.readTileLayerMetadata(wasmBlob);
        }, tileLayerBlob) as {
            id: string;
            mapName: string;
            layerName: string;
            tileId: bigint;
            stage?: number;
        };
        const tileStage = Number.isInteger(mapTileMetadata.stage) ? Number(mapTileMetadata.stage) : 0;
        const canonicalMapTileKey = mapTileMetadata.id
            ? this.canonicalizeMapTileKey(mapTileMetadata.id)
            : coreLib.getTileFeatureLayerKey(
                mapTileMetadata.mapName,
                mapTileMetadata.layerName,
                mapTileMetadata.tileId);
        const existingTile = this.loadedTileLayers.get(canonicalMapTileKey);
        let tileLayer: FeatureTile;
        if (existingTile) {
            tileLayer = existingTile;
            tileLayer.preventCulling = tileLayer.preventCulling || preventCulling;
            tileLayer.hydrateFromBlob(tileLayerBlob, tileStage);
        } else {
            tileLayer = new FeatureTile(this.tileLayerParser, tileLayerBlob, preventCulling);
            this.loadedTileLayers.set(canonicalMapTileKey, tileLayer);
        }

        // Consider, if this tile is needed by a selection tile request.
        this.selectionTileRequests = this.selectionTileRequests.filter(request => {
            if (tileLayer.mapTileKey === request.tileKey) {
                request.resolve!(tileLayer);
                return false;
            }
            return true;
        });

        this.statsDialogNeedsUpdate.next();
        if (this.selectedTileKeys.has(tileLayer.mapTileKey)) {
            this.selectionTileUpdated.next(tileLayer.mapTileKey);
        }

        // Update legal information if any.
        if (tileLayer.legalInfo) {
            this.setLegalInfo(tileLayer.mapName, tileLayer.legalInfo);
        }
        if (style && !this.styleService.styles.has(style.id)) {
            for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                if (!this.viewShowsFeatureTile(viewIndex, tileLayer)) {
                    continue;
                }
                this.renderTileLayer(viewIndex, tileLayer, style);
            }
        }

        // Fast path: only wake visualizations already tracked for this tile.
        // If none exist yet, create only the tile-local visualizations.
        const waitingUpdate = this.updateWaitingVisualizationsForTile(tileLayer);
        if (waitingUpdate.visibleInAnyView && !waitingUpdate.foundExistingVisualization) {
            this.createVisualizationsForTile(tileLayer);
        }
    }

    private updateWaitingVisualizationsForTile(tileLayer: FeatureTile): {
        foundExistingVisualization: boolean;
        visibleInAnyView: boolean;
    } {
        const tileKey = tileLayer.mapTileKey;
        let foundExistingVisualization = false;
        let visibleInAnyView = false;

        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            if (!this.viewShowsFeatureTile(viewIndex, tileLayer)) {
                continue;
            }
            visibleInAnyView = true;

            const viewState = this.viewVisualizationState[viewIndex];
            const queuedVisualizations = new Set(viewState.visualizationQueue);
            for (const visu of viewState.getVisualizations(undefined, tileKey)) {
                foundExistingVisualization = true;
                const style = this.styleService.styles.get(visu.styleId);
                if (style && !this.tileSatisfiesStyleStage(tileLayer, style.featureLayerStyle)) {
                    visu.updateStatus(false);
                    continue;
                }
                const isQueued = queuedVisualizations.has(visu);
                const isDirty = visu.isDirty();

                visu.showTileBorder = this.maps.getViewTileBorderState(viewIndex);
                visu.isHighDetail = tileLayer.preventCulling || viewState.highDetailTileIds.has(tileLayer.tileId);

                if (!isDirty) {
                    continue;
                }

                visu.updateStatus(true);
                if (!isQueued) {
                    viewState.visualizationQueue.push(visu);
                    queuedVisualizations.add(visu);
                }
            }
        }

        return {
            foundExistingVisualization,
            visibleInAnyView
        };
    }

    private createVisualizationsForTile(tileLayer: FeatureTile): void {
        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            if (!this.viewShowsFeatureTile(viewIndex, tileLayer)) {
                continue;
            }
            for (const [_, style] of this.styleService.styles) {
                this.renderTileLayerOnDemand(viewIndex, tileLayer, style);
            }
        }
    }

    private renderTileLayerOnDemand(viewIndex: number, tileLayer: FeatureTile, style: ErdblickStyle) {
        if (style.visible &&
            style.featureLayerStyle.hasLayerAffinity(tileLayer.layerName) &&
            style.featureLayerStyle.supportsHighlightMode(coreLib.HighlightMode.NO_HIGHLIGHT)) {
            this.renderTileLayer(viewIndex, tileLayer, style);
        }
    }

    private createTileVisualization(
        viewIndex: number,
        tile: FeatureTile,
        style: FeatureLayerStyle,
        styleSource: string,
        highDetail: boolean,
        highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
        featureIdSubset: string[] = [],
        boxGrid = false,
        options: Record<string, boolean | number | string> = {}
    ): ITileVisualization {
        if (this.stateService.rendererMode === "deck") {
            return new DeckTileVisualization(
                viewIndex,
                tile,
                this.pointMergeService,
                style,
                styleSource,
                highDetail,
                highlightMode,
                featureIdSubset,
                boxGrid,
                options
            );
        }
        return new CesiumTileVisualization(
            viewIndex,
            tile,
            this.pointMergeService,
            (tileKey: string) => this.getFeatureTile(tileKey),
            style,
            highDetail,
            highlightMode,
            featureIdSubset,
            boxGrid,
            options
        );
    }

    private renderTileLayer(viewIndex: number, tileLayer: FeatureTile, style: ErdblickStyle) {
        const wasmStyle = style.featureLayerStyle;
        if (!wasmStyle) {
            return;
        }
        if (!style.visible) {
            return;
        }
        if (!wasmStyle.supportsHighlightMode(coreLib.HighlightMode.NO_HIGHLIGHT)) {
            return;
        }
        const stageReady = this.tileSatisfiesStyleStage(tileLayer, wasmStyle);

        const styleId = style.id;
        const mapName = tileLayer.mapName;
        const layerName = tileLayer.layerName;
        const tileKey = tileLayer.mapTileKey;
        const viewState = this.viewVisualizationState[viewIndex];
        const existing = viewState.getVisualization(styleId, tileKey);
        if (existing) {
            existing.showTileBorder = this.maps.getViewTileBorderState(viewIndex);
            existing.isHighDetail = tileLayer.preventCulling || viewState.highDetailTileIds.has(tileLayer.tileId);
            if (!stageReady) {
                existing.updateStatus(false);
                return;
            }
            if (existing.isDirty()) {
                existing.updateStatus(true);
                viewState.visualizationQueue.push(existing);
            }
            return;
        }
        let visu = this.createTileVisualization(
            viewIndex,
            tileLayer,
            wasmStyle,
            style.source,
            tileLayer.preventCulling || viewState.highDetailTileIds.has(tileLayer.tileId),
            coreLib.HighlightMode.NO_HIGHLIGHT,
            [],
            this.maps.getViewTileBorderState(viewIndex),
            this.maps.getLayerStyleOptions(viewIndex, mapName, layerName, styleId)
        );
        viewState.putVisualization(styleId, tileKey, visu);
        if (!stageReady) {
            visu.updateStatus(false);
            return;
        }
        visu.updateStatus(true);
        viewState.visualizationQueue.push(visu);
    }

    setViewport(viewIndex: number, viewport: Viewport) {
        const maxIndex = this.viewVisualizationState.length - 1;
        if (viewIndex > maxIndex) {
            console.error(`Attempted to write @ viewIndex: ${viewIndex} but it is out of bounds (${maxIndex})`);
            return;
        }
        this.viewVisualizationState[viewIndex].viewport = viewport;
        this.scheduleUpdate();
    }

    getPrioritisedTiles(viewIndex: number) {
        let tiles = new Array<[number, FeatureTile]>();
        for (const [_, tile] of this.loadedTileLayers) {
            if (!tile.hasData()) {
                continue;
            }
            tiles.push([coreLib.getTilePriorityById(this.viewVisualizationState[viewIndex].viewport, tile.tileId), tile]);
        }
        tiles.sort((a, b) => b[0] - a[0]);
        return tiles.map(val => val[1]);
    }

    getFeatureTile(tileKey: string): FeatureTile | null {
        const canonicalTileKey = this.canonicalizeMapTileKey(tileKey);
        const tile = this.loadedTileLayers.get(canonicalTileKey);
        if (!tile || !tile.hasData()) {
            return null;
        }
        return tile;
    }

    private showPausedTileLoadInfoOnce() {
        if (this.blockedTileLoadInfoShown) {
            return;
        }
        this.blockedTileLoadInfoShown = true;
        this.messageService.showInfo('Tile pipeline is paused; cannot load additional tiles');
    }

    resolveTileFeatureIdByIndex(tileKey: string, featureIndex: number): TileFeatureId | null {
        if (!Number.isInteger(featureIndex) || featureIndex < 0) {
            return null;
        }
        const canonicalTileKey = this.canonicalizeMapTileKey(tileKey);
        const tile = this.loadedTileLayers.get(canonicalTileKey);
        if (!tile || !tile.hasData()) {
            return null;
        }
        if (featureIndex >= tile.numFeatures) {
            return null;
        }
        const featureId = tile.featureIdByIndex(featureIndex);
        if (!featureId) {
            return null;
        }
        return {
            mapTileKey: canonicalTileKey,
            featureId
        };
    }

    async loadTiles(tileKeys: Set<string | null>): Promise<Map<string, FeatureTile>> {
        const result = new Map<string, FeatureTile>();

        // TODO: Optimize this loop to make just a single update call.
        // NOTE: Currently each missing tile triggers a separate update() call, which is inefficient.
        // Should batch all missing tiles and make a single update call for better performance.
        for (const tileKey of tileKeys) {
            if (!tileKey) {
                continue;
            }

            const canonicalTileKey = this.canonicalizeMapTileKey(tileKey);
            const parsedTileKey = this.parseMapTileKeySafe(canonicalTileKey);
            if (!parsedTileKey) {
                continue;
            }
            const [mapId, layerId, tileId] = parsedTileKey;

            let tile = this.loadedTileLayers.get(canonicalTileKey);
            if (tile && tile.hasData()) {
                result.set(tileKey, tile);
                result.set(canonicalTileKey, tile);
                continue;
            }

            if (this.tilePipelinePaused) {
                this.showPausedTileLoadInfoOnce();
                continue;
            }

            const selectionTileRequest: SelectionTileRequest =  {
                remoteRequest: {
                    mapId: mapId,
                    layerId: layerId,
                    tileIds: [Number(tileId)],
                },
                tileKey: canonicalTileKey,
                resolve: null,
                reject: null
            };

            const selectionTilePromise = new Promise<FeatureTile>((resolve, reject) => {
                selectionTileRequest.resolve = resolve;
                selectionTileRequest.reject = reject;
            });

            this.selectionTileRequests.push(selectionTileRequest);
            this.scheduleUpdate();
            tile = await selectionTilePromise;
            result.set(tileKey, tile);
            result.set(canonicalTileKey, tile);
        }

        return result;
    }

    async loadFeatures(tileFeatureIds: (TileFeatureId | null)[]): Promise<FeatureWrapper[]> {
        const normalizedIds = tileFeatureIds.filter((tileFeatureId): tileFeatureId is TileFeatureId => !!tileFeatureId);

        // Load the tiles.
        const tiles = await this.loadTiles(new Set(normalizedIds.map(id => id.mapTileKey)));

        // Ensure that the feature really exists in the tile.
        const features: FeatureWrapper[] = [];
        for (const id of normalizedIds) {
            const tile = tiles.get(id?.mapTileKey || "");
            if (!tile) {
                console.error(`Could not load tile ${id?.mapTileKey} for highlighting!`);
                continue;
            }

            const maybeResolveByIndex = (featureIndex: number | undefined): string | null => {
                if (!Number.isInteger(featureIndex) || featureIndex === undefined || featureIndex < 0) {
                    return null;
                }
                return tile.featureIdByIndex(featureIndex);
            };

            let resolvedFeatureId = id?.featureId || "";
            const idWithOptionalIndex = id as TileFeatureId & { featureIndex?: number };
            const resolvedFromExplicitIndex = maybeResolveByIndex(idWithOptionalIndex.featureIndex);
            if (resolvedFromExplicitIndex) {
                resolvedFeatureId = resolvedFromExplicitIndex;
            } else {
                const numericFeatureId = Number(resolvedFeatureId);
                if (Number.isInteger(numericFeatureId) && numericFeatureId >= 0) {
                    const resolvedFromNumericId = maybeResolveByIndex(numericFeatureId);
                    if (resolvedFromNumericId) {
                        resolvedFeatureId = resolvedFromNumericId;
                    }
                }
            }

            if (!resolvedFeatureId) {
                continue;
            }

            if (!tile.has(resolvedFeatureId)) {
                const parsedTileKey = this.parseMapTileKeySafe(id?.mapTileKey || "");
                const [mapId, layerId, tileId] = parsedTileKey ?? ["", "", 0n];
                this.messageService.showError(
                    `The feature ${id?.featureId} does not exist in the ${layerId} layer of tile ${tileId} of map ${mapId}.`);
                continue;
            }

            features.push(new FeatureWrapper(resolvedFeatureId, tile));
        }
        return features;
    }

    async setHoveredFeatures(tileFeatureIds: (TileFeatureId | null)[]) {
        const features = await this.loadFeatures(tileFeatureIds);
        if (!features.length) {
            this.hoverTopic.next(features);
            return;
        }

        const selectedFeatures = this.selectionTopic.getValue().flatMap(panel => panel.features);
        const currentHover = this.hoverTopic.getValue();

        if (featureSetsEqual(selectedFeatures, features) || featureSetsEqual(currentHover, features)) {
            return;
        }
        if (featureSetContains(selectedFeatures, features)) {
            if (currentHover.length) {
                this.hoverTopic.next([]);
            }
            return;
        }
        this.hoverTopic.next(features);
    }

    async focusOnFeature(viewIndex: number, tileFeatureId: TileFeatureId) {
        const features = await this.loadFeatures([tileFeatureId]);
        if (!features.length) {
            this.messageService.showError(`Could not locate feature ${tileFeatureId.featureId} in ${tileFeatureId.mapTileKey}!`)
            return;
        }
        const position = features[0].peek((parsedFeature: Feature) => parsedFeature.center());
        this.moveToWgs84PositionTopic.next({targetView: viewIndex, x: position.x, y: position.y});
    }

    zoomToFeature(viewIndex: number|undefined, featureWrapper: FeatureWrapper) {
        const runForTargetViewOrAllAffected = (cb: (viewIndex: number)=>void) => {
            if (viewIndex !== undefined) {
                cb(viewIndex);
            }
            for (let i = 0; i < this.stateService.numViews; ++i) {
                if (this.viewShowsFeatureTile(i, featureWrapper.featureTile, true)) {
                    cb(i);
                }
            }
        }

        featureWrapper.peek((feature: Feature) => {
            const center = feature.center() as Cartesian3;
            const centerCartesian = Cartesian3.fromDegrees(center.x, center.y, center.z);
            let radiusPoint = feature.boundingRadiusEndPoint() as Cartesian3;
            radiusPoint = Cartesian3.fromDegrees(radiusPoint.x, radiusPoint.y, radiusPoint.z);
            const boundingRadius = Cartesian3.distance(centerCartesian, radiusPoint);
            const geometryType = feature.getGeometryType() as any;

            if (geometryType === this.GeometryType?.Mesh) {
                // Get the first triangle from the mesh, and calculate the
                // camera perspective from its normal.
                // TODO: Use a more efficient WASM function like feature.firstTriangle() to get the first triangle.
                const inspectionModel = feature.inspectionModel()
                let triangle: Array<Cartesian3> = [];
                if (this) {
                    for (const section of inspectionModel) {
                        if (section.key == "Geometry") {
                            for (let i = 0; i < 3; i++) {
                                const cartographic = section.children[0].children[i].value.map((coordinate: string) => Number(coordinate));
                                if (cartographic.length == 3) {
                                    triangle.push(Cartesian3.fromDegrees(cartographic[0], cartographic[1], cartographic[2]));
                                }
                            }
                            break;
                        }
                    }
                }
                const normal = Cartesian3.cross(
                    Cartesian3.subtract(triangle[1], triangle[0], new Cartesian3()),
                    Cartesian3.subtract(triangle[2], triangle[0], new Cartesian3()),
                    new Cartesian3()
                );
                Cartesian3.negate(normal, normal);
                Cartesian3.normalize(normal, normal);
                Cartesian3.multiplyByScalar(normal, 3 * boundingRadius, normal);
                runForTargetViewOrAllAffected(vi =>
                    this.originAndNormalForFeatureZoomTopic.next({
                        targetView: vi,
                        origin: {x: centerCartesian.x, y: centerCartesian.y, z: centerCartesian.z},
                        normal: {x: normal.x, y: normal.y, z: normal.z}
                    }));
            }

            // Fallback for lines/points: Just move the camera to the position.
            runForTargetViewOrAllAffected(vi =>
                this.moveToWgs84PositionTopic.next({
                    targetView: vi,
                    x: center.x,
                    y: center.y,
                    // TODO: Calculate height using faux Cesium camera with target view rectangle.
                    z: center.z + 3 * boundingRadius
                }));
        });
    }

    *tileLayersForTileId(tileId: bigint): Generator<FeatureTile> {
        for (const tile of this.loadedTileLayers.values()) {
            if (tile.tileId == tileId && tile.hasData()) {
                yield tile;
            }
        }
    }

    private visualizeHighlights(mode: HighlightMode, groups: {features: FeatureWrapper[], color?: string, id?: number}[]) {
        let visualizationCollection = null;
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

        // Apply highlight styles.
        for (const group of groups) {
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
                    // Do not render the highlight for any view that doesn't need it.
                    if (!this.viewShowsFeatureTile(viewIndex, featureTile, true)) {
                        continue;
                    }
                    for (let [_, style] of this.styleService.styles) {
                        if (style.visible &&
                            style.featureLayerStyle.hasLayerAffinity(featureTile.layerName) &&
                            this.tileSatisfiesStyleStage(featureTile, style.featureLayerStyle) &&
                            style.featureLayerStyle.supportsHighlightMode(mode)) {
                            const styleOptions = this.maps.getLayerStyleOptions(
                                viewIndex, featureTile.mapName, featureTile.layerName, style.id) ?? {};
                            if (group.color) {
                                styleOptions["selectableFeatureHighlightColor"] = group.color;
                            }
                            let visualization = this.createTileVisualization(
                                viewIndex,
                                featureTile,
                                style.featureLayerStyle,
                                style.source,
                                true,
                                mode,
                                featureIds,
                                false,
                                styleOptions
                            );
                            this.tileVisualizationTopic.next(visualization);
                            visualizationCollection.push(visualization);
                        }
                    }
                }
            }
        }
    }

    private setLegalInfo(mapName: string, legalInfo: string): void {
        if (this.legalInformationPerMap.has(mapName)) {
            this.legalInformationPerMap.get(mapName)!.add(legalInfo);
        } else {
            this.legalInformationPerMap.set(mapName, new Set<string>().add(legalInfo));
        }
        this.legalInformationUpdated.next(true);
    }

    /**
     * Clean up all tile visualizations - used during viewer deletion.
     */
    clearAllTileVisualizations(viewIndex: number, sceneHandle: IRenderSceneHandle): void {
        if (viewIndex >= this.stateService.numViews) {
            return;
        }
        for (const tileVisu of this.viewVisualizationState[viewIndex].removeVisualizations()) {
            try {
                tileVisu.destroy(sceneHandle);
            } catch (error) {
                console.warn('Error destroying tile visualization:', error);
            }
        }
        this.viewVisualizationState[viewIndex].visualizationQueue = [];
    }

    setMapLayerVisibility(viewIndex: number, mapOrGroupId: string, layerId: string = "", state: boolean) {
        this.maps.setMapLayerVisibility(viewIndex, mapOrGroupId, layerId, state);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    toggleViewTileBorderVisibility(viewIndex: number) {
        const nextState = !this.maps.getViewTileBorderState(viewIndex);
        this.maps.setViewTileBorderState(viewIndex, nextState);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    setMapLayerLevel(viewIndex: number, mapId: string, layerId: string, level: number) {
        this.maps.setMapLayerLevel(viewIndex, mapId, layerId, level);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    private viewShowsFeatureTile(viewIndex: number, tile: FeatureTile, skipViewportCheck: boolean = false) {
        if (viewIndex >= this.viewVisualizationState.length) {
            console.error("Attempt to access non-existing view index.");
            return false;
        }
        if (!skipViewportCheck) {
            const viewState = this.viewVisualizationState[viewIndex];
            if (!viewState.visibleTileIds.has(tile.tileId)) {
                return false;
            }
        }
        return this.maps.getMapLayerVisibility(viewIndex, tile.mapName, tile.layerName) &&
            tile.level() === this.maps.getMapLayerLevel(viewIndex, tile.mapName, tile.layerName);
    }

    /**
     * Returns an internal layerId for a human-readable layer name.
     *
     * @param layerName Layer id to get the name for
     */
    sourceDataLayerIdForLayerName(layerName: string) {
        for (const [_, mapInfo] of this.maps.maps.entries()) {
            for (const [_, layerInfo] of mapInfo.layers.entries()) {
                if (layerInfo.type == "SourceData") {
                    if (this.layerNameForSourceDataLayerId(layerInfo.id) == layerName ||
                        this.layerNameForSourceDataLayerId(layerInfo.id) == layerName.replace('-', '.') ||
                        layerInfo.id == layerName) {
                        return layerInfo.id;
                    }
                }
            }
        }
        return null;
    }

    findLayersForMapId(mapId: string, isMetadata: boolean = false) {
        const map = this.maps.maps.get(mapId);
        if (map) {
            const prefix = isMetadata ? "Metadata" : "SourceData";
            const dataLayers = new Set<string>();
            for (const layer of map.layers.values()) {
                if (layer.type === "SourceData" && layer.id.startsWith(prefix)) {
                    dataLayers.add(layer.id);
                }
            }
            return [...dataLayers].map(layerId => ({
                id: layerId,
                name: this.layerNameForSourceDataLayerId(layerId, isMetadata)
            })).sort((a, b) => a.name.localeCompare(b.name));
        }
        return [];
    }

    /**
     * Returns a human-readable layer name for a layer id.
     *
     * @param layerId Layer id to get the name for
     * @param isMetadata Matches the metadata SourceDataLayers
     */
    layerNameForSourceDataLayerId(layerId: string, isMetadata: boolean = false) {
        const match = isMetadata ?
            layerId.match(/^Metadata-(.+)-(.+)/) : layerId.match(/^SourceData-(.+-[^-]+)/);
        if (!match) {
            return layerId;
        }
        return isMetadata ? match[2] :`${match[1]}`.replace('-', '.');
    }
}
