import {Injectable} from "@angular/core";
import {BehaviorSubject, filter, Subject, Subscription, take} from "rxjs";
import {
    FeatureSearchAttributeScopeCandidate,
    SearchResultTileEntry,
    SearchResultTilePayload
} from "../mapdata/map-runtime.model";
import {MapInfoService} from "../mapdata/map-info.service";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {
    FeatureSearchResolvedDefinition,
    featureSearchResultFields
} from "../mapdata/feature-search-runtime-state.model";
import {FeatureSearchSchemaService, FeatureSearchScopeAnalysis} from "../mapdata/feature-search-schema.service";
import {
    CompletionCandidate,
    DiagnosticsMessage,
    SearchResultFieldValueSummary,
    SearchTraceValueSummary,
    SearchValueHistogramBucket,
    SearchValueKindCounts,
    SearchValueNumericSummary,
    SearchValueSummariesState,
    SearchValueSummary
} from "./search.model";
import {GeoMath} from "../integrations/geo";
import {coreLib, uint8ArrayFromWasm, uint8ArrayToWasm} from "../integrations/wasm";
import {
    AppStateService,
    FEATURE_SEARCH_DIALOG_LAYOUT_ID,
    FEATURE_SEARCH_EXPORT_DIALOG_LAYOUT_ID,
    SEARCH_DOCK_TAB_ID
} from "../shared/appstate.service";
import {
    DEFAULT_FEATURE_SEARCH_TILE_LEVELS,
    DEFAULT_FEATURE_SEARCH_VIEW_INDICES,
    defaultFeatureSearchViewIndicesForMapLayers,
    FeatureSearchMapLayerRef,
    FeatureSearchRenderStrategy,
    FeatureSearchScope,
    FeatureSearchStateEntry,
    normalizeFeatureSearchFeatureTypes
} from "../shared/feature-search-state";
import type {MapTileStreamFilterStatusPayload} from "../mapdata/tilestream";
import {
    SearchResultDensityIndex,
    SearchResultPoint,
    SearchResultPointBucket
} from "./search-result-density.model";
import type {
    SearchCompletionRequestMessage,
    SearchCompletionWorkerOptions,
    SearchCompletionResultMessage
} from "./search-completion.worker.protocol";
import {featureSearchDefinitionFromImportPayload} from "./feature-search-export.util";
import {FrameBudgetLoop} from "../shared/frame-budget-loop";
import {
    StyledMapgetLayer,
    type StyledMapgetLayerEvent
} from "../mapdata/styled-mapget-layer.model";
import {
    filterSubscriptionCoverageMembershipEqual,
    type FilterSubscriptionCoverage
} from "../mapdata/filter-subscription.model";
import type {FilterTileState} from "../mapdata/filter-tile-state.model";
import type {MapgetLayer} from "../mapdata/mapget-layer.model";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {
    compileFeatureSearchStyle,
    type CompiledFeatureSearchStyle
} from "./feature-search-style";
import {formatFeatureInspectionTarget} from "../shared/tile-feature-id";

export interface FeatureSearchResultEntry {
    label: string;
    mapId: string;
    layerId: string;
    featureId: string;
    resultIndex: number;
    resultKey: string;
    mapTileKey: string;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: number;
    hoverFeatureId: string;
    attributeIndex?: number;
    validityIndex?: number;
    validityCount?: number;
}

export interface FeatureSearchSession {
    id: string;
    layoutId: string;
    definition: FeatureSearchStateEntry;
    runId: string;
    refresh: number;
    paused: boolean;
    progressDone: number;
    progressTotal: number;
    backendComplete: boolean;
    resultTileIngressDone: number;
    resultTileIngressTotal: number;
    complete: boolean;
    startTime: number;
    endTime: number;
    pointColor: string;
    timeElapsed: string;
    totalFeatureCount: number;
    searchResults: FeatureSearchResultEntry[];
    diagnostics: DiagnosticsMessage[];
    diagnosticsBlobs: Uint8Array[];
    valueSummaries: SearchValueSummariesState;
    valueSummaryRevision: number;
    schemaAnalysis: FeatureSearchSessionSchemaAnalysis;
    lastResolvedDefinition?: FeatureSearchResolvedDefinition;
    lastResolvedDefinitionSignature?: string;
    errors: Set<string>;
    progressByRequestKey: Map<string, SearchRequestProgress>;
    searchResultTilesBySourceKey: Map<string, SearchResultTileContribution>;
    searchResultPointsByFeatureKey: Map<string, SearchResultPoint>;
    searchResultPointsCache: SearchResultPoint[];
    searchResultPointBucketsCache: SearchResultPointBucket[];
    searchResultPointBucketIndexBySourceKey: Map<string, number>;
    searchResultPointsCacheDirty: boolean;
    searchResultPointsVersion: number;
    searchResultDensityIndex: SearchResultDensityIndex;
}

export interface FeatureSearchSessionSchemaAnalysis {
    signature: string;
    status: "pending" | "ready" | "error";
    concreteScope: "feature" | "attribute";
    normalizedQuery: string;
    attributeScopes: FeatureSearchAttributeScopeCandidate[];
    attributeScopeCandidateCount: number;
    rewriteSuppressed: boolean;
    rewriteSuppressionReason: string;
    matchedFieldNames: string[];
    matchedEnumValues: string[];
    matchedFeatureTypes: string[];
    error?: string;
}

interface SearchRequestProgress {
    tilesQueued: number;
    tilesSearched: number;
    chunksEmitted: number;
    chunksReported: boolean;
    matches: number;
    terminal: boolean;
}

interface SearchResultTileContribution {
    refresh: number;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: number;
    requestOrder: number;
    resultCount: number;
    resultFields: string[];
    results: FeatureSearchResultEntry[];
    diagnostics: Uint8Array | null;
    layerBlob: Uint8Array;
    valueSummary: SearchTileValueSummaries | null;
    points: SearchResultPoint[];
}

interface SearchTileValueSummaries {
    resultFields: SearchResultFieldValueSummary[];
    traces: SearchTraceValueSummary[];
}

interface SearchStyledPresentation {
    key: string;
    sessionId: string;
    mapgetLayer: MapgetLayer;
    compiled: CompiledFeatureSearchStyle;
    styledLayer: StyledMapgetLayer;
    subscription: Subscription;
    definitionSignature: string;
    coverage: FilterSubscriptionCoverage | null;
    coverageOrder: Map<number, number>;
}

interface SearchSubsetIngestionTask {
    presentationKey: string;
    searchId: string;
    sourceTileKey: string;
    state: FilterTileState;
    valueVersion: number;
    generation: number;
    offset: number;
    resultCount: number;
    resultFields: string[];
    projectedFieldIndices: number[];
    includeExactPositions: boolean;
}

export interface FeatureSearchOverlayLayer {
    id: string;
    pointsVersion: number;
    pointColor: string;
    pointColorRgba: [number, number, number, number];
    selectedViewIndices: number[];
    renderStrategy: FeatureSearchRenderStrategy;
    styleRuleCount: number;
    pointBuckets: SearchResultPointBucket[];
    densityIndex: SearchResultDensityIndex;
}

export interface FeatureSearchResultLayer extends FeatureSearchOverlayLayer {
    points: SearchResultPoint[];
}

export interface CompletionOwnerState {
    candidates: BehaviorSubject<CompletionCandidate[]>;
    pending: BehaviorSubject<boolean>;
    candidateList: CompletionCandidate[];
    requestSerial: number;
}

export interface FeatureSearchCompletionOptions {
    scope?: FeatureSearchScope;
    selectedMapLayers?: FeatureSearchMapLayerRef[];
    timeoutMs?: number;
}

export interface FeatureSearchActionPayload {
    selectedMapLayers: FeatureSearchMapLayerRef[];
    selectedViewIndices?: number[];
    selectedMapLayersManual?: boolean;
}

/** Extracts a compact feature-search payload from a schema completion candidate. */
export function featureSearchActionPayloadFromCompletion(
    candidate: CompletionCandidate | null | undefined
): FeatureSearchActionPayload | undefined {
    const selectedMapLayers = uniqueFeatureSearchMapLayers(candidate?.originLayers ?? []);
    return selectedMapLayers.length ? {selectedMapLayers} : undefined;
}

/** Extracts selected map/layers from a persisted or transient feature-search action payload. */
export function featureSearchSelectedMapLayersFromPayload(payload: unknown): FeatureSearchMapLayerRef[] | undefined {
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
    const selectedMapLayers = Array.isArray(record?.["selectedMapLayers"])
        ? record["selectedMapLayers"]
        : [];
    const result = uniqueFeatureSearchMapLayers(selectedMapLayers.flatMap(item => {
        const raw = item && typeof item === "object" && !Array.isArray(item)
            ? item as Record<string, unknown>
            : null;
        const mapId = typeof raw?.["mapId"] === "string" ? raw["mapId"] : "";
        const layerId = typeof raw?.["layerId"] === "string" ? raw["layerId"] : "";
        return mapId && layerId ? [{mapId, layerId}] : [];
    }));
    return result.length ? result : undefined;
}

/** Extracts selected result views from a persisted or transient feature-search action payload. */
export function featureSearchSelectedViewIndicesFromPayload(payload: unknown): number[] | undefined {
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
    const selectedViewIndices = Array.isArray(record?.["selectedViewIndices"])
        ? record["selectedViewIndices"]
        : [];
    const seen = new Set<number>();
    const result: number[] = [];
    for (const item of selectedViewIndices) {
        const viewIndex = Number(item);
        if (!Number.isInteger(viewIndex) || viewIndex < 0 || viewIndex >= DEFAULT_FEATURE_SEARCH_VIEW_INDICES.length
            || seen.has(viewIndex)) {
            continue;
        }
        seen.add(viewIndex);
        result.push(viewIndex);
    }
    return result.length ? result.sort((lhs, rhs) => lhs - rhs) : undefined;
}

/** Returns whether a feature-search action payload represents explicit user map-layer scope. */
export function featureSearchMapLayersManualFromPayload(payload: unknown): boolean | undefined {
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
    return typeof record?.["selectedMapLayersManual"] === "boolean"
        ? record["selectedMapLayersManual"]
        : undefined;
}

/** Returns unique feature-search map/layer refs in first-seen order. */
function uniqueFeatureSearchMapLayers(refs: FeatureSearchMapLayerRef[]): FeatureSearchMapLayerRef[] {
    const result: FeatureSearchMapLayerRef[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
        const mapId = ref.mapId?.trim();
        const layerId = ref.layerId?.trim();
        const key = JSON.stringify([mapId, layerId]);
        if (!mapId || !layerId || seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push({mapId, layerId});
    }
    return result;
}

export interface FeatureSearchExportGroupingOption {
    id: number;
    name: string;
}

export interface FeatureSearchExportDialogRequest {
    searchId: string;
    includeConfiguration: boolean;
    includeResults: boolean;
    closeAfterExport: boolean;
    grouping: FeatureSearchExportGroupingOption[];
    filterValue: string;
}

export interface FeatureSearchExportDialogOptions {
    includeConfiguration?: boolean;
    includeResults?: boolean;
    closeAfterExport?: boolean;
    grouping?: FeatureSearchExportGroupingOption[];
    filterValue?: string;
}

export type FeatureSearchRunOptions = Partial<Pick<
    FeatureSearchStateEntry,
    "scope" | "selectedMapLayers" | "selectedViewIndices" | "selectedMapLayersManual" | "selectedFeatureTypes"
>>;

@Injectable({providedIn: 'root'})
/**
 * Coordinates feature search, query completion, result indexing, and search-marker overlays.
 *
 * Search execution is delegated to mapget; this service keeps server progress and UI-friendly result caches in sync.
 */
export class FeatureSearchService {
    private static readonly LOCATION_MARKER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="48" viewBox="0 0 24 24" width="48"><path d="M12 2C8.1 2 5 5.1 5 9c0 3.3 4.2 8.6 6.6 11.6.4.5 1.3.5 1.7 0C14.8 17.6 19 12.3 19 9c0-3.9-3.1-7-7-7zm0 9.5c-1.4 0-2.5-1.1-2.5-2.5S10.6 6.5 12 6.5s2.5 1.1 2.5 2.5S13.4 11.5 12 11.5z" fill="white"/></svg>`;
    private static readonly FLOATING_DIALOG_WIDTH_EM = 42;
    private static readonly FLOATING_DIALOG_HEIGHT_EM = 42;
    private static readonly FLOATING_DIALOG_HORIZONTAL_MARGIN_EM = 2;
    private static readonly FLOATING_DIALOG_VERTICAL_MARGIN_EM = 5;
    private static readonly DEFAULT_SEARCH_COLORS = [
        "#ea4336",
        "#3474ff",
        "#ff04d6",
        "#ffa600",
        "#4ad6d6",
        "#8f52ff"
    ];
    private static readonly DEFAULT_COMPLETION_OWNER_ID = "omnibox";
    private static readonly VALUE_SUMMARY_HISTOGRAM_LIMIT = 64;
    private static readonly VALUE_SUMMARY_DISTINCT_LIMIT = 2048;
    private static readonly VALUE_SUMMARY_TILE_BATCH_SIZE = 12;

    static layoutIdForSearch(searchId: string): string {
        return `${FEATURE_SEARCH_DIALOG_LAYOUT_ID}:${searchId}`;
    }

    private searchRunCounter = 0;
    private searchSessionCounter = 0;
    private searchPresentationRevision = 0;

    readonly sessionsChanged = new BehaviorSubject<FeatureSearchSession[]>([]);
    readonly progress: BehaviorSubject<FeatureSearchSession|null> = new BehaviorSubject<FeatureSearchSession|null>(null);
    readonly exportDialogRequest = new BehaviorSubject<FeatureSearchExportDialogRequest | null>(null);
    diagnosticsMessageLimit: number = 25;

    private readonly completionStates = new Map<string, CompletionOwnerState>();
    private readonly completionTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly completionCandidates = this.completionStateForOwner(FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID).candidates;
    readonly completionPending = this.completionStateForOwner(FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID).pending;
    completionCandidateLimit: number = 15;

    showFeatureSearchDialog: boolean = false;

    private readonly searchSessions: FeatureSearchSession[] = [];
    private searchResultLayersVersionValue = 0;
    private locationMarkerGraphicUrl: string | null = null;
    private pendingResultDataRebuildSessionIds = new Set<string>();
    private pendingForcedGenerationIds = new Set<string>();
    private pendingSchemaAnalysisSignatures = new Set<string>();
    private pendingProgressEmissionSessionIds = new Set<string>();
    private resultDataRebuildRaf: number | null = null;
    private progressEmissionRaf: number | null = null;
    private readonly searchPresentations = new Map<string, SearchStyledPresentation>();
    private readonly searchPresentationByLayer =
        new Map<StyledMapgetLayer, SearchStyledPresentation>();
    private readonly searchRenderDecisionCache = new Map<string, boolean>();
    private readonly pendingCoverageRefreshIds = new Set<string>();
    private searchPresentationReconcileQueued = false;
    readonly searchPresentationsChanged = new Subject<void>();
    private readonly subsetIngestionLoop = new FrameBudgetLoop<SearchSubsetIngestionTask>(
        (task, deadline) => this.ingestSearchSubsetTask(task, deadline),
        10
    );

    public fixedDiagnosticsSearchQuery: Subject<string> = new Subject<string>();

    /**
     * Initializes marker styling and reconciles persisted subset searches.
     */
    constructor(private mapInfo: MapInfoService,
                private searchSchema: FeatureSearchSchemaService,
                private tileStream: MapTileStreamService,
                private viewState: MapViewStateService,
                private stateService: AppStateService) {
        this.stateService.ready.pipe(
            filter((ready): ready is true => ready),
            take(1)
        ).subscribe(() => {
            this.resetStaleDockState();
            this.reconcilePersistedFeatureSearchState(this.stateService.featureSearches);
        });
        this.stateService.featureSearchState.subscribe(entries => {
            if (!this.stateService.ready.getValue()) {
                return;
            }
            this.reconcilePersistedFeatureSearchState(entries);
        });
        this.viewState.viewStateChanged.subscribe(() => {
            this.searchRenderDecisionCache.clear();
            for (const session of this.searchSessions) {
                if (session.definition.autoUpdate) {
                    this.pendingCoverageRefreshIds.add(session.id);
                }
            }
            this.scheduleSearchPresentationReconcile();
        });
        this.mapInfo.layerStateChanged.subscribe(reason => {
            if (reason === "datasources" && this.stateService.ready.getValue()) {
                this.invalidateAllSchemaAnalysis();
                this.reconcilePersistedFeatureSearchState(this.stateService.featureSearches);
            }
        });
        this.installFeatureSearchDiagnostics();
    }

    /** Installs a console helper for capturing restored-search state without mutating the application. */
    private installFeatureSearchDiagnostics(): void {
        const host = globalThis as typeof globalThis & {
            erdblickFeatureSearchDiagnostics?: () => unknown;
            erdblickFeatureSearchDiagnosticsJson?: () => string;
        };
        host.erdblickFeatureSearchDiagnostics = () => this.featureSearchDiagnosticsSnapshot();
        host.erdblickFeatureSearchDiagnosticsJson = () => JSON.stringify(this.featureSearchDiagnosticsSnapshot(), null, 2);
    }

    /** Returns the UI/service side of the feature-search diagnostic snapshot. */
    private featureSearchDiagnosticsSnapshot(): unknown {
        return {
            timestamp: new Date().toISOString(),
            url: typeof location === "undefined" ? "" : location.href,
            appReady: this.stateService.ready.getValue(),
            numViews: this.stateService.numViews,
            persistedFeatureSearches: this.stateService.featureSearches.map(entry => this.searchDefinitionDiagnostics(entry)),
            sessions: this.searchSessions.map(session => ({
                id: session.id,
                refresh: session.refresh,
                runId: session.runId,
                complete: session.complete,
                paused: session.paused,
                backendComplete: session.backendComplete,
                progressDone: session.progressDone,
                progressTotal: session.progressTotal,
                resultTileIngressDone: session.resultTileIngressDone,
                resultTileIngressTotal: session.resultTileIngressTotal,
                totalFeatureCount: session.totalFeatureCount,
                searchResultCount: session.searchResults.length,
                contributionCount: session.searchResultTilesBySourceKey.size,
                schemaAnalysis: session.schemaAnalysis,
                hasLastResolvedDefinition: !!session.lastResolvedDefinition,
                lastResolvedDefinitionSignature: session.lastResolvedDefinitionSignature ?? null,
                definition: this.searchDefinitionDiagnostics(session.definition),
                progressByRequestKey: Array.from(session.progressByRequestKey.entries()).map(([key, value]) => ({
                    key,
                    ...value
                })),
                errors: Array.from(session.errors)
            })),
            tileStream: this.tileStream.featureSearchDiagnosticsSnapshot()
        };
    }

    /** Summarizes a feature-search definition without carrying large style payloads. */
    private searchDefinitionDiagnostics(definition: FeatureSearchStateEntry): Record<string, unknown> {
        return {
            id: definition.id,
            query: definition.query,
            scope: definition.scope,
            enabled: definition.enabled,
            paused: definition.paused,
            autoUpdate: definition.autoUpdate,
            selectedMapLayers: definition.selectedMapLayers,
            selectedMapLayersManual: definition.selectedMapLayersManual,
            selectedTileLevels: definition.selectedTileLevels,
            selectedViewIndices: definition.selectedViewIndices,
            selectedFeatureTypes: definition.selectedFeatureTypes,
            searchStyleRuleCount: definition.searchStyleRules.length
        };
    }

    /** Removes persisted dock chrome for searches that cannot survive a page reload. */
    private resetStaleDockState(): void {
        const activeLayoutIds = new Set(
            this.stateService.featureSearches.map(entry => FeatureSearchService.layoutIdForSearch(entry.id))
        );
        for (const layoutId of Object.keys(this.stateService.dialogLayoutsState.getValue())) {
            if ((layoutId === FEATURE_SEARCH_DIALOG_LAYOUT_ID || layoutId.startsWith(`${FEATURE_SEARCH_DIALOG_LAYOUT_ID}:`))
                && !activeLayoutIds.has(layoutId)) {
                this.stateService.removeDialogLayout(layoutId);
            }
        }
    }

    /** Returns a stable snapshot of all live feature-search sessions. */
    getSessions(): FeatureSearchSession[] {
        return [...this.searchSessions];
    }

    /** Returns one live session by runtime id. */
    getSession(id: string): FeatureSearchSession | undefined {
        return this.getInternalSession(id);
    }

    /** Starts lazy native aggregation of withFields and trace values for the Diagnostics tab. */
    requestValueSummaries(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.canSummarizeSessionValues(session)) {
            return;
        }
        if (session.valueSummaries.status === "loading"
            || (session.valueSummaries.revision === session.valueSummaryRevision
                && (session.valueSummaries.status === "ready"
                    || session.valueSummaries.status === "empty"
                    || session.valueSummaries.status === "error"))) {
            return;
        }

        const revision = session.valueSummaryRevision;
        const totalTiles = Array.from(session.searchResultTilesBySourceKey.values())
            .filter(contribution => contribution.layerBlob.length > 0)
            .length;
        session.valueSummaries = this.emptyValueSummariesState(totalTiles === 0 ? "empty" : "loading", revision, totalTiles);
        this.progress.next(session);
        if (totalTiles > 0) {
            void this.computeValueSummariesAsync(session.id, revision);
        }
    }

    /** Returns all live sessions currently represented inside the dock. */
    getDockedSessions(): FeatureSearchSession[] {
        return this.searchSessions
            .filter(session => this.isSessionDocked(session.id))
            .sort((a, b) => this.sessionDockOrder(a) - this.sessionDockOrder(b));
    }

    /** Returns all live sessions currently represented as floating dialogs. */
    getUndockedSessions(): FeatureSearchSession[] {
        return this.searchSessions.filter(session => !this.isSessionDocked(session.id));
    }

    /** Returns whether a session is currently represented inside the dock. */
    isSessionDocked(sessionId: string): boolean {
        const session = this.getInternalSession(sessionId);
        return !!session && this.stateService.isSurfaceDocked(session.layoutId);
    }

    /** Returns the persisted dock position for one session, falling back to creation order. */
    private sessionDockOrder(session: FeatureSearchSession): number {
        const order = this.stateService.getDialogLayout(session.layoutId)?.dockOrder;
        if (typeof order === 'number' && Number.isFinite(order)) {
            return order;
        }
        const index = this.searchSessions.findIndex(candidate => candidate.id === session.id);
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    }

    /**
     * Returns the legacy single-marker icon used for explicit coordinate marking.
     */
    markerGraphics(): string {
        if (!this.locationMarkerGraphicUrl) {
            this.locationMarkerGraphicUrl =
                `data:image/svg+xml;base64,${btoa(FeatureSearchService.LOCATION_MARKER_SVG)}`;
        }
        return this.locationMarkerGraphicUrl;
    }

    /** Returns one marker-layer descriptor per search so colors stay independent. */
    getSearchResultLayers(): FeatureSearchResultLayer[] {
        return this.searchSessions
            .filter(session => session.definition.showResultsOnMap)
            .map(session => ({
                id: session.id,
                pointsVersion: session.searchResultPointsVersion,
                pointColor: session.pointColor,
                pointColorRgba: this.parseSearchResultColor(session.pointColor),
                selectedViewIndices: [...session.definition.selectedViewIndices],
                renderStrategy: session.definition.renderStrategy,
                styleRuleCount: session.definition.searchStyleRules.length,
                points: this.getSessionSearchResultPoints(session),
                pointBuckets: this.getSessionSearchResultPointBuckets(session),
                densityIndex: session.searchResultDensityIndex
            }))
            .filter(layer => layer.points.length > 0);
    }

    /** Returns map-overlay search descriptors without materializing every per-result point. */
    getSearchResultOverlayLayers(): FeatureSearchOverlayLayer[] {
        return this.searchSessions
            .filter(session => session.definition.showResultsOnMap)
            .map(session => ({
                id: session.id,
                pointsVersion: session.searchResultPointsVersion,
                pointColor: session.pointColor,
                pointColorRgba: this.parseSearchResultColor(session.pointColor),
                selectedViewIndices: [...session.definition.selectedViewIndices],
                renderStrategy: session.definition.renderStrategy,
                styleRuleCount: session.definition.searchStyleRules.length,
                pointBuckets: this.getSessionSearchResultPointBuckets(session),
                densityIndex: session.searchResultDensityIndex
            }))
            .filter(layer => layer.pointBuckets.length > 0);
    }

    /** Reconciles persisted feature-search definitions with runtime sessions. */
    private reconcileFeatureSearchState(definitions: FeatureSearchStateEntry[]): void {
        const definitionById = new Map(definitions.map(definition => [definition.id, definition]));
        let structuralChange = false;

        for (const session of [...this.searchSessions]) {
            if (!definitionById.has(session.id)) {
                structuralChange = this.closeRuntimeSearch(session.id) || structuralChange;
            }
        }

        for (const definition of definitions) {
            const session = this.getInternalSession(definition.id);
            if (!session) {
                const nextSession = this.createSession(definition);
                this.searchSessions.push(nextSession);
                structuralChange = true;
                this.updateSessionColor(nextSession, definition.pinColor);
                if (definition.enabled) {
                    this.startSessionSearch(nextSession, definition);
                } else {
                    this.applySearchDisabled(nextSession, definition);
                }
                continue;
            }
            this.applyFeatureSearchDefinition(session, definition);
        }

        if (structuralChange) {
            this.notifySessionsChanged();
        }
        this.syncSearchRequestsToMapService();
    }

    /** Applies non-structural definition changes to an existing runtime session. */
    private applyFeatureSearchDefinition(session: FeatureSearchSession, definition: FeatureSearchStateEntry): void {
        const previous = session.definition;
        const normalizedColor = this.normalizeHexColor(definition.pinColor);
        const selectedLayersChanged = JSON.stringify(previous.selectedMapLayers)
            !== JSON.stringify(definition.selectedMapLayers);
        const selectedTileLevelsChanged = JSON.stringify(previous.selectedTileLevels)
            !== JSON.stringify(definition.selectedTileLevels);
        const selectedFeatureTypesChanged = JSON.stringify(previous.selectedFeatureTypes)
            !== JSON.stringify(definition.selectedFeatureTypes);
        const selectedViewsChanged = JSON.stringify(previous.selectedViewIndices)
            !== JSON.stringify(definition.selectedViewIndices);

        if (previous.enabled !== definition.enabled) {
            if (!definition.enabled) {
                this.applySearchDisabled(session, definition);
                return;
            }
            this.resetSessionSearch(session, definition);
            this.updateSessionColor(session, normalizedColor);
            this.startSessionSearch(session, definition, {forceGenerationIds: [session.id]});
            return;
        }

        if (!definition.enabled) {
            session.definition = definition;
            this.updateSessionColor(session, normalizedColor);
            this.progress.next(session);
            this.syncSearchRequestsToMapService();
            return;
        }

        const concreteScope = session.schemaAnalysis.status === "ready"
            ? session.schemaAnalysis.concreteScope
            : "feature";
        const previousFields = featureSearchResultFields(previous, concreteScope);
        const nextFields = featureSearchResultFields(definition, concreteScope);
        const searchGenerationChanged = previous.query !== definition.query
            || previous.scope !== definition.scope
            || selectedLayersChanged
            || selectedTileLevelsChanged
            || selectedFeatureTypesChanged
            || JSON.stringify(previousFields) !== JSON.stringify(nextFields);

        if (searchGenerationChanged) {
            this.resetSessionSearch(session, definition);
            this.updateSessionColor(session, normalizedColor);
            this.startSessionSearch(session, definition);
            return;
        }

        session.definition = definition;
        if (session.pointColor !== normalizedColor) {
            this.updateSessionColor(session, normalizedColor);
        }
        if (session.paused !== definition.paused) {
            if (definition.paused) {
                this.applySearchPause(session);
            } else {
                this.applySearchResume(session);
            }
        }
        if (previous.showResultsOnMap !== definition.showResultsOnMap || selectedViewsChanged) {
            this.bumpSearchResultLayersVersion();
            this.progress.next(session);
        }
        if (JSON.stringify(previous.renderStrategy) !== JSON.stringify(definition.renderStrategy)) {
            this.bumpSearchResultLayersVersion();
            this.progress.next(session);
        }
        if (previous.autoUpdate !== definition.autoUpdate
            || previous.bookmarked !== definition.bookmarked
            || previous.enabled !== definition.enabled
            || selectedLayersChanged
            || selectedTileLevelsChanged
            || selectedFeatureTypesChanged
            || selectedViewsChanged) {
            this.progress.next(session);
        }
        if (JSON.stringify(previous.searchStyleRules ?? []) !== JSON.stringify(definition.searchStyleRules ?? [])) {
            this.bumpSearchResultLayersVersion();
            this.progress.next(session);
        }
        this.syncSearchRequestsToMapService();
    }

    /** Selects the next default result color for a newly created search. */
    private nextDefaultSearchColor(): string {
        const color = FeatureSearchService.DEFAULT_SEARCH_COLORS[
            this.searchSessionCounter % FeatureSearchService.DEFAULT_SEARCH_COLORS.length
        ];
        this.searchSessionCounter += 1;
        return color;
    }

    /** Returns all feature map/layers that are visible in at least one view. */
    private activeFeatureSearchLayers(): FeatureSearchMapLayerRef[] {
        const selected = new Map<string, FeatureSearchMapLayerRef>();
        for (const [mapId, map] of this.mapInfo.maps.maps) {
            for (const layer of map.allFeatureLayers()) {
                for (let viewIndex = 0; viewIndex < this.stateService.numViews; ++viewIndex) {
                    if (!this.mapInfo.maps.getMapLayerVisibility(viewIndex, mapId, layer.id)) {
                        continue;
                    }
                    selected.set(JSON.stringify([mapId, layer.id]), {mapId, layerId: layer.id});
                    break;
                }
            }
        }
        return Array.from(selected.values())
            .sort((lhs, rhs) => lhs.mapId.localeCompare(rhs.mapId) || lhs.layerId.localeCompare(rhs.layerId));
    }

    /** Returns the view indices that should receive visualizations for a newly created search. */
    private activeFeatureSearchViewIndices(selectedMapLayers: FeatureSearchMapLayerRef[] = []): number[] {
        return defaultFeatureSearchViewIndicesForMapLayers(
            selectedMapLayers,
            this.stateService.numViews,
            (viewIndex, ref) => this.mapInfo.maps.getMapLayerVisibility(viewIndex, ref.mapId, ref.layerId)
        );
    }

    /** Returns all feature map/layers enabled in a specific view. */
    featureSearchLayersForView(viewIndex: number): FeatureSearchMapLayerRef[] {
        const selected = new Map<string, FeatureSearchMapLayerRef>();
        if (!Number.isInteger(viewIndex) || viewIndex < 0 || viewIndex >= this.stateService.numViews) {
            return [];
        }
        for (const [mapId, map] of this.mapInfo.maps.maps) {
            for (const layer of map.allFeatureLayers()) {
                if (!this.mapInfo.maps.getMapLayerVisibility(viewIndex, mapId, layer.id)) {
                    continue;
                }
                selected.set(JSON.stringify([mapId, layer.id]), {mapId, layerId: layer.id});
            }
        }
        return Array.from(selected.values())
            .sort((lhs, rhs) => lhs.mapId.localeCompare(rhs.mapId) || lhs.layerId.localeCompare(rhs.layerId));
    }

    /** Returns enabled feature map/layers that currently have loaded non-empty data in a specific view. */
    featureSearchLayersWithDataForView(viewIndex: number): FeatureSearchMapLayerRef[] {
        // Source occupancy now belongs to view-owned subset dependencies. The
        // action merely needs eligible visible layers; excluding an unknown
        // layer here would make the result depend on presentation timing.
        return this.featureSearchLayersForView(viewIndex);
    }

    /** Reconciles persisted feature-search definitions with live runtime sessions. */
    private reconcilePersistedFeatureSearchState(definitions: FeatureSearchStateEntry[]): void {
        this.reconcileFeatureSearchState(definitions);
    }

    /** Starts a feature search from the compact payload stored on search actions/history entries. */
    runFromActionPayload(query: string, payload?: unknown): FeatureSearchSession {
        const selectedMapLayers = featureSearchSelectedMapLayersFromPayload(payload);
        const selectedViewIndices = featureSearchSelectedViewIndicesFromPayload(payload);
        const selectedMapLayersManual = featureSearchMapLayersManualFromPayload(payload);
        return this.run(query, {
            ...(selectedMapLayers ? {selectedMapLayers} : {}),
            ...(selectedViewIndices ? {selectedViewIndices} : {}),
            ...(selectedMapLayersManual !== undefined ? {selectedMapLayersManual} : {})
        });
    }

    /** Starts a new feature search over the currently prioritized tiles, optionally with explicit scope/layers. */
    run(
        query: string,
        options: FeatureSearchRunOptions = {}
    ): FeatureSearchSession {
        const selectedMapLayers = options.selectedMapLayers === undefined
            ? this.activeFeatureSearchLayers()
            : this.mapLayersForSearchContext(options.selectedMapLayers);
        const selectedViewIndices = options.selectedViewIndices
            ?? this.activeFeatureSearchViewIndices(selectedMapLayers);
        const entry = this.stateService.addFeatureSearch({
            query,
            ...(options.scope ? {scope: options.scope} : {}),
            pinColor: this.nextDefaultSearchColor(),
            selectedMapLayers,
            selectedMapLayersManual: options.selectedMapLayersManual ?? false,
            selectedFeatureTypes: options.selectedFeatureTypes ?? [],
            selectedTileLevels: [...DEFAULT_FEATURE_SEARCH_TILE_LEVELS],
            selectedViewIndices
        });
        this.placeNewSearchSurface(entry.id);
        let session = this.getInternalSession(entry.id);
        if (!session) {
            this.reconcilePersistedFeatureSearchState(this.stateService.featureSearches);
            session = this.getInternalSession(entry.id);
        }
        return session!;
    }

    /** Imports feature-search JSON as a fresh runnable search session. */
    importSearchJsonPayload(payload: unknown): FeatureSearchSession {
        const imported = featureSearchDefinitionFromImportPayload(payload).definition;
        const selectedMapLayers = imported.selectedMapLayers.map(ref => ({...ref}));
        const entry = this.stateService.addFeatureSearch({
            query: imported.query,
            scope: imported.scope,
            autoUpdate: imported.autoUpdate,
            bookmarked: imported.bookmarked,
            enabled: true,
            paused: false,
            showResultsOnMap: imported.showResultsOnMap,
            pinColor: imported.pinColor,
            selectedMapLayers,
            selectedMapLayersManual: imported.selectedMapLayersManual ?? false,
            selectedFeatureTypes: [...imported.selectedFeatureTypes],
            selectedTileLevels: [...imported.selectedTileLevels],
            selectedViewIndices: [...imported.selectedViewIndices],
            searchStyleRules: this.cloneJsonCompatible(imported.searchStyleRules),
            renderStrategy: {...imported.renderStrategy}
        });
        this.placeNewSearchSurface(entry.id);
        let session = this.getInternalSession(entry.id);
        if (!session) {
            this.reconcilePersistedFeatureSearchState(this.stateService.featureSearches);
            session = this.getInternalSession(entry.id);
        }
        return session!;
    }

    /** Replaces one session's query/results while preserving its surface and color. */
    rerunSearch(sessionId: string, query: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session || !session.definition.enabled) {
            return;
        }
        this.pendingForcedGenerationIds.add(session.id);
        const patched = this.stateService.patchFeatureSearch(sessionId, {query, paused: false});
        if (patched) {
            return;
        }
        const nextDefinition: FeatureSearchStateEntry = {
            ...session.definition,
            query,
            paused: false
        };
        this.resetSessionSearch(session, nextDefinition);
        this.startSessionSearch(session, nextDefinition, {forceGenerationIds: [session.id]});
    }

    /** Requests one differential refresh over the currently visible map area. */
    updateSearchInArea(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session || !session.definition.enabled) {
            return;
        }
        session.paused = false;
        session.definition = {
            ...session.definition,
            paused: false
        };
        this.resetServerSearchProgress(session, session.refresh);
        this.progress.next(session);
        this.syncSearchRequestsToMapService({
            forceGenerationIds: [session.id],
            updateCoverageIds: [session.id]
        });
        this.stateService.patchFeatureSearch(sessionId, {paused: false});
    }

    /** Toggles whether viewport changes automatically update this search's tile coverage. */
    setSearchAutoUpdate(sessionId: string, autoUpdate: boolean): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {autoUpdate})) {
            session.definition = {
                ...session.definition,
                autoUpdate
            };
            this.syncSearchRequestsToMapService();
            this.progress.next(session);
        }
    }

    /** Applies a pause to runtime server dispatch for one session. */
    private applySearchPause(session: FeatureSearchSession): void {
        session.paused = true;
        session.backendComplete = true;
        session.complete = true;
        session.progressDone = session.progressTotal;
        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        this.progress.next(session);
        this.syncSearchRequestsToMapService();
    }

    /** Removes one search from backend dispatch while keeping its persisted panel state. */
    private applySearchDisabled(session: FeatureSearchSession, definition: FeatureSearchStateEntry): void {
        session.definition = definition;
        session.paused = false;
        session.backendComplete = true;
        session.complete = true;
        session.progressDone = session.progressTotal;
        session.endTime = Date.now();
        session.timeElapsed = session.startTime > 0
            ? this.formatTime(session.endTime - session.startTime)
            : this.formatTime(0);
        this.clearSessionResultData(session);
        this.progress.next(session);
        this.syncSearchRequestsToMapService();
    }

    /** Resumes runtime server dispatch for one session. */
    private applySearchResume(session: FeatureSearchSession): void {
        session.paused = false;
        session.progressDone = 0;
        session.progressTotal = 1;
        session.backendComplete = false;
        session.resultTileIngressDone = 0;
        session.resultTileIngressTotal = 0;
        session.complete = false;
        session.startTime = Date.now();
        session.endTime = 0;
        session.timeElapsed = this.formatTime(0);
        this.progress.next(session);
        this.syncSearchRequestsToMapService();
    }

    /** Pauses dispatch of further search tasks for one session. */
    pauseSearch(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session || !session.definition.enabled) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {paused: true})) {
            this.applySearchPause(session);
        }
    }

    /** Resumes one paused search and hands it back to mapget. */
    resumeSearch(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session || !session.definition.enabled) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {paused: false})) {
            this.applySearchResume(session);
        }
    }

    /** Stops one search without clearing its partial result state. */
    stopSearch(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session || !session.definition.enabled) {
            return;
        }
        session.complete = true;
        session.backendComplete = true;
        session.progressDone = session.progressTotal;
        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        session.paused = false;
        session.definition = {
            ...session.definition,
            autoUpdate: false,
            paused: true
        };
        if (!this.stateService.patchFeatureSearch(sessionId, {autoUpdate: false, paused: true})) {
            this.progress.next(session);
        }
        this.syncSearchRequestsToMapService();
    }

    /** Updates one search session's marker color. */
    setSearchColor(sessionId: string, color: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {pinColor: color})) {
            this.updateSessionColor(session, color);
        }
    }

    /** Toggles close protection for one persisted search panel. */
    setSearchBookmarked(sessionId: string, bookmarked: boolean): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {bookmarked})) {
            session.definition = {...session.definition, bookmarked};
            this.progress.next(session);
        }
    }

    /** Opens the feature-search export dialog for one runtime session. */
    openExportDialog(sessionId: string, options: FeatureSearchExportDialogOptions = {}): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        this.exportDialogRequest.next({
            searchId: session.id,
            includeConfiguration: options.includeConfiguration ?? true,
            includeResults: options.includeResults ?? true,
            closeAfterExport: options.closeAfterExport ?? false,
            grouping: options.grouping ?? [],
            filterValue: options.filterValue ?? ""
        });
        this.stateService.openDialog(FEATURE_SEARCH_EXPORT_DIALOG_LAYOUT_ID);
    }

    /** Clears the current feature-search export request after the dialog closes. */
    clearExportDialogRequest(): void {
        this.exportDialogRequest.next(null);
    }

    /** Enables or disables one persisted search without removing the panel. */
    setSearchEnabled(sessionId: string, enabled: boolean): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {enabled, paused: enabled ? session.definition.paused : false})) {
            const definition = {...session.definition, enabled, paused: enabled ? session.definition.paused : false};
            if (enabled) {
                this.resetSessionSearch(session, definition);
                this.startSessionSearch(session, definition, {forceGenerationIds: [session.id]});
            } else {
                this.applySearchDisabled(session, definition);
            }
        }
    }

    /** Replaces the selected source map/layers for one search. */
    setSearchMapLayers(sessionId: string, selectedMapLayers: FeatureSearchMapLayerRef[]): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        const selectedFeatureTypes = this.availableFeatureTypesForLayers(
            session.definition.selectedFeatureTypes,
            selectedMapLayers
        );
        if (!this.stateService.patchFeatureSearch(sessionId, {
            selectedMapLayers,
            selectedMapLayersManual: true,
            selectedFeatureTypes
        })) {
            session.definition = {...session.definition, selectedMapLayers, selectedMapLayersManual: true, selectedFeatureTypes};
            this.syncSearchRequestsToMapService({forceGenerationIds: [session.id]});
            this.progress.next(session);
        }
    }

    /** Replaces the source tile levels used by one search. */
    setSearchTileLevels(sessionId: string, selectedTileLevels: number[]): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {selectedTileLevels})) {
            session.definition = {...session.definition, selectedTileLevels};
            this.syncSearchRequestsToMapService({forceGenerationIds: [session.id]});
            this.progress.next(session);
        }
    }

    /** Replaces the feature-type filter for one search; an empty list means all feature types. */
    setSearchFeatureTypes(sessionId: string, selectedFeatureTypes: string[]): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        const normalizedTypes = this.availableFeatureTypesForLayers(selectedFeatureTypes, session.definition.selectedMapLayers);
        if (JSON.stringify(session.definition.selectedFeatureTypes) === JSON.stringify(normalizedTypes)) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {selectedFeatureTypes: normalizedTypes})) {
            session.definition = {...session.definition, selectedFeatureTypes: normalizedTypes};
            this.syncSearchRequestsToMapService({forceGenerationIds: [session.id]});
            this.progress.next(session);
        }
    }

    /** Keeps a feature-type filter within the union of currently selected source-layer schemas. */
    private availableFeatureTypesForLayers(
        selectedFeatureTypes: string[],
        selectedMapLayers: FeatureSearchMapLayerRef[]
    ): string[] {
        const normalizedTypes = normalizeFeatureSearchFeatureTypes(selectedFeatureTypes);
        if (!normalizedTypes.length) {
            return [];
        }
        const availableTypes = new Set<string>();
        for (const ref of selectedMapLayers) {
            const layer = this.mapInfo.maps.maps.get(ref.mapId)?.layers.get(ref.layerId);
            for (const featureType of layer?.info.featureTypes ?? []) {
                if (featureType.name) {
                    availableTypes.add(featureType.name);
                }
            }
        }
        return normalizedTypes.filter(type => availableTypes.has(type));
    }

    /** Replaces the map views that render one search's visualizations. */
    setSearchViewIndices(sessionId: string, selectedViewIndices: number[]): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {selectedViewIndices})) {
            session.definition = {...session.definition, selectedViewIndices};
            this.bumpSearchResultLayersVersion();
            this.syncSearchRequestsToMapService();
            this.progress.next(session);
        }
    }

    /** Switches one session between docked and floating representations. */
    setSessionDocked(sessionId: string, docked: boolean): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!docked) {
            this.ensureInitialFloatingDialogLayout(session.layoutId);
        }
        this.stateService.setSurfaceDocked(session.layoutId, docked, SEARCH_DOCK_TAB_ID);
        if (docked) {
            this.moveDockedSurfaceToTop(session.layoutId);
            this.stateService.dockActiveTab = SEARCH_DOCK_TAB_ID;
            this.stateService.isDockOpen = true;
        }
        this.notifySessionsChanged();
    }

    /** Creates a new search session from another session's configuration without copying runtime results. */
    cloneSearch(sessionId: string): FeatureSearchSession | undefined {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return undefined;
        }
        const definition = session.definition;
        const entry = this.stateService.addFeatureSearch({
            query: definition.query,
            scope: definition.scope,
            autoUpdate: definition.autoUpdate,
            bookmarked: definition.bookmarked,
            enabled: definition.enabled,
            paused: false,
            showResultsOnMap: definition.showResultsOnMap,
            pinColor: definition.pinColor,
            selectedMapLayers: definition.selectedMapLayers.map(ref => ({...ref})),
            selectedMapLayersManual: definition.selectedMapLayersManual ?? false,
            selectedFeatureTypes: [...definition.selectedFeatureTypes],
            selectedTileLevels: [...definition.selectedTileLevels],
            selectedViewIndices: [...definition.selectedViewIndices],
            searchStyleRules: this.cloneJsonCompatible(definition.searchStyleRules),
            renderStrategy: {...definition.renderStrategy}
        });
        const layoutId = FeatureSearchService.layoutIdForSearch(entry.id);
        if (this.isSessionDocked(session.id)) {
            this.stateService.setSurfaceDocked(layoutId, true, SEARCH_DOCK_TAB_ID);
            this.moveDockedSurfaceToTop(layoutId);
        } else {
            this.positionClonedFloatingSearch(session.layoutId, layoutId);
        }
        this.notifySessionsChanged();
        return this.getInternalSession(entry.id);
    }

    /** Clones simple persisted configuration objects without retaining shared draft references. */
    private cloneJsonCompatible<T>(value: T): T {
        return JSON.parse(JSON.stringify(value)) as T;
    }

    /** Places a floating clone near its source dialog while preserving viewport bounds. */
    private positionClonedFloatingSearch(sourceLayoutId: string, cloneLayoutId: string): void {
        const sourceLayout = this.stateService.getDialogLayout(sourceLayoutId);
        if (!sourceLayout) {
            this.ensureInitialFloatingDialogLayout(cloneLayoutId);
            return;
        }
        const baseFontSize = this.stateService.baseFontSize || 16;
        const offset = Math.round(baseFontSize * 1.25);
        const width = sourceLayout.size.width;
        const height = sourceLayout.size.height;
        const left = Math.min(Math.max(0, sourceLayout.position.left + offset), Math.max(0, window.innerWidth - width));
        const top = Math.min(Math.max(0, sourceLayout.position.top + offset), Math.max(0, window.innerHeight - height));
        this.stateService.upsertDialogLayout(cloneLayoutId, {
            position: {left, top},
            size: {...sourceLayout.size},
            open: false,
            docked: false,
            dockTab: SEARCH_DOCK_TAB_ID
        });
    }

    /** Places a newly docked search before older docked searches, matching inspection dock behavior. */
    private moveDockedSurfaceToTop(layoutId: string): void {
        const existingOrder = this.getDockedSessions()
            .map(session => session.layoutId)
            .filter(id => id !== layoutId);
        this.stateService.reorderDockedSurfaces(SEARCH_DOCK_TAB_ID, [layoutId, ...existingOrder]);
    }

    /** Docks a newly created search when the Search dock is already active. */
    private placeNewSearchSurface(searchId: string): void {
        const layoutId = FeatureSearchService.layoutIdForSearch(searchId);
        if (this.getDockedSessions().length > 0 || this.stateService.hasDockedSurface(SEARCH_DOCK_TAB_ID)) {
            this.stateService.setSurfaceDocked(layoutId, true, SEARCH_DOCK_TAB_ID);
            this.moveDockedSurfaceToTop(layoutId);
            this.notifySessionsChanged();
        }
    }

    /** Centers searches that were first created in the dock and only have the generic dock fallback position. */
    private ensureInitialFloatingDialogLayout(layoutId: string): void {
        const current = this.stateService.getDialogLayout(layoutId);
        if (current && (current.position.left !== 0 || current.position.top !== 0)) {
            return;
        }
        const baseFontSize = this.stateService.baseFontSize || 16;
        const width = Math.round(Math.min(
            FeatureSearchService.FLOATING_DIALOG_WIDTH_EM * baseFontSize,
            Math.max(baseFontSize, window.innerWidth - FeatureSearchService.FLOATING_DIALOG_HORIZONTAL_MARGIN_EM * baseFontSize)
        ));
        const height = Math.round(Math.min(
            FeatureSearchService.FLOATING_DIALOG_HEIGHT_EM * baseFontSize,
            Math.max(baseFontSize, window.innerHeight - FeatureSearchService.FLOATING_DIALOG_VERTICAL_MARGIN_EM * baseFontSize)
        ));
        this.stateService.upsertDialogLayout(layoutId, {
            ...(current ?? {
                position: {left: 0, top: 0},
                size: {width, height},
                open: false,
                docked: false,
                dockTab: SEARCH_DOCK_TAB_ID
            }),
            position: {
                left: Math.max(0, Math.round((window.innerWidth - width) / 2)),
                top: Math.max(0, Math.round((window.innerHeight - height) / 2))
            },
            size: {width, height}
        });
    }

    /** Closes one search session and removes its dock and marker state. */
    closeSearch(sessionId: string): void {
        if (this.stateService.featureSearches.some(entry => entry.id === sessionId)) {
            this.stateService.removeFeatureSearch(sessionId);
            return;
        }
        this.closeRuntimeSearch(sessionId);
    }

    /** Closes one runtime search session without mutating persisted search definitions. */
    private closeRuntimeSearch(sessionId: string): boolean {
        const index = this.searchSessions.findIndex(session => session.id === sessionId);
        if (index === -1) {
            return false;
        }
        const [session] = this.searchSessions.splice(index, 1);
        this.stateService.removeDialogLayout(session.layoutId);
        this.bumpSearchResultLayersVersion();
        this.notifySessionsChanged();
        this.progress.next(null);
        this.syncSearchRequestsToMapService();
        if (this.stateService.isDockAutoCollapsible
            && !this.stateService.selection.some(panel => !panel.undocked)
            && this.getDockedSessions().length === 0) {
            this.stateService.isDockOpen = false;
        }
        return true;
    }

    /** Creates a runtime session with independent result, diagnostics, and marker state. */
    private createSession(definition: FeatureSearchStateEntry): FeatureSearchSession {
        const paused = definition.paused;
        const session: FeatureSearchSession = {
            id: definition.id,
            layoutId: FeatureSearchService.layoutIdForSearch(definition.id),
            definition,
            runId: this.generateRunId(),
            refresh: 0,
            paused,
            progressDone: paused ? 1 : 0,
            progressTotal: 1,
            backendComplete: paused,
            resultTileIngressDone: 0,
            resultTileIngressTotal: 0,
            complete: paused,
            startTime: 0,
            endTime: 0,
            pointColor: this.normalizeHexColor(definition.pinColor),
            timeElapsed: this.formatTime(0),
            totalFeatureCount: 0,
            searchResults: [],
            diagnostics: [],
            diagnosticsBlobs: [],
            valueSummaries: this.emptyValueSummariesState("idle", 0),
            valueSummaryRevision: 0,
            schemaAnalysis: this.initialSchemaAnalysis(definition),
            errors: new Set<string>(),
            progressByRequestKey: new Map<string, SearchRequestProgress>(),
            searchResultTilesBySourceKey: new Map<string, SearchResultTileContribution>(),
            searchResultPointsByFeatureKey: new Map<string, SearchResultPoint>(),
            searchResultPointsCache: [],
            searchResultPointBucketsCache: [],
            searchResultPointBucketIndexBySourceKey: new Map<string, number>(),
            searchResultPointsCacheDirty: false,
            searchResultPointsVersion: 0,
            searchResultDensityIndex: new SearchResultDensityIndex()
        };
        return session;
    }

    /**
     * Reconciles each logical search into one ordinary StyledMapgetLayer per
     * selected source layer. Those subscriptions feed both list ingestion and
     * every selected view; no search-result transport or second map subscription
     * exists.
     */
    private syncSearchRequestsToMapService(options: {
        forceGenerationIds?: Iterable<string>;
        updateCoverageIds?: Iterable<string>;
        notifyPresentationChange?: boolean;
    } = {}): void {
        const forceGenerationIds = new Set(options.forceGenerationIds ?? []);
        const updateCoverageIds = new Set(options.updateCoverageIds ?? []);
        for (const id of this.pendingForcedGenerationIds) {
            forceGenerationIds.add(id);
        }
        for (const id of this.pendingCoverageRefreshIds) {
            updateCoverageIds.add(id);
        }
        const resolvedDefinitions: FeatureSearchResolvedDefinition[] = [];
        for (const session of this.searchSessions.filter(session => session.definition.enabled)) {
            const resolved = this.resolvedDefinitionForSession(session);
            if (resolved) {
                resolvedDefinitions.push(resolved);
            }
        }
        for (const id of Array.from(this.pendingForcedGenerationIds)) {
            if (resolvedDefinitions.some(definition => definition.id === id)) {
                this.pendingForcedGenerationIds.delete(id);
            }
        }
        for (const id of updateCoverageIds) {
            this.pendingCoverageRefreshIds.delete(id);
        }
        this.reconcileSearchPresentations(
            resolvedDefinitions,
            forceGenerationIds,
            updateCoverageIds,
            options.notifyPresentationChange !== false
        );
    }

    /** Search presentations currently visible in one logical view. */
    searchStyledLayersForView(viewIndex: number): StyledMapgetLayer[] {
        const result: StyledMapgetLayer[] = [];
        for (const presentation of this.searchPresentations.values()) {
            const session = this.getInternalSession(presentation.sessionId);
            if (!session ||
                !session.definition.enabled ||
                !session.definition.showResultsOnMap ||
                !session.definition.selectedViewIndices.includes(viewIndex)) {
                continue;
            }
            result.push(presentation.styledLayer);
        }
        return result;
    }

    /** Whether one search subset should contribute its full style geometry in a view. */
    shouldRenderSearchStyledLayer(
        viewIndex: number,
        layer: StyledMapgetLayer,
        tileId: number
    ): boolean {
        const level = Number(coreLib.getTileLevel(tileId));
        const cacheKey = `${viewIndex}|${layer.ownerId}|${level}`;
        const cached = this.searchRenderDecisionCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }
        const presentation = this.searchPresentationByLayer.get(layer);
        const session = presentation
            ? this.getInternalSession(presentation.sessionId)
            : undefined;
        if (!session ||
            !session.definition.enabled ||
            !session.definition.showResultsOnMap ||
            !session.definition.selectedViewIndices.includes(viewIndex) ||
            !session.definition.renderStrategy.showHighFiGeometry ||
            session.definition.searchStyleRules.length === 0) {
            this.searchRenderDecisionCache.set(cacheKey, false);
            return false;
        }
        const strategy = session.definition.renderStrategy;
        const result = !strategy.showLowFiDots ||
            this.viewState.prefersHighFidelityForSearchResultTile(
                viewIndex,
                session.id,
                tileId,
                strategy.highFidelityMaxVisibleTiles
            );
        this.searchRenderDecisionCache.set(cacheKey, result);
        return result;
    }

    private scheduleSearchPresentationReconcile(): void {
        if (this.searchPresentationReconcileQueued) {
            return;
        }
        this.searchPresentationReconcileQueued = true;
        queueMicrotask(() => {
            this.searchPresentationReconcileQueued = false;
            // ViewLayerController is subscribed to the same viewport event and
            // will reconcile after this microtask. Avoid scheduling a second
            // full pass for the coverage work completed here.
            this.syncSearchRequestsToMapService({
                notifyPresentationChange: false
            });
        });
    }

    private reconcileSearchPresentations(
        definitions: readonly FeatureSearchResolvedDefinition[],
        forceGenerationIds: ReadonlySet<string>,
        updateCoverageIds: ReadonlySet<string>,
        notifyPresentationChange: boolean
    ): void {
        this.searchRenderDecisionCache.clear();
        const desiredKeys = new Set<string>();
        for (const definition of definitions) {
            for (const ref of definition.selectedMapLayers) {
                const mapgetLayer = this.mapInfo.mapgetLayer(ref.mapId, ref.layerId);
                if (!mapgetLayer) {
                    continue;
                }
                const featureTypes = this.searchFeatureTypesForMapgetLayer(
                    definition,
                    mapgetLayer
                );
                if (featureTypes === null) {
                    continue;
                }
                const key = this.searchPresentationKey(definition.id, mapgetLayer);
                desiredKeys.add(key);
                const definitionSignature = JSON.stringify({
                    query: definition.backendQuery,
                    scope: definition.concreteScope,
                    featureTypes,
                    resultFields: definition.resultFields,
                    rules: definition.searchStyleRules
                });
                let presentation = this.searchPresentations.get(key);
                if (!presentation ||
                    presentation.mapgetLayer !== mapgetLayer ||
                    presentation.definitionSignature !== definitionSignature) {
                    let replacement: SearchStyledPresentation;
                    try {
                        replacement = this.createSearchPresentation(
                            key,
                            definition,
                            mapgetLayer,
                            featureTypes,
                            definitionSignature
                        );
                    } catch (error) {
                        const session = this.getInternalSession(definition.id);
                        session?.errors.add(
                            error instanceof Error ? error.message : String(error)
                        );
                        // Keep a complete previous presentation alive when an
                        // editor intermediate cannot be compiled. A later
                        // definition or viewport event will retry replacement.
                        continue;
                    }
                    if (presentation) {
                        this.destroySearchPresentation(presentation);
                    }
                    presentation = replacement;
                    this.searchPresentations.set(key, presentation);
                } else if (forceGenerationIds.has(definition.id)) {
                    presentation.styledLayer.refresh();
                }

                presentation.styledLayer.setSuspended(definition.paused);
                const shouldUpdateCoverage =
                    !presentation.coverage ||
                    definition.autoUpdate ||
                    updateCoverageIds.has(definition.id);
                if (shouldUpdateCoverage) {
                    const coverage = this.searchCoverage(
                        definition,
                        presentation.mapgetLayer
                    );
                    if (!presentation.coverage ||
                        !filterSubscriptionCoverageMembershipEqual(
                            coverage,
                            presentation.coverage
                        )) {
                        presentation.coverage = {
                            tileIds: [...coverage.tileIds],
                            ...(coverage.priorityTileIds
                                ? {priorityTileIds:
                                    [...coverage.priorityTileIds]}
                                : {})
                        };
                        presentation.coverageOrder = new Map(
                            coverage.tileIds.map((tileId, index) => [tileId, index])
                        );
                        presentation.styledLayer.setCoverage(
                            coverage.tileIds,
                            coverage.priorityTileIds
                        );
                        this.applySearchCoverageSnapshot(definition.id);
                    }
                }
            }
        }

        for (const [key, presentation] of [...this.searchPresentations]) {
            if (desiredKeys.has(key)) {
                continue;
            }
            this.searchPresentations.delete(key);
            this.destroySearchPresentation(presentation);
        }
        if (notifyPresentationChange) {
            this.searchPresentationsChanged.next();
        }
    }

    private createSearchPresentation(
        key: string,
        definition: FeatureSearchResolvedDefinition,
        mapgetLayer: MapgetLayer,
        featureTypes: string[],
        definitionSignature: string
    ): SearchStyledPresentation {
        const compiled = compileFeatureSearchStyle(
            definition,
            mapgetLayer,
            this.mapInfo,
            featureTypes
        );
        let styledLayer: StyledMapgetLayer;
        try {
            styledLayer = new StyledMapgetLayer(
                {
                    viewIndex: -1,
                    mapId: mapgetLayer.mapId,
                    layerId: mapgetLayer.layerId,
                    presentationKind: "search",
                    // A replacement is deliberately constructed before its
                    // predecessor is retired. Give each concrete owner a
                    // unique transport identity so both may coexist during
                    // that transactional handoff.
                    presentationInstanceId:
                        `${definition.id}:${++this.searchPresentationRevision}`
                },
                mapgetLayer,
                compiled.style,
                {},
                this.mapInfo,
                this.tileStream,
                coreLib.HighlightMode.NO_HIGHLIGHT,
                coreLib.RuleFidelity.ANY,
                compiled.filterPlan
            );
        } catch (error) {
            compiled.style.featureLayerStyle.delete?.();
            throw error;
        }
        const presentation: SearchStyledPresentation = {
            key,
            sessionId: definition.id,
            mapgetLayer,
            compiled,
            styledLayer,
            subscription: new Subscription(),
            definitionSignature,
            coverage: null,
            coverageOrder: new Map()
        };
        this.searchPresentationByLayer.set(styledLayer, presentation);
        presentation.subscription = styledLayer.events.subscribe(event =>
            this.handleSearchStyledLayerEvent(presentation, event)
        );
        return presentation;
    }

    private destroySearchPresentation(presentation: SearchStyledPresentation): void {
        this.searchPresentationByLayer.delete(presentation.styledLayer);
        this.searchRenderDecisionCache.clear();
        this.subsetIngestionLoop.cancel(
            task => task.presentationKey === presentation.key
        );
        presentation.subscription.unsubscribe();
        presentation.styledLayer.dispose();
        presentation.compiled.style.featureLayerStyle.delete?.();
        const session = this.getInternalSession(presentation.sessionId);
        for (const sourceTileKey of [
            ...(session?.searchResultTilesBySourceKey.keys() ?? [])
        ]) {
            const contribution =
                session?.searchResultTilesBySourceKey.get(sourceTileKey);
            if (contribution?.sourceMapId === presentation.mapgetLayer.mapId &&
                contribution.sourceLayerId === presentation.mapgetLayer.layerId) {
                this.removeServerSearchResultTile({
                    searchId: presentation.sessionId,
                    sourceTileKey
                });
            }
        }
    }

    private searchPresentationKey(searchId: string, layer: MapgetLayer): string {
        return `${searchId}\n${layer.mapId}\n${layer.layerId}`;
    }

    private searchFeatureTypesForMapgetLayer(
        definition: FeatureSearchResolvedDefinition,
        layer: MapgetLayer
    ): string[] | null {
        const layerTypes = (layer.info.featureTypes ?? [])
            .map(featureType => featureType.name)
            .filter((name): name is string => !!name);
        if (!definition.selectedFeatureTypes.length) {
            return layerTypes;
        }
        const selected = new Set(definition.selectedFeatureTypes);
        const result = layerTypes.filter(type => selected.has(type));
        return result.length ? result : null;
    }

    /** Stable union of selected-view coverage; request order remains significant. */
    private searchCoverage(
        definition: FeatureSearchResolvedDefinition,
        layer: MapgetLayer
    ): {tileIds: number[]; priorityTileIds: number[]} {
        const tileIds: number[] = [];
        const seen = new Set<number>();
        for (const viewIndex of definition.selectedViewIndices) {
            const levels = definition.selectedTileLevels.length
                ? definition.selectedTileLevels
                : [this.viewState.autoSearchTileLevel(
                    viewIndex,
                    layer.mapId,
                    layer.layerId
                )].filter((level): level is number => level !== null);
            for (const level of levels) {
                for (const tileId of this.viewState.visibleSearchTileIdsForLevel(
                    viewIndex,
                    level
                )) {
                    if (seen.has(tileId)) {
                        continue;
                    }
                    seen.add(tileId);
                    tileIds.push(tileId);
                }
            }
        }
        return {tileIds, priorityTileIds: []};
    }

    private applySearchCoverageSnapshot(searchId: string): void {
        const session = this.getInternalSession(searchId);
        if (!session) {
            return;
        }
        let total = 0;
        let completed = 0;
        for (const presentation of this.searchPresentations.values()) {
            if (presentation.sessionId !== searchId) {
                continue;
            }
            total += presentation.styledLayer.tileStates.size;
            completed += [...presentation.styledLayer.tileStates.values()]
                .filter(state => state.status === "ready").length;
        }
        session.progressTotal = Math.max(1, total);
        session.progressDone = total === 0 ? 1 : completed;
        session.backendComplete = session.paused || completed >= total;
        this.updateSearchResultIngressProgress(session);
        this.updateSessionCompletion(session);
        this.progress.next(session);
    }

    /** Clears only result-side state; the persisted search definition and UI surface stay intact. */
    private clearSessionResultData(session: FeatureSearchSession): void {
        this.pendingResultDataRebuildSessionIds.delete(session.id);
        session.searchResultTilesBySourceKey.clear();
        if (this.clearSessionSearchResultPoints(session)) {
            this.bumpSearchResultLayersVersion();
        }
        session.searchResults = [];
        session.diagnostics = [];
        session.diagnosticsBlobs = [];
        this.markValueSummariesDirty(session);
        session.errors.clear();
        session.totalFeatureCount = 0;
        session.resultTileIngressDone = 0;
        session.resultTileIngressTotal = 0;
    }

    /** Starts a fresh server progress run for a new query or mapget refresh. */
    private resetServerSearchProgress(session: FeatureSearchSession, refresh: number): void {
        session.runId = this.generateRunId();
        session.refresh = refresh;
        session.paused = session.definition.paused;
        session.progressDone = session.paused ? 1 : 0;
        session.progressTotal = 1;
        session.progressByRequestKey.clear();
        session.backendComplete = session.paused;
        session.resultTileIngressDone = 0;
        session.resultTileIngressTotal = 0;
        session.complete = session.paused;
        session.startTime = Date.now();
        session.endTime = 0;
        session.timeElapsed = this.formatTime(0);
        session.diagnostics = [];
    }

    /** Prepares an existing session to receive result chunks for a newer mapget refresh. */
    private resetSessionForServerRefresh(session: FeatureSearchSession, refresh: number): void {
        this.clearSessionResultData(session);
        this.resetServerSearchProgress(session, refresh);
    }

    /** Clears one session and installs a fresh search group for the supplied query. */
    private resetSessionSearch(session: FeatureSearchSession, definition: FeatureSearchStateEntry): void {
        session.definition = definition;
        session.schemaAnalysis = this.initialSchemaAnalysis(definition);
        session.lastResolvedDefinition = undefined;
        session.lastResolvedDefinitionSignature = undefined;
        this.clearSessionResultData(session);
        session.refresh = 0;
        session.paused = definition.paused;
        session.progressDone = definition.paused ? 1 : 0;
        session.progressTotal = 1;
        session.progressByRequestKey.clear();
        session.backendComplete = definition.paused;
        session.resultTileIngressDone = 0;
        session.resultTileIngressTotal = 0;
        session.complete = definition.paused;
        session.startTime = 0;
        session.endTime = 0;
        session.timeElapsed = this.formatTime(0);
    }

    /** Starts or refreshes one server-side search session. */
    private startSessionSearch(
        session: FeatureSearchSession,
        definition: FeatureSearchStateEntry,
        options: {forceGenerationIds?: Iterable<string>} = {}
    ): void {
        session.definition = definition;
        this.resetServerSearchProgress(session, session.refresh);
        this.progress.next(session);
        this.syncSearchRequestsToMapService(options);
    }

    /** Builds conservative initial analysis without native schema work. */
    private initialSchemaAnalysis(definition: FeatureSearchStateEntry): FeatureSearchSessionSchemaAnalysis {
        const signature = this.searchScopeAnalysisSignature(definition);
        return {
            signature,
            status: "pending",
            concreteScope: definition.scope === "attribute" ? "attribute" : "feature",
            normalizedQuery: definition.query,
            attributeScopes: [],
            attributeScopeCandidateCount: 0,
            rewriteSuppressed: false,
            rewriteSuppressionReason: "",
            matchedFieldNames: [],
            matchedEnumValues: [],
            matchedFeatureTypes: []
        };
    }

    /** Drops schema-analysis caches for live sessions after datasource metadata changed. */
    private invalidateAllSchemaAnalysis(): void {
        this.pendingSchemaAnalysisSignatures.clear();
        for (const session of this.searchSessions) {
            session.schemaAnalysis = this.initialSchemaAnalysis(session.definition);
        }
    }

    /** Returns the resolved definition consumed by MapTileStreamService, keeping the previous one during same-signature re-analysis. */
    private resolvedDefinitionForSession(session: FeatureSearchSession): FeatureSearchResolvedDefinition | null {
        const signature = this.searchScopeAnalysisSignature(session.definition);
        if (!this.ensureSessionSchemaAnalysis(session, signature)) {
            if (session.lastResolvedDefinitionSignature !== signature || !session.lastResolvedDefinition) {
                return null;
            }
            const concreteScope = session.lastResolvedDefinition.concreteScope;
            return {
                ...session.definition,
                concreteScope,
                backendQuery: session.lastResolvedDefinition.backendQuery,
                resultFields: featureSearchResultFields(session.definition, concreteScope)
            };
        }
        const concreteScope = session.schemaAnalysis.concreteScope;
        const resolved = {
            ...session.definition,
            concreteScope,
            backendQuery: session.schemaAnalysis.normalizedQuery || session.definition.query,
            resultFields: featureSearchResultFields(session.definition, concreteScope)
        };
        session.lastResolvedDefinition = resolved;
        session.lastResolvedDefinitionSignature = signature;
        return resolved;
    }

    /** Ensures a session has async schema analysis for the current definition. */
    private ensureSessionSchemaAnalysis(session: FeatureSearchSession, signature: string): boolean {
        if (session.schemaAnalysis.signature === signature && session.schemaAnalysis.status === "ready") {
            return true;
        }
        if (session.schemaAnalysis.signature === signature && session.schemaAnalysis.status === "pending") {
            this.requestSessionSchemaAnalysis(session, signature);
            return false;
        }

        session.schemaAnalysis = this.initialSchemaAnalysis(session.definition);
        this.requestSessionSchemaAnalysis(session, signature);
        this.progress.next(session);
        return false;
    }

    /** Starts one worker-backed scope-analysis request unless the same request is already in flight. */
    private requestSessionSchemaAnalysis(session: FeatureSearchSession, signature: string): void {
        const requestKey = `${session.id}\u0000${signature}`;
        if (this.pendingSchemaAnalysisSignatures.has(requestKey)) {
            return;
        }
        this.pendingSchemaAnalysisSignatures.add(requestKey);
        this.searchSchema.requestSearchScopeAnalysis(
            session.definition.query,
            session.definition.scope,
            session.definition.selectedMapLayers
        ).then(analysis => {
            this.pendingSchemaAnalysisSignatures.delete(requestKey);
            this.applySearchScopeAnalysis(session.id, analysis);
        });
    }

    /** Applies a completed async schema-analysis result if the session still represents the same definition. */
    private applySearchScopeAnalysis(sessionId: string, analysis: FeatureSearchScopeAnalysis): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        const currentSignature = this.searchScopeAnalysisSignature(session.definition);
        if (analysis.signature !== currentSignature) {
            return;
        }
        this.applyReadySearchScopeAnalysis(session, analysis);
    }

    /** Installs a completed selected-layer scope analysis and lets backend search requests proceed. */
    private applyReadySearchScopeAnalysis(session: FeatureSearchSession, analysis: FeatureSearchScopeAnalysis): void {
        if (this.applyInferredSearchMapLayers(session, analysis.inferredMapLayers)) {
            return;
        }
        session.schemaAnalysis = {
            signature: analysis.signature,
            status: "ready",
            concreteScope: analysis.concreteScope,
            normalizedQuery: analysis.normalizedQuery || session.definition.query,
            attributeScopes: analysis.attributeScopes,
            attributeScopeCandidateCount: analysis.attributeScopeCandidateCount,
            rewriteSuppressed: analysis.rewriteSuppressed,
            rewriteSuppressionReason: analysis.rewriteSuppressionReason,
            matchedFieldNames: analysis.matchedFieldNames,
            matchedEnumValues: analysis.matchedEnumValues,
            matchedFeatureTypes: analysis.matchedFeatureTypes,
            ...(analysis.error ? {error: analysis.error} : {})
        };
        this.progress.next(session);
        this.syncSearchRequestsToMapService({forceGenerationIds: [session.id]});
    }

    /** Returns the schema-analysis identity used to guard resolved-definition reuse. */
    private searchScopeAnalysisSignature(definition: FeatureSearchStateEntry): string {
        return this.searchSchema.searchScopeAnalysisSignature(
            definition.query,
            definition.scope,
            definition.selectedMapLayers
        );
    }

    /** Narrows source layers to the query-compatible subset inferred from all known schemas. */
    private applyInferredSearchMapLayers(
        session: FeatureSearchSession,
        inferredMapLayers: FeatureSearchMapLayerRef[]
    ): boolean {
        if (session.definition.selectedMapLayersManual) {
            return false;
        }
        const selectedMapLayers = this.mapLayersForSearchContext(inferredMapLayers, session.definition.selectedMapLayers);
        return selectedMapLayers.length
            ? this.applySearchMapLayerSelection(session, selectedMapLayers)
            : false;
    }

    /** Applies detected schema-context layers to a search using the same source-layer selection rule as auto-scope. */
    applySearchMapLayersForDetectedContext(
        sessionId: string,
        detectedMapLayers: FeatureSearchMapLayerRef[]
    ): boolean {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return false;
        }
        if (session.definition.selectedMapLayersManual) {
            return false;
        }

        const selectedMapLayers = this.mapLayersForSearchContext(detectedMapLayers, session.definition.selectedMapLayers);
        return selectedMapLayers.length
            ? this.applySearchMapLayerSelection(session, selectedMapLayers)
            : false;
    }

    /** Resolves detected query-context layers against current search selection and active map layers. */
    private mapLayersForSearchContext(
        detectedMapLayers: FeatureSearchMapLayerRef[],
        selectedMapLayers: FeatureSearchMapLayerRef[] = []
    ): FeatureSearchMapLayerRef[] {
        const detectedSelection = uniqueFeatureSearchMapLayers(detectedMapLayers);
        if (!detectedSelection.length) {
            return [];
        }

        const selectedOverlap = this.overlappingMapLayers(selectedMapLayers, detectedSelection);
        if (selectedOverlap.length) {
            return selectedOverlap;
        }

        const activeOverlap = this.overlappingMapLayers(this.activeFeatureSearchLayers(), detectedSelection);
        return activeOverlap.length ? activeOverlap : detectedSelection;
    }

    /** Applies a schema-inferred source-layer selection unless it is already the persisted selection. */
    private applySearchMapLayerSelection(
        session: FeatureSearchSession,
        selectedMapLayers: FeatureSearchMapLayerRef[]
    ): boolean {
        const normalizedLayers = uniqueFeatureSearchMapLayers(selectedMapLayers);
        if (this.sameSelectedMapLayers(session.definition.selectedMapLayers, normalizedLayers)) {
            return false;
        }
        if (this.stateService.patchFeatureSearch(session.id, {selectedMapLayers: normalizedLayers, selectedMapLayersManual: false})) {
            return true;
        }

        const nextDefinition = {...session.definition, selectedMapLayers: normalizedLayers, selectedMapLayersManual: false};
        this.resetSessionSearch(session, nextDefinition);
        this.progress.next(session);
        this.syncSearchRequestsToMapService({forceGenerationIds: [session.id]});
        return true;
    }

    /** Returns current layer refs that are also present in the inferred query scope. */
    private overlappingMapLayers(
        currentLayers: FeatureSearchMapLayerRef[],
        inferredLayers: FeatureSearchMapLayerRef[]
    ): FeatureSearchMapLayerRef[] {
        const inferredKeys = new Set(inferredLayers.map(ref => JSON.stringify([ref.mapId, ref.layerId])));
        return uniqueFeatureSearchMapLayers(currentLayers)
            .filter(ref => inferredKeys.has(JSON.stringify([ref.mapId, ref.layerId])));
    }

    /** Returns whether two source-layer selections are equivalent after normalization. */
    private sameSelectedMapLayers(lhs: FeatureSearchMapLayerRef[], rhs: FeatureSearchMapLayerRef[]): boolean {
        return JSON.stringify(uniqueFeatureSearchMapLayers(lhs)) === JSON.stringify(uniqueFeatureSearchMapLayers(rhs));
    }

    /** Generates a unique runtime id for one server-search run. */
    private generateRunId(): string {
        return `search_${Date.now()}_${++this.searchRunCounter}`;
    }

    /**
     * Aggregates all raw diagnostics blobs for the completed search that is still current in the UI.
     */
    private updateDiagnosticsForCompletedSearch(session: FeatureSearchSession): void {
        const messages = coreLib.simfilGetDiagnostics(
            session.definition.query,
            Array.from(session.diagnosticsBlobs)
        );
        const executionMessages = Array.isArray(messages) ? messages : [];
        session.diagnostics = executionMessages.slice(0, this.diagnosticsMessageLimit);
        this.progress.next(session);
    }

    /** Creates a blank summary state with stable empty arrays for Angular templates. */
    private emptyValueSummariesState(
        status: SearchValueSummariesState["status"],
        revision: number,
        totalTiles = 0
    ): SearchValueSummariesState {
        return {
            status,
            revision,
            processedTiles: 0,
            totalTiles,
            resultFields: [],
            traces: []
        };
    }

    /** Invalidates cached value diagnostics after streamed tile contributions change. */
    private markValueSummariesDirty(session: FeatureSearchSession): void {
        session.valueSummaryRevision += 1;
        session.valueSummaries = this.emptyValueSummariesState("idle", session.valueSummaryRevision);
    }

    /** Computes native per-tile value summaries and merges them across the current session. */
    private async computeValueSummariesAsync(sessionId: string, revision: number): Promise<void> {
        const session = this.getInternalSession(sessionId);
        if (!session || session.valueSummaryRevision !== revision) {
            return;
        }

        const contributions = Array.from(session.searchResultTilesBySourceKey.values())
            .filter(contribution => contribution.layerBlob.length > 0)
            .sort((lhs, rhs) => this.compareSearchResultTileContributions(lhs, rhs));
        const resultFieldsByKey = new Map<string, SearchResultFieldValueSummary>();
        const tracesByName = new Map<string, SearchTraceValueSummary>();
        const errors: string[] = [];
        let processedTiles = 0;

        for (const contribution of contributions) {
            const currentSession = this.getInternalSession(sessionId);
            if (!currentSession || currentSession.valueSummaryRevision !== revision) {
                return;
            }

            try {
                const tileSummary = this.valueSummariesForContribution(contribution);
                if (tileSummary) {
                    this.mergeTileValueSummaries(resultFieldsByKey, tracesByName, tileSummary);
                }
            } catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
            }

            processedTiles += 1;
            if (processedTiles % FeatureSearchService.VALUE_SUMMARY_TILE_BATCH_SIZE === 0) {
                currentSession.valueSummaries = {
                    ...currentSession.valueSummaries,
                    status: "loading",
                    processedTiles,
                    totalTiles: contributions.length
                };
                this.progress.next(currentSession);
                await this.nextAnimationFrame();
            }
        }

        const finalSession = this.getInternalSession(sessionId);
        if (!finalSession || finalSession.valueSummaryRevision !== revision) {
            return;
        }

        const resultFields = Array.from(resultFieldsByKey.values())
            .sort((lhs, rhs) => lhs.index - rhs.index || lhs.expression.localeCompare(rhs.expression))
            .map(item => ({...item, summary: this.finalizeValueSummary(item.summary)}));
        const traces = Array.from(tracesByName.values())
            .sort((lhs, rhs) => lhs.name.localeCompare(rhs.name))
            .map(item => ({...item, summary: this.finalizeValueSummary(item.summary)}));
        const hasValues = resultFields.length > 0 || traces.length > 0;
        finalSession.valueSummaries = {
            status: hasValues ? "ready" : (errors.length > 0 ? "error" : "empty"),
            revision,
            processedTiles,
            totalTiles: contributions.length,
            resultFields,
            traces,
            ...(errors.length > 0 ? {error: errors.slice(0, 3).join("\n")} : {})
        };
        this.progress.next(finalSession);
    }

    /** Defers the next chunk of summary work until the browser has had a chance to paint. */
    private nextAnimationFrame(): Promise<void> {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    /** Returns the cached native summary for one contribution, reparsing the ModelPool blob on first use. */
    private valueSummariesForContribution(contribution: SearchResultTileContribution): SearchTileValueSummaries | null {
        if (contribution.valueSummary) {
            return contribution.valueSummary;
        }

        const subsetLayer = uint8ArrayToWasm(wasmBlob => {
            return this.mapInfo.tileLayerParser.readTileSubsetLayer(wasmBlob);
        }, contribution.layerBlob);
        if (!subsetLayer) {
            return null;
        }

        try {
            const rawSummaries = subsetLayer.valueSummaries(
                0,
                FeatureSearchService.VALUE_SUMMARY_HISTOGRAM_LIMIT,
                FeatureSearchService.VALUE_SUMMARY_DISTINCT_LIMIT
            );
            contribution.valueSummary = this.normalizeTileValueSummaries(rawSummaries);
            return contribution.valueSummary;
        } finally {
            subsetLayer.delete();
        }
    }

    /** Normalizes one native `TileSubsetLayer.valueSummaries()` return value. */
    private normalizeTileValueSummaries(value: unknown): SearchTileValueSummaries {
        const record = this.recordFromUnknown(value);
        const rawResultFields = Array.isArray(record?.["resultFields"]) ? record["resultFields"] : [];
        const rawTraces = Array.isArray(record?.["traces"]) ? record["traces"] : [];
        return {
            resultFields: rawResultFields
                .map(item => this.normalizeResultFieldValueSummary(item))
                .filter((item): item is SearchResultFieldValueSummary => item !== null),
            traces: rawTraces
                .map(item => this.normalizeTraceValueSummary(item))
                .filter((item): item is SearchTraceValueSummary => item !== null)
        };
    }

    /** Normalizes a native withFields summary object. */
    private normalizeResultFieldValueSummary(value: unknown): SearchResultFieldValueSummary | null {
        const record = this.recordFromUnknown(value);
        if (!record) {
            return null;
        }
        const index = this.nonNegativeNumber(record["index"], 0);
        return {
            source: "resultField",
            index,
            expression: String(record["expression"] ?? `values[${index}]`),
            summary: this.normalizeValueSummary(record["summary"])
        };
    }

    /** Normalizes a native trace summary object. */
    private normalizeTraceValueSummary(value: unknown): SearchTraceValueSummary | null {
        const record = this.recordFromUnknown(value);
        if (!record) {
            return null;
        }
        return {
            source: "trace",
            name: String(record["name"] ?? ""),
            calls: this.nonNegativeNumber(record["calls"], 0),
            totalus: this.nonNegativeNumber(record["totalus"], 0),
            summary: this.normalizeValueSummary(record["summary"])
        };
    }

    /** Normalizes one native value-summary object. */
    private normalizeValueSummary(value: unknown): SearchValueSummary {
        const record = this.recordFromUnknown(value);
        const kindsRecord = this.recordFromUnknown(record?.["kinds"]);
        const histogramValue = Array.isArray(record?.["histogram"]) ? record["histogram"] : [];
        const summary: SearchValueSummary = {
            count: this.nonNegativeNumber(record?.["count"], 0),
            missing: this.nonNegativeNumber(record?.["missing"], 0),
            nulls: this.nonNegativeNumber(record?.["nulls"], 0),
            kinds: this.normalizeKindCounts(kindsRecord),
            histogram: histogramValue
                .map(item => this.normalizeHistogramBucket(item))
                .filter((item): item is SearchValueHistogramBucket => item !== null),
            otherCount: this.nonNegativeNumber(record?.["otherCount"], 0),
            distinctLimitReached: Boolean(record?.["distinctLimitReached"])
        };
        const numeric = this.normalizeNumericSummary(record?.["numeric"]);
        if (numeric) {
            summary.numeric = numeric;
        }
        return summary;
    }

    /** Normalizes per-kind counters from native diagnostics. */
    private normalizeKindCounts(record: Record<string, unknown> | null): SearchValueKindCounts {
        return {
            integer: this.nonNegativeNumber(record?.["integer"], 0),
            number: this.nonNegativeNumber(record?.["number"], 0),
            boolean: this.nonNegativeNumber(record?.["boolean"], 0),
            string: this.nonNegativeNumber(record?.["string"], 0),
            object: this.nonNegativeNumber(record?.["object"], 0),
            list: this.nonNegativeNumber(record?.["list"], 0),
            blob: this.nonNegativeNumber(record?.["blob"], 0),
            unknown: this.nonNegativeNumber(record?.["unknown"], 0)
        };
    }

    /** Normalizes one numeric summary object. */
    private normalizeNumericSummary(value: unknown): SearchValueNumericSummary | undefined {
        const record = this.recordFromUnknown(value);
        const count = this.nonNegativeNumber(record?.["count"], 0);
        if (!record || count === 0) {
            return undefined;
        }
        const sum = Number(record["sum"] ?? 0);
        return {
            count,
            min: Number(record["min"] ?? 0),
            max: Number(record["max"] ?? 0),
            sum: Number.isFinite(sum) ? sum : 0,
            average: Number(record["average"] ?? 0)
        };
    }

    /** Normalizes one string histogram bucket. */
    private normalizeHistogramBucket(value: unknown): SearchValueHistogramBucket | null {
        const record = this.recordFromUnknown(value);
        if (!record) {
            return null;
        }
        return {
            value: String(record["value"] ?? ""),
            count: this.nonNegativeNumber(record["count"], 0)
        };
    }

    /** Merges one tile's native summaries into session-wide accumulators. */
    private mergeTileValueSummaries(
        resultFieldsByKey: Map<string, SearchResultFieldValueSummary>,
        tracesByName: Map<string, SearchTraceValueSummary>,
        tileSummary: SearchTileValueSummaries
    ): void {
        for (const resultField of tileSummary.resultFields) {
            const key = `${resultField.index}\n${resultField.expression}`;
            let target = resultFieldsByKey.get(key);
            if (!target) {
                target = {
                    source: "resultField",
                    index: resultField.index,
                    expression: resultField.expression,
                    summary: this.emptyValueSummary()
                };
                resultFieldsByKey.set(key, target);
            }
            this.mergeValueSummary(target.summary, resultField.summary);
        }

        for (const trace of tileSummary.traces) {
            let target = tracesByName.get(trace.name);
            if (!target) {
                target = {
                    source: "trace",
                    name: trace.name,
                    calls: 0,
                    totalus: 0,
                    summary: this.emptyValueSummary()
                };
                tracesByName.set(trace.name, target);
            }
            target.calls += trace.calls;
            target.totalus += trace.totalus;
            this.mergeValueSummary(target.summary, trace.summary);
        }
    }

    /** Creates a zeroed mutable summary accumulator. */
    private emptyValueSummary(): SearchValueSummary {
        return {
            count: 0,
            missing: 0,
            nulls: 0,
            kinds: this.normalizeKindCounts(null),
            histogram: [],
            otherCount: 0,
            distinctLimitReached: false
        };
    }

    /** Adds one value summary into another. */
    private mergeValueSummary(target: SearchValueSummary, source: SearchValueSummary): void {
        target.count += source.count;
        target.missing += source.missing;
        target.nulls += source.nulls;
        target.kinds.integer += source.kinds.integer;
        target.kinds.number += source.kinds.number;
        target.kinds.boolean += source.kinds.boolean;
        target.kinds.string += source.kinds.string;
        target.kinds.object += source.kinds.object;
        target.kinds.list += source.kinds.list;
        target.kinds.blob += source.kinds.blob;
        target.kinds.unknown += source.kinds.unknown;
        target.otherCount += source.otherCount;
        target.distinctLimitReached = target.distinctLimitReached || source.distinctLimitReached;

        if (source.numeric) {
            if (!target.numeric) {
                target.numeric = {...source.numeric};
            } else {
                target.numeric.count += source.numeric.count;
                target.numeric.min = Math.min(target.numeric.min, source.numeric.min);
                target.numeric.max = Math.max(target.numeric.max, source.numeric.max);
                target.numeric.sum += source.numeric.sum;
                target.numeric.average = target.numeric.count > 0
                    ? target.numeric.sum / target.numeric.count
                    : 0;
            }
        }

        const histogramByValue = new Map(target.histogram.map(bucket => [bucket.value, bucket.count]));
        for (const bucket of source.histogram) {
            histogramByValue.set(bucket.value, (histogramByValue.get(bucket.value) ?? 0) + bucket.count);
        }
        target.histogram = Array.from(histogramByValue.entries())
            .map(([value, count]) => ({value, count}));
    }

    /** Sorts and trims a merged summary for display. */
    private finalizeValueSummary(summary: SearchValueSummary): SearchValueSummary {
        const histogram = [...summary.histogram]
            .sort((lhs, rhs) => rhs.count - lhs.count || lhs.value.localeCompare(rhs.value));
        const visibleHistogram = histogram.slice(0, FeatureSearchService.VALUE_SUMMARY_HISTOGRAM_LIMIT);
        const hiddenHistogramCount = histogram
            .slice(FeatureSearchService.VALUE_SUMMARY_HISTOGRAM_LIMIT)
            .reduce((sum, bucket) => sum + bucket.count, 0);
        return {
            ...summary,
            numeric: summary.numeric
                ? {
                    ...summary.numeric,
                    average: summary.numeric.count > 0 ? summary.numeric.sum / summary.numeric.count : 0
                }
                : undefined,
            histogram: visibleHistogram,
            otherCount: summary.otherCount + hiddenHistogramCount
        };
    }

    /** Returns an object record or null for untrusted native values. */
    private recordFromUnknown(value: unknown): Record<string, unknown> | null {
        return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
    }

    /** Returns the completion stream pair owned by one input surface. */
    public completionStateForOwner(ownerId: string): CompletionOwnerState {
        const normalizedOwnerId = ownerId || FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID;
        let state = this.completionStates.get(normalizedOwnerId);
        if (!state) {
            state = {
                candidates: new BehaviorSubject<CompletionCandidate[]>([]),
                pending: new BehaviorSubject<boolean>(false),
                candidateList: [],
                requestSerial: 0
            };
            this.completionStates.set(normalizedOwnerId, state);
        }
        return state;
    }

    /**
     * Clears the currently shown completion list for one input surface.
     */
    public clearCurrentCompletion(ownerId: string = FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID) {
        const normalizedOwnerId = ownerId || FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID;
        this.cancelPendingCompletion(normalizedOwnerId);
        const state = this.completionStateForOwner(normalizedOwnerId);
        state.requestSerial++;
        state.candidateList = [];
        state.pending.next(false);
        state.candidates.next([]);
    }

    /**
     * Completes a query for the legacy omnibox owner.
     */
    public completeQuery(query: string, point: number | undefined) {
        // The omnibox is global by design: it should see every schema, not only the active map-layer subset.
        this.completeQueryForOwner(FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID, query, point);
    }

    /** Returns whether completion already contains the exact current query as a valid candidate. */
    public hasExactCompletionCandidate(
        query: string,
        ownerId: string = FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID
    ): boolean {
        const trimmedQuery = query.trim();
        const state = this.completionStateForOwner(ownerId);
        return state.candidateList.some(candidate => candidate.query.trim() === trimmedQuery);
    }

    /**
     * Completes a query from schema metadata. Datasources without feature-model schema provide no candidates.
     */
    public completeQueryForOwner(
        ownerId: string,
        query: string,
        point: number | undefined,
        options: FeatureSearchCompletionOptions = {}
    ) {
        const normalizedOwnerId = ownerId || FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID;
        this.cancelPendingCompletion(normalizedOwnerId);
        const state = this.completionStateForOwner(normalizedOwnerId);
        const requestSerial = ++state.requestSerial;
        const caret = point ?? query.length;
        state.candidateList = [];
        state.candidates.next([]);
        state.pending.next(true);
        const timer = setTimeout(() => {
            this.completionTimers.delete(normalizedOwnerId);
            const currentState = this.completionStateForOwner(normalizedOwnerId);
            if (currentState.requestSerial !== requestSerial) {
                return;
            }
            if (this.requestWorkerCompletion(normalizedOwnerId, requestSerial, query, caret, options)) {
                return;
            }
            currentState.pending.next(false);
            currentState.candidates.next([]);
        }, 0);
        this.completionTimers.set(normalizedOwnerId, timer);
    }

    /** Sends one completion request to the schema worker, returning false when completion is unavailable. */
    private requestWorkerCompletion(
        ownerId: string,
        requestSerial: number,
        query: string,
        point: number,
        options: FeatureSearchCompletionOptions
    ): boolean {
        const message: SearchCompletionRequestMessage = {
            type: "SearchCompletionRequest",
            ownerId,
            requestSerial,
            query,
            point,
            options: this.completionWorkerOptions(options)
        };
        return this.searchSchema.requestCompletion(
            message,
            result => this.handleCompletionWorkerMessage(result)
        );
    }

    /** Applies a worker completion result if it still matches the owner's latest request serial. */
    private handleCompletionWorkerMessage(message: SearchCompletionResultMessage): void {
        const state = this.completionStateForOwner(message.ownerId);
        if (state.requestSerial !== message.requestSerial) {
            return;
        }
        if (message.error) {
            console.warn("Schema completion worker failed to complete a query.", message.error);
        }
        if (message.candidates.length > 0) {
            state.candidateList = this.mergeCompletionCandidates(state.candidateList, message.candidates);
            state.candidates.next(state.candidateList);
        }
        if (message.done) {
            state.pending.next(false);
            if (message.candidates.length === 0) {
                state.candidates.next(state.candidateList);
            }
        }
    }

    /** Adds streamed candidate batches while preserving stable order and removing cross-layer duplicates. */
    private mergeCompletionCandidates(
        currentCandidates: CompletionCandidate[],
        nextCandidates: CompletionCandidate[]
    ): CompletionCandidate[] {
        const merged = [...currentCandidates];
        const indexByKey = new Map(currentCandidates.map((candidate, index) => [
            this.completionCandidateKey(candidate),
            index
        ]));
        for (const candidate of nextCandidates) {
            const key = this.completionCandidateKey(candidate);
            const existingIndex = indexByKey.get(key);
            if (existingIndex !== undefined) {
                merged[existingIndex] = this.mergeCompletionCandidateOrigins(merged[existingIndex]!, candidate);
                continue;
            }
            if (merged.length >= this.completionCandidateLimit) {
                continue;
            }
            indexByKey.set(key, merged.length);
            merged.push(candidate);
        }
        return merged;
    }

    /** Preserves all schema origins when identical completion text is produced by multiple layers. */
    private mergeCompletionCandidateOrigins(
        currentCandidate: CompletionCandidate,
        nextCandidate: CompletionCandidate
    ): CompletionCandidate {
        const originLayers = this.mergeCompletionOriginLayers(
            currentCandidate.originLayers ?? [],
            nextCandidate.originLayers ?? []
        );
        return originLayers.length
            ? {...currentCandidate, originLayers}
            : currentCandidate;
    }

    /** Returns unique completion-origin layers in first-seen order. */
    private mergeCompletionOriginLayers(
        currentLayers: FeatureSearchMapLayerRef[],
        nextLayers: FeatureSearchMapLayerRef[]
    ): FeatureSearchMapLayerRef[] {
        const result: FeatureSearchMapLayerRef[] = [];
        const seen = new Set<string>();
        for (const layer of [...currentLayers, ...nextLayers]) {
            const key = JSON.stringify([layer.mapId, layer.layerId]);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            result.push(layer);
        }
        return result;
    }

    /** Builds a de-duplication key for completion candidates streamed from multiple schema contexts. */
    private completionCandidateKey(candidate: CompletionCandidate): string {
        return `${candidate.query}\u0000${candidate.begin}\u0000${candidate.end}\u0000${candidate.kind}\u0000${candidate.hint}`;
    }

    /** Converts UI completion options into the worker/native option shape. */
    private completionWorkerOptions(options: FeatureSearchCompletionOptions): SearchCompletionWorkerOptions {
        return {
            limit: this.completionCandidateLimit,
            timeoutMs: options.timeoutMs ?? 35,
            ...(options.scope ? {scope: options.scope} : {}),
            ...(options.selectedMapLayers !== undefined ? {selectedMapLayers: options.selectedMapLayers} : {})
        };
    }

    /** Cancels a deferred completion computation that has not started yet. */
    private cancelPendingCompletion(ownerId: string): void {
        const timer = this.completionTimers.get(ownerId);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        this.completionTimers.delete(ownerId);
    }

    /** Routes one directly owned search subset into list ingestion and progress. */
    private handleSearchStyledLayerEvent(
        presentation: SearchStyledPresentation,
        event: StyledMapgetLayerEvent
    ): void {
        const session = this.getInternalSession(presentation.sessionId);
        if (!session) {
            return;
        }
        if (event.type === "generation") {
            for (const key of [...session.progressByRequestKey.keys()]) {
                if (key.startsWith(`${presentation.styledLayer.filterRef.filterId}\n`)) {
                    session.progressByRequestKey.delete(key);
                }
            }
            session.backendComplete = false;
            session.complete = false;
            this.applySearchCoverageSnapshot(session.id);
            return;
        }
        if (event.type === "status") {
            this.applyFilterSearchStatus(presentation, event.status);
            return;
        }
        if (event.type === "error") {
            session.errors.add(event.message);
            this.progress.next(session);
            return;
        }
        if (event.type === "tile-removed") {
            this.subsetIngestionLoop.cancel(task =>
                task.presentationKey === presentation.key &&
                task.sourceTileKey === event.state.mapTileKey
            );
            this.removeServerSearchResultTile({
                searchId: session.id,
                sourceTileKey: event.state.mapTileKey
            });
            this.applySearchCoverageSnapshot(session.id);
            return;
        }
        if (event.type !== "tile-ready") {
            return;
        }

        const state = event.state;
        const subsetBlob = state.subsetBlob;
        if (!subsetBlob) {
            return;
        }
        const subset = uint8ArrayToWasm(
            data => this.mapInfo.tileLayerParser.readTileSubsetLayer(data),
            subsetBlob
        );
        if (!subset) {
            session.errors.add(
                `Failed to decode search subset '${state.mapTileKey}'.`
            );
            this.progress.next(session);
            return;
        }
        let schema: {
            scope: "feature" | "attribute" | "relation" | "group";
            featureFields: string[];
            entryFields: string[];
            entryCount: number;
        };
        let diagnostics: Uint8Array | null;
        try {
            schema = subset.channelSchema(
                presentation.compiled.resultChannelOrdinal
            ) as typeof schema;
            diagnostics = uint8ArrayFromWasm(
                buffer => subset.copyDiagnostics(buffer)
            );
        } finally {
            subset.delete();
        }
        const projectedFields = schema.scope === "feature"
            ? schema.featureFields
            : schema.entryFields;
        const projectedFieldIndices = presentation.compiled.resultFields
            .map(field => projectedFields.indexOf(field));
        const resultCount = Math.max(0, Math.floor(Number(schema.entryCount ?? 0)));
        const requestOrder =
            presentation.coverageOrder.get(state.tileId)
            ?? Number.MAX_SAFE_INTEGER;
        const payloadBase: SearchResultTilePayload = {
            searchId: session.id,
            refresh: session.refresh,
            mapId: state.mapId,
            layerId: state.layerId,
            tileId: state.tileId,
            sourceTileKey: state.mapTileKey,
            sourceMapId: state.mapId,
            sourceLayerId: state.layerId,
            sourceTileId: state.tileId,
            requestOrder,
            resultCount,
            resultFields: presentation.compiled.resultFields,
            layerBlob: subsetBlob,
            diagnostics,
            entries: [],
            // Absence means "replace the complete contribution". Only the
            // bounded row payloads below carry entryOffset and append to this
            // freshly installed header. Sending offset zero here would append
            // an empty batch to a previous generation's contribution.
            entriesComplete: resultCount === 0
        };
        this.subsetIngestionLoop.cancel(task =>
            task.presentationKey === presentation.key &&
            task.sourceTileKey === state.mapTileKey
        );
        this.addServerSearchResultTile(payloadBase);
        if (resultCount > 0) {
            this.subsetIngestionLoop.enqueue({
                presentationKey: presentation.key,
                searchId: session.id,
                sourceTileKey: state.mapTileKey,
                state,
                valueVersion: state.valueVersion,
                generation: state.deliveredGeneration,
                offset: 0,
                resultCount,
                resultFields: presentation.compiled.resultFields,
                projectedFieldIndices,
                includeExactPositions:
                    session.definition.renderStrategy.showHighFiResultDots
            });
        }
        this.applySearchCoverageSnapshot(session.id);
    }

    /** Drains one bounded subset row range; stale tile generations self-cancel. */
    private ingestSearchSubsetTask(
        task: SearchSubsetIngestionTask,
        _deadline: number
    ): boolean {
        const presentation = this.searchPresentations.get(task.presentationKey);
        const session = this.getInternalSession(task.searchId);
        const subsetBlob = task.state.subsetBlob;
        if (!presentation || !session || !subsetBlob ||
            task.state.status !== "ready" ||
            task.state.valueVersion !== task.valueVersion ||
            task.state.deliveredGeneration !== task.generation) {
            return true;
        }
        const limit = Math.min(2000, task.resultCount - task.offset);
        const subset = uint8ArrayToWasm(
            data => this.mapInfo.tileLayerParser.readTileSubsetLayer(data),
            subsetBlob
        );
        if (!subset) {
            session.errors.add(
                `Failed to decode search subset '${task.sourceTileKey}'.`
            );
            this.progress.next(session);
            return true;
        }
        let entries: SearchResultTileEntry[];
        try {
            const rawEntries = subset.entryRange(
                presentation.compiled.resultChannelOrdinal,
                task.offset,
                limit,
                task.includeExactPositions
            ) as SearchResultTileEntry[];
            entries = (Array.isArray(rawEntries) ? rawEntries : []).map(entry => {
                const projectedValues = Array.isArray(entry.values) ? entry.values : [];
                return {
                    ...entry,
                    mapTileKey: entry.mapTileKey || task.sourceTileKey,
                    values: task.projectedFieldIndices.map(index =>
                        index >= 0 && index < projectedValues.length
                            ? projectedValues[index]
                            : null
                    )
                };
            });
        } finally {
            subset.delete();
        }
        const batchOffset = task.offset;
        task.offset += limit;
        this.addServerSearchResultTile({
            searchId: session.id,
            refresh: session.refresh,
            mapId: task.state.mapId,
            layerId: task.state.layerId,
            tileId: task.state.tileId,
            sourceTileKey: task.sourceTileKey,
            sourceMapId: task.state.mapId,
            sourceLayerId: task.state.layerId,
            sourceTileId: task.state.tileId,
            requestOrder:
                presentation.coverageOrder.get(task.state.tileId)
                ?? Number.MAX_SAFE_INTEGER,
            resultCount: task.resultCount,
            resultFields: task.resultFields,
            layerBlob: subsetBlob,
            diagnostics: null,
            entries,
            entryOffset: batchOffset,
            entriesComplete: task.offset >= task.resultCount
        });
        return task.offset >= task.resultCount;
    }

    /** Aggregates protocol-3 filter progress across a search's source layers. */
    private applyFilterSearchStatus(
        presentation: SearchStyledPresentation,
        status: MapTileStreamFilterStatusPayload
    ): void {
        const session = this.getInternalSession(presentation.sessionId);
        if (!session ||
            status.generation !== presentation.styledLayer.generation) {
            return;
        }
        if (status.error) {
            session.errors.add(status.error);
        }
        const terminal =
            status.state === "Success" ||
            status.state === "Failed" ||
            status.state === "Aborted";
        const queued = this.nonNegativeNumber(
            status.outputTilesRequested,
            presentation.styledLayer.tileStates.size
        );
        const emitted = this.nonNegativeNumber(
            status.outputTilesEmitted,
            0
        );
        const key = [
            status.filterId,
            status.generation
        ].join("\n");
        session.progressByRequestKey.set(key, {
            tilesQueued: queued,
            tilesSearched: terminal ? queued : Math.min(queued, emitted),
            chunksEmitted: emitted,
            chunksReported: true,
            matches: this.nonNegativeNumber(status.entriesEmitted, 0),
            terminal
        });
        const progressEntries = [...session.progressByRequestKey.values()];
        const total = progressEntries.reduce(
            (sum, item) => sum + item.tilesQueued,
            0
        );
        const done = progressEntries.reduce(
            (sum, item) => sum + item.tilesSearched,
            0
        );
        session.progressTotal = Math.max(1, total);
        session.progressDone = Math.min(session.progressTotal, done);
        session.backendComplete =
            session.paused ||
            (progressEntries.length > 0 &&
                progressEntries.every(item => item.terminal));
        session.totalFeatureCount = progressEntries.reduce(
            (sum, item) => sum + item.matches,
            0
        );
        this.updateSearchResultIngressProgress(session);
        const becameComplete = this.updateSessionCompletion(session);
        if (becameComplete) {
            session.endTime = Date.now();
            session.timeElapsed = this.formatTime(
                session.endTime - session.startTime
            );
            this.updateDiagnosticsForCompletedSearch(session);
        }
        this.progress.next(session);
    }

    /** Integrates one streamed mapget search-result tile into the matching session. */
    private addServerSearchResultTile(payload: SearchResultTilePayload): void {
        const session = this.getInternalSession(payload.searchId);
        if (!session) {
            return;
        }
        const refresh = Number(payload.refresh ?? 0);
        if (refresh < session.refresh) {
            return;
        }
        if (refresh > session.refresh) {
            this.resetSessionForServerRefresh(session, refresh);
        }

        const sourceTileKey = payload.sourceTileKey || coreLib.getTileFeatureLayerKey(
            payload.sourceMapId,
            payload.sourceLayerId,
            payload.sourceTileId
        );
        const results: FeatureSearchResultEntry[] = [];
        const points: SearchResultPoint[] = [];
        const resultFields = payload.resultFields ?? [];
        const sourceMapLayerIds = this.parseMapLayerIds(sourceTileKey);
        const fallbackTileCenter = payload.entries.some(entry => !entry.position)
            ? coreLib.getTilePosition(payload.sourceTileId)
            : null;
        for (const entry of payload.entries) {
            const {mapId, layerId} = entry.mapTileKey === sourceTileKey
                ? sourceMapLayerIds
                : this.parseMapLayerIds(entry.mapTileKey);
            const resultIndex = this.entryResultIndex(entry, results.length);
            const resultKey = this.searchResultEntryKey(sourceTileKey, entry.mapTileKey, resultIndex);
            const hoverFeatureId = this.searchResultHoverFeatureId(entry.featureId, entry);
            const point = this.makeSearchResultPoint(
                sourceTileKey,
                payload.sourceMapId,
                payload.sourceLayerId,
                payload.sourceTileId,
                mapId,
                layerId,
                entry.mapTileKey,
                entry.featureId,
                resultIndex,
                resultKey,
                hoverFeatureId,
                entry,
                fallbackTileCenter
            );
            if (point) {
                points.push(point);
            }
            results.push({
                label: this.searchResultEntryLabel(entry, resultFields, resultIndex),
                mapId,
                layerId,
                featureId: entry.featureId,
                resultIndex,
                resultKey,
                mapTileKey: entry.mapTileKey,
                sourceTileKey,
                sourceMapId: payload.sourceMapId,
                sourceLayerId: payload.sourceLayerId,
                sourceTileId: payload.sourceTileId,
                hoverFeatureId,
                ...(this.hasFiniteIndex(entry.attributeIndex) ? {attributeIndex: Math.floor(entry.attributeIndex)} : {}),
                ...(this.hasFiniteIndex(entry.validityIndex) ? {validityIndex: Math.floor(entry.validityIndex)} : {}),
                ...(this.hasFiniteIndex(entry.validityCount) ? {validityCount: Math.floor(entry.validityCount)} : {})
            });
        }

        const contribution: SearchResultTileContribution = {
            refresh,
            sourceTileKey,
            sourceMapId: payload.sourceMapId,
            sourceLayerId: payload.sourceLayerId,
            sourceTileId: payload.sourceTileId,
            requestOrder: this.nonNegativeNumber(payload.requestOrder, Number.MAX_SAFE_INTEGER),
            resultCount: payload.resultCount,
            resultFields,
            results,
            diagnostics: payload.diagnostics,
            layerBlob: payload.layerBlob,
            valueSummary: null,
            points
        };
        const previousContribution = session.searchResultTilesBySourceKey.get(sourceTileKey);
        if (previousContribution && payload.entryOffset !== undefined) {
            this.appendSessionResultEntryBatch(session, previousContribution, contribution, Boolean(payload.entriesComplete));
            this.applyProgressSnapshot(session, payload.tilesConsidered, payload.tilesCompleted);
            const becameComplete = this.updateSessionCompletion(session);
            session.endTime = Date.now();
            session.timeElapsed = this.formatTime(session.endTime - session.startTime);
            if (becameComplete) {
                this.updateDiagnosticsForCompletedSearch(session);
            }
            this.scheduleProgressEmission(session);
            return;
        }
        session.searchResultTilesBySourceKey.set(sourceTileKey, contribution);
        this.markValueSummariesDirty(session);
        let emitProgressNow = true;
        if (previousContribution) {
            session.searchResultDensityIndex.removeContribution(sourceTileKey);
            session.searchResultDensityIndex.addContribution(sourceTileKey, contribution.points);
            this.scheduleSessionResultDataRebuild(session);
            emitProgressNow = false;
        } else {
            this.appendSessionResultContribution(session, contribution);
        }
        this.applyProgressSnapshot(session, payload.tilesConsidered, payload.tilesCompleted);
        const becameComplete = this.updateSessionCompletion(session);

        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        if (becameComplete) {
            this.updateDiagnosticsForCompletedSearch(session);
        }
        if (emitProgressNow) {
            this.progress.next(session);
        }
    }

    /** Removes UI-visible result data for one source tile that left the desired search area. */
    private removeServerSearchResultTile(payload: {searchId: string; sourceTileKey: string}): void {
        const session = this.getInternalSession(payload.searchId);
        if (!session || !session.searchResultTilesBySourceKey.delete(payload.sourceTileKey)) {
            return;
        }
        session.searchResultDensityIndex.removeContribution(payload.sourceTileKey);
        this.markValueSummariesDirty(session);
        this.updateSearchResultIngressProgress(session);
        this.updateSessionCompletion(session);
        this.scheduleSessionResultDataRebuild(session);
    }

    private nonNegativeNumber(value: unknown, fallback: number): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
    }

    /** Sorts streamed result-tile data by the same first-seen tile order used for backend search requests. */
    private compareSearchResultTileContributions(
        lhs: SearchResultTileContribution,
        rhs: SearchResultTileContribution
    ): number {
        if (lhs.requestOrder !== rhs.requestOrder) {
            return lhs.requestOrder - rhs.requestOrder;
        }
        return lhs.sourceTileKey.localeCompare(rhs.sourceTileKey);
    }

    /** Returns whether an optional backend index is usable in UI labels and hover feature ids. */
    private hasFiniteIndex(value: unknown): value is number {
        return Number.isFinite(Number(value));
    }

    /** Normalizes the backend result index, falling back to the streamed array position for older payloads. */
    private entryResultIndex(entry: SearchResultTileEntry, fallback: number): number {
        return this.hasFiniteIndex(entry.resultIndex)
            ? Math.max(0, Math.floor(entry.resultIndex))
            : fallback;
    }

    /** Applies full-coverage progress snapshots from MapTileStreamService without losing streamed result state. */
    private applyProgressSnapshot(
        session: FeatureSearchSession,
        tilesConsidered: unknown,
        tilesCompleted: unknown
    ): void {
        const total = this.nonNegativeNumber(tilesConsidered, 0);
        if (total > 0) {
            session.progressTotal = Math.max(1, total);
        }
        const completed = this.nonNegativeNumber(tilesCompleted, 0);
        if (completed > 0 || total > 0) {
            session.progressDone = Math.min(session.progressTotal, Math.max(session.progressDone, completed));
        }
        this.updateSearchResultIngressProgress(session);
    }

    /** Returns true once all expected search-result tile layers have entered the UI service. */
    private canSummarizeSessionValues(session: FeatureSearchSession): boolean {
        return session.complete
            && session.resultTileIngressDone >= session.resultTileIngressTotal;
    }

    /** Updates result-tile ingress counters from current coverage and accepted contributions. */
    private updateSearchResultIngressProgress(session: FeatureSearchSession): void {
        const progressEntries = Array.from(session.progressByRequestKey.values());
        const reportedChunkTotal = progressEntries
            .filter(item => item.chunksReported)
            .reduce((sum, item) => sum + item.chunksEmitted, 0);
        session.resultTileIngressTotal = Math.max(reportedChunkTotal, session.searchResultTilesBySourceKey.size);
        session.resultTileIngressDone = Math.min(
            session.resultTileIngressTotal,
            session.searchResultTilesBySourceKey.size
        );
    }

    /** Recomputes the externally visible completion state after backend status or result ingress changes. */
    private updateSessionCompletion(session: FeatureSearchSession): boolean {
        const wasComplete = session.complete;
        if (session.paused) {
            session.complete = true;
            return !wasComplete;
        }
        // Full-area coverage is the canonical completion signal. Individual
        // request status entries can be invalidated by auto-update races and
        // should not keep a session open once every considered tile is done.
        if (session.progressTotal > 0 && session.progressDone >= session.progressTotal) {
            session.backendComplete = true;
        }
        const ingressComplete = session.resultTileIngressTotal === 0
            || session.resultTileIngressDone >= session.resultTileIngressTotal;
        session.complete = session.backendComplete && ingressComplete;
        return session.complete && !wasComplete;
    }

    /** Rebuilds derived result arrays from per-tile contributions after add, replace, or eviction. */
    private rebuildSessionResultData(session: FeatureSearchSession): void {
        const nextResults: FeatureSearchResultEntry[] = [];
        const nextDiagnosticsBlobs: Uint8Array[] = [];
        const nextPoints = new Map<string, SearchResultPoint>();
        const nextBuckets: SearchResultPointBucket[] = [];
        let totalFeatureCount = 0;

        const contributions = Array.from(session.searchResultTilesBySourceKey.values())
            .sort((lhs, rhs) => this.compareSearchResultTileContributions(lhs, rhs));
        for (const contribution of contributions) {
            totalFeatureCount += contribution.resultCount;
            this.appendArray(nextResults, contribution.results);
            if (contribution.diagnostics) {
                nextDiagnosticsBlobs.push(contribution.diagnostics);
            }
            for (const point of contribution.points) {
                if (!nextPoints.has(point.resultKey)) {
                    nextPoints.set(point.resultKey, point);
                }
            }
            const bucket = this.searchResultPointBucketFromContribution(contribution);
            if (bucket) {
                nextBuckets.push(bucket);
            }
        }

        session.searchResults = nextResults;
        session.diagnosticsBlobs = nextDiagnosticsBlobs;
        session.totalFeatureCount = totalFeatureCount;
        session.searchResultPointsByFeatureKey = nextPoints;
        session.searchResultPointBucketsCache = nextBuckets;
        session.searchResultPointBucketIndexBySourceKey = this.searchResultPointBucketIndex(nextBuckets);
        session.searchResultPointsCacheDirty = true;
        session.searchResultPointsVersion += 1;
        this.bumpSearchResultLayersVersion();
    }

    /** Schedules one result-data rebuild after a burst of source-tile replacement or eviction events. */
    private scheduleSessionResultDataRebuild(session: FeatureSearchSession): void {
        this.pendingResultDataRebuildSessionIds.add(session.id);
        if (this.resultDataRebuildRaf !== null) {
            return;
        }
        this.resultDataRebuildRaf = requestAnimationFrame(() => {
            this.resultDataRebuildRaf = null;
            this.flushPendingSessionResultDataRebuilds();
        });
    }

    /** Flushes coalesced result-data rebuilds and emits one UI update per affected search session. */
    private flushPendingSessionResultDataRebuilds(): void {
        const sessionIds = Array.from(this.pendingResultDataRebuildSessionIds);
        this.pendingResultDataRebuildSessionIds.clear();
        for (const sessionId of sessionIds) {
            const session = this.getInternalSession(sessionId);
            if (!session) {
                continue;
            }
            this.rebuildSessionResultData(session);
            this.progress.next(session);
        }
    }

    /** Appends a new source tile contribution without touching previously aggregated result arrays. */
    private appendSessionResultEntryBatch(
        session: FeatureSearchSession,
        contribution: SearchResultTileContribution,
        batch: SearchResultTileContribution,
        entriesComplete: boolean
    ): void {
        contribution.refresh = batch.refresh;
        contribution.resultFields = batch.resultFields;
        contribution.layerBlob = batch.layerBlob;
        contribution.valueSummary = null;
        this.appendArray(contribution.results, batch.results);
        this.appendArray(contribution.points, batch.points);
        this.appendArray(session.searchResults, batch.results);

        let pointsChanged = false;
        for (const point of batch.points) {
            if (!session.searchResultPointsByFeatureKey.has(point.resultKey)) {
                session.searchResultPointsByFeatureKey.set(point.resultKey, point);
                pointsChanged = true;
            }
        }

        if (entriesComplete && contribution.points.length > 0) {
            session.searchResultDensityIndex.addContribution(contribution.sourceTileKey, contribution.points);
            this.upsertSearchResultPointBucket(session, contribution);
            pointsChanged = true;
        }
        if (pointsChanged || batch.results.length > 0) {
            session.searchResultPointsCacheDirty = session.searchResultPointsCacheDirty || pointsChanged;
            session.searchResultPointsVersion += pointsChanged ? 1 : 0;
            if (pointsChanged) {
                this.bumpSearchResultLayersVersion();
            }
        }
    }

    /** Appends or replaces the source-tile bucket exposed to search-result overlay code. */
    private upsertSearchResultPointBucket(
        session: FeatureSearchSession,
        contribution: SearchResultTileContribution
    ): void {
        const bucket = this.searchResultPointBucketFromContribution(contribution);
        if (!bucket) {
            return;
        }
        const existingIndex = session.searchResultPointBucketIndexBySourceKey.get(contribution.sourceTileKey);
        if (existingIndex !== undefined) {
            session.searchResultPointBucketsCache[existingIndex] = bucket;
            return;
        }
        session.searchResultPointBucketIndexBySourceKey.set(
            contribution.sourceTileKey,
            session.searchResultPointBucketsCache.length);
        session.searchResultPointBucketsCache.push(bucket);
    }

    /** Builds the source-key index used to avoid O(n²) bucket replacement during broad streamed searches. */
    private searchResultPointBucketIndex(buckets: SearchResultPointBucket[]): Map<string, number> {
        const index = new Map<string, number>();
        buckets.forEach((bucket, position) => index.set(bucket.sourceTileKey, position));
        return index;
    }

    /** Appends a new source tile contribution without touching previously aggregated result arrays. */
    private appendSessionResultContribution(
        session: FeatureSearchSession,
        contribution: SearchResultTileContribution
    ): void {
        this.appendArray(session.searchResults, contribution.results);
        if (contribution.diagnostics) {
            session.diagnosticsBlobs.push(contribution.diagnostics);
        }
        session.totalFeatureCount += contribution.resultCount;
        const densityChanged = contribution.points.length > 0;
        if (densityChanged) {
            session.searchResultDensityIndex.addContribution(contribution.sourceTileKey, contribution.points);
            const bucket = this.searchResultPointBucketFromContribution(contribution);
            if (bucket) {
                session.searchResultPointBucketIndexBySourceKey.set(
                    contribution.sourceTileKey,
                    session.searchResultPointBucketsCache.length);
                session.searchResultPointBucketsCache.push(bucket);
            }
        }

        let pointsChanged = false;
        for (const point of contribution.points) {
            if (!session.searchResultPointsByFeatureKey.has(point.resultKey)) {
                session.searchResultPointsByFeatureKey.set(point.resultKey, point);
                pointsChanged = true;
            }
        }
        if (pointsChanged || densityChanged) {
            session.searchResultPointsCacheDirty = session.searchResultPointsCacheDirty || pointsChanged;
            session.searchResultPointsVersion += 1;
            this.bumpSearchResultLayersVersion();
        }
    }

    /** Appends large result batches without using spread syntax, which can exceed V8's argument limit. */
    private appendArray<T>(target: T[], items: readonly T[]): void {
        for (const item of items) {
            target.push(item);
        }
    }

    /** Converts one streamed source-tile contribution into the overlay bucket cache entry. */
    private searchResultPointBucketFromContribution(
        contribution: SearchResultTileContribution
    ): SearchResultPointBucket | null {
        if (!contribution.points.length) {
            return null;
        }
        return {
            sourceTileKey: contribution.sourceTileKey,
            mapId: contribution.sourceMapId,
            layerId: contribution.sourceLayerId,
            tileId: contribution.sourceTileId,
            requestOrder: contribution.requestOrder,
            points: contribution.points
        };
    }

    /** Returns one internal live session by runtime id. */
    private getInternalSession(id: string): FeatureSearchSession | undefined {
        return this.searchSessions.find(session => session.id === id);
    }

    /** Emits a shallow session snapshot so structural UI can re-render. */
    private notifySessionsChanged(): void {
        this.sessionsChanged.next([...this.searchSessions]);
    }

    /** Coalesces high-frequency streamed-result mutations into at most one Angular emission per frame. */
    private scheduleProgressEmission(session: FeatureSearchSession): void {
        this.pendingProgressEmissionSessionIds.add(session.id);
        if (this.progressEmissionRaf !== null) {
            return;
        }
        const schedule = typeof requestAnimationFrame === "function"
            ? requestAnimationFrame
            : ((callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16) as unknown as number);
        this.progressEmissionRaf = schedule(() => {
            this.progressEmissionRaf = null;
            const sessionIds = Array.from(this.pendingProgressEmissionSessionIds);
            this.pendingProgressEmissionSessionIds.clear();
            for (const sessionId of sessionIds) {
                const currentSession = this.getInternalSession(sessionId);
                if (currentSession) {
                    this.progress.next(currentSession);
                }
            }
        });
    }

    /** Returns one session's cached marker list, rebuilding it only after mutations. */
    private getSessionSearchResultPoints(session: FeatureSearchSession): SearchResultPoint[] {
        if (session.searchResultPointsCacheDirty) {
            session.searchResultPointsCache = Array.from(session.searchResultPointsByFeatureKey.values());
            session.searchResultPointsCacheDirty = false;
        }
        return session.searchResultPointsCache;
    }

    /** Returns one session's cached marker list grouped by source map/layer/tile. */
    private getSessionSearchResultPointBuckets(session: FeatureSearchSession): SearchResultPointBucket[] {
        return session.searchResultPointBucketsCache;
    }

    /** Clears one session's marker caches and returns whether anything changed. */
    private clearSessionSearchResultPoints(session: FeatureSearchSession): boolean {
        if (!session.searchResultPointsByFeatureKey.size
            && !session.searchResultPointsCache.length
            && !session.searchResultPointBucketsCache.length
            && !session.searchResultPointBucketIndexBySourceKey.size
            && !session.searchResultPointsCacheDirty) {
            return false;
        }
        session.searchResultPointsByFeatureKey.clear();
        session.searchResultPointsCache = [];
        session.searchResultPointBucketsCache = [];
        session.searchResultPointBucketIndexBySourceKey.clear();
        session.searchResultPointsCacheDirty = false;
        session.searchResultPointsVersion += 1;
        session.searchResultDensityIndex.clear();
        return true;
    }

    /** Bumps the aggregate marker-layer version consumed by the map overlay. */
    private bumpSearchResultLayersVersion(): void {
        this.searchResultLayersVersionValue += 1;
    }

    /** Updates one session's configured marker color and refreshes dependent map overlays. */
    private updateSessionColor(session: FeatureSearchSession, color: string): void {
        const normalizedColor = this.normalizeHexColor(color);
        session.pointColor = normalizedColor;
        this.bumpSearchResultLayersVersion();
        this.progress.next(session);
    }

    /**
     * Canonicalizes 3-digit and 6-digit hex color inputs to a lower-case #rrggbb string.
     */
    private normalizeHexColor(color: string): string {
        const hex = (color || "").trim();
        const validHex = /^#([0-9a-f]{6})$/i.exec(hex);
        if (validHex) {
            return `#${validHex[1].toLowerCase()}`;
        }
        const shortHex = /^#([0-9a-f]{3})$/i.exec(hex);
        if (shortHex) {
            const [r, g, b] = shortHex[1].split("");
            return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
        }
        return "#ea4336";
    }

    /**
     * Splits a normalized hex color into RGB channel values.
     */
    private parseHexRgb(color: string): [number, number, number] {
        return [
            parseInt(color.slice(1, 3), 16),
            parseInt(color.slice(3, 5), 16),
            parseInt(color.slice(5, 7), 16)
        ];
    }

    /** Converts a normalized search color into the RGBA tuple consumed by Deck marker layers. */
    private parseSearchResultColor(color: string): [number, number, number, number] {
        const [r, g, b] = this.parseHexRgb(color);
        return [r, g, b, 235];
    }

    /**
     * Extracts map and layer ids from a tile key, falling back to a plain split if parsing fails.
     */
    private parseMapLayerIds(mapTileKey: string): {mapId: string; layerId: string} {
        try {
            const [mapId, layerId] = coreLib.parseMapTileKey(mapTileKey);
            return {mapId: String(mapId), layerId: String(layerId)};
        } catch (_error) {
            const [mapId = "", layerId = ""] = mapTileKey.split("/");
            return {mapId, layerId};
        }
    }

    /** Builds the stable UI identity for one streamed search result, independent of its feature id. */
    private searchResultEntryKey(sourceTileKey: string, mapTileKey: string, resultIndex: number): string {
        return `${sourceTileKey}\n${mapTileKey}\n${resultIndex}`;
    }

    /** Builds the feature-id suffix consumed by native highlight code for attribute/validity hover. */
    private searchResultHoverFeatureId(featureId: string, entry: SearchResultTileEntry): string {
        if (!this.hasFiniteIndex(entry.attributeIndex)) {
            return featureId;
        }
        return formatFeatureInspectionTarget({
            scope: "attribute",
            baseFeatureId: featureId,
            attributeIndex: Math.max(0, Math.floor(entry.attributeIndex)),
            ...(this.hasFiniteIndex(entry.validityIndex)
                ? {
                    validityIndex: Math.max(
                        0,
                        Math.floor(entry.validityIndex)
                    )
                }
                : {})
        });
    }

    /** Creates a compact human-readable label for the result tree. */
    private searchResultEntryLabel(
        entry: SearchResultTileEntry,
        resultFields: readonly string[],
        _resultIndex: number
    ): string {
        const attributeName = entry.values
            ? this.searchResultFieldValue(entry, resultFields, "$name")
            : "";
        const attributeSuffix = attributeName
            || (this.hasFiniteIndex(entry.attributeIndex)
                ? `attribute ${Math.max(0, Math.floor(entry.attributeIndex)) + 1}`
                : "");
        const validitySuffix = this.searchResultValidityLabel(entry);
        const detail = [attributeSuffix, validitySuffix].filter(Boolean).join(" ");
        if (detail) {
            return `${entry.featureId} - ${detail}`;
        }
        return entry.featureId;
    }

    /** Formats one optional validity ordinal using one-based values for users. */
    private searchResultValidityLabel(entry: SearchResultTileEntry): string {
        if (!this.hasFiniteIndex(entry.validityIndex)) {
            return "";
        }
        const validityIndex = Math.max(0, Math.floor(entry.validityIndex));
        if (this.hasFiniteIndex(entry.validityCount) && entry.validityCount > 0) {
            return `validity ${validityIndex + 1}/${Math.floor(entry.validityCount)}`;
        }
        return `validity ${validityIndex + 1}`;
    }

    /** Reads and stringifies one backend-provided result field value. */
    private searchResultFieldValue(
        entry: SearchResultTileEntry,
        resultFields: readonly string[],
        field: string
    ): string {
        const fieldIndex = resultFields.indexOf(field);
        if (fieldIndex < 0 || !entry.values || fieldIndex >= entry.values.length) {
            return "";
        }
        const value = entry.values[fieldIndex];
        if (value === null || value === undefined) {
            return "";
        }
        if (typeof value === "string") {
            return value;
        }
        if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
            return String(value);
        }
        try {
            return JSON.stringify(value);
        } catch (_error) {
            return String(value);
        }
    }

    /**
     * Creates a search marker, falling back to the source tile center for compact streamed entries.
     *
     * Default density-map rendering aggregates by tile anyway, so compact entries intentionally skip expensive
     * per-result geometry-center extraction. Exact entry positions are still used when the native payload includes them.
     */
    private makeSearchResultPoint(
        sourceTileKey: string,
        sourceMapId: string,
        sourceLayerId: string,
        sourceTileId: number,
        mapId: string,
        layerId: string,
        mapTileKey: string,
        featureId: string,
        resultIndex: number,
        resultKey: string,
        hoverFeatureId: string,
        entry: SearchResultTileEntry,
        fallbackTileCenter: {x: number; y: number; z: number} | null
    ): SearchResultPoint | null {
        const cartographicRad = entry.position?.cartographicRad;
        const cartographic = entry.position?.cartographic;
        const lon = cartographicRad
            ? GeoMath.toDegrees(cartographicRad.longitude)
            : cartographic?.x ?? fallbackTileCenter?.x;
        const lat = cartographicRad
            ? GeoMath.toDegrees(cartographicRad.latitude)
            : cartographic?.y ?? fallbackTileCenter?.y;
        if (lon === undefined || lat === undefined) {
            return null;
        }
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            return null;
        }
        const featureKey = `${mapId}/${layerId}/${featureId}`;
        return {
            coordinates: [lon, lat],
            mapId,
            layerId,
            tileId: sourceTileId,
            mapTileKey,
            sourceTileKey,
            sourceMapId,
            sourceLayerId,
            sourceTileId,
            featureId,
            resultIndex,
            resultKey,
            featureKey,
            hoverFeatureId
        };
    }

    /**
     * Formats elapsed time for the diagnostics panel without dragging in a heavier date library.
     */
    private formatTime(milliseconds: number): string {
        const mseconds = Math.floor(milliseconds % 1000);
        const seconds = Math.floor((milliseconds / 1000) % 60);
        const minutes = Math.floor((milliseconds / 60000) % 60);
        const hours = Math.floor((milliseconds / 3600000) % 24);

        return `${hours ? `${hours}h ` : ''}
                ${minutes ? `${minutes}m ` : ''}
                ${seconds ? `${seconds}s ` : ''}
                ${mseconds ? `${mseconds}ms` : ''}`.trim() || "0ms";
    }

}
