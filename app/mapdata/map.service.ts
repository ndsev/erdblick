import {Injectable, NgZone} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {MapTileRequestStatus, MapTileStreamClient} from "./tilestream";
import {featureSetContains, featureSetsEqual, FeatureTile, FeatureWrapper} from "./features.model";
import type {MapTileStreamStatusPayload, MapTileStreamTransportCompressionStats} from "./tilestream";
import {RelationLocateRequest, RelationLocateResult, RelationLocateResolution} from "./relation-locate.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {DeckTileVisualization} from "../mapview/deck/deck-tile.visualization.model";
import {
    configureDeckRenderWorkerSettings,
    getDeckRenderWorkerConcurrency,
    isDeckRenderWorkerPipelineEnabled
} from "../mapview/deck/deck-render.worker.pool";
import {BehaviorSubject, distinctUntilChanged, firstValueFrom, skip, Subject} from "rxjs";
import {ErdblickStyle, StyleService} from "../styledata/style.service";
import {Feature, FeatureLayerStyle, HighlightMode, TileLayerParser, Viewport} from '../../build/libs/core/erdblick-core';
import {
    AppStateService,
    InspectionPanelModel,
    TileGridMode,
    TileFeatureId,
    VIEW_SYNC_LAYERS
} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {MergedPointsTile, PointMergeService} from "../mapview/pointmerge.service";
import {KeyboardService} from "../shared/keyboard.service";
import {MapInfoItem, MapLayerTree, StyleOptionNode, SyncViewsResult} from "./map.tree.model";
import {ViewVisualizationState} from "../mapview/view.visualization.model";
import {Cartesian3} from "../integrations/geo";
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
    frameTimeMs: number;
    viewportRenderSeconds: number;
}

export interface TileVisualizationRenderTask {
    visualization: ITileVisualization;
    onDone?: () => void;
}

interface RequestedLayerProgressState {
    mapId: string;
    layerId: string;
    tileMaxRequestedStageByKey: Map<string, number>;
    stageCount: number;
}

/**
 * Erdblick map service class. This class is responsible for keeping track
 * of the following objects:
 *  (1) available maps
 *  (2) currently loaded tiles
 *  (3) rendered visualizations per view and affine style sheets.
 *
 * As the viewport changes, it requests new tiles from the mapget server
 * and triggers their conversion to render-ready buffers according to the active
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
    private selectionHighlightSignature = "";
    private hoverHighlightSignature = "";
    private viewVisualizationState: ViewVisualizationState[] = [];
    private GeometryType?: typeof coreLib.GeomType;
    private updateTimer: ReturnType<typeof setTimeout> | null = null;
    private updateInProgress: boolean = false;
    private updatePending: boolean = false;
    private updateRequestedWhilePaused: boolean = false;
    private blockedTileLoadInfoShown: boolean = false;
    private readonly updateDebounceMs: number = 50;
    private lastUpdateAt: number = 0;
    private frameTimeMsEwma: number = 0;
    private lastAnimationFrameTimestampMs: number | null = null;
    private frameTimeSamplingStarted: boolean = false;
    private readonly frameTimeEwmaAlpha: number = 0.2;
    private stageRequestProgress: Array<{done: number; total: number}> = [];
    private pendingRequestedTileKeysByStage: Array<Set<string>> = [];
    private requestedLayerProgressByKey: Map<string, RequestedLayerProgressState> = new Map();
    private observedLayerStageCountByKey: Map<string, number> = new Map();
    private dataSourceInfoJson: string | null = null;
    private selectionConversionRevision = 0;
    private backendRequestProgress: BackendRequestProgress = {done: 0, total: 0, allDone: true};
    private viewportLoadStartedAtMs: number | null = null;
    private viewportRenderCompletedAtMs: number | null = null;
    private nextVisualizationViewIndex: number = 0;
    private inFlightVisualizationRendersByView: number[] = [];
    private inFlightBlockedTileIdsByView: Array<Map<bigint, number>> = [];
    // Increments for every selection-state emission. Async selection projection
    // work captures this value and bails out if a newer emission started meanwhile.
    // This prevents stale async completions from overwriting newer close/dock updates.
    private selectionSyncRevision: number = 0;
    readonly tilePipelinePaused$ = new BehaviorSubject<boolean>(false);

    tileVisualizationTopic: Subject<TileVisualizationRenderTask>;
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
                private keyboardService: KeyboardService,
                private ngZone: NgZone) {
        this.loadedTileLayers = new Map();
        this.selectionVisualizations = [];
        this.hoverVisualizations = [];
        this.viewVisualizationState = [];

        // Triggered when a tile layer is freshly rendered and should be added to the frontend.
        this.tileVisualizationTopic = new Subject<TileVisualizationRenderTask>();

        // Triggered when a tile layer is being removed.
        this.tileVisualizationDestructionTopic = new Subject<ITileVisualization>();
        this.mergedTileVisualizationDestructionTopic = new Subject<MergedPointsTile>();

        // Triggered when the user requests to zoom to a map layer.
        this.moveToWgs84PositionTopic = new Subject<{ targetView: number, x: number, y: number, z?: number }>();
        this.moveToRectangleTopic = new Subject<{ targetView: number, rectangle: RenderRectangle }>();

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
        this.tileStream.onFeatures = (payload) => {
            this.ngZone.runOutsideAngular(() => this.addTileFeatureLayer(payload));
        };
        this.tileStream.onStatus = (status) => {
            this.ngZone.runOutsideAngular(() => this.handleTilesRequestStatus(status));
        };
        this.tileStream.onError = (event) => {
            console.error("Tile WebSocket error.", event);
        };
        this.startFrameTimeSampling();

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
            const revision = ++this.selectionConversionRevision;
            const convertedSelections: InspectionPanelModel<FeatureWrapper>[] = [];
            const pendingPanelUpdates: Array<{
                panel: InspectionPanelModel<FeatureWrapper>,
                selection: InspectionPanelModel<TileFeatureId>
            }> = [];
            const existingPanels = new Map(this.selectionTopic.getValue().map(panel => [panel.id, panel]));
            for (const selection of selected) {
                // Only push a new panel if the selection changed. Otherwise,
                // just reuse the old panel so that the inspection trees in existing
                // opened panels are not recalculated.
                const existing = existingPanels.get(selection.id);
                if (existing && featureSetsEqual(selection.features, existing.features) && deepEquals(existing.sourceData, selection.sourceData)) {
                    convertedSelections.push(existing);
                    pendingPanelUpdates.push({panel: existing, selection});
                    continue;
                }
                let features: FeatureWrapper[] = [];
                try {
                    features = await this.loadFeatures(selection.features);
                } catch (error) {
                    console.error(`Failed to resolve inspection selection for panel ${selection.id}.`, error);
                    continue;
                }
                if (revision !== this.selectionConversionRevision) {
                    return;
                }
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
            if (revision !== this.selectionConversionRevision) {
                return;
            }
            pendingPanelUpdates.forEach(update => {
                update.panel.locked = update.selection.locked;
                update.panel.color = update.selection.color;
                update.panel.size = update.selection.size;
                update.panel.undocked = update.selection.undocked ?? false;
                update.panel.inspectionDialogLayoutEntry = update.selection.inspectionDialogLayoutEntry;
            });
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
            this.refreshHighlightVisualizationIfNeeded(coreLib.HighlightMode.SELECTION_HIGHLIGHT, selectedPanels);
            // If a hovered feature is selected, eliminate it from the hover highlights.
            const hoveredFeatures = this.hoverTopic.getValue();
            if (hoveredFeatures.length) {
                this.hoverTopic.next(hoveredFeatures.filter(hoveredFeature =>
                    !selectedPanels.some(panel =>
                        panel.features.some(feature => feature.equals(hoveredFeature)))));
            }
        });
        this.hoverTopic.subscribe(hoveredFeatureWrappers => {
            this.refreshHighlightVisualizationIfNeeded(coreLib.HighlightMode.HOVER_HIGHLIGHT, [{
                features: hoveredFeatureWrappers}]);
        });
    }

    private processVisualizationTasks() {
        if (this.tilePipelinePaused) {
            this.scheduleOutsideAngular(() => this.processVisualizationTasks(), 100);
            return;
        }
        const viewCount = this.viewVisualizationState.length;
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
        const timeBudget = 20; // milliseconds
        let currentQueueLength = this.visualizationQueueLength();
        let dispatchedAny = false;
        let blockedByInFlight = false;
        let blockedByNeighbor = false;

        while (currentQueueLength > 0 && viewCount > 0) {
            // Check if the time budget is exceeded.
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            let dispatchedInRound = false;
            blockedByInFlight = false;
            for (let inspectedViews = 0; inspectedViews < viewCount; inspectedViews++) {
                const viewIndex = (this.nextVisualizationViewIndex + inspectedViews) % viewCount;
                const viewState = this.viewVisualizationState[viewIndex];
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
                        this.sortVisualizationQueue(viewState);
                    }
                    this.unmarkTileInFlightForView(viewIndex, entry.tile.tileId);
                    const inFlightCount = this.inFlightVisualizationRendersByView[viewIndex] ?? 0;
                    this.inFlightVisualizationRendersByView[viewIndex] = Math.max(
                        0,
                        inFlightCount - 1
                    );
                };
                this.tileVisualizationTopic.next({
                    visualization: entry,
                    onDone
                });
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

        // Continue visualizing tiles with a delay.
        const delay = currentQueueLength
            ? (dispatchedAny ? 0 : ((blockedByInFlight || blockedByNeighbor) ? 4 : 10))
            : 10;
        this.tryFinalizeViewportRenderDuration();
        this.scheduleOutsideAngular(() => this.processVisualizationTasks(), delay);
    }

    public get tileLayerParser(): TileLayerParser {
        return this.tileStream!.parser;
    }

    public getVisualizationCounts(): {total: number; done: number} {
        const result = {
            total: 0,
            done: 0
        };
        for (const view of this.viewVisualizationState) {
            for (const visu of view.getVisualizations()) {
                result.total += 1;
                if (!visu.isDirty()) {
                    result.done += 1;
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
            frameTimeMs: this.currentFrameTimeMs(),
            viewportRenderSeconds
        };
    }

    public getRequestedStageProgress(): Array<{done: number; total: number}> {
        return this.stageRequestProgress.map(counter => ({...counter}));
    }

    public getRequestedStageLabels(): string[] {
        const labelsByStage: Array<Set<string>> = [];
        const ensureStageLabelSet = (stage: number) => {
            while (labelsByStage.length <= stage) {
                labelsByStage.push(new Set<string>());
            }
        };

        for (const layerState of this.requestedLayerProgressByKey.values()) {
            const stageLabels = this.getLayerStageLabels(
                layerState.mapId,
                layerState.layerId,
                layerState.stageCount
            );
            for (let stage = 0; stage < layerState.stageCount; stage++) {
                ensureStageLabelSet(stage);
                labelsByStage[stage].add(stageLabels[stage] ?? `Stage ${stage}`);
            }
        }

        return this.stageRequestProgress.map((_, stage) => {
            const stageLabels = labelsByStage[stage];
            if (!stageLabels || stageLabels.size !== 1) {
                return `Stage ${stage}`;
            }
            const [label] = Array.from(stageLabels.values());
            return label;
        });
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

    private markTileInFlightForView(viewIndex: number, tileId: bigint): void {
        const blockedByView = this.inFlightBlockedTileIdsByView[viewIndex];
        if (!blockedByView) {
            return;
        }
        for (const blockedTileId of this.tileNeighborhoodForConcurrentRenderBlock(tileId)) {
            blockedByView.set(
                blockedTileId,
                (blockedByView.get(blockedTileId) ?? 0) + 1
            );
        }
    }

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

    private dequeueNextRenderableVisualization(
        viewIndex: number,
        viewState: ViewVisualizationState
    ): ITileVisualization | undefined {
        const queue = viewState.visualizationQueue;
        if (!queue.length) {
            return undefined;
        }
        const blockedTileIds = this.inFlightBlockedTileIdsByView[viewIndex];
        if (!blockedTileIds || !blockedTileIds.size) {
            return queue.shift();
        }
        for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
            const candidate = queue[queueIndex];
            if (blockedTileIds.has(candidate.tile.tileId)) {
                continue;
            }
            if (queueIndex === 0) {
                return queue.shift();
            }
            const [entry] = queue.splice(queueIndex, 1);
            return entry;
        }
        return undefined;
    }

    private sortVisualizationQueue(viewState: ViewVisualizationState): void {
        const queue = viewState.visualizationQueue;
        if (queue.length < 2) {
            return;
        }
        const rankedQueue = queue.map((visualization, index) => ({
            visualization,
            rank: visualization.renderRank(),
            tileKey: visualization.tile.mapTileKey,
            styleId: visualization.styleId,
            index
        }));
        rankedQueue.sort((lhs, rhs) => {
            if (lhs.rank !== rhs.rank) {
                return lhs.rank - rhs.rank;
            }
            const tileKeyCompare = lhs.tileKey.localeCompare(rhs.tileKey);
            if (tileKeyCompare !== 0) {
                return tileKeyCompare;
            }
            const styleIdCompare = lhs.styleId.localeCompare(rhs.styleId);
            if (styleIdCompare !== 0) {
                return styleIdCompare;
            }
            return lhs.index - rhs.index;
        });
        for (let i = 0; i < rankedQueue.length; i++) {
            queue[i] = rankedQueue[i].visualization;
        }
    }

    private queueVisualization(viewState: ViewVisualizationState, visualization: ITileVisualization): void {
        if (viewState.visualizationQueue.includes(visualization)) {
            return;
        }
        viewState.visualizationQueue.push(visualization);
    }

    private shouldRequeueVisualizationAfterRender(
        viewIndex: number,
        visualization: ITileVisualization
    ): boolean {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState) {
            return false;
        }
        if (viewState.getVisualization(visualization.styleId, visualization.tile.mapTileKey) !== visualization) {
            return false;
        }
        if (visualization.tile.disposed || !this.viewShowsFeatureTile(viewIndex, visualization.tile)) {
            return false;
        }
        const style = this.styleService.styles.get(visualization.styleId);
        if (visualization.styleId !== "_builtin" && (!style || !style.visible)) {
            return false;
        }
        return visualization.isDirty();
    }

    private clearMergedPointsForMapViewLayerStyleId(mapViewLayerStyleId: string): void {
        for (const removedMergedPointsTile of this.pointMergeService.clear(mapViewLayerStyleId)) {
            this.mergedTileVisualizationDestructionTopic.next(removedMergedPointsTile);
        }
    }

    private startFrameTimeSampling() {
        if (this.frameTimeSamplingStarted) {
            return;
        }
        if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
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

    private currentFrameTimeMs(): number {
        return Math.max(0, this.frameTimeMsEwma || 0);
    }

    private layerRequestKey(mapId: string, layerId: string): string {
        return `${mapId}/${layerId}`;
    }

    private getLayerStageLabels(
        mapId: string,
        layerId: string,
        stageCount: number
    ): string[] {
        const layerInfo = this.maps.maps.get(mapId)?.layers.get(layerId)?.info as {
            stageLabels?: unknown;
        } | undefined;
        const declaredStageLabels = Array.isArray(layerInfo?.stageLabels)
            ? layerInfo.stageLabels
            : [];
        const result: string[] = [];
        for (let stage = 0; stage < stageCount; stage++) {
            const label = declaredStageLabels[stage];
            if (typeof label === "string" && label.trim().length > 0) {
                result.push(label.trim());
            } else {
                result.push(`Stage ${stage}`);
            }
        }
        return result;
    }

    private rebuildRequestedStageProgressFromLayerState() {
        this.stageRequestProgress = [];
        this.pendingRequestedTileKeysByStage = [];
        if (!this.requestedLayerProgressByKey.size) {
            return;
        }

        const ensureStageCapacity = (stage: number) => {
            while (this.pendingRequestedTileKeysByStage.length <= stage) {
                this.pendingRequestedTileKeysByStage.push(new Set<string>());
            }
        };

        for (const layerState of this.requestedLayerProgressByKey.values()) {
            if (!layerState.tileMaxRequestedStageByKey.size) {
                continue;
            }
            for (const [tileKey, maxRequestedStage] of layerState.tileMaxRequestedStageByKey.entries()) {
                const stageLimit = Math.max(
                    0,
                    Math.min(layerState.stageCount - 1, Math.floor(maxRequestedStage))
                );
                for (let stage = 0; stage <= stageLimit; stage++) {
                    ensureStageCapacity(stage);
                    this.pendingRequestedTileKeysByStage[stage].add(tileKey);
                }
            }
        }

        for (let stage = 0; stage < this.pendingRequestedTileKeysByStage.length; stage++) {
            const pendingSet = this.pendingRequestedTileKeysByStage[stage];
            const totalRequested = pendingSet.size;
            for (const tileKey of Array.from(pendingSet)) {
                const loadedTile = this.loadedTileLayers.get(tileKey);
                if (loadedTile && loadedTile.hasStage(stage)) {
                    pendingSet.delete(tileKey);
                }
            }
            this.stageRequestProgress[stage] = {
                total: totalRequested,
                done: Math.max(0, totalRequested - pendingSet.size),
            };
        }
    }

    private resetRequestedStageProgressFromExpected(
        expectedByLayer: Map<string, {
            mapId: string;
            layerId: string;
            tileIdToRequestedMaxStage: Map<number, number>;
        }>
    ) {
        this.requestedLayerProgressByKey.clear();
        if (!expectedByLayer.size) {
            this.rebuildRequestedStageProgressFromLayerState();
            return;
        }

        for (const entry of expectedByLayer.values()) {
            if (!entry.tileIdToRequestedMaxStage.size) {
                continue;
            }
            const layerKey = this.layerRequestKey(entry.mapId, entry.layerId);
            const layerStageCount = Math.max(1, this.getLayerStageCount(entry.mapId, entry.layerId));
            const layerState: RequestedLayerProgressState = {
                mapId: entry.mapId,
                layerId: entry.layerId,
                tileMaxRequestedStageByKey: new Map<string, number>(),
                stageCount: layerStageCount
            };

            for (const [tileId, requestedMaxStage] of entry.tileIdToRequestedMaxStage.entries()) {
                const clampedMaxStage = Math.max(
                    0,
                    Math.min(layerStageCount - 1, Math.floor(requestedMaxStage))
                );
                const tileKey = coreLib.getTileFeatureLayerKey(
                    entry.mapId,
                    entry.layerId,
                    BigInt(tileId)
                );
                const existingMaxStage = layerState.tileMaxRequestedStageByKey.get(tileKey) ?? -1;
                if (clampedMaxStage > existingMaxStage) {
                    layerState.tileMaxRequestedStageByKey.set(tileKey, clampedMaxStage);
                }
            }

            if (!layerState.tileMaxRequestedStageByKey.size) {
                continue;
            }
            this.requestedLayerProgressByKey.set(layerKey, layerState);
        }

        this.rebuildRequestedStageProgressFromLayerState();
    }

    private trackObservedLayerStage(
        mapId: string,
        layerId: string,
        stage: number
    ) {
        if (!Number.isInteger(stage) || stage < 0) {
            return;
        }

        const layerKey = this.layerRequestKey(mapId, layerId);
        const observedStageCount = Math.max(
            1,
            Math.floor(stage) + 1
        );
        const previousStageCount = this.observedLayerStageCountByKey.get(layerKey) ?? 1;
        if (observedStageCount <= previousStageCount) {
            return;
        }
        this.observedLayerStageCountByKey.set(layerKey, observedStageCount);

        const requestedLayerState = this.requestedLayerProgressByKey.get(layerKey);
        if (!requestedLayerState || observedStageCount <= requestedLayerState.stageCount) {
            return;
        }
        const oldMaxStage = requestedLayerState.stageCount - 1;
        requestedLayerState.stageCount = observedStageCount;
        const newMaxStage = observedStageCount - 1;
        for (const [tileKey, maxRequestedStage] of requestedLayerState.tileMaxRequestedStageByKey.entries()) {
            if (maxRequestedStage >= oldMaxStage) {
                requestedLayerState.tileMaxRequestedStageByKey.set(tileKey, newMaxStage);
            }
        }
        this.rebuildRequestedStageProgressFromLayerState();
    }

    private markRequestedStageAsReceived(tileKey: string, stage: number) {
        if (!Number.isInteger(stage) || stage < 0 || stage >= this.pendingRequestedTileKeysByStage.length) {
            return;
        }
        const pendingSet = this.pendingRequestedTileKeysByStage[stage];
        if (!pendingSet.delete(tileKey)) {
            return;
        }
        const counter = this.stageRequestProgress[stage];
        if (!counter) {
            return;
        }
        counter.done = Math.max(0, counter.total - pendingSet.size);
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
        this.showInfoMessage('Tile pipeline paused');
        console.info(`Tile pipeline paused (${source})`);
    }

    resumeTilePipeline(source: 'diagnostics' | string = 'diagnostics') {
        if (!this.tilePipelinePaused) {
            return;
        }
        this.tilePipelinePaused$.next(false);
        this.blockedTileLoadInfoShown = false;
        this.tileStream?.setFrameProcessingPaused(false);
        this.showInfoMessage('Tile pipeline resumed');
        console.info(`Tile pipeline resumed (${source})`);

        const needsUpdate = this.updatePending
            || this.updateRequestedWhilePaused
            || this.selectionTileRequests.length > 0;
        this.updateRequestedWhilePaused = false;
        if (needsUpdate) {
            this.scheduleOutsideAngular(() => this.scheduleUpdate(), 0);
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
        this.showErrorMessage(`Tile request failed: ${summary}${detail}`);
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
        this.updateTimer = this.scheduleOutsideAngular(() => {
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
            const tileLimit = this.stateService.tilesLoadLimit / this.stateService.numViews;
            this.viewVisualizationState.forEach((state, viewIndex) => {
                state.recalculateTileIds(
                    tileLimit,
                    this.maps.allLevels(viewIndex),
                    this.stateService.cameraViewDataState.getValue(viewIndex).destination.alt
                );
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
        let stageCount = 1;
        const layerInfo = this.maps.maps.get(mapId)?.layers.get(layerId)?.info as {
            stages?: unknown;
            stageLabels?: unknown;
        } | undefined;

        if (typeof layerInfo?.stages === "number"
            && Number.isFinite(layerInfo.stages)
            && layerInfo.stages > 0) {
            stageCount = Math.max(stageCount, Math.floor(layerInfo.stages));
        }
        if (Array.isArray(layerInfo?.stageLabels) && layerInfo.stageLabels.length > 0) {
            stageCount = Math.max(stageCount, layerInfo.stageLabels.length);
        }

        const layerKey = this.layerRequestKey(mapId, layerId);
        const trackedRequestState = this.requestedLayerProgressByKey.get(layerKey);
        if (trackedRequestState) {
            stageCount = Math.max(stageCount, trackedRequestState.stageCount);
        }
        const observedStageCount = this.observedLayerStageCountByKey.get(layerKey);
        if (typeof observedStageCount === "number" && observedStageCount > 0) {
            stageCount = Math.max(stageCount, observedStageCount);
        }

        return stageCount;
    }

    private getLayerHighFidelityStage(mapId: string, layerId: string): number {
        const stageCount = this.getLayerStageCount(mapId, layerId);
        const layerInfo = this.maps.maps.get(mapId)?.layers.get(layerId)?.info as {
            highFidelityStage?: unknown;
        } | undefined;
        const fallback = stageCount > 1 ? 1 : 0;
        if (typeof layerInfo?.highFidelityStage !== "number"
            || !Number.isFinite(layerInfo.highFidelityStage)) {
            return fallback;
        }
        return Math.max(0, Math.min(stageCount - 1, Math.floor(layerInfo.highFidelityStage)));
    }

    /**
     * Returns the highest stage currently expected for this tile.
     * Visible tiles and pinned selection tiles always target the layer's max stage.
     * Returns null when the tile is currently not expected by any active view.
     */
    public getRequestedMaxStageForTile(tile: FeatureTile): number | null {
        const stageCount = this.getLayerStageCount(tile.mapName, tile.layerName);
        const maxLayerStage = Math.max(0, stageCount - 1);
        let requestedMaxStage: number | null = tile.preventCulling ? maxLayerStage : null;

        for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
            if (!this.maps.getMapLayerVisibility(viewIndex, tile.mapName, tile.layerName)) {
                continue;
            }
            if (!this.viewShowsFeatureTile(viewIndex, tile)) {
                continue;
            }
            requestedMaxStage = maxLayerStage;
            break;
        }

        return requestedMaxStage;
    }

    private styleMinimumStage(style: FeatureLayerStyle): number {
        const rawValue = style.minimumStage();
        if (!Number.isFinite(rawValue)) {
            return 0;
        }
        return Math.max(0, Math.floor(rawValue));
    }

    private tileSatisfiesStyleStage(tile: FeatureTile, style: FeatureLayerStyle): boolean {
        const highestLoadedStage = tile.highestLoadedStage();
        if (highestLoadedStage === null) {
            return false;
        }
        return highestLoadedStage >= this.styleMinimumStage(style);
    }

    public isTileInspectionDataComplete(tile: FeatureTile): boolean {
        return tile.isComplete(this.getLayerStageCount(tile.mapName, tile.layerName));
    }

    private tileMinimumMissingStage(
        mapId: string,
        layerId: string,
        tileId: bigint,
        requestedMaxStage?: number
    ): number | undefined {
        const tileKey = coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
        const tile = this.loadedTileLayers.get(tileKey);
        const stageCount = this.getLayerStageCount(mapId, layerId);
        const clampedMaxStage = Math.max(
            0,
            Math.min(
                stageCount - 1,
                Math.floor(requestedMaxStage ?? (stageCount - 1))
            )
        );
        if (!tile) {
            return clampedMaxStage >= 0 ? 0 : undefined;
        }
        return tile.nextMissingStage(clampedMaxStage + 1);
    }

    private tileRenderPolicyForView(viewIndex: number, tile: FeatureTile): {
        prefersHighFidelity: boolean;
        maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
    } {
        const viewPolicy = this.viewVisualizationState[viewIndex].getTileRenderPolicy(tile.tileId);
        return {
            prefersHighFidelity: viewPolicy.targetFidelity === "high",
            maxLowFiLod: viewPolicy.maxLowFiLod
        };
    }

    private applyTileRenderPolicyToVisualization(viewIndex: number, visualization: ITileVisualization): void {
        const policy = this.tileRenderPolicyForView(viewIndex, visualization.tile);
        visualization.highFidelityStage = this.getLayerHighFidelityStage(
            visualization.tile.mapName,
            visualization.tile.layerName
        );
        visualization.prefersHighFidelity = policy.prefersHighFidelity;
        visualization.maxLowFiLod = policy.maxLowFiLod;
    }

    private shouldHardResetMergedPointsForPolicyChange(
        previousPrefersHighFidelity: boolean,
        previousMaxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null,
        visualization: ITileVisualization,
        styleHasExplicitLowFidelityRules: boolean
    ): boolean {
        // Switching into low-fi, or tightening the active low-fi LOD cap, changes
        // the point-merge layer family itself. Returning to high-fi is handled by
        // normal tile rerenders so low-fi fallback can stay visible until replaced.
        if (visualization.prefersHighFidelity) {
            return false;
        }
        if (previousPrefersHighFidelity) {
            return true;
        }
        return styleHasExplicitLowFidelityRules && previousMaxLowFiLod !== visualization.maxLowFiLod;
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
                    this.queueVisualization(viewState, visu);
                }
            }
        }
        this.sortVisualizationQueue(viewState);
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
        let anyRenderPolicyChanged = false;
        this.viewVisualizationState.forEach((state, viewIndex) => {
            // A low-fidelity policy change invalidates merged-point aggregation as a whole.
            // Hard-reset the style family once and let subsequent tile renders rebuild it.
            const mapViewLayerStyleIdsRequiringMergedPointReset = new Set<string>();
            const visibleTileByKey = new Map<string, boolean>();
            const isVisibleForView = (tile: FeatureTile): boolean => {
                const cached = visibleTileByKey.get(tile.mapTileKey);
                if (cached !== undefined) {
                    return cached;
                }
                const visible = !tile.disposed && this.viewShowsFeatureTile(viewIndex, tile);
                visibleTileByKey.set(tile.mapTileKey, visible);
                return visible;
            };

            // Update visualizations - first, delete stale visualizations.
            for (const styleId of state.getVisualizedStyleIds()) {
                let styleEnabled = false;
                if (this.styleService.styles.has(styleId)) {
                    styleEnabled = this.styleService.styles.get(styleId)!.visible;
                }
                const removals: string[] = [];
                for (const tileVisu of state.getVisualizations(styleId)) {
                    if (!isVisibleForView(tileVisu.tile)) {
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
                    const previousHighFidelityStage = tileVisu.highFidelityStage;
                    const previousPrefersHighFidelity = tileVisu.prefersHighFidelity;
                    const previousMaxLowFiLod = tileVisu.maxLowFiLod;
                    this.applyTileRenderPolicyToVisualization(viewIndex, tileVisu);
                    const styleEntry = this.styleService.styles.get(styleId);
                    const styleHasExplicitLowFidelityRules =
                        styleEntry?.featureLayerStyle?.hasExplicitLowFidelityRules() ?? true;
                    const lowFiLodPolicyChanged =
                        styleHasExplicitLowFidelityRules
                        && previousMaxLowFiLod !== tileVisu.maxLowFiLod;
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
            for (const tile of this.loadedTileLayers.values()) {
                if (isVisibleForView(tile)) {
                    tile.setRenderOrder(state.getTileOrder(tile.tileId));
                    visibleTiles.push(tile);
                }
            }

            const visibleStyles = Array.from(this.styleService.styles.values())
                .filter(style => style.visible);

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

            // Update tile visualization queue.
            state.visualizationQueue = [];
            // Schedule new or dirty visualizations.
            for (const [layerName, tilesForLayer] of visibleTilesByLayer.entries()) {
                const applicableStyles: ErdblickStyle[] = [];
                for (const style of renderableStyles) {
                    if (style.featureLayerStyle.hasLayerAffinity(layerName)) {
                        applicableStyles.push(style);
                    }
                }
                if (!applicableStyles.length) {
                    continue;
                }
                for (const tile of tilesForLayer) {
                    for (const style of applicableStyles) {
                        this.renderTileLayer(viewIndex, tile, style);
                    }
                }
            }
            this.sortVisualizationQueue(state);
        });
        if (anyRenderPolicyChanged
            || this.selectionVisualizations.length > 0
            || this.hoverVisualizations.length > 0) {
            this.refreshHighlightVisualizationsForCurrentPolicies();
        }
    }

    private refreshHighlightVisualizationsForCurrentPolicies(): void {
        const selectionGroups = this.selectionTopic.getValue();
        this.refreshHighlightVisualizationIfNeeded(coreLib.HighlightMode.SELECTION_HIGHLIGHT, selectionGroups);
        const hoveredFeatureWrappers = this.hoverTopic.getValue();
        this.refreshHighlightVisualizationIfNeeded(coreLib.HighlightMode.HOVER_HIGHLIGHT, [{
            features: hoveredFeatureWrappers
        }]);
    }

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
                const featureIds = features
                    .map(feature => feature.featureId)
                    .sort();
                signatureParts.push(
                    `tile:${featureTile.mapTileKey}:${featureTile.dataVersion}:${featureTile.highestLoadedStage() ?? -1}:${featureIds.join(",")}`
                );

                for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                    if (!this.viewShowsFeatureTile(viewIndex, featureTile, true)) {
                        continue;
                    }

                    const renderPolicy = this.tileRenderPolicyForView(viewIndex, featureTile);
                    signatureParts.push(
                        `view:${viewIndex}:${renderPolicy.prefersHighFidelity ? 1 : 0}:${renderPolicy.maxLowFiLod ?? -1}`
                    );

                    for (const style of visibleStyles) {
                        const wasmStyle = style.featureLayerStyle;
                        if (!wasmStyle.hasLayerAffinity(featureTile.layerName)
                            || !this.tileSatisfiesStyleStage(featureTile, wasmStyle)
                            || !wasmStyle.supportsHighlightMode(mode)) {
                            continue;
                        }

                        const styleOptions = {
                            ...(this.maps.getLayerStyleOptions(
                                viewIndex,
                                featureTile.mapName,
                                featureTile.layerName,
                                style.id
                            ) ?? {})
                        };
                        if (group.color) {
                            styleOptions["selectableFeatureHighlightColor"] = group.color;
                        }
                        signatureParts.push(
                            `style:${viewIndex}:${style.id}:${style.source}:${JSON.stringify(styleOptions)}`
                        );
                    }
                }
            }
        }

        return signatureParts.join("|");
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
        type ExpectedLayerEntry = {
            mapId: string;
            layerId: string;
            tileIdToRequestedMaxStage: Map<number, number>;
        };
        const requestByLayer = new Map<string, LayerRequestEntry>();
        const expectedByLayer = new Map<string, ExpectedLayerEntry>();
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
        const trackRequestedTile = (mapId: string, layerId: string, tileId: number, requestedMaxStage: number) => {
            const key = `${mapId}/${layerId}`;
            let entry = expectedByLayer.get(key);
            if (!entry) {
                entry = {
                    mapId,
                    layerId,
                    tileIdToRequestedMaxStage: new Map<number, number>(),
                };
                expectedByLayer.set(key, entry);
            }
            const previousMaxStage = entry.tileIdToRequestedMaxStage.get(tileId);
            if (previousMaxStage === undefined || requestedMaxStage > previousMaxStage) {
                entry.tileIdToRequestedMaxStage.set(tileId, requestedMaxStage);
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
                    const selectionStageCount = this.getLayerStageCount(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId
                    );
                    const selectionRequestedMaxStage = Math.max(0, selectionStageCount - 1);
                    trackRequestedTile(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId,
                        tileId,
                        selectionRequestedMaxStage
                    );
                    const nextMissingStage = this.tileMinimumMissingStage(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId,
                        BigInt(tileId),
                        selectionRequestedMaxStage);
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
                        const stageCount = this.getLayerStageCount(mapName, layer.id);
                        const layerMaxStage = Math.max(0, stageCount - 1);
                        const requestedMaxStage = layerMaxStage;
                        // Keep progress bars as overall viewport completeness.
                        trackRequestedTile(
                            mapName,
                            layer.id,
                            Number(tileId),
                            layerMaxStage
                        );
                        const nextMissingStage = this.tileMinimumMissingStage(
                            mapName,
                            layer.id,
                            tileId,
                            requestedMaxStage);
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

        this.resetRequestedStageProgressFromExpected(expectedByLayer);

        if (this.tilePipelinePaused) {
            return;
        }
        const hasPendingRequestedStages = this.stageRequestProgress
            .some(counter => counter.total > 0 && counter.done < counter.total);
        if (!requests.length && hasPendingRequestedStages) {
            // Do not replace an active backend request with an empty one while
            // later stages are still expected to arrive automatically.
            return;
        }
        const requestSent = await this.tileStream!.updateRequest(requests);
        if (requestSent) {
            const previousProgress = this.backendRequestProgress;
            const hasPreviousProgress = previousProgress.total > 0;
            const newTotal = requests.length;
            const preservePreviousProgress = newTotal === 0
                && hasPreviousProgress
                && !previousProgress.allDone;
            if (newTotal > 0) {
                this.backendRequestProgress = {
                    done: 0,
                    total: newTotal,
                    allDone: false
                };
                this.viewportLoadStartedAtMs = performance.now();
                this.viewportRenderCompletedAtMs = null;
            } else if (!preservePreviousProgress) {
                this.backendRequestProgress = {done: 0, total: 0, allDone: true};
                this.viewportLoadStartedAtMs = performance.now();
                this.viewportRenderCompletedAtMs = this.viewportLoadStartedAtMs;
            }
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
        this.trackObservedLayerStage(mapTileMetadata.mapName, mapTileMetadata.layerName, tileStage);
        this.markRequestedStageAsReceived(canonicalMapTileKey, tileStage);

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
            tileLayer.setRenderOrder(viewState.getTileOrder(tileLayer.tileId));
            const queuedVisualizations = new Set(viewState.visualizationQueue);
            for (const visu of viewState.getVisualizations(undefined, tileKey)) {
                foundExistingVisualization = true;
                const style = this.styleService.styles.get(visu.styleId);
                if (style && !this.tileSatisfiesStyleStage(tileLayer, style.featureLayerStyle)) {
                    visu.updateStatus(false);
                    continue;
                }
                const isQueued = queuedVisualizations.has(visu);

                visu.showTileBorder = this.maps.getViewTileBorderState(viewIndex);
                this.applyTileRenderPolicyToVisualization(viewIndex, visu);
                const isDirty = visu.isDirty();

                if (!isDirty) {
                    continue;
                }

                visu.updateStatus(true);
                if (!isQueued) {
                    this.queueVisualization(viewState, visu);
                    queuedVisualizations.add(visu);
                }
            }
            this.sortVisualizationQueue(viewState);
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
            const viewState = this.viewVisualizationState[viewIndex];
            for (const [_, style] of this.styleService.styles) {
                this.renderTileLayerOnDemand(viewIndex, tileLayer, style);
            }
            this.sortVisualizationQueue(viewState);
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
        highFidelityStage: number,
        prefersHighFidelity: boolean,
        maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null,
        highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
        featureIdSubset: string[] = [],
        layerKeySuffix = "",
        boxGrid = false,
        options: Record<string, boolean | number | string> = {}
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
            (requests) => this.resolveRelationExternalTiles(requests)
        );
    }

    private async resolveRelationExternalTiles(
        requests: RelationLocateRequest[]
    ): Promise<RelationLocateResult> {
        if (requests.length === 0) {
            return {responses: [], tiles: []};
        }
        let response: Response | undefined;
        try {
            response = await fetch("locate", {
                body: JSON.stringify(
                    {requests},
                    (_, value) => typeof value === "bigint" ? Number(value) : value),
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
            return {
                responses: locateResponse.responses ?? [],
                tiles: []
            };
        }
        const loadedTiles = await this.loadTiles(tileKeys);
        const seenTileKeys = new Set<string>();
        const relationTiles: FeatureTile[] = [];
        for (const tileKey of tileKeys) {
            const tile = loadedTiles.get(tileKey) ?? null;
            if (!tile) {
                continue;
            }
            if (!tile.hasData() || seenTileKeys.has(tile.mapTileKey)) {
                continue;
            }
            seenTileKeys.add(tile.mapTileKey);
            relationTiles.push(tile);
        }
        return {
            responses: locateResponse.responses ?? [],
            tiles: relationTiles
        };
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
        const renderPolicy = this.tileRenderPolicyForView(viewIndex, tileLayer);
        const highFidelityStage = this.getLayerHighFidelityStage(mapName, layerName);
        const requestedStageDiagnostic = Math.max(0, this.getLayerStageCount(mapName, layerName) - 1);
        tileLayer.stats.set(
            `Rendering/Policy/View-${viewIndex}/RequestedMaxStage#value`,
            [requestedStageDiagnostic]);
        tileLayer.stats.set(
            `Rendering/Policy/View-${viewIndex}/HighFidelityStage#value`,
            [highFidelityStage]);
        tileLayer.stats.set(
            `Rendering/Policy/View-${viewIndex}/MaxLowFiLod#value`,
            [renderPolicy.maxLowFiLod ?? -1]);
        const existing = viewState.getVisualization(styleId, tileKey);
        if (existing) {
            existing.showTileBorder = this.maps.getViewTileBorderState(viewIndex);
            existing.highFidelityStage = highFidelityStage;
            existing.prefersHighFidelity = renderPolicy.prefersHighFidelity;
            existing.maxLowFiLod = renderPolicy.maxLowFiLod;
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
        let visu = this.createTileVisualization(
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
            this.maps.getViewTileBorderState(viewIndex),
            this.maps.getLayerStyleOptions(viewIndex, mapName, layerName, styleId)
        );
        viewState.putVisualization(styleId, tileKey, visu);
        if (!stageReady) {
            visu.updateStatus(false);
            return;
        }
        visu.updateStatus(true);
        this.queueVisualization(viewState, visu);
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
        const viewState = this.viewVisualizationState[viewIndex];
        let tiles = new Array<{
            visibilityRank: number;
            renderOrderRank: number;
            priorityRank: number;
            tile: FeatureTile;
        }>();
        for (const [_, tile] of this.loadedTileLayers) {
            if (!tile.hasData()) {
                continue;
            }
            const isVisibleInView = this.viewShowsFeatureTile(viewIndex, tile);
            const renderOrderRank = viewState.getTileOrder(tile.tileId);
            const priorityRank = coreLib.getTilePriorityById(viewState.viewport, tile.tileId);
            tiles.push({
                visibilityRank: isVisibleInView ? 0 : 1,
                renderOrderRank,
                priorityRank,
                tile
            });
        }
        tiles.sort((lhs, rhs) => {
            if (lhs.visibilityRank !== rhs.visibilityRank) {
                return lhs.visibilityRank - rhs.visibilityRank;
            }
            if (lhs.renderOrderRank !== rhs.renderOrderRank) {
                return lhs.renderOrderRank - rhs.renderOrderRank;
            }
            if (lhs.priorityRank !== rhs.priorityRank) {
                return rhs.priorityRank - lhs.priorityRank;
            }
            return lhs.tile.mapTileKey.localeCompare(rhs.tile.mapTileKey);
        });
        return tiles.map(val => val.tile);
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
        this.showInfoMessage('Tile pipeline is paused; cannot load additional tiles');
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
        if (featureId) {
            return {
                mapTileKey: canonicalTileKey,
                featureId,
                featureIndex
            };
        }
        return {
            mapTileKey: canonicalTileKey,
            featureId: `${featureIndex}`,
            featureIndex
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
        const parseFeatureIndexToken = (value: string): number | undefined => {
            if (!/^\d+$/.test(value)) {
                return undefined;
            }
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed < 0) {
                return undefined;
            }
            return parsed;
        };
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
            let featureIndex = Number.isInteger(id.featureIndex) && id.featureIndex !== undefined && id.featureIndex >= 0
                ? id.featureIndex
                : undefined;
            let resolvedFromFeatureIndex = false;

            const resolvedFromExplicitIndex = maybeResolveByIndex(featureIndex);
            if (resolvedFromExplicitIndex) {
                resolvedFeatureId = resolvedFromExplicitIndex;
                resolvedFromFeatureIndex = true;
            } else {
                const numericFeatureId = parseFeatureIndexToken(resolvedFeatureId);
                if (numericFeatureId !== undefined) {
                    featureIndex = featureIndex ?? numericFeatureId;
                    const resolvedFromNumericId = maybeResolveByIndex(numericFeatureId);
                    if (resolvedFromNumericId) {
                        resolvedFeatureId = resolvedFromNumericId;
                        resolvedFromFeatureIndex = true;
                    }
                }
            }

            if (!resolvedFeatureId && featureIndex === undefined) {
                continue;
            }

            const unresolvedNumericFeatureId =
                !resolvedFromFeatureIndex &&
                parseFeatureIndexToken(resolvedFeatureId) !== undefined;
            const useFeatureIndexFallback =
                featureIndex !== undefined &&
                (!resolvedFeatureId || unresolvedNumericFeatureId || !tile.has(resolvedFeatureId));
            if (useFeatureIndexFallback) {
                resolvedFeatureId = `${featureIndex}`;
            } else if (!tile.has(resolvedFeatureId)) {
                const parsedTileKey = this.parseMapTileKeySafe(id?.mapTileKey || "");
                const [mapId, layerId, tileId] = parsedTileKey ?? ["", "", 0n];
                this.showErrorMessage(
                    `The feature ${id?.featureId} does not exist in the ${layerId} layer of tile ${tileId} of map ${mapId}.`);
                continue;
            }

            features.push(new FeatureWrapper(resolvedFeatureId, tile, featureIndex));
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
            this.showErrorMessage(`Could not locate feature ${tileFeatureId.featureId} in ${tileFeatureId.mapTileKey}!`)
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
                    // TODO: Calculate height using a synthetic camera with target view rectangle.
                    z: center.z + 3 * boundingRadius
                }));
        });
    }

    private visualizeHighlights(
        mode: HighlightMode,
        groups: {features: FeatureWrapper[], color?: string, id?: number}[],
        signature: string = this.buildHighlightVisualizationSignature(mode, groups)
    ) {
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
                    // Do not render the highlight for any view that doesn't need it.
                    if (!this.viewShowsFeatureTile(viewIndex, featureTile, true)) {
                        continue;
                    }
                    for (let [_, style] of this.styleService.styles) {
                        if (style.visible &&
                            style.featureLayerStyle.hasLayerAffinity(featureTile.layerName) &&
                            this.tileSatisfiesStyleStage(featureTile, style.featureLayerStyle) &&
                            style.featureLayerStyle.supportsHighlightMode(mode)) {
                            const styleOptions = {
                                ...(this.maps.getLayerStyleOptions(
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
                            let visualization = this.createTileVisualization(
                                viewIndex,
                                featureTile,
                                style.featureLayerStyle,
                                style.source,
                                this.getLayerHighFidelityStage(featureTile.mapName, featureTile.layerName),
                                renderPolicy.prefersHighFidelity,
                                renderPolicy.maxLowFiLod,
                                mode,
                                featureIds,
                                groupKey,
                                false,
                                styleOptions
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
        if (viewIndex >= 0 && viewIndex < this.inFlightVisualizationRendersByView.length) {
            this.inFlightVisualizationRendersByView[viewIndex] = 0;
        }
        if (viewIndex >= 0 && viewIndex < this.inFlightBlockedTileIdsByView.length) {
            this.inFlightBlockedTileIdsByView[viewIndex].clear();
        }
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

    setViewTileGridMode(viewIndex: number, mode: TileGridMode) {
        this.maps.setViewTileGridMode(viewIndex, mode);
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

    private scheduleOutsideAngular(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
        return this.ngZone.runOutsideAngular(() => setTimeout(callback, delay));
    }

    private requestAnimationFrameOutsideAngular(callback: (timestamp: number) => void): number {
        return this.ngZone.runOutsideAngular(() => window.requestAnimationFrame(callback));
    }

    private showInfoMessage(message: string) {
        this.ngZone.run(() => this.messageService.showInfo(message));
    }

    private showErrorMessage(message: string) {
        this.ngZone.run(() => this.messageService.showError(message));
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

    findSourceDataMapsForTileId(tileId: bigint): Array<{id: string, name: string}> {
        const level = coreLib.getTileLevel(tileId);
        const result: Array<{id: string, name: string}> = [];
        for (const mapInfo of this.maps.maps.values()) {
            for (const layerInfo of mapInfo.layers.values()) {
                if (layerInfo.type != "SourceData") {
                    continue;
                }
                if (layerInfo.info.zoomLevels.length && !layerInfo.info.zoomLevels.includes(level)) {
                    continue;
                }
                result.push({id: mapInfo.id, name: mapInfo.id});
                break;
            }
        }
        return result;
    }

    visibleFeatureLevelsInView(viewIndex: number): Set<number> {
        const levels = new Set<number>();
        for (const [mapId, mapInfo] of this.maps.maps.entries()) {
            for (const layerInfo of mapInfo.layers.values()) {
                if (layerInfo.type === "SourceData") {
                    continue;
                }
                if (!this.maps.getMapLayerVisibility(viewIndex, mapId, layerInfo.id)) {
                    continue;
                }
                levels.add(this.maps.getMapLayerLevel(viewIndex, mapId, layerInfo.id));
            }
        }
        return levels;
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
