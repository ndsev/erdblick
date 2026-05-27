import {Injectable, NgZone} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {MapTileRequestStatus, MapTileStreamClient} from "./tilestream";
import {featureSetContains, featureSetsEqual, FeatureTile, FeatureWrapper} from "./features.model";
import type {
    MapTileStreamSearchStatusPayload,
    MapTileStreamStatusPayload,
    MapTileStreamTransportCompressionStats
} from "./tilestream";
import {RelationLocateRequest, RelationLocateResult, RelationLocateResolution} from "./relation-locate.model";
import {coreLib, uint8ArrayFromWasm, uint8ArrayToWasm} from "../integrations/wasm";
import {DeckTileVisualization} from "../mapview/deck/deck-tile.visualization.model";
import {DeckTileSearchVisualization} from "../mapview/deck/deck-tile-search.visualization.model";
import {
    configureDeckRenderWorkerSettings,
    getDeckRenderWorkerConcurrency,
    isDeckRenderWorkerPipelineEnabled
} from "../mapview/deck/deck-render.worker.pool";
import {BehaviorSubject, distinctUntilChanged, firstValueFrom, skip, Subject} from "rxjs";
import {ErdblickStyle, StyleService} from "../styledata/style.service";
import {StyleValidationIssue, StyleSourceRef} from "../styledata/style-validation.model";
import {StyleValidationReportService} from "../styledata/style-validation-report.service";
import {Feature, FeatureLayerStyle, HighlightMode, TileLayerParser, Viewport} from '../../build/libs/core/erdblick-core';
import {
    AppStateService,
    InspectionPanelModel,
    SelectedSourceData,
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
import {
    IRenderSceneHandle,
    ITileVisualization,
    RenderRectangle,
    type TileVisualizationTile
} from "../mapview/render-view.model";
import {SearchResultTile} from "./search-result-tile.model";
import {
    normalizeFeatureSearchRenderStrategy,
    type FeatureSearchRenderStrategy,
    type FeatureSearchScope,
    type FeatureSearchStyleRule
} from "../shared/feature-search-state";
import {tileGridVisibleCellCount} from "../mapview/tile-grid-visibility";

interface SelectionTileRequest {
    remoteRequest: {
        mapId: string,
        layerId: string,
        tileIds: Array<number>
    };
    tileKey: string;
    /** Keep the request pending until the selected tile has enough stages for inspection. */
    resolveWhenInspectionComplete?: boolean;
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

export type TileDataChangeReason = "placeholder" | "loaded" | "evicted";

export interface TileDataChange {
    tileKey: string;
    tile: FeatureTile;
    reason: TileDataChangeReason;
}

interface RequestedLayerProgressState {
    mapId: string;
    layerId: string;
    tileMaxRequestedStageByKey: Map<string, number>;
    stageCount: number;
}

interface Wgs84Point {
    x: number;
    y: number;
    z?: number;
}

export interface FeatureSearchDataPlaneRequest {
    searchId: string;
    query: string;
    scope: FeatureSearchScope;
    autoUpdate: boolean;
    updateSerial: number;
    generationSerial: number;
    paused: boolean;
    showResultsOnMap: boolean;
    pinColor: string;
    searchStyleRules: FeatureSearchStyleRule[];
    renderStrategy: FeatureSearchRenderStrategy;
    withFields: string[];
}

export interface SearchResultTileEntry {
    mapTileKey: string;
    featureId: string;
    resultIndex: number;
    position: {
        cartesian: {x: number, y: number, z: number};
        cartographic: {x: number, y: number, z: number} | null;
        cartographicRad?: {longitude: number, latitude: number, height: number} | null;
    };
    values?: unknown[];
    attributeIndex?: number;
    validityIndex?: number;
    validityCount?: number;
}

export interface SearchResultTilePayload {
    searchId: string;
    refresh: number;
    mapId: string;
    layerId: string;
    tileId: bigint;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: bigint;
    resultCount: number;
    resultFields: string[];
    tilesConsidered?: number;
    tilesCompleted?: number;
    traces: Record<string, unknown> | null;
    diagnostics: Uint8Array | null;
    entries: SearchResultTileEntry[];
}

export interface SearchResultTileEvictedPayload {
    searchId: string;
    sourceTileKey: string;
}

interface SearchLayerTileSet {
    mapId: string;
    layerId: string;
    tileIds: Set<number>;
    priorityTileIds: Set<number>;
}

interface FeatureSearchTileState {
    mapId: string;
    layerId: string;
    tileId: number;
    sourceTileKey: string;
    refresh: number;
    priority: boolean;
    requested: boolean;
    completed: boolean;
}

interface FeatureSearchTileRequest {
    mapId: string;
    layerId: string;
    tileIds: number[];
    priorityTileIds?: number[];
    searchId: string;
    refresh: number;
    searchQuery: string;
    searchScope: "feature" | "attribute";
    withFields?: string[];
}

interface SearchResultRenderTile {
    searchId: string;
    refresh: number;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: bigint;
    tile: SearchResultTile;
}

interface SearchResultStyleSpec {
    fallbackColor: string;
    fallbackWidth: number;
    fallbackPointRadius: number;
    rules: FeatureSearchStyleRule[];
}

export interface FeatureSearchAttributeScopeCandidate {
    attrName: string;
    attrLayerName: string;
    featureType: string;
    mapId: string;
    layerId: string;
}

export interface FeatureSearchStyleFieldCandidate {
    path: string;
    mapId: string;
    layerId: string;
    attrName?: string;
    featureType?: string;
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
    private static readonly AUTO_LAYER_LEVEL_MAX_VISIBLE_TILES = 64;
    private static readonly SEARCH_RESULT_STYLE_PREFIX = "__search_result__:";

    public loadedTileLayers: Map<string, FeatureTile>;
    public legalInformationPerMap = new Map<string, Set<string>>();
    public legalInformationUpdated = new Subject<boolean>();
    private tileStream: MapTileStreamClient|null = null;
    private selectionVisualizations: ITileVisualization[];
    private hoverVisualizations: ITileVisualization[];
    private selectionHighlightSignature = "";
    private hoverHighlightSignature = "";
    private viewVisualizationState: ViewVisualizationState[] = [];
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
    private activeFeatureSearchRequests: Map<string, FeatureSearchDataPlaneRequest> = new Map();
    private pendingFeatureSearchCancellations: Map<string, FeatureSearchDataPlaneRequest> = new Map();
    private pendingFeatureSearchCancellationLayerKeysById: Map<string, Set<string>> = new Map();
    private lastFeatureSearchRequestSignature = "";
    private featureSearchRefreshById: Map<string, number> = new Map();
    private featureSearchFingerprintById: Map<string, string> = new Map();
    private lastFeatureSearchUpdateSerialById: Map<string, number> = new Map();
    private featureSearchTileStatesById: Map<string, Map<string, FeatureSearchTileState>> = new Map();
    private searchResultRenderTilesByKey: Map<string, SearchResultRenderTile> = new Map();
    private searchResultMaxRefreshById: Map<string, number> = new Map();
    private attributeScopesByQueryCache = new Map<string, FeatureSearchAttributeScopeCandidate[]>();
    private searchStyleFieldsByQueryCache = new Map<string, FeatureSearchStyleFieldCandidate[]>();
    private selectionConversionRevision = 0;
    private hoverConversionRevision = 0;
    private lastHoverRequestSignature = "";
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
    hoverTopic = new BehaviorSubject<FeatureWrapper[]>([]);
    selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
    styleOptionChangedTopic: Subject<[StyleOptionNode, number]> = new Subject<[StyleOptionNode, number]>();

    maps$: BehaviorSubject<MapLayerTree> = new BehaviorSubject<MapLayerTree>(new MapLayerTree([], this.selectionTopic, this.stateService, this.styleService));
    /** Returns the mutable map tree owned by the map data service. */
    get maps() {
        return this.maps$.getValue();
    }

    /** Returns whether tile loading and rendering are currently paused. */
    get tilePipelinePaused(): boolean {
        return this.tilePipelinePaused$.getValue();
    }

    /** Returns datasource metadata as a JSON string for diagnostics and debug views. */
    getDataSourceInfoJson(): string | null {
        return this.dataSourceInfoJson;
    }

    /** Replaces the active server-side feature-search definitions used by the next `/tiles` request. */
    setFeatureSearchRequests(requests: FeatureSearchDataPlaneRequest[]): void {
        const normalized = requests
            .filter(request => request.searchId && request.query)
            .map(request => ({
                ...request,
                autoUpdate: !!request.autoUpdate,
                updateSerial: Number.isFinite(Number(request.updateSerial))
                    ? Math.max(0, Math.floor(Number(request.updateSerial)))
                    : 0,
                generationSerial: Number.isFinite(Number(request.generationSerial))
                    ? Math.max(0, Math.floor(Number(request.generationSerial)))
                    : 0,
                paused: !!request.paused,
                showResultsOnMap: request.showResultsOnMap !== false,
                pinColor: (request.pinColor || "").trim(),
                searchStyleRules: [...(request.searchStyleRules ?? [])],
                renderStrategy: normalizeFeatureSearchRenderStrategy(request.renderStrategy),
                withFields: Array.from(new Set((request.withFields ?? []).filter(Boolean))).sort()
            }))
            .sort((lhs, rhs) => lhs.searchId.localeCompare(rhs.searchId));
        const signature = JSON.stringify(normalized);
        if (signature === this.lastFeatureSearchRequestSignature) {
            return;
        }

        const nextIds = new Set(normalized.map(request => request.searchId));
        for (const [searchId, request] of this.activeFeatureSearchRequests) {
            if (!nextIds.has(searchId)) {
                this.pendingFeatureSearchCancellations.set(searchId, request);
                this.pendingFeatureSearchCancellationLayerKeysById.set(
                    searchId,
                    this.layerKeysForFeatureSearchTileStates(searchId)
                );
                this.clearFeatureSearchTileStates(searchId, true);
            }
        }

        this.activeFeatureSearchRequests = new Map(normalized.map(request => [request.searchId, request]));
        for (const request of normalized) {
            this.refreshForFeatureSearchDefinition(request);
        }
        this.lastFeatureSearchRequestSignature = signature;
        this.scheduleUpdate();
    }

    selectionTileRequests: SelectionTileRequest[] = [];
    tileDataChanged: Subject<TileDataChange> = new Subject<TileDataChange>();
    selectionTileUpdated: Subject<string> = new Subject<string>();
    searchResultTileReceived: Subject<SearchResultTilePayload> = new Subject<SearchResultTilePayload>();
    searchResultTileEvicted: Subject<SearchResultTileEvictedPayload> = new Subject<SearchResultTileEvictedPayload>();
    searchStatusReceived: Subject<MapTileStreamSearchStatusPayload> = new Subject<MapTileStreamSearchStatusPayload>();
    private selectedTileKeys: Set<string> = new Set<string>();

    constructor(public styleService: StyleService,
                public stateService: AppStateService,
                private httpClient: HttpClient,
                private messageService: InfoMessageService,
                private pointMergeService: PointMergeService,
                private keyboardService: KeyboardService,
                private ngZone: NgZone,
                private styleValidationReportService: StyleValidationReportService = new StyleValidationReportService()) {
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
        this.keyboardService.registerShortcut("Ctrl+j", this.zoomToFocusedInspectionPanel.bind(this));

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
        this.stateService.pinLowFiToMaxLodState.subscribe(() => {
            this.scheduleUpdate();
        });
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

    /**
     * Wires the tile stream, style/state subscriptions, and the long-lived visualization pump.
     * This is the service's real startup hook and must run before any viewport-driven work starts.
     */
    public async initialize() {
        // Setup TileLayerStream
        this.tileStream = new MapTileStreamClient("/tiles");
        this.tileStream.setPullCompressionEnabled(this.stateService.tilePullCompressionEnabled);
        this.tileStream.setFrameProcessingPaused(this.tilePipelinePaused);
        this.tileStream.onFeatures = (payload) => {
            this.ngZone.runOutsideAngular(() => this.addTileFeatureLayer(payload));
        };
        this.tileStream.onSearchResults = (payload) => {
            this.ngZone.runOutsideAngular(() => this.addTileSearchResultLayer(payload));
        };
        this.tileStream.onStatus = (status) => {
            this.ngZone.runOutsideAngular(() => this.handleTilesRequestStatus(status));
        };
        this.tileStream.onSearchStatus = (status) => {
            this.ngZone.runOutsideAngular(() => this.handleSearchStatus(status));
        };
        this.tileStream.onError = (event) => {
            console.error("Tile WebSocket error.", event);
        };
        this.startFrameTimeSampling();

        // Initial call to processVisualizationTasks: will keep calling itself.
        this.processVisualizationTasks();

        this.styleService.styleRemovedForId.subscribe(styleId => {
            this.viewVisualizationState.forEach(state => {
                state.visualizationQueue.clear();
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
                let features: FeatureWrapper[];
                try {
                    features = await this.loadFeatures(selection.features, {allowIncomplete: true});
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
                    focused: selection.focused,
                    size: selection.size,
                    features: features,
                    sourceData: selection.sourceData,
                    color: selection.color,
                    undocked: selection.undocked ?? false
                });
            }
            if (revision !== this.selectionConversionRevision) {
                return;
            }
            pendingPanelUpdates.forEach(update => {
                update.panel.locked = update.selection.locked;
                update.panel.focused = update.selection.focused;
                update.panel.color = update.selection.color;
                update.panel.size = update.selection.size;
                update.panel.undocked = update.selection.undocked ?? false;
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

    /**
     * Continuously dispatches dirty visualizations under a small frame budget.
     * Neighboring tiles are intentionally blocked from concurrent rendering to avoid duplicate point-merge work.
     */
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

    /** Exposes the shared WASM tile parser used by `FeatureTile` and inspection helpers. */
    public get tileLayerParser(): TileLayerParser {
        return this.tileStream!.parser;
    }

    /** Returns the number of visualizations known to the service and how many are fully rendered. */
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

    /** Returns whether a view currently wants high-fidelity geometry for a tile id. */
    public prefersHighFidelityForTile(viewIndex: number, tileId: bigint): boolean {
        return this.viewVisualizationState[viewIndex]?.getTileRenderPolicy(tileId).targetFidelity === "high";
    }

    /** Returns whether search-result geometry should be rendered for one visible source tile. */
    public prefersHighFidelityForSearchResultTile(viewIndex: number, searchId: string, tileId: bigint): boolean {
        const request = this.activeFeatureSearchRequests.get(searchId);
        if (!request?.showResultsOnMap || !request.renderStrategy.showHighFiGeometry) {
            return false;
        }
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState) {
            return false;
        }
        return this.visibleSearchGridCellCountForLevel(viewIndex, tileId)
            <= request.renderStrategy.highFidelityMaxVisibleTiles;
    }

    /**
     * Counts actual visible grid cells at the tile's level for search-specific fidelity decisions.
     * This deliberately does not use `visibleTileIdsPerLevel`, which is capped by the tile load limit.
     */
    private visibleSearchGridCellCountForLevel(viewIndex: number, tileId: bigint): number {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState) {
            return Number.MAX_SAFE_INTEGER;
        }
        const level = Number(coreLib.getTileLevel(tileId));
        return tileGridVisibleCellCount(level, viewState.viewport, this.maps.getViewTileGridMode(viewIndex));
    }

    /** Returns whether a feature tile id is currently inside one view's visible tile set and layer state. */
    public showsFeatureTileInView(viewIndex: number, mapId: string, layerId: string, tileId: bigint): boolean {
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState || !viewState.visibleTileIds.has(tileId)) {
            return false;
        }
        return this.maps.getMapLayerVisibility(viewIndex, mapId, layerId)
            && coreLib.getTileLevel(tileId) === this.getEffectiveMapLayerLevel(viewIndex, mapId, layerId);
    }

    /** Returns whether a search-result source tile is visible in one view and layer context. */
    private viewShowsSearchResultTile(viewIndex: number, tile: SearchResultTile): boolean {
        return !tile.disposed
            && this.showsFeatureTileInView(viewIndex, tile.sourceMapId, tile.sourceLayerId, tile.sourceTileId);
    }

    /** Returns schema-backed attribute contexts matching a search query. */
    public getAttributeScopeForQuery(query: string): FeatureSearchAttributeScopeCandidate[] {
        const cacheKey = query.trim();
        const cached = this.attributeScopesByQueryCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        try {
            const candidates = (this.tileLayerParser as any).getAttributeScopeForQuery(query) as unknown;
            const normalized = this.normalizeAttributeScopeCandidates(candidates);
            this.attributeScopesByQueryCache.set(cacheKey, normalized);
            return normalized;
        } catch (error) {
            console.warn("Failed to infer feature-search attribute scope from schema metadata.", error);
            return [];
        }
    }

    /** Returns schema-backed field expressions available to search-result style rules. */
    public searchStyleFieldsForQuery(query: string, scope: FeatureSearchScope): FeatureSearchStyleFieldCandidate[] {
        const cacheKey = `${scope}\n${query.trim()}`;
        const cached = this.searchStyleFieldsByQueryCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        try {
            const candidates = this.tileLayerParser.searchStyleFieldsForQuery(query, scope) as unknown;
            const normalized = this.normalizeSearchStyleFieldCandidates(candidates);
            this.searchStyleFieldsByQueryCache.set(cacheKey, normalized);
            return normalized;
        } catch (error) {
            console.warn("Failed to enumerate feature-search style fields from schema metadata.", error);
            return [];
        }
    }

    /** Returns a snapshot of the current logical `/tiles` backend request progress. */
    public getBackendRequestProgress(): BackendRequestProgress {
        return {...this.backendRequestProgress};
    }

    /** Aggregates the diagnostics shown in the tile-loading HUD and performance panel. */
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

    /** Returns per-stage viewport completeness counters derived from requested vs. received tiles. */
    public getRequestedStageProgress(): Array<{done: number; total: number}> {
        return this.stageRequestProgress.map(counter => ({...counter}));
    }

    /** Chooses human-readable stage labels, falling back to `Stage N` when layers disagree. */
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

    /** Proxies `/tiles/next` compression stats while tolerating an uninitialized tile stream. */
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

    /** Returns the wall-clock duration of the current viewport load, or zero when idle. */
    private currentViewportRenderSeconds(): number {
        if (this.viewportLoadStartedAtMs === null) {
            return 0;
        }
        const endTime = this.viewportRenderCompletedAtMs ?? performance.now();
        return Math.max(0, (endTime - this.viewportLoadStartedAtMs) / 1000);
    }

    /** Returns the combined queued visualization count across all views. */
    private visualizationQueueLength(): number {
        return this.viewVisualizationState.reduce(
            (sum, state) => sum + state.visualizationQueue.length,
            0
        );
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
            blockedByView.set(
                blockedTileId,
                (blockedByView.get(blockedTileId) ?? 0) + 1
            );
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
    private dequeueNextRenderableVisualization(
        viewIndex: number,
        viewState: ViewVisualizationState
    ): ITileVisualization | undefined {
        return viewState.visualizationQueue.dequeueNext(this.inFlightBlockedTileIdsByView[viewIndex]);
    }

    /** Enqueues a visualization through the per-view queue helper so ordering invariants stay centralized. */
    private queueVisualization(viewState: ViewVisualizationState, visualization: ITileVisualization): void {
        viewState.visualizationQueue.enqueue(visualization);
    }

    /** Returns true when a finished render should immediately be queued again because it became dirty meanwhile. */
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
        const style = this.styleService.styles.get(visualization.styleId);
        const searchRequest = this.searchRequestForVisualizationStyle(visualization.styleId);
        if (searchRequest) {
            if (!(visualization instanceof DeckTileSearchVisualization)) {
                return false;
            }
            if (!this.searchResultRenderTilesByKey.has(
                this.searchResultRenderTileKey(searchRequest.searchId, visualization.tile.sourceTileKey)
            )) {
                return false;
            }
            if (!searchRequest.showResultsOnMap || !this.viewShowsSearchResultTile(viewIndex, visualization.tile)) {
                return false;
            }
            visualization.prefersHighFidelity = this.prefersHighFidelityForSearchResultTile(
                viewIndex,
                searchRequest.searchId,
                visualization.tile.sourceTileId
            );
            return visualization.isDirty();
        }
        if (visualization.tile.disposed || !this.viewShowsFeatureTile(viewIndex, visualization.tile as FeatureTile)) {
            return false;
        }
        if (!searchRequest && visualization.styleId !== "_builtin" && (!style || !style.visible)) {
            return false;
        }
        return visualization.isDirty();
    }

    /** Destroys cached merged-point artifacts for one view/layer/style family. */
    private clearMergedPointsForMapViewLayerStyleId(mapViewLayerStyleId: string): void {
        for (const removedMergedPointsTile of this.pointMergeService.clear(mapViewLayerStyleId)) {
            this.mergedTileVisualizationDestructionTopic.next(removedMergedPointsTile);
        }
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

    /** Returns the current EWMA frame time in milliseconds. */
    private currentFrameTimeMs(): number {
        return Math.max(0, this.frameTimeMsEwma || 0);
    }

    /** Creates the stable key used to aggregate per-layer request progress. */
    private layerRequestKey(mapId: string, layerId: string): string {
        return `${mapId}/${layerId}`;
    }

    /** Resolves stage labels for a layer, filling gaps with generic `Stage N` labels. */
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

    /** Recomputes per-stage progress from the currently expected layers and the already loaded tiles. */
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

    /** Replaces the expected-stage bookkeeping after a new viewport request was assembled. */
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

    /** Expands the known stage count for a layer when incoming payloads reveal additional stages. */
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

    /** Marks one requested tile/stage pair as received and updates the derived progress counters. */
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

    /** Closes the viewport render timer once backend requests and visualization work both finished. */
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

    /** Reads the best-known vertex count from a tile for HUD statistics. */
    private vertexCountFromTileStats(tile: FeatureTile): number {
        return tile.vertexCount();
    }

    /** Returns whether the `/tiles` websocket is currently connected. */
    public isTileStreamConnected(): boolean {
        return this.tileStream?.isOpen() ?? false;
    }

    /** Pauses tile parsing, updates, and render-queue dispatch while diagnostics are inspecting the pipeline. */
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

    /** Resumes the tile pipeline and replays any deferred update request. */
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

    /** Convenience toggle for the diagnostics pause control. */
    toggleTilePipelinePause(source: 'diagnostics' | string = 'diagnostics') {
        if (this.tilePipelinePaused) {
            this.resumeTilePipeline(source);
        } else {
            this.pauseTilePipeline(source);
        }
    }

    /** Updates backend progress and surfaces terminal request failures from `/tiles` status payloads. */
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
            .map(req => {
                const noDataSourceSuffix = req.status === MapTileRequestStatus.NoDataSource && req.noDataSourceReason
                    ? ` (${req.noDataSourceReason})`
                    : "";
                return `${req.mapId}/${req.layerId}: ${req.statusText}${noDataSourceSuffix}`;
            })
            .join(", ");
        const detail = statusMessage ? ` (${statusMessage})` : "";
        this.showErrorMessage(`Tile request failed: ${summary}${detail}`);
    }

    /** Publishes server-side search progress independently from regular tile request progress. */
    private handleSearchStatus(status: MapTileStreamSearchStatusPayload) {
        if (!status || status.type !== "mapget.search.status") {
            return;
        }
        if (!this.activeFeatureSearchRequests.has(status.searchId)) {
            return;
        }
        const refresh = Number(status.refresh ?? 0);
        const currentRefresh = this.featureSearchRefreshById.get(status.searchId);
        if (currentRefresh !== undefined && refresh !== currentRefresh) {
            return;
        }
        // Mapget status frames describe the backend diff request. The UI progress bar
        // needs the whole current search area, so merge in the local tile-state snapshot.
        this.searchStatusReceived.next({
            ...status,
            ...this.featureSearchProgressSnapshot(status.searchId)
        });
    }

    /** Stores one streamed result layer for queued high-fidelity rendering. */
    private addSearchResultRenderTile(
        searchId: string,
        refresh: number,
        sourceTileKey: string,
        sourceMapId: string,
        sourceLayerId: string,
        sourceTileId: bigint,
        nodeId: string,
        layerBlob: Uint8Array,
        resultCount: number
    ): boolean {
        if (!this.activeFeatureSearchRequests.has(searchId)) {
            return false;
        }
        const currentRefresh = this.featureSearchRefreshById.get(searchId);
        if (currentRefresh !== undefined && refresh !== currentRefresh) {
            return false;
        }
        const previousMaxRefresh = this.searchResultMaxRefreshById.get(searchId) ?? -1;
        if (refresh < previousMaxRefresh) {
            return false;
        }
        if (refresh > previousMaxRefresh) {
            this.clearSearchResultRenderTilesForSearch(searchId, refresh);
            this.searchResultMaxRefreshById.set(searchId, refresh);
        }
        this.markFeatureSearchTileCompleted(searchId, refresh, sourceTileKey);
        if (resultCount <= 0) {
            this.removeSearchResultRenderTile(searchId, sourceTileKey);
            return true;
        }

        const update = {
            refresh,
            nodeId,
            layerBlob
        };
        const key = this.searchResultRenderTileKey(searchId, sourceTileKey);
        const tile = this.searchResultRenderTilesByKey.get(key)?.tile ?? new SearchResultTile(
            this.tileLayerParser,
            searchId,
            sourceTileKey,
            sourceMapId,
            sourceLayerId,
            sourceTileId,
            update
        );
        if (this.searchResultRenderTilesByKey.has(key)) {
            tile.update(update);
        }
        tile.setRenderOrder(this.searchResultTileRenderOrder(sourceTileId));
        this.searchResultRenderTilesByKey.set(key, {
            searchId,
            refresh,
            sourceTileKey,
            sourceMapId,
            sourceLayerId,
            sourceTileId,
            tile
        });
        this.updateSearchResultVisualizationsForTile(tile);
        return true;
    }

    /** Debounces expensive viewport updates while still guaranteeing a trailing refresh. */
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

    /** Recomputes visible tiles, refreshes backend requests, evicts stale tiles, and updates visualizations. */
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
                    this.visibleFeatureLevelsInView(viewIndex),
                    this.stateService.cameraViewDataState.getValue(viewIndex).destination.alt,
                    this.stateService.pinLowFiToMaxLod
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


    /** Returns the best-known stage count for a layer from metadata, requests, and observed payloads. */
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

    /** Returns the stage considered high-fidelity for rendering decisions and inspection labels. */
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

    /** Normalizes the style's requested minimum stage to a non-negative integer. */
    private styleMinimumStage(style: FeatureLayerStyle): number {
        const rawValue = style.minimumStage();
        if (!Number.isFinite(rawValue)) {
            return 0;
        }
        return Math.max(0, Math.floor(rawValue));
    }

    /**
     * Returns whether a tile has enough stage data for a style to render.
     * Fully loaded lower-stage datasets are treated as complete even when the style asked for more.
     */
    private tileSatisfiesStyleStage(tile: FeatureTile, style: FeatureLayerStyle): boolean {
        const requiredStage = this.styleMinimumStage(style);
        const highestLoadedStage = tile.highestLoadedStage();
        if (highestLoadedStage === null) {
            return false;
        }
        if (highestLoadedStage >= requiredStage) {
            return true;
        }

        // Some datasets expose fewer stages than a style was authored for.
        // In that case, once the tile is complete for the layer's advertised
        // stage count, treat the style as ready instead of blocking forever on
        // a stage that will never arrive.
        return tile.isComplete(this.getLayerStageCount(tile.mapName, tile.layerName));
    }

    /** Returns whether inspection can safely assume that every advertised stage for this tile is loaded. */
    public isTileInspectionDataComplete(tile: FeatureTile): boolean {
        return tile.isComplete(this.getLayerStageCount(tile.mapName, tile.layerName));
    }

    /** Returns the earliest missing stage for a tile, clamped to the stage actually requested. */
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

    /** Returns the current fidelity policy that a view wants for a given tile. */
    private tileRenderPolicyForView(viewIndex: number, tile: TileVisualizationTile): {
        prefersHighFidelity: boolean;
        maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
    } {
        const viewPolicy = this.viewVisualizationState[viewIndex].getTileRenderPolicy(tile.tileId);
        return {
            prefersHighFidelity: viewPolicy.targetFidelity === "high",
            maxLowFiLod: viewPolicy.maxLowFiLod
        };
    }

    /** Copies the current view policy into an existing visualization instance. */
    private applyTileRenderPolicyToVisualization(viewIndex: number, visualization: ITileVisualization): void {
        const policy = this.tileRenderPolicyForView(viewIndex, visualization.tile);
        visualization.highFidelityStage = this.getLayerHighFidelityStage(
            visualization.tile.mapName,
            visualization.tile.layerName
        );
        visualization.prefersHighFidelity = policy.prefersHighFidelity;
        visualization.maxLowFiLod = policy.maxLowFiLod;
    }

    /** Decides whether a fidelity-policy change invalidates merged low-fi point state outright. */
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

    /** Normalizes tile keys so legacy and canonical string forms map to the same cache entry. */
    private canonicalizeMapTileKey(tileKey: string): string {
        const parsed = this.parseMapTileKeySafe(tileKey);
        if (!parsed) {
            return tileKey;
        }
        const [mapId, layerId, tileId] = parsed;
        return coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
    }

    /** Parses tile keys defensively, including a fallback for older slash-separated forms. */
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

    /** Ensures a placeholder `FeatureTile` exists so selection and progress logic can reference missing tiles. */
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
        this.lastHoverRequestSignature = "";
        this.tileDataChanged.next({tileKey, tile: placeholder, reason: "placeholder"});

        return true;
    }

    /** Reapplies one changed style option to all existing visualizations of the affected layer. */
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

        viewState.visualizationQueue.retain(visu =>
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
    }

    /** Enables or disables one view as the source for cross-view option synchronization. */
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

    /** Returns whether the given view currently drives option synchronization. */
    public isSyncOptionsForViewEnabled(viewIndex: number): boolean {
        return this.stateService.getLayerSyncOption(viewIndex);
    }

    /** Mirrors layer, style, and background-layer state to sibling views when global view sync is enabled. */
    private syncViewsIfEnabled(viewIndex: number): SyncViewsResult | null {
        if (!this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return null;
        }
        const result = this.maps.syncViews(viewIndex);
        for (const [optionNode, targetIndex] of result.styleOptionChanges) {
            this.applyStyleOptionChange(optionNode, targetIndex);
        }

        this.syncBackgroundSettingsFromView(viewIndex);

        return result;
    }

    /** Pushes one view's current style-option values into every compatible layer and sibling view. */
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

    /** Replays sync settings after the number of views or tree contents changed. */
    private reapplySyncOptionsForAllViews() {
        const numViews = this.stateService.numViews;
        for (let viewIndex = 0; viewIndex < numViews; viewIndex++) {
            if (this.stateService.getLayerSyncOption(viewIndex)) {
                this.applySyncOptionsForView(viewIndex);
            }
        }
    }

    /** Copies one view's background-layer selection and opacity to the other views. */
    private syncBackgroundSettingsFromView(viewIndex: number): boolean {
        const numViews = this.stateService.numViews;
        if (viewIndex < 0 || viewIndex >= numViews) {
            return false;
        }
        const sourceBackground = this.stateService.getBackgroundState(viewIndex);
        let changed = false;
        for (let targetIndex = 0; targetIndex < numViews; targetIndex++) {
            if (targetIndex === viewIndex) {
                continue;
            }
            const targetBackground = this.stateService.getBackgroundState(targetIndex);
            if (targetBackground.layerId !== sourceBackground.layerId || targetBackground.opacity !== sourceBackground.opacity) {
                this.stateService.setBackgroundState(targetIndex, sourceBackground.layerId, sourceBackground.opacity);
                changed = true;
            }
        }
        return changed;
    }

    /** Public entry point that syncs background-layer settings only when layer sync is globally active. */
    public syncBackgroundSettings(viewIndex: number) {
        if (!this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return;
        }
        this.syncBackgroundSettingsFromView(viewIndex);
    }

    /** Reloads `/sources`, rebuilds the map tree, and refreshes the parser's datasource metadata. */
    async reloadDataSources() {
        try {
            const result = await firstValueFrom(this.httpClient.get<Array<MapInfoItem>>("/sources"));
            const maps = result.filter(m => !m.addOn).map(mapInfo => mapInfo);
            this.maps$.next(new MapLayerTree(maps, this.selectionTopic, this.stateService, this.styleService));
            this.reapplySyncOptionsForAllViews();

            const jsonString = JSON.stringify(result);
            this.dataSourceInfoJson = jsonString;
            this.tileStream!.setDataSourceInfoJson(jsonString);
            FeatureTile.clearDataSourceInfoBlobCache();
            SearchResultTile.clearDataSourceInfoBlobCache();
            this.clearSearchSchemaMetadataCaches();
        } catch (err) {
            console.error("Failed to load data source info.", err);
        }
    }

    /** Clears schema-derived search UI caches after datasource metadata changes. */
    private clearSearchSchemaMetadataCaches(): void {
        this.attributeScopesByQueryCache.clear();
        this.searchStyleFieldsByQueryCache.clear();
    }

    /** Evicts cached tiles that are neither visible nor pinned for selection/inspection. */
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
                this.lastHoverRequestSignature = "";
                this.tileDataChanged.next({
                    tileKey: tileLayer.mapTileKey,
                    tile: tileLayer,
                    reason: "evicted"
                });
            } else {
                newTileLayers.set(tileLayer.mapTileKey, tileLayer);
            }
        }
        this.loadedTileLayers = newTileLayers;
    }

    /** Reconciles visible tiles and styles with the per-view visualization caches and queues. */
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
                const searchRequest = this.searchRequestForVisualizationStyle(styleId);
                let styleEnabled = !!searchRequest?.showResultsOnMap;
                if (!searchRequest && this.styleService.styles.has(styleId)) {
                    styleEnabled = this.styleService.styles.get(styleId)!.visible;
                }
                const removals: string[] = [];
                for (const tileVisu of state.getVisualizations(styleId)) {
                    if (searchRequest) {
                        if (!(tileVisu instanceof DeckTileSearchVisualization)) {
                            this.tileVisualizationDestructionTopic.next(tileVisu);
                            removals.push(tileVisu.tile.mapTileKey);
                            continue;
                        }
                        const highFidelityActive = this.prefersHighFidelityForSearchResultTile(
                            viewIndex,
                            searchRequest.searchId,
                            tileVisu.tile.sourceTileId
                        );
                        const renderTileKey = this.searchResultRenderTileKey(
                            searchRequest.searchId,
                            tileVisu.tile.sourceTileKey
                        );
                        if (!this.searchResultRenderTilesByKey.has(renderTileKey)
                            || !this.viewShowsSearchResultTile(viewIndex, tileVisu.tile)
                            || !styleEnabled) {
                            this.tileVisualizationDestructionTopic.next(tileVisu);
                            removals.push(tileVisu.tile.mapTileKey);
                            continue;
                        }
                        const renderPolicy = this.tileRenderPolicyForView(viewIndex, tileVisu.tile);
                        tileVisu.highFidelityStage = this.getLayerHighFidelityStage(
                            tileVisu.tile.mapName,
                            tileVisu.tile.layerName
                        );
                        tileVisu.prefersHighFidelity = highFidelityActive;
                        tileVisu.maxLowFiLod = renderPolicy.maxLowFiLod;
                        if (tileVisu.isDirty()) {
                            tileVisu.updateStatus(true);
                            this.queueVisualization(state, tileVisu);
                        }
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
            state.visualizationQueue.clear();
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
            this.updateSearchResultVisualizationsForView(state, viewIndex);
        });
        if (anyRenderPolicyChanged
            || this.selectionVisualizations.length > 0
            || this.hoverVisualizations.length > 0
            || this.selectionTopic.getValue().length > 0
            || this.hoverTopic.getValue().length > 0) {
            this.refreshHighlightVisualizationsForCurrentPolicies();
        }
    }

    /** Returns the style id namespace used for queued high-fidelity search-result visualizations. */
    private searchResultStyleId(searchId: string): string {
        return `${MapDataService.SEARCH_RESULT_STYLE_PREFIX}${searchId}`;
    }

    /** Extracts a search id from a search-result visualization style id. */
    private searchIdFromSearchResultStyleId(styleId: string): string | null {
        return styleId.startsWith(MapDataService.SEARCH_RESULT_STYLE_PREFIX)
            ? styleId.slice(MapDataService.SEARCH_RESULT_STYLE_PREFIX.length)
            : null;
    }

    /** Builds the cache key for one search/result source tile pair. */
    private searchResultRenderTileKey(searchId: string, sourceTileKey: string): string {
        return `${searchId}:${sourceTileKey}`;
    }

    /** Removes one cached search-result tile and any queued/rendered visualizations for it. */
    private removeSearchResultRenderTile(searchId: string, sourceTileKey: string): void {
        const key = this.searchResultRenderTileKey(searchId, sourceTileKey);
        const renderTile = this.searchResultRenderTilesByKey.get(key);
        if (!renderTile || !this.searchResultRenderTilesByKey.delete(key)) {
            return;
        }
        renderTile.tile.dispose();
        const styleId = this.searchResultStyleId(searchId);
        for (const state of this.viewVisualizationState) {
            for (const visualization of state.removeVisualizations(styleId, sourceTileKey)) {
                this.tileVisualizationDestructionTopic.next(visualization);
            }
            state.visualizationQueue.retain(visualization =>
                visualization.styleId !== styleId || visualization.tile.mapTileKey !== sourceTileKey);
        }
    }

    /** Removes cached result tiles for a search, optionally only stale refreshes. */
    private clearSearchResultRenderTilesForSearch(searchId: string, refreshBefore?: number): void {
        for (const renderTile of Array.from(this.searchResultRenderTilesByKey.values())) {
            if (renderTile.searchId !== searchId) {
                continue;
            }
            if (refreshBefore !== undefined && renderTile.refresh >= refreshBefore) {
                continue;
            }
            this.removeSearchResultRenderTile(searchId, renderTile.sourceTileKey);
        }
        if (refreshBefore === undefined) {
            this.searchResultMaxRefreshById.delete(searchId);
        }
    }

    /** Looks up the active search request represented by a visualization style id. */
    private searchRequestForVisualizationStyle(styleId: string): FeatureSearchDataPlaneRequest | undefined {
        const searchId = this.searchIdFromSearchResultStyleId(styleId);
        return searchId ? this.activeFeatureSearchRequests.get(searchId) : undefined;
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
        const orderedSearchIds = Array.from(this.activeFeatureSearchRequests.keys()).sort();
        const index = orderedSearchIds.indexOf(searchId);
        return 10_000 + Math.max(0, index);
    }

    /** Uses the best visible-tile ordering rank known across views for detached result tiles. */
    private searchResultTileRenderOrder(tileId: bigint): number {
        let order = FeatureTile.DEFAULT_RENDER_ORDER;
        for (const state of this.viewVisualizationState) {
            order = Math.min(order, state.getTileOrder(tileId));
        }
        return order;
    }

    /** Schedules queued high-fidelity renderers for streamed search-result tiles in one view. */
    private updateSearchResultVisualizationsForView(
        state: ViewVisualizationState,
        viewIndex: number
    ): void {
        for (const renderTile of this.searchResultRenderTilesByKey.values()) {
            const request = this.activeFeatureSearchRequests.get(renderTile.searchId);
            if (!request?.showResultsOnMap) {
                continue;
            }
            if (!this.viewShowsSearchResultTile(viewIndex, renderTile.tile)) {
                continue;
            }

            renderTile.tile.setRenderOrder(state.getTileOrder(renderTile.sourceTileId));
            const renderPolicy = this.tileRenderPolicyForView(viewIndex, renderTile.tile);
            const highFidelityActive = this.prefersHighFidelityForSearchResultTile(
                viewIndex,
                renderTile.searchId,
                renderTile.sourceTileId
            );

            const styleId = this.searchResultStyleId(renderTile.searchId);
            const highFidelityStage = this.getLayerHighFidelityStage(
                renderTile.sourceMapId,
                renderTile.sourceLayerId
            );
            const styleSpecJson = this.searchResultStyleSpec(request);
            const styleOrder = this.searchResultStyleOrder(renderTile.searchId);
            const existing = state.getVisualization(styleId, renderTile.sourceTileKey);
            if (existing instanceof DeckTileSearchVisualization) {
                existing.updateSearchResultStyle(
                    styleSpecJson,
                    styleOrder
                );
                existing.highFidelityStage = highFidelityStage;
                existing.prefersHighFidelity = highFidelityActive;
                existing.maxLowFiLod = renderPolicy.maxLowFiLod;
                if (existing.isDirty()) {
                    existing.updateStatus(true);
                    this.queueVisualization(state, existing);
                }
                continue;
            }

            if (existing) {
                this.tileVisualizationDestructionTopic.next(existing);
                state.removeVisualizations(styleId, renderTile.sourceTileKey).forEach(_ => _);
            }

            if (!highFidelityActive) {
                continue;
            }

            const visualization = new DeckTileSearchVisualization(
                viewIndex,
                styleId,
                renderTile.tile,
                this.tileLayerParser,
                styleSpecJson,
                highFidelityStage,
                true,
                renderPolicy.maxLowFiLod,
                styleOrder
            );
            state.putVisualization(styleId, renderTile.sourceTileKey, visualization);
            visualization.updateStatus(true);
            this.queueVisualization(state, visualization);
        }
    }

    /** Updates only the visualizations affected by one streamed search-result tile. */
    private updateSearchResultVisualizationsForTile(tile: SearchResultTile): void {
        const request = this.activeFeatureSearchRequests.get(tile.searchId);
        if (!request?.showResultsOnMap) {
            return;
        }
        const styleId = this.searchResultStyleId(tile.searchId);
        const highFidelityStage = this.getLayerHighFidelityStage(tile.sourceMapId, tile.sourceLayerId);
        const styleSpecJson = this.searchResultStyleSpec(request);
        const styleOrder = this.searchResultStyleOrder(tile.searchId);

        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            const state = this.viewVisualizationState[viewIndex];
            const existing = state.getVisualization(styleId, tile.sourceTileKey);
            if (!this.viewShowsSearchResultTile(viewIndex, tile)) {
                if (existing) {
                    this.tileVisualizationDestructionTopic.next(existing);
                    state.removeVisualizations(styleId, tile.sourceTileKey).forEach(_ => _);
                    state.visualizationQueue.retain(visualization =>
                        visualization.styleId !== styleId || visualization.tile.mapTileKey !== tile.sourceTileKey);
                }
                continue;
            }

            tile.setRenderOrder(state.getTileOrder(tile.sourceTileId));
            const renderPolicy = this.tileRenderPolicyForView(viewIndex, tile);
            const highFidelityActive = this.prefersHighFidelityForSearchResultTile(
                viewIndex,
                tile.searchId,
                tile.sourceTileId
            );

            if (existing instanceof DeckTileSearchVisualization) {
                existing.updateSearchResultStyle(styleSpecJson, styleOrder);
                existing.highFidelityStage = highFidelityStage;
                existing.prefersHighFidelity = highFidelityActive;
                existing.maxLowFiLod = renderPolicy.maxLowFiLod;
                if (existing.isDirty()) {
                    existing.updateStatus(true);
                    this.queueVisualization(state, existing);
                }
                continue;
            }

            if (existing) {
                this.tileVisualizationDestructionTopic.next(existing);
                state.removeVisualizations(styleId, tile.sourceTileKey).forEach(_ => _);
            }

            if (!highFidelityActive) {
                continue;
            }

            const visualization = new DeckTileSearchVisualization(
                viewIndex,
                styleId,
                tile,
                this.tileLayerParser,
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
    }

    /** Rebuilds hover and selection highlights when fidelity policy changes affect their geometry. */
    private refreshHighlightVisualizationsForCurrentPolicies(): void {
        const selectionGroups = this.selectionTopic.getValue();
        this.refreshHighlightVisualizationIfNeeded(coreLib.HighlightMode.SELECTION_HIGHLIGHT, selectionGroups);
        const hoveredFeatureWrappers = this.hoverTopic.getValue();
        this.refreshHighlightVisualizationIfNeeded(coreLib.HighlightMode.HOVER_HIGHLIGHT, [{
            features: hoveredFeatureWrappers
        }]);
    }

    /** Forces the next highlight refresh to rebuild even if the tracked signature stayed unchanged. */
    public refreshHighlightVisualizations(): void {
        this.selectionHighlightSignature = "";
        this.hoverHighlightSignature = "";
        this.refreshHighlightVisualizationsForCurrentPolicies();
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

    /**
     * Builds a stable signature for highlight inputs and render policies.
     * Any change that can alter highlight geometry or styling must appear here.
     */
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

    /** Uses the schema-aware native parser to keep auto scope aligned with completion. */
    private isAttributeScopeSearchQuery(query: string): boolean {
        try {
            return this.tileLayerParser.isAttributeScopeSearchQuery(query);
        } catch (error) {
            console.warn("Failed to infer feature-search scope from schema metadata.", error);
            return false;
        }
    }

    /** Normalizes untyped WASM attribute-scope candidates into the TypeScript-facing shape. */
    private normalizeAttributeScopeCandidates(value: unknown): FeatureSearchAttributeScopeCandidate[] {
        if (!Array.isArray(value)) {
            return [];
        }
        return value.flatMap(item => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return [];
            }
            const raw = item as Record<string, unknown>;
            const attrName = typeof raw["attrName"] === "string" ? raw["attrName"] : "";
            const attrLayerName = typeof raw["attrLayerName"] === "string" ? raw["attrLayerName"] : "";
            const featureType = typeof raw["featureType"] === "string" ? raw["featureType"] : "";
            const mapId = typeof raw["mapId"] === "string" ? raw["mapId"] : "";
            const layerId = typeof raw["layerId"] === "string" ? raw["layerId"] : "";
            return attrName && mapId && layerId
                ? [{attrName, attrLayerName, featureType, mapId, layerId}]
                : [];
        });
    }

    /** Normalizes untyped WASM search-style field candidates into the TypeScript-facing shape. */
    private normalizeSearchStyleFieldCandidates(value: unknown): FeatureSearchStyleFieldCandidate[] {
        if (!Array.isArray(value)) {
            return [];
        }
        return value.flatMap(item => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return [];
            }
            const raw = item as Record<string, unknown>;
            const path = typeof raw["path"] === "string" ? raw["path"] : "";
            const mapId = typeof raw["mapId"] === "string" ? raw["mapId"] : "";
            const layerId = typeof raw["layerId"] === "string" ? raw["layerId"] : "";
            if (!path || !mapId || !layerId) {
                return [];
            }
            const attrName = typeof raw["attrName"] === "string" ? raw["attrName"] : undefined;
            const featureType = typeof raw["featureType"] === "string" ? raw["featureType"] : undefined;
            return [{path, mapId, layerId, attrName, featureType}];
        });
    }

    /** Resolves persisted search scope state to the concrete token expected by mapget. */
    private resolveFeatureSearchScope(request: FeatureSearchDataPlaneRequest): "feature" | "attribute" {
        if (request.scope === "feature" || request.scope === "attribute") {
            return request.scope;
        }
        return this.isAttributeScopeSearchQuery(request.query) ? "attribute" : "feature";
    }

    /** Encodes map/layer ids without relying on slash splitting, since map ids may be grouped paths. */
    private featureSearchLayerKey(mapId: string, layerId: string): string {
        return JSON.stringify([mapId, layerId]);
    }

    /** Adds one source tile to the reusable visible-tile plan consumed by map loading and search. */
    private trackVisibleSearchLayerTile(
        visibleLayerTiles: Map<string, SearchLayerTileSet>,
        mapId: string,
        layerId: string,
        tileId: bigint,
        priority: boolean
    ): void {
        const key = this.featureSearchLayerKey(mapId, layerId);
        let entry = visibleLayerTiles.get(key);
        if (!entry) {
            entry = {
                mapId,
                layerId,
                tileIds: new Set<number>(),
                priorityTileIds: new Set<number>(),
            };
            visibleLayerTiles.set(key, entry);
        }
        const numericTileId = Number(tileId);
        entry.tileIds.add(numericTileId);
        if (priority) {
            entry.priorityTileIds.add(numericTileId);
        }
    }

    /** Decodes a key produced by featureSearchLayerKey(). */
    private parseFeatureSearchLayerKey(key: string): {mapId: string; layerId: string} | null {
        try {
            const parsed = JSON.parse(key);
            if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
                return {mapId: parsed[0], layerId: parsed[1]};
            }
        } catch (_error) {
            // Ignore malformed legacy keys.
        }
        return null;
    }

    /** Builds the stable logical-search fingerprint that owns the backend refresh generation. */
    private featureSearchDefinitionFingerprint(request: FeatureSearchDataPlaneRequest): string {
        return JSON.stringify({
            searchId: request.searchId,
            generationSerial: request.generationSerial,
            query: request.query,
            scope: this.resolveFeatureSearchScope(request),
            withFields: request.withFields
        });
    }

    /** Bumps refresh only when old chunks for this search id must be treated as stale. */
    private refreshForFeatureSearchDefinition(request: FeatureSearchDataPlaneRequest): number {
        const fingerprint = this.featureSearchDefinitionFingerprint(request);
        const searchId = request.searchId;
        if (this.featureSearchFingerprintById.get(searchId) === fingerprint) {
            return this.featureSearchRefreshById.get(searchId) ?? 0;
        }
        const nextRefresh = (this.featureSearchRefreshById.get(searchId) ?? 0) + 1;
        this.featureSearchFingerprintById.set(searchId, fingerprint);
        this.featureSearchRefreshById.set(searchId, nextRefresh);
        this.clearFeatureSearchTileStates(searchId, true);
        return nextRefresh;
    }

    /** Returns the mutable per-source-tile state table for one search. */
    private featureSearchTileStates(searchId: string): Map<string, FeatureSearchTileState> {
        let states = this.featureSearchTileStatesById.get(searchId);
        if (!states) {
            states = new Map<string, FeatureSearchTileState>();
            this.featureSearchTileStatesById.set(searchId, states);
        }
        return states;
    }

    /** Returns all concrete source layers currently represented by one search's tile state. */
    private layerKeysForFeatureSearchTileStates(searchId: string): Set<string> {
        const result = new Set<string>();
        const states = this.featureSearchTileStatesById.get(searchId);
        if (!states) {
            return result;
        }
        for (const state of states.values()) {
            result.add(this.featureSearchLayerKey(state.mapId, state.layerId));
        }
        return result;
    }

    /** Removes one source tile from local search coverage and optionally from UI-facing result state. */
    private removeFeatureSearchTileState(searchId: string, sourceTileKey: string, notifyEviction: boolean): void {
        const states = this.featureSearchTileStatesById.get(searchId);
        states?.delete(sourceTileKey);
        this.removeSearchResultRenderTile(searchId, sourceTileKey);
        if (notifyEviction) {
            this.searchResultTileEvicted.next({searchId, sourceTileKey});
        }
    }

    /** Clears all per-tile state for one search generation. */
    private clearFeatureSearchTileStates(searchId: string, notifyEvictions: boolean): void {
        const states = this.featureSearchTileStatesById.get(searchId);
        if (states) {
            for (const sourceTileKey of Array.from(states.keys())) {
                this.removeFeatureSearchTileState(searchId, sourceTileKey, notifyEvictions);
            }
        }
        this.featureSearchTileStatesById.delete(searchId);
        this.lastFeatureSearchUpdateSerialById.delete(searchId);
        this.clearSearchResultRenderTilesForSearch(searchId);
    }

    /** Freezes current results but makes unfinished tiles eligible for re-request after resume. */
    private markFeatureSearchTilesPending(searchId: string): void {
        const states = this.featureSearchTileStatesById.get(searchId);
        if (!states) {
            return;
        }
        for (const state of states.values()) {
            if (!state.completed) {
                state.requested = false;
            }
        }
    }

    /** Adopts the current visible tile plan for an auto-update or explicit area update. */
    private adoptFeatureSearchVisibleTiles(
        searchId: string,
        refresh: number,
        visibleLayerTiles: Map<string, SearchLayerTileSet>
    ): void {
        const states = this.featureSearchTileStates(searchId);
        const desiredKeys = new Set<string>();
        for (const entry of visibleLayerTiles.values()) {
            for (const tileId of entry.tileIds) {
                const sourceTileKey = coreLib.getTileFeatureLayerKey(entry.mapId, entry.layerId, BigInt(tileId));
                desiredKeys.add(sourceTileKey);
                const priority = entry.priorityTileIds.has(tileId);
                const existing = states.get(sourceTileKey);
                if (existing && existing.refresh === refresh) {
                    existing.priority = priority;
                    continue;
                }
                states.set(sourceTileKey, {
                    mapId: entry.mapId,
                    layerId: entry.layerId,
                    tileId,
                    sourceTileKey,
                    refresh,
                    priority,
                    requested: false,
                    completed: false
                });
            }
        }

        for (const sourceTileKey of Array.from(states.keys())) {
            if (!desiredKeys.has(sourceTileKey)) {
                this.removeFeatureSearchTileState(searchId, sourceTileKey, true);
            }
        }
    }

    /** Marks one streamed search-result tile as completed, including zero-result tiles. */
    private markFeatureSearchTileCompleted(searchId: string, refresh: number, sourceTileKey: string): void {
        const state = this.featureSearchTileStatesById.get(searchId)?.get(sourceTileKey);
        if (!state || state.refresh !== refresh) {
            return;
        }
        state.completed = true;
        state.requested = false;
    }

    /** Returns current full-coverage search progress, independent from the latest differential backend request. */
    private featureSearchProgressSnapshot(searchId: string): {tilesConsidered: number; tilesCompleted: number} {
        const states = this.featureSearchTileStatesById.get(searchId);
        if (!states) {
            return {tilesConsidered: 0, tilesCompleted: 0};
        }
        let tilesCompleted = 0;
        for (const state of states.values()) {
            if (state.completed) {
                tilesCompleted += 1;
            }
        }
        return {
            tilesConsidered: states.size,
            tilesCompleted
        };
    }

    /** Builds one concrete mapget search request object for a map/layer tile set. */
    private createFeatureSearchTileRequest(
        request: FeatureSearchDataPlaneRequest,
        mapId: string,
        layerId: string,
        tileIds: number[],
        priorityTileIds: number[],
        refresh: number
    ): FeatureSearchTileRequest {
        const result: FeatureSearchTileRequest = {
            mapId,
            layerId,
            tileIds,
            searchId: request.searchId,
            refresh,
            searchQuery: request.query,
            searchScope: this.resolveFeatureSearchScope(request),
        };
        if (priorityTileIds.length) {
            result.priorityTileIds = priorityTileIds;
        }
        if (request.withFields.length) {
            result.withFields = request.withFields;
        }
        return result;
    }

    /** Creates empty tile requests that cancel or pause a server-side search on its previously active layers. */
    private createFeatureSearchCancellationRequests(
        request: FeatureSearchDataPlaneRequest,
        layerKeys: Iterable<string>,
        refresh: number
    ): FeatureSearchTileRequest[] {
        const cancellations: FeatureSearchTileRequest[] = [];
        for (const layerKey of layerKeys) {
            const parsed = this.parseFeatureSearchLayerKey(layerKey);
            if (!parsed) {
                continue;
            }
            cancellations.push(this.createFeatureSearchTileRequest(
                request,
                parsed.mapId,
                parsed.layerId,
                [],
                [],
                refresh
            ));
        }
        return cancellations;
    }

    /** Groups incomplete source tiles into concrete backend search requests. */
    private appendFeatureSearchTileRequests(
        requests: FeatureSearchTileRequest[],
        request: FeatureSearchDataPlaneRequest,
        refresh: number
    ): void {
        const states = this.featureSearchTileStatesById.get(request.searchId);
        if (!states) {
            return;
        }
        const statesByLevelLayer = new Map<string, {
            mapId: string;
            layerId: string;
            tileIds: number[];
            priorityTileIds: number[];
        }>();
        for (const state of states.values()) {
            if (state.completed) {
                continue;
            }
            const tileLevel = Math.trunc(state.tileId % 0x10000);
            const key = `${state.mapId}/${state.layerId}/${tileLevel}`;
            let entry = statesByLevelLayer.get(key);
            if (!entry) {
                entry = {
                    mapId: state.mapId,
                    layerId: state.layerId,
                    tileIds: [],
                    priorityTileIds: []
                };
                statesByLevelLayer.set(key, entry);
            }
            entry.tileIds.push(state.tileId);
            if (state.priority) {
                entry.priorityTileIds.push(state.tileId);
            }
            state.requested = true;
        }

        const sortedEntries = Array.from(statesByLevelLayer.values())
            .sort((lhs, rhs) => lhs.mapId.localeCompare(rhs.mapId) || lhs.layerId.localeCompare(rhs.layerId));
        for (const entry of sortedEntries) {
            entry.tileIds.sort((lhs, rhs) => lhs - rhs);
            entry.priorityTileIds.sort((lhs, rhs) => lhs - rhs);
            requests.push(this.createFeatureSearchTileRequest(
                request,
                entry.mapId,
                entry.layerId,
                entry.tileIds,
                entry.priorityTileIds,
                refresh
            ));
        }
    }

    /** Builds all active server-side search-as-map requests for the next `/tiles` update. */
    private buildFeatureSearchTileRequests(
        visibleLayerTiles: Map<string, SearchLayerTileSet>
    ): FeatureSearchTileRequest[] {
        const requests: FeatureSearchTileRequest[] = [];

        for (const [searchId, request] of this.activeFeatureSearchRequests) {
            const refresh = this.refreshForFeatureSearchDefinition(request);

            if (request.paused) {
                const cancellationLayerKeys = this.layerKeysForFeatureSearchTileStates(searchId);
                requests.push(...this.createFeatureSearchCancellationRequests(request, cancellationLayerKeys, refresh));
                this.markFeatureSearchTilesPending(searchId);
                continue;
            }

            const lastUpdateSerial = this.lastFeatureSearchUpdateSerialById.get(searchId);
            const shouldAdoptVisibleTiles = request.autoUpdate
                || lastUpdateSerial !== request.updateSerial
                || !this.featureSearchTileStatesById.has(searchId);
            if (shouldAdoptVisibleTiles && (visibleLayerTiles.size > 0 || request.autoUpdate)) {
                this.adoptFeatureSearchVisibleTiles(searchId, refresh, visibleLayerTiles);
                this.lastFeatureSearchUpdateSerialById.set(searchId, request.updateSerial);
            }

            this.appendFeatureSearchTileRequests(requests, request, refresh);
        }

        for (const [searchId, request] of Array.from(this.pendingFeatureSearchCancellations)) {
            const layerKeys = this.pendingFeatureSearchCancellationLayerKeysById.get(searchId);
            if (layerKeys?.size) {
                const refresh = (this.featureSearchRefreshById.get(searchId) ?? 0) + 1;
                requests.push(...this.createFeatureSearchCancellationRequests(request, layerKeys, refresh));
            }
            this.pendingFeatureSearchCancellations.delete(searchId);
            this.pendingFeatureSearchCancellationLayerKeysById.delete(searchId);
            this.lastFeatureSearchUpdateSerialById.delete(searchId);
            this.featureSearchTileStatesById.delete(searchId);
            this.featureSearchRefreshById.delete(searchId);
            this.featureSearchFingerprintById.delete(searchId);
            this.searchResultMaxRefreshById.delete(searchId);
        }

        return requests;
    }

    /**
     * Recomputes the logical `/tiles` request from visible tiles and pinned selection tiles.
     * Requests are grouped by map/layer/level so websocket chunking can stay backend-friendly.
     */
    private async updateMapDataRequest() {
        if (this.tilePipelinePaused) {
            return;
        }

        type LayerRequestEntry = {
            mapId: string;
            layerId: string;
            tileIdToNextMissingStage: Map<number, number>;
            priorityTileIds: Set<number>;
        };
        type ExpectedLayerEntry = {
            mapId: string;
            layerId: string;
            tileIdToRequestedMaxStage: Map<number, number>;
        };
        const requestByLayer = new Map<string, LayerRequestEntry>();
        const expectedByLayer = new Map<string, ExpectedLayerEntry>();
        const visibleSearchLayerTiles = new Map<string, SearchLayerTileSet>();
        const queueTile = (
            mapId: string,
            layerId: string,
            tileId: number,
            nextMissingStage: number,
            priority = false
        ) => {
            const tileLevel = Math.trunc(tileId % 0x10000);
            const key = `${mapId}/${layerId}/${tileLevel}`;
            let entry = requestByLayer.get(key);
            if (!entry) {
                entry = {
                    mapId,
                    layerId,
                    tileIdToNextMissingStage: new Map<number, number>(),
                    priorityTileIds: new Set<number>(),
                };
                requestByLayer.set(key, entry);
            }
            if (priority) {
                entry.priorityTileIds.add(tileId);
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
                    this.ensureTilePlaceholder(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId,
                        BigInt(tileId),
                        true);
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
                            nextMissingStage,
                            true);
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
                    let level = this.getEffectiveMapLayerLevel(viewIndex, mapName, layer.id);
                    let tileIds = this.viewVisualizationState[viewIndex].visibleTileIdsPerLevel.get(level);
                    if (tileIds === undefined) {
                        continue;
                    }
                    for (let tileId of tileIds!) {
                        const tileMapLayerKey = coreLib.getTileFeatureLayerKey(mapName, layer.id, tileId);
                        const isSelectedTile = this.selectedTileKeys.has(tileMapLayerKey);
                        this.trackVisibleSearchLayerTile(
                            visibleSearchLayerTiles,
                            mapName,
                            layer.id,
                            tileId,
                            isSelectedTile
                        );
                        const existingTile = this.loadedTileLayers.get(tileMapLayerKey);
                        if (!existingTile) {
                            this.ensureTilePlaceholder(mapName, layer.id, tileId, false);
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
                            queueTile(mapName, layer.id, Number(tileId), nextMissingStage, isSelectedTile);
                        }
                    }
                }
            }
        }

        const requests: any[] = Array.from(requestByLayer.values()).map(entry => {
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
            const request: {
                mapId: string;
                layerId: string;
                tileIdsByNextStage: number[][];
                priorityTileIds?: number[];
            } = {
                mapId: entry.mapId,
                layerId: entry.layerId,
                tileIdsByNextStage,
            };
            if (entry.priorityTileIds.size) {
                request.priorityTileIds = Array.from(entry.priorityTileIds);
            }
            return request;
        });
        requests.push(...this.buildFeatureSearchTileRequests(visibleSearchLayerTiles));

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

    /** Parses a streamed TileSearchResultLayer and forwards its compact UI payload. */
    private addTileSearchResultLayer(searchResultLayerBlob: Uint8Array) {
        const searchResultLayer = uint8ArrayToWasm((wasmBlob: any) => {
            return (this.tileLayerParser as any).readTileSearchResultLayer(wasmBlob);
        }, searchResultLayerBlob) as any | null;
        if (!searchResultLayer) {
            return;
        }

        try {
            const rawInfo = (searchResultLayer.info?.() ?? {}) as Record<string, unknown>;
            const searchId = typeof rawInfo["searchId"] === "string" ? rawInfo["searchId"] : "";
            if (!searchId) {
                return;
            }

            const refresh = Number(rawInfo["refresh"] ?? 0);
            const resultFields = (searchResultLayer.resultFields?.() ?? []) as string[];
            const resultCountValue = Number(rawInfo["resultCount"] ?? searchResultLayer.numResults?.() ?? 0);
            const tileId = BigInt(searchResultLayer.tileId() as any);
            const sourceMapId = typeof rawInfo["sourceMapId"] === "string"
                ? rawInfo["sourceMapId"]
                : searchResultLayer.mapId();
            const sourceLayerId = typeof rawInfo["sourceLayerId"] === "string"
                ? rawInfo["sourceLayerId"]
                : searchResultLayer.layerId();
            const sourceTileId = rawInfo["sourceTileId"] !== undefined
                ? BigInt(rawInfo["sourceTileId"] as any)
                : tileId;
            const sourceTileKey = coreLib.getTileFeatureLayerKey(sourceMapId, sourceLayerId, sourceTileId);
            const rawEntries = (searchResultLayer.resultEntries?.() ?? []) as SearchResultTileEntry[];
            const entries = rawEntries.map(entry => ({
                ...entry,
                mapTileKey: entry.mapTileKey
                    ? this.canonicalizeMapTileKey(entry.mapTileKey)
                    : sourceTileKey
            }));
            const tracesValue = rawInfo["traces"];
            const traces = tracesValue && typeof tracesValue === "object" && !Array.isArray(tracesValue)
                ? tracesValue as Record<string, unknown>
                : null;
            const diagnostics = uint8ArrayFromWasm((buffer) => searchResultLayer.copyDiagnostics(buffer));
            const normalizedRefresh = Number.isFinite(refresh) ? refresh : 0;
            const accepted = this.addSearchResultRenderTile(
                searchId,
                normalizedRefresh,
                sourceTileKey,
                sourceMapId,
                sourceLayerId,
                sourceTileId,
                searchResultLayer.nodeId(),
                searchResultLayerBlob,
                Number.isFinite(resultCountValue) ? resultCountValue : entries.length
            );
            if (!accepted) {
                return;
            }
            // Result frames are often more frequent than status frames, so include the
            // same full-area progress snapshot to keep the UI responsive while streaming.
            const progress = this.featureSearchProgressSnapshot(searchId);

            this.searchResultTileReceived.next({
                searchId,
                refresh: normalizedRefresh,
                mapId: searchResultLayer.mapId(),
                layerId: searchResultLayer.layerId(),
                tileId,
                sourceTileKey,
                sourceMapId,
                sourceLayerId,
                sourceTileId,
                resultCount: Number.isFinite(resultCountValue) ? resultCountValue : entries.length,
                resultFields,
                ...progress,
                traces,
                diagnostics,
                entries
            });
        } finally {
            searchResultLayer.delete?.();
        }
    }

    /** Hydrates an incoming tile payload, updates caches, and wakes any waiting render or inspection work. */
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
                if (request.resolveWhenInspectionComplete
                    && !this.isTileInspectionDataComplete(tileLayer)) {
                    return true;
                }
                request.resolve!(tileLayer);
                return false;
            }
            return true;
        });

        this.lastHoverRequestSignature = "";
        this.tileDataChanged.next({
            tileKey: tileLayer.mapTileKey,
            tile: tileLayer,
            reason: "loaded"
        });
        if (this.selectedTileKeys.has(tileLayer.mapTileKey)) {
            this.selectionTileUpdated.next(tileLayer.mapTileKey);
        }
        if (this.selectedTileKeys.has(tileLayer.mapTileKey)
            || this.hoverTopic.getValue().some(feature => feature.mapTileKey === tileLayer.mapTileKey)) {
            this.refreshHighlightVisualizationsForCurrentPolicies();
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

    /** Requeues existing visualizations for a tile that just received additional stage data. */
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
                visu.showTileBorder = this.maps.getViewTileBorderState(viewIndex);
                this.applyTileRenderPolicyToVisualization(viewIndex, visu);
                const isDirty = visu.isDirty();

                if (!isDirty) {
                    continue;
                }

                visu.updateStatus(true);
                this.queueVisualization(viewState, visu);
            }
        }

        return {
            foundExistingVisualization,
            visibleInAnyView
        };
    }

    /** Creates all currently applicable style visualizations for a newly visible tile. */
    private createVisualizationsForTile(tileLayer: FeatureTile): void {
        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            if (!this.viewShowsFeatureTile(viewIndex, tileLayer)) {
                continue;
            }
            const viewState = this.viewVisualizationState[viewIndex];
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

    /** Publishes runtime style issues collected during tile rendering. */
    private recordStyleValidationIssues(issues: StyleValidationIssue[]): void {
        for (const issue of issues) {
            this.styleValidationReportService.recordIssue(issue);
        }
    }

    /** Resolves relation targets via `/locate` and ensures the referenced tiles are loaded. */
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

    /** Creates or refreshes one style visualization for a tile in a specific view. */
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
        const styleOrder = this.styleOrder(styleId);
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
            this.maps.getLayerStyleOptions(viewIndex, mapName, layerName, styleId),
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

    /** Updates one view's viewport snapshot and schedules a full tile/visualization refresh. */
    setViewport(viewIndex: number, viewport: Viewport) {
        const maxIndex = this.viewVisualizationState.length - 1;
        if (viewIndex > maxIndex) {
            console.warn(`Attempted to write @ viewIndex: ${viewIndex} but it is out of bounds (${maxIndex})`);
            return;
        }
        this.viewVisualizationState[viewIndex].viewport = viewport;
        this.scheduleUpdate();
    }

    /** Returns loaded tiles ordered by visibility, render order, and backend priority for diagnostics. */
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

    /** Returns a loaded feature tile by key, accepting legacy and canonical key forms. */
    getFeatureTile(tileKey: string): FeatureTile | null {
        const canonicalTileKey = this.canonicalizeMapTileKey(tileKey);
        const tile = this.loadedTileLayers.get(canonicalTileKey);
        if (!tile || !tile.hasData()) {
            return null;
        }
        return tile;
    }

    /** Emits the paused-pipeline info toast only once per paused interval. */
    private showPausedTileLoadInfoOnce() {
        if (this.blockedTileLoadInfoShown) {
            return;
        }
        this.blockedTileLoadInfoShown = true;
        this.showInfoMessage('Tile pipeline is paused; cannot load additional tiles');
    }

    /** Resolves an address-based feature reference back to a stable tile/feature id pair. */
    resolveTileFeatureIdByAddress(tileKey: string, featureAddress: number): TileFeatureId | null {
        if (!Number.isInteger(featureAddress) || featureAddress < 0) {
            return null;
        }
        const canonicalTileKey = this.canonicalizeMapTileKey(tileKey);
        const tile = this.loadedTileLayers.get(canonicalTileKey);
        if (!tile || !tile.hasData()) {
            return null;
        }
        if (featureAddress >= tile.numFeatures) {
            return null;
        }
        const featureId = tile.featureIdByAddress(featureAddress);
        return featureId ? {
            mapTileKey: canonicalTileKey,
            featureId
        } : null;
    }

    /** Ensures a set of tiles is loaded, using selection-style pin requests for cache misses. */
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
                resolveWhenInspectionComplete: false,
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

    /** Pins a tile until inspection has seen every advertised stage, without exposing a caller-visible promise. */
    private pinTileForSelectionInspection(
        mapId: string,
        layerId: string,
        tileId: bigint,
        canonicalTileKey: string
    ): void {
        if (this.selectionTileRequests.some(request => request.tileKey === canonicalTileKey)) {
            return;
        }

        // This path expresses selection intent only: the selected tile should stay
        // requested until inspection data is complete, but no caller awaits it.
        this.selectionTileRequests.push({
            remoteRequest: {
                mapId,
                layerId,
                tileIds: [Number(tileId)],
            },
            tileKey: canonicalTileKey,
            resolveWhenInspectionComplete: true,
            resolve: () => {},
            reject: () => {}
        });
        this.scheduleUpdate();
    }

    /**
     * Resolves tile/feature ids to `FeatureWrapper`s.
     * `allowIncomplete` keeps selection restore usable before all tile stages arrived.
     */
    async loadFeatures(
        tileFeatureIds: (TileFeatureId | null)[],
        options?: {allowIncomplete?: boolean}
    ): Promise<FeatureWrapper[]> {
        const normalizedIds = tileFeatureIds.filter((tileFeatureId): tileFeatureId is TileFeatureId => !!tileFeatureId);
        const allowIncomplete = options?.allowIncomplete ?? false;

        if (allowIncomplete) {
            const features: FeatureWrapper[] = [];

            for (const id of normalizedIds) {
                const canonicalTileKey = this.canonicalizeMapTileKey(id.mapTileKey);
                const parsedTileKey = this.parseMapTileKeySafe(canonicalTileKey);
                let tile = this.loadedTileLayers.get(canonicalTileKey) ?? this.loadedTileLayers.get(id.mapTileKey);

                if (!tile && parsedTileKey) {
                    const [mapId, layerId, tileId] = parsedTileKey;
                    this.ensureTilePlaceholder(mapId, layerId, tileId, true);
                    tile = this.loadedTileLayers.get(canonicalTileKey);
                }

                if (!tile) {
                    console.error(`Could not prepare tile ${id.mapTileKey} for inspection restore!`);
                    continue;
                }

                tile.preventCulling = true;

                const resolvedFeatureId = id.featureId || "";
                if (!resolvedFeatureId) {
                    continue;
                }

                const inspectionDataComplete = this.isTileInspectionDataComplete(tile);
                if (!inspectionDataComplete) {
                    if (parsedTileKey) {
                        const [mapId, layerId, tileId] = parsedTileKey;
                        this.pinTileForSelectionInspection(mapId, layerId, tileId, canonicalTileKey);
                    }
                    features.push(new FeatureWrapper(resolvedFeatureId, tile));
                    continue;
                }

                if (!tile.has(resolvedFeatureId)) {
                    const [mapId, layerId, tileId] = parsedTileKey ?? ["", "", 0n];
                    this.showErrorMessage(
                        `The feature ${id.featureId} does not exist in the ${layerId} layer of tile ${tileId} of map ${mapId}.`);
                    continue;
                }

                features.push(new FeatureWrapper(resolvedFeatureId, tile));
            }

            return features;
        }

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

            const resolvedFeatureId = id?.featureId || "";
            if (!resolvedFeatureId) {
                continue;
            }
            if (!tile.has(resolvedFeatureId)) {
                const parsedTileKey = this.parseMapTileKeySafe(id?.mapTileKey || "");
                const [mapId, layerId, tileId] = parsedTileKey ?? ["", "", 0n];
                this.showErrorMessage(
                    `The feature ${id?.featureId} does not exist in the ${layerId} layer of tile ${tileId} of map ${mapId}.`);
                continue;
            }

            features.push(new FeatureWrapper(resolvedFeatureId, tile));
        }
        return features;
    }

    /** Resolves hover ids, drops duplicates against selection, and publishes the resulting hover set. */
    async setHoveredFeatures(tileFeatureIds: (TileFeatureId | null)[]) {
        const requestSignature = tileFeatureIds
            .filter((id): id is TileFeatureId => !!id)
            .map((id) => `${id.mapTileKey}/${id.featureId}`)
            .sort()
            .join("|");
        if (requestSignature === this.lastHoverRequestSignature) {
            return;
        }
        this.lastHoverRequestSignature = requestSignature;
        const revision = ++this.hoverConversionRevision;
        const features = await this.loadFeatures(tileFeatureIds);
        if (revision !== this.hoverConversionRevision) {
            return;
        }
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

    /** Loads a feature and centers the target view on its reported center point. */
    async focusOnFeature(viewIndex: number, tileFeatureId: TileFeatureId) {
        const features = await this.loadFeatures([tileFeatureId]);
        if (!features.length) {
            this.showErrorMessage(`Could not locate feature ${tileFeatureId.featureId} in ${tileFeatureId.mapTileKey}!`)
            return;
        }
        this.zoomToFeature(viewIndex, features[0]);
    }

    /** Moves the focused view to the inspection panel most recently focused by the user. */
    zoomToFocusedInspectionPanel() {
        const focusedPanelId = this.stateService.focusedInspectionPanelId;
        if (focusedPanelId === undefined) {
            return;
        }
        const panel = this.selectionTopic.getValue().find(candidate => candidate.id === focusedPanelId);
        if (!panel) {
            return;
        }
        const targetView = this.stateService.focusedView;
        if (panel.features.length) {
            this.zoomToFeature(targetView, panel.features[0]);
            return;
        }
        if (panel.sourceData) {
            this.zoomToSourceDataSelection(targetView, panel.sourceData);
        }
    }

    /**
     * Moves one or more views to a feature using Deck's WGS84 camera path.
     * Passing `undefined` targets every view that currently shows the feature tile.
     */
    zoomToFeature(viewIndex: number|undefined, featureWrapper: FeatureWrapper) {
        const targetViews = this.targetViewsForFeatureZoom(viewIndex, featureWrapper.featureTile);
        if (!targetViews.length) {
            return;
        }
        featureWrapper.peek((feature: Feature) => {
            const center = feature.center() as Wgs84Point;
            if (!this.isFiniteWgs84Point(center)) {
                return;
            }
            const radiusPoint = feature.boundingRadiusEndPoint() as Wgs84Point;
            const boundingRadius = this.featureBoundingRadiusMeters(center, radiusPoint);
            const altitude = this.featureZoomAltitude(center.z, boundingRadius);

            targetViews.forEach(vi =>
                this.moveToWgs84PositionTopic.next({
                    targetView: vi,
                    x: center.x,
                    y: center.y,
                    z: altitude
                }));
        });
    }

    /** Resolves the view indices affected by a feature zoom request. */
    private targetViewsForFeatureZoom(viewIndex: number|undefined, featureTile: FeatureTile): number[] {
        if (viewIndex !== undefined) {
            return viewIndex >= 0 && viewIndex < this.stateService.numViews ? [viewIndex] : [];
        }

        const targetViews: number[] = [];
        for (let i = 0; i < this.stateService.numViews; ++i) {
            if (this.viewShowsFeatureTile(i, featureTile, true)) {
                targetViews.push(i);
            }
        }
        return targetViews;
    }

    /** Fits the target view to the tile represented by a focused source-data inspection. */
    private zoomToSourceDataSelection(viewIndex: number, sourceData: SelectedSourceData) {
        if (viewIndex < 0 || viewIndex >= this.stateService.numViews) {
            return;
        }
        const parsedKey = this.parseMapTileKeySafe(sourceData.mapTileKey);
        if (!parsedKey) {
            return;
        }
        const [, , tileId] = parsedKey;
        const tileBox = coreLib.getTileBox(tileId) as number[];
        if (!Array.isArray(tileBox) || tileBox.length < 4) {
            return;
        }
        this.moveToRectangleTopic.next({
            targetView: viewIndex,
            rectangle: {
                west: tileBox[0],
                south: tileBox[1],
                east: tileBox[2],
                north: tileBox[3],
            }
        });
    }

    /** Validates the WGS84 point shape returned by the WASM feature bindings. */
    private isFiniteWgs84Point(point: Wgs84Point | undefined): point is Wgs84Point {
        return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
    }

    /** Computes a metric radius from two WGS84 points, falling back to zero for incomplete feature bounds. */
    private featureBoundingRadiusMeters(center: Wgs84Point, radiusPoint: Wgs84Point | undefined): number {
        if (!this.isFiniteWgs84Point(radiusPoint)) {
            return 0;
        }
        const centerCartesian = Cartesian3.fromDegrees(center.x, center.y, this.finiteHeight(center.z));
        const radiusCartesian = Cartesian3.fromDegrees(radiusPoint.x, radiusPoint.y, this.finiteHeight(radiusPoint.z));
        const radius = Cartesian3.distance(centerCartesian, radiusCartesian);
        return Number.isFinite(radius) ? radius : 0;
    }

    /** Converts feature size into a Deck camera altitude with a useful minimum for point-like features. */
    private featureZoomAltitude(centerHeight: number | undefined, boundingRadius: number): number {
        return this.finiteHeight(centerHeight) + Math.max(100, 3 * Math.max(0, boundingRadius));
    }

    /** Normalizes optional feature heights from the WASM point representation. */
    private finiteHeight(height: number | undefined): number {
        return Number.isFinite(height) ? Math.max(0, height as number) : 0;
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

    /** Deduplicates and publishes legal-info strings per map as tiles arrive. */
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
        this.viewVisualizationState[viewIndex].visualizationQueue.clear();
        if (viewIndex >= 0 && viewIndex < this.inFlightVisualizationRendersByView.length) {
            this.inFlightVisualizationRendersByView[viewIndex] = 0;
        }
        if (viewIndex >= 0 && viewIndex < this.inFlightBlockedTileIdsByView.length) {
            this.inFlightBlockedTileIdsByView[viewIndex].clear();
        }
    }

    /** Persists map/layer visibility changes and schedules the resulting viewport refresh. */
    setMapLayerVisibility(viewIndex: number, mapOrGroupId: string, layerId: string = "", state: boolean) {
        this.maps.setMapLayerVisibility(viewIndex, mapOrGroupId, layerId, state);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    /** Toggles the diagnostic tile-border overlay in one view. */
    toggleViewTileBorderVisibility(viewIndex: number) {
        const nextState = !this.maps.getViewTileBorderState(viewIndex);
        this.setViewTileBorderVisibility(viewIndex, nextState);
    }

    /** Sets diagnostic tile-border overlay visibility in one view. */
    setViewTileBorderVisibility(viewIndex: number, enabled: boolean) {
        if (this.maps.getViewTileBorderState(viewIndex) === enabled) {
            return;
        }
        this.maps.setViewTileBorderState(viewIndex, enabled);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    /** Sets the tile-grid coordinate mode and refreshes affected overlays. */
    setViewTileGridMode(viewIndex: number, mode: TileGridMode) {
        this.maps.setViewTileGridMode(viewIndex, mode);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    /** Persists an explicit layer level for one view and refreshes visible tiles. */
    setMapLayerLevel(viewIndex: number, mapId: string, layerId: string, level: number) {
        this.maps.setMapLayerLevel(viewIndex, mapId, layerId, level);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    /** Enables or disables auto-level, normalizing the stored level when auto mode is turned on. */
    setMapLayerAutoLevel(viewIndex: number, mapId: string, layerId: string, autoLevel: boolean) {
        if (autoLevel) {
            const configuredLevel = this.maps.getMapLayerLevel(viewIndex, mapId, layerId);
            const normalizedLevel = this.autoSelectedMapLayerLevel(viewIndex, mapId, layerId, configuredLevel);
            this.maps.setMapLayerLevel(viewIndex, mapId, layerId, normalizedLevel);
        }
        this.maps.setMapLayerAutoLevel(viewIndex, mapId, layerId, autoLevel);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    /** Returns whether a map layer currently follows the auto-level heuristic in the given view. */
    isMapLayerAutoLevelEnabled(viewIndex: number, mapId: string, layerId: string): boolean {
        return this.maps.getMapLayerAutoLevel(viewIndex, mapId, layerId);
    }

    /** Returns the currently active level, substituting the auto-selected level when needed. */
    getEffectiveMapLayerLevel(viewIndex: number, mapId: string, layerId: string): number {
        const configuredLevel = this.maps.getMapLayerLevel(viewIndex, mapId, layerId);
        if (!this.maps.getMapLayerAutoLevel(viewIndex, mapId, layerId)) {
            return configuredLevel;
        }
        return this.autoSelectedMapLayerLevel(viewIndex, mapId, layerId, configuredLevel);
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
            if (visibleTileCount <= MapDataService.AUTO_LAYER_LEVEL_MAX_VISIBLE_TILES) {
                return candidateLevel;
            }
        }
        return advertisedLevels[0];
    }

    /** Returns the sorted unique zoom levels declared for a layer, clamped to sane bounds. */
    private advertisedLayerLevels(mapId: string, layerId: string): number[] {
        const mapItem = this.maps.maps.get(mapId);
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

    /** Returns whether a tile should currently be visible in a view after viewport and level checks. */
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
            tile.level() === this.getEffectiveMapLayerLevel(viewIndex, tile.mapName, tile.layerName);
    }

    /** Schedules timer work outside Angular so frequent render churn does not trigger global change detection. */
    private scheduleOutsideAngular(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
        return this.ngZone.runOutsideAngular(() => setTimeout(callback, delay));
    }

    /** Schedules a RAF callback outside Angular for performance sampling. */
    private requestAnimationFrameOutsideAngular(callback: (timestamp: number) => void): number {
        return this.ngZone.runOutsideAngular(() => window.requestAnimationFrame(callback));
    }

    /** Proxies an info toast through Angular's zone. */
    private showInfoMessage(message: string) {
        this.ngZone.run(() => this.messageService.showInfo(message));
    }

    /** Proxies an error toast through Angular's zone. */
    private showErrorMessage(message: string) {
        this.ngZone.run(() => this.messageService.showError(message));
    }

    /**
     * Returns an internal layerId for a human-readable layer name.
     *
     * @param layerName Layer id to get the name for
     */
    /** Resolves a human-readable source-data layer name back to its internal layer id. */
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

    /** Returns every map that could expose source-data for a tile id at the matching level. */
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

    /** Returns the set of feature levels that are currently visible in one view across all layers. */
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
                levels.add(this.getEffectiveMapLayerLevel(viewIndex, mapId, layerInfo.id));
            }
        }
        return levels;
    }

    /** Lists source-data or metadata layers for a map using human-readable names. */
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
