import type {SearchPreparation, SearchInterpretation} from "./search-preparation.model";
import {combinePreparedSearchAutoStyles, preparedSearchAutoStyleRules} from "./feature-search-auto-style.util";
import { Injectable } from "@angular/core";
import { BehaviorSubject, Subject, take } from "rxjs";
import { filter } from "rxjs/operators";
import { z } from "zod";
import {schemaTypeIdentitySchema} from "../mapdata/schema-type.model";

import { AppActionContributor, AppActionRegistration } from "../action/action-contributor.model";
import {
    AppActionCandidate,
    applied,
    boundedCollection,
    colorSchema,
    ControlReadContext,
    identifierSchema,
    indexSchema,
    rejectAction
} from "../action/action.model";
import { deepEquals } from "../appstate/appstate.model";
import { AppStateService } from "../appstate/appstate.service";
import { formatFeatureInspectionTarget } from "../inspection/feature-identity.model";
import { InspectionState } from "../inspection/inspection.state";
import { GeoMath } from "../integrations/geo.adapter";
import { coreLib, uint8ArrayFromWasm, uint8ArrayToWasm } from "../integrations/wasm.adapter";
import {
    FEATURE_SEARCH_DIALOG_LAYOUT_ID,
    FEATURE_SEARCH_EXPORT_DIALOG_LAYOUT_ID,
    SEARCH_DOCK_TAB_ID
} from "../layout/layout.model";
import { LayoutService } from "../layout/layout.service";
import type { FilterTileState } from "../mapdata/filter-tile-state.model";
import type { MapTileStreamFilterStatusPayload } from "../mapdata/map-tile-stream.protocol";
import { MapTileStreamService } from "../mapdata/map-tile-stream.service";
import { MapDataService } from "../mapdata/mapdata.service";
import type { MapgetLayer } from "../mapdata/mapget-layer.model";
import { tilePartition, type PartitionId } from "../mapdata/partition.model";
import { type StyledMapgetLayerEvent } from "../mapdata/styled-mapget-layer.model";
import { StyledMapgetLayer } from "../mapdata/styled-mapget-layer.presentation";
import { viewIdSchema } from "../mapview/mapview.model";
import { MapViewService } from "../mapview/mapview.service";
import { MapViewState } from "../mapview/mapview.state";
import { FrameBudgetLoop } from "../utils/frame-budget-loop.util";
import { boundedUnicodeString, unicodePrefix } from "../utils/unicode-string.util";
import { featureSearchDefinitionExport, featureSearchDefinitionFromImportPayload } from "./feature-search-export.util";
import { FeatureSearchResolvedDefinition, featureSearchResultFields } from "./feature-search-runtime-state.model";
import { FeatureSearchSchemaService, FeatureSearchScopeAnalysis } from "./feature-search-schema.service";
import type { FeatureSearchStyleRule } from "./search-definition.model";
import {
    DEFAULT_FEATURE_SEARCH_TILE_LEVELS,
    defaultFeatureSearchViewIndicesForMapLayers,
    FeatureSearchMapLayerRef,
    FeatureSearchStateEntry,
    normalizeFeatureSearchFeatureTypes
} from "./search-definition.model";
import { SearchResultDensityIndex } from "./search-result-density.visualization";
import type { SearchResultPoint } from "./search-results.model";
import {
    SearchResults,
    type SearchResultTileContribution,
    type SearchTileValueSummaries
} from "./search-results.model";
import type {
    FeatureSearchOverlayLayer,
    FeatureSearchResultLayer,
    FeatureSearchSession,
    FeatureSearchSessionSchemaAnalysis
} from "./search-session.model";
import {
    featureSearchMapLayersManualFromPayload,
    featureSearchMapLayersFromPayload,
    featureSearchSelectedViewIndicesFromPayload,
    uniqueFeatureSearchMapLayers,
    type FeatureSearchExportDialogOptions,
    type FeatureSearchExportDialogRequest,
    type FeatureSearchRunOptions
} from "./search-session.model";
import { SearchPresentation, type SearchCoverageRequest } from "./search-visualization.presentation";
import {
    FeatureSearchResultEntry,
    SearchResultFieldValueSummary,
    SearchResultTileEntry,
    SearchResultTilePayload,
    SearchTraceValueSummary
} from "./search.model";
import { SearchState } from "./search.state";

interface SearchSubsetIngestionTask {
    runId: string;
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

/** Runtime controller alone can mutate the per-session result owner. */
interface RuntimeSearchSession extends FeatureSearchSession { readonly results: SearchResults; }

@Injectable({ providedIn: 'root' })
/**
 * Coordinates search sessions, native ingestion, and their view presentations.
 *
 * Search execution is delegated to mapget; this service keeps server progress and UI-friendly result caches in sync.
 */
export class SearchService implements AppActionContributor {

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
    private static readonly VALUE_SUMMARY_TILE_BATCH_SIZE = 12;

    static layoutIdForSearch(searchId: string): string {
        return `${FEATURE_SEARCH_DIALOG_LAYOUT_ID}:${searchId}`;
    }

    private searchRunCounter = 0;
    private searchSessionCounter = 0;
    /** Definitions dismissed by a scene reset stay saved, but do not reopen on catalog refresh. */
    private presentationDismissedSearches = new Map<string, string>();
    private searchPresentationRevision = 0;

    readonly sessionsChanged = new BehaviorSubject<FeatureSearchSession[]>([]);
    readonly progress: BehaviorSubject<FeatureSearchSession | null> = new BehaviorSubject<FeatureSearchSession | null>(null);
    readonly exportDialogRequest = new BehaviorSubject<FeatureSearchExportDialogRequest | null>(null);
    diagnosticsMessageLimit: number = 25;

    private readonly searchSessions: RuntimeSearchSession[] = [];
    private locationMarkerGraphicUrl: string | null = null;
    private pendingResultDataRebuildSessionIds = new Set<string>();
    private pendingForcedGenerationIds = new Set<string>();
    private pendingSchemaAnalysisSignatures = new Set<string>();
    private pendingProgressEmissionSessionIds = new Set<string>();
    private resultDataRebuildRaf: number | null = null;
    private progressEmissionRaf: number | null = null;
    private readonly searchPresentations = new Map<string, SearchPresentation>();
    private readonly searchPresentationByLayer =
        new Map<StyledMapgetLayer, SearchPresentation>();
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
    constructor(private mapInfo: MapDataService,
        private searchSchema: FeatureSearchSchemaService,
        private tileStream: MapTileStreamService,
        private viewState: MapViewService,
        private stateService: AppStateService,
        public readonly layout: LayoutService,
        public readonly inspectionState: InspectionState,
        public readonly viewSettings: MapViewState,
        public readonly state: SearchState) { }

    private initialized = false;

    /** Starts runtime reconciliation after every state owner has registered its values. */
    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;
        this.stateService.ready
            .pipe(
                filter((ready): ready is true => ready),
                take(1)
            )
            .subscribe(() => {
                this.resetStaleDockState();
                this.reconcilePersistedFeatureSearchState(this.state.featureSearches);
            });
        this.stateService
            .observe(() => this.state.featureSearches, deepEquals)
            .subscribe((entries) => {
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
        this.mapInfo.layerStateChanged.subscribe((reason) => {
            if (reason === "datasources" && this.stateService.ready.getValue()) {
                if (this.invalidateChangedSchemaAnalysis()) {
                    this.reconcilePersistedFeatureSearchState(this.state.featureSearches);
                }
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
            numViews: this.viewSettings.numViews,
            persistedFeatureSearches: this.state.featureSearches.map((entry) =>
                this.searchDefinitionDiagnostics(entry)
            ),
            sessions: this.searchSessions.map((session) => ({
                id: session.id,
                refresh: session.refresh,
                runId: session.runId,
                complete: session.results.complete,
                paused: session.paused,
                backendComplete: session.results.backendComplete,
                progressDone: session.results.progressDone,
                progressTotal: session.results.progressTotal,
                resultTileIngressDone: session.results.resultTileIngressDone,
                resultTileIngressTotal: session.results.resultTileIngressTotal,
                totalFeatureCount: session.results.totalFeatureCount,
                searchResultCount: session.results.searchResults.length,
                contributionCount: session.results.searchResultTilesBySourceKey.size,
                schemaAnalysis: session.schemaAnalysis,
                hasLastResolvedDefinition: !!session.lastResolvedDefinition,
                lastResolvedDefinitionSignature: session.lastResolvedDefinitionSignature ?? null,
                definition: this.searchDefinitionDiagnostics(session.definition),
                progressByRequestKey: Array.from(session.results.progressByRequestKey.entries()).map(
                    ([key, value]) => ({
                        key,
                        ...value
                    })
                ),
                errors: Array.from(session.results.errors)
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
            this.state.featureSearches.map((entry) => SearchService.layoutIdForSearch(entry.id))
        );
        for (const layoutId of Object.keys(this.layout.state.dialogLayoutsState.getValue())) {
            if (
                (layoutId === FEATURE_SEARCH_DIALOG_LAYOUT_ID ||
                    layoutId.startsWith(`${FEATURE_SEARCH_DIALOG_LAYOUT_ID}:`)) &&
                !activeLayoutIds.has(layoutId)
            ) {
                this.layout.removeDialogLayout(layoutId);
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

    /** Captures current resolved membership and editor rules together for a save dialog. */
    getStyleExportSnapshot(id: string, rules: readonly FeatureSearchStyleRule[]): FeatureSearchResolvedDefinition {
        const session = this.getInternalSession(id);
        if (!session) {
            throw new Error("The search is no longer available.");
        }
        const resolved = this.resolvedDefinitionForSession(session);
        if (!resolved || session.preparation?.status !== "ready") {
            throw new Error(session.schemaAnalysis.error
                || "Search scope is still being resolved. Please save again when the search is ready.");
        }
        return structuredClone({...resolved, searchStyleRules: [...rules]});
    }

    /** Starts lazy native aggregation of withFields and trace values for the Diagnostics tab. */
    requestValueSummaries(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!session.results.canSummarizeSessionValues()) {
            return;
        }
        if (session.results.valueSummaries.status === "loading"
            || (session.results.valueSummaries.revision === session.results.valueSummaryRevision
                && (session.results.valueSummaries.status === "ready"
                    || session.results.valueSummaries.status === "empty"
                    || session.results.valueSummaries.status === "error"))) {
            return;
        }

        const revision = session.results.valueSummaryRevision;
        const totalTiles = Array.from(session.results.searchResultTilesBySourceKey.values())
            .filter(contribution => contribution.layerBlob.length > 0)
            .length;
        session.results.valueSummaries = session.results.emptyValueSummariesState(totalTiles === 0 ? "empty" : "loading", revision, totalTiles);
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
        return !!session && this.layout.isSurfaceDocked(session.layoutId);
    }

    /** Returns the persisted dock position for one session, falling back to creation order. */
    private sessionDockOrder(session: RuntimeSearchSession): number {
        const order = this.layout.getDialogLayout(session.layoutId)?.dockOrder;
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
                `data:image/svg+xml;base64,${btoa(SearchService.LOCATION_MARKER_SVG)}`;
        }
        return this.locationMarkerGraphicUrl;
    }

    /** Returns one marker-layer descriptor per search so colors stay independent. */
    getSearchResultLayers(): FeatureSearchResultLayer[] {
        return this.searchSessions
            .filter(session => session.definition.showResultsOnMap)
            .map(session => ({
                id: session.id,
                pointsVersion: session.results.searchResultPointsVersion,
                pointColor: session.pointColor,
                pointColorRgba: this.parseSearchResultColor(session.pointColor),
                selectedViewIndices: [...session.definition.selectedViewIndices],
                renderStrategy: session.definition.renderStrategy,
                styleRuleCount: session.definition.searchStyleRules.length,
                points: session.results.getSessionSearchResultPoints(),
                pointBuckets: session.results.getSessionSearchResultPointBuckets(),
                densityIndex: session.results.searchResultDensityIndex
            }))
            .filter(layer => layer.points.length > 0);
    }

    /** Returns map-overlay search descriptors without materializing every per-result point. */
    getSearchResultOverlayLayers(): FeatureSearchOverlayLayer[] {
        return this.searchSessions
            .filter(session => session.definition.showResultsOnMap)
            .map(session => ({
                id: session.id,
                pointsVersion: session.results.searchResultPointsVersion,
                pointColor: session.pointColor,
                pointColorRgba: this.parseSearchResultColor(session.pointColor),
                selectedViewIndices: [...session.definition.selectedViewIndices],
                renderStrategy: session.definition.renderStrategy,
                styleRuleCount: session.definition.searchStyleRules.length,
                pointBuckets: session.results.getSessionSearchResultPointBuckets(),
                densityIndex: session.results.searchResultDensityIndex
            }))
            .filter(layer => layer.pointBuckets.length > 0);
    }

    /** Reconciles persisted feature-search definitions with runtime sessions. */
    private reconcileFeatureSearchState(definitions: FeatureSearchStateEntry[]): void {
        const currentIds = new Set(definitions.map(definition => definition.id));
        for (const id of this.presentationDismissedSearches.keys()) {
            if (!currentIds.has(id)) this.presentationDismissedSearches.delete(id);
        }
        definitions = definitions.filter(definition => {
            if (this.presentationDismissedSearches.get(definition.id) === JSON.stringify(definition)) return false;
            this.presentationDismissedSearches.delete(definition.id);
            return true;
        });
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
    private applyFeatureSearchDefinition(session: RuntimeSearchSession, definition: FeatureSearchStateEntry): void {
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
            this.startSessionSearch(session, definition, { forceGenerationIds: [session.id] });
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
        const searchGenerationChanged = JSON.stringify(previous.interpretationIds) !== JSON.stringify(definition.interpretationIds)
            || previous.query !== definition.query
            || previous.scope !== definition.scope
            || selectedLayersChanged
            || selectedTileLevelsChanged
            || selectedFeatureTypesChanged
            || JSON.stringify(previousFields) !== JSON.stringify(nextFields);

        if (searchGenerationChanged && this.searchScopeAnalysisSignature(previous) !== this.searchScopeAnalysisSignature(definition)) {
            // A confirmed replacement is prepared while the previous result is
            // retained. Preparation is never triggered by editor keystrokes.
            session.definition = definition;
            session.schemaAnalysis = this.initialSchemaAnalysis(definition);
            session.preparation = undefined;
            this.progress.next(session);
            this.syncSearchRequestsToMapService();
            return;
        }
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
            this.progress.next(session);
        }
        if (JSON.stringify(previous.renderStrategy) !== JSON.stringify(definition.renderStrategy)) {
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
            this.progress.next(session);
        }
        this.syncSearchRequestsToMapService();
    }

    /** Selects the next default result color for a newly created search. */
    private nextDefaultSearchColor(): string {
        const color = SearchService.DEFAULT_SEARCH_COLORS[
            this.searchSessionCounter % SearchService.DEFAULT_SEARCH_COLORS.length
        ];
        this.searchSessionCounter += 1;
        return color;
    }

    /** Returns all feature map/layers that are visible in at least one view. */
    private activeFeatureSearchLayers(): FeatureSearchMapLayerRef[] {
        const selected = new Map<string, FeatureSearchMapLayerRef>();
        for (const [mapId, map] of this.mapInfo.maps.maps) {
            for (const layer of map.allFeatureLayers()) {
                for (let viewIndex = 0; viewIndex < this.viewSettings.numViews; ++viewIndex) {
                    if (!this.mapInfo.maps.getMapLayerVisibility(viewIndex, mapId, layer.id)) {
                        continue;
                    }
                    selected.set(JSON.stringify([mapId, layer.id]), { mapId, layerId: layer.id });
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
            this.viewSettings.numViews,
            (viewIndex, ref) => this.mapInfo.maps.getMapLayerVisibility(viewIndex, ref.mapId, ref.layerId)
        );
    }

    /** Returns all feature map/layers enabled in a specific view. */
    featureSearchLayersForView(viewIndex: number): FeatureSearchMapLayerRef[] {
        const selected = new Map<string, FeatureSearchMapLayerRef>();
        if (!Number.isInteger(viewIndex) || viewIndex < 0 || viewIndex >= this.viewSettings.numViews) {
            return [];
        }
        for (const [mapId, map] of this.mapInfo.maps.maps) {
            for (const layer of map.allFeatureLayers()) {
                if (!this.mapInfo.maps.getMapLayerVisibility(viewIndex, mapId, layer.id)) {
                    continue;
                }
                selected.set(JSON.stringify([mapId, layer.id]), { mapId, layerId: layer.id });
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
        let selectedMapLayers = featureSearchMapLayersFromPayload(payload);
        if (!selectedMapLayers) {
            // The viewport expresses the user's current source choice. A
            // completion batch is bounded and its origins are not an inventory
            // of every map that can evaluate the accepted portable expression.
            const active = this.activeFeatureSearchLayers();
            selectedMapLayers = active.length ? active : featureSearchMapLayersFromPayload(payload, "suggestedMapLayers");
        }
        const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
        const ids = record?.["selectedViewIds"];
        if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !this.viewSettings.viewIds.includes(id)))) {
            rejectAction("The saved search refers to a map view that is no longer available");
        }
        const selectedViewIndices = Array.isArray(ids)
            ? ids.map(id => this.viewSettings.indexOfView(id))
            : featureSearchSelectedViewIndicesFromPayload(payload);
        const selectedMapLayersManual = featureSearchMapLayersManualFromPayload(payload);
        const interpretationIds = Array.isArray(record?.["interpretationIds"])
            ? record["interpretationIds"].filter((id): id is string => typeof id === "string") : undefined;
        return this.run(query, {
            ...(interpretationIds ? {interpretationIds} : {}),
            ...(selectedMapLayers ? { selectedMapLayers } : {}),
            ...(selectedViewIndices ? { selectedViewIndices } : {}),
            ...(selectedMapLayersManual !== undefined ? { selectedMapLayersManual } : {})
        });
    }

    /** Starts a new feature search over the currently prioritized tiles, optionally with explicit scope/layers. */
    run(query: string, options: FeatureSearchRunOptions = {}): FeatureSearchSession {
        const selectedMapLayers =
            options.selectedMapLayers === undefined
                ? this.activeFeatureSearchLayers()
                : uniqueFeatureSearchMapLayers(options.selectedMapLayers);
        const selectedViewIndices =
            options.selectedViewIndices ?? this.activeFeatureSearchViewIndices(selectedMapLayers);
        const entry = this.state.addFeatureSearch({
            query,
            ...(options.scope ? { scope: options.scope } : {}),
            ...(options.interpretationIds ? {interpretationIds: options.interpretationIds} : {}),
            ...(options.autoUpdate === undefined ? {} : { autoUpdate: options.autoUpdate }),
            pinColor: this.nextDefaultSearchColor(),
            selectedMapLayers,
            selectedMapLayersManual: options.selectedMapLayersManual ?? false,
            selectedFeatureTypes: options.selectedFeatureTypes ?? [],
            selectedTileLevels: [...(options.selectedTileLevels ?? DEFAULT_FEATURE_SEARCH_TILE_LEVELS)],
            selectedViewIndices
        });
        this.placeNewSearchSurface(entry.id);
        let session = this.getInternalSession(entry.id);
        if (!session) {
            this.reconcilePersistedFeatureSearchState(this.state.featureSearches);
            session = this.getInternalSession(entry.id);
        }
        return session!;
    }

    /** Imports feature-search JSON as a fresh runnable search session. */
    importSearchJsonPayload(payload: unknown): FeatureSearchSession {
        const imported = featureSearchDefinitionFromImportPayload(payload).definition;
        const selectedMapLayers = imported.selectedMapLayers.map((ref) => ({ ...ref }));
        const entry = this.state.addFeatureSearch({
            query: imported.query,
            scope: imported.scope,
            interpretationIds: imported.interpretationIds,
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
            renderStrategy: { ...imported.renderStrategy }
        });
        this.placeNewSearchSurface(entry.id);
        let session = this.getInternalSession(entry.id);
        if (!session) {
            this.reconcilePersistedFeatureSearchState(this.state.featureSearches);
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
        // Completion changes the expression, not the layer selector beside it.
        const patched = this.state.patchFeatureSearch(sessionId, {query, paused: false, interpretationIds: undefined});
        if (patched) {
            return;
        }
        const nextDefinition: FeatureSearchStateEntry = {
            ...session.definition,
            query,
            paused: false
        };
        this.resetSessionSearch(session, nextDefinition);
        this.startSessionSearch(session, nextDefinition, { forceGenerationIds: [session.id] });
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
        this.state.patchFeatureSearch(sessionId, { paused: false });
    }

    /** Toggles whether viewport changes automatically update this search's tile coverage. */
    setSearchAutoUpdate(sessionId: string, autoUpdate: boolean): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.state.patchFeatureSearch(sessionId, { autoUpdate })) {
            session.definition = {
                ...session.definition,
                autoUpdate
            };
            this.syncSearchRequestsToMapService();
            this.progress.next(session);
        }
    }

    /** Applies a pause to runtime server dispatch for one session. */
    private applySearchPause(session: RuntimeSearchSession): void {
        session.paused = true;
        session.results.backendComplete = true;
        session.results.complete = true;
        session.results.progressDone = session.results.progressTotal;
        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        this.progress.next(session);
        this.syncSearchRequestsToMapService();
    }

    /** Removes one search from backend dispatch while keeping its persisted panel state. */
    private applySearchDisabled(session: RuntimeSearchSession, definition: FeatureSearchStateEntry): void {
        session.definition = definition;
        session.paused = false;
        session.results.backendComplete = true;
        session.results.complete = true;
        session.results.progressDone = session.results.progressTotal;
        session.endTime = Date.now();
        session.timeElapsed = session.startTime > 0
            ? this.formatTime(session.endTime - session.startTime)
            : this.formatTime(0);
        this.clearSessionResultData(session);
        this.progress.next(session);
        this.syncSearchRequestsToMapService();
    }

    /** Resumes runtime server dispatch for one session. */
    private applySearchResume(session: RuntimeSearchSession): void {
        session.paused = false;
        session.results.progressDone = 0;
        session.results.progressTotal = 1;
        session.results.backendComplete = false;
        session.results.resultTileIngressDone = 0;
        session.results.resultTileIngressTotal = 0;
        session.results.complete = false;
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
        if (!this.state.patchFeatureSearch(sessionId, { paused: true })) {
            this.applySearchPause(session);
        }
    }

    /** Resumes one paused search and hands it back to mapget. */
    resumeSearch(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session || !session.definition.enabled) {
            return;
        }
        if (!this.state.patchFeatureSearch(sessionId, { paused: false })) {
            this.applySearchResume(session);
        }
    }

    /** Stops one search without clearing its partial result state. */
    stopSearch(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session || !session.definition.enabled) {
            return;
        }
        session.results.complete = true;
        session.results.backendComplete = true;
        session.results.progressDone = session.results.progressTotal;
        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        session.paused = false;
        session.definition = {
            ...session.definition,
            autoUpdate: false,
            paused: true
        };
        if (!this.state.patchFeatureSearch(sessionId, { autoUpdate: false, paused: true })) {
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
        if (!this.state.patchFeatureSearch(sessionId, {pinColor: color,
            searchStyleRules: session.definition.searchStyleRules.map(rule => rule.autoGenerated && rule.color.mode === "solid"
                ? {...rule, color: {mode: "solid" as const, color}} : rule)})) {
            this.updateSessionColor(session, color);
        }
    }

    /** Toggles close protection for one persisted search panel. */
    setSearchBookmarked(sessionId: string, bookmarked: boolean): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.state.patchFeatureSearch(sessionId, { bookmarked })) {
            session.definition = { ...session.definition, bookmarked };
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
        this.layout.openDialog(FEATURE_SEARCH_EXPORT_DIALOG_LAYOUT_ID);
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
        if (
            !this.state.patchFeatureSearch(sessionId, {
                enabled,
                paused: enabled ? session.definition.paused : false
            })
        ) {
            const definition = {
                ...session.definition,
                enabled,
                paused: enabled ? session.definition.paused : false
            };
            if (enabled) {
                this.resetSessionSearch(session, definition);
                this.startSessionSearch(session, definition, { forceGenerationIds: [session.id] });
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
        if (
            !this.state.patchFeatureSearch(sessionId, {
                selectedMapLayers,
                selectedMapLayersManual: true,
                selectedFeatureTypes
            })
        ) {
            session.definition = {
                ...session.definition,
                selectedMapLayers,
                selectedMapLayersManual: true,
                selectedFeatureTypes
            };
            this.syncSearchRequestsToMapService({ forceGenerationIds: [session.id] });
            this.progress.next(session);
        }
    }

    /** Replaces the source tile levels used by one search. */
    setSearchTileLevels(sessionId: string, selectedTileLevels: number[]): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.state.patchFeatureSearch(sessionId, { selectedTileLevels })) {
            session.definition = { ...session.definition, selectedTileLevels };
            this.syncSearchRequestsToMapService({ forceGenerationIds: [session.id] });
            this.progress.next(session);
        }
    }

    /** Replaces the feature-type filter for one search; an empty list means all feature types. */
    setSearchFeatureTypes(sessionId: string, selectedFeatureTypes: string[]): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        const normalizedTypes = this.availableFeatureTypesForLayers(
            selectedFeatureTypes,
            session.definition.selectedMapLayers
        );
        if (JSON.stringify(session.definition.selectedFeatureTypes) === JSON.stringify(normalizedTypes)) {
            return;
        }
        if (!this.state.patchFeatureSearch(sessionId, { selectedFeatureTypes: normalizedTypes })) {
            session.definition = { ...session.definition, selectedFeatureTypes: normalizedTypes };
            this.syncSearchRequestsToMapService({ forceGenerationIds: [session.id] });
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
        // Pending schema installation is not evidence that a saved type vanished.
        if (!this.mapInfo.canPruneStateForCurrentCatalog()) return normalizedTypes;
        const availableTypes = new Set<string>();
        for (const ref of selectedMapLayers) {
            for (const type of this.mapInfo.featureTypesForLayer(ref.mapId, ref.layerId)) {
                availableTypes.add(type);
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
        if (!this.state.patchFeatureSearch(sessionId, { selectedViewIndices })) {
            session.definition = { ...session.definition, selectedViewIndices };
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
        this.layout.setSurfaceDocked(session.layoutId, docked, SEARCH_DOCK_TAB_ID);
        if (docked) {
            this.moveDockedSurfaceToTop(session.layoutId);
            this.layout.state.dockActiveTab = SEARCH_DOCK_TAB_ID;
            this.layout.state.isDockOpen = true;
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
        const entry = this.state.addFeatureSearch({
            query: definition.query,
            interpretationIds: definition.interpretationIds ? [...definition.interpretationIds] : undefined,
            scope: definition.scope,
            autoUpdate: definition.autoUpdate,
            bookmarked: definition.bookmarked,
            enabled: definition.enabled,
            paused: false,
            showResultsOnMap: definition.showResultsOnMap,
            pinColor: definition.pinColor,
            selectedMapLayers: definition.selectedMapLayers.map((ref) => ({ ...ref })),
            selectedMapLayersManual: definition.selectedMapLayersManual ?? false,
            selectedFeatureTypes: [...definition.selectedFeatureTypes],
            selectedTileLevels: [...definition.selectedTileLevels],
            selectedViewIndices: [...definition.selectedViewIndices],
            searchStyleRules: this.cloneJsonCompatible(definition.searchStyleRules),
            renderStrategy: { ...definition.renderStrategy }
        });
        const layoutId = SearchService.layoutIdForSearch(entry.id);
        if (this.isSessionDocked(session.id)) {
            this.layout.setSurfaceDocked(layoutId, true, SEARCH_DOCK_TAB_ID);
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
        const sourceLayout = this.layout.getDialogLayout(sourceLayoutId);
        if (!sourceLayout) {
            this.ensureInitialFloatingDialogLayout(cloneLayoutId);
            return;
        }
        const baseFontSize = this.layout.baseFontSize || 16;
        const offset = Math.round(baseFontSize * 1.25);
        const width = sourceLayout.size.width;
        const height = sourceLayout.size.height;
        const left = Math.min(Math.max(0, sourceLayout.position.left + offset), Math.max(0, window.innerWidth - width));
        const top = Math.min(Math.max(0, sourceLayout.position.top + offset), Math.max(0, window.innerHeight - height));
        this.layout.upsertDialogLayout(cloneLayoutId, {
            position: { left, top },
            size: { ...sourceLayout.size },
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
        this.layout.reorderDockedSurfaces(SEARCH_DOCK_TAB_ID, [layoutId, ...existingOrder]);
    }

    /** Docks a newly created search when the Search dock is already active. */
    private placeNewSearchSurface(searchId: string): void {
        const layoutId = SearchService.layoutIdForSearch(searchId);
        if (this.getDockedSessions().length > 0 || this.layout.hasDockedSurface(SEARCH_DOCK_TAB_ID)) {
            this.layout.setSurfaceDocked(layoutId, true, SEARCH_DOCK_TAB_ID);
            this.moveDockedSurfaceToTop(layoutId);
            this.notifySessionsChanged();
        }
    }

    /** Centers searches that were first created in the dock and only have the generic dock fallback position. */
    private ensureInitialFloatingDialogLayout(layoutId: string): void {
        const current = this.layout.getDialogLayout(layoutId);
        if (current && (current.position.left !== 0 || current.position.top !== 0)) {
            return;
        }
        const baseFontSize = this.layout.baseFontSize || 16;
        const width = Math.round(Math.min(
            SearchService.FLOATING_DIALOG_WIDTH_EM * baseFontSize,
            Math.max(baseFontSize, window.innerWidth - SearchService.FLOATING_DIALOG_HORIZONTAL_MARGIN_EM * baseFontSize)
        ));
        const height = Math.round(Math.min(
            SearchService.FLOATING_DIALOG_HEIGHT_EM * baseFontSize,
            Math.max(baseFontSize, window.innerHeight - SearchService.FLOATING_DIALOG_VERTICAL_MARGIN_EM * baseFontSize)
        ));
        this.layout.upsertDialogLayout(layoutId, {
            ...(current ?? {
                position: { left: 0, top: 0 },
                size: { width, height },
                open: false,
                docked: false,
                dockTab: SEARCH_DOCK_TAB_ID
            }),
            position: {
                left: Math.max(0, Math.round((window.innerWidth - width) / 2)),
                top: Math.max(0, Math.round((window.innerHeight - height) / 2))
            },
            size: { width, height }
        });
    }

    /** Dismisses all runtime searches for a new scene, retaining saved definitions for later edits or reload. */
    dismissForPresentation(): void {
        for (const definition of this.state.featureSearches) {
            this.presentationDismissedSearches.set(definition.id, JSON.stringify(definition));
        }
        for (const session of [...this.searchSessions]) this.closeRuntimeSearch(session.id);
    }

    /** Closes one search session and removes its persisted definition. */
    closeSearch(sessionId: string): void {
        if (this.state.featureSearches.some((entry) => entry.id === sessionId)) {
            this.state.removeFeatureSearch(sessionId);
            return;
        }
        this.closeRuntimeSearch(sessionId);
    }

    /** Closes one runtime search session without mutating persisted search definitions. */
    private closeRuntimeSearch(sessionId: string): boolean {
        const index = this.searchSessions.findIndex((session) => session.id === sessionId);
        if (index === -1) {
            return false;
        }
        const [session] = this.searchSessions.splice(index, 1);
        session.results.destroy();
        this.layout.removeDialogLayout(session.layoutId);
        this.notifySessionsChanged();
        this.progress.next(null);
        this.syncSearchRequestsToMapService();
        if (
            this.layout.state.isDockAutoCollapsible &&
            !this.inspectionState.selection.some((panel) => !panel.undocked) &&
            this.getDockedSessions().length === 0
        ) {
            this.layout.state.isDockOpen = false;
        }
        return true;
    }

    /** Creates a runtime session with independent result, diagnostics, and marker state. */
    private createSession(definition: FeatureSearchStateEntry): RuntimeSearchSession {
        const paused = definition.paused;
        const session: RuntimeSearchSession = {
            results: new SearchResults(new SearchResultDensityIndex()),
            id: definition.id,
            layoutId: SearchService.layoutIdForSearch(definition.id),
            definition,
            runId: this.generateRunId(),
            refresh: 0,
            paused,

            startTime: 0,
            endTime: 0,
            pointColor: this.normalizeHexColor(definition.pinColor),
            timeElapsed: this.formatTime(0),

            schemaAnalysis: this.initialSchemaAnalysis(definition),

        };
        session.results.beginRun(session.runId, paused);
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
        partitionOrTileId: PartitionId | number
    ): boolean {
        const partition = typeof partitionOrTileId === "number"
            ? tilePartition(partitionOrTileId)
            : partitionOrTileId;
        const level = partition.kind === "tile"
            ? Number(coreLib.getTileLevel(partition.id))
            : layer.mapgetLayer.tileAssociationLevel ?? 0;
        const cacheKey = `${viewIndex}|${layer.ownerId}|` +
            `${partition.kind}|${level}`;
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
        const result = partition.kind === "object" ||
            !strategy.showLowFiDots ||
            this.viewState.prefersHighFidelityForSearchResultTile(
                viewIndex,
                partition.id,
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
        const prepared = definitions.flatMap(definition => definition.branches?.filter(branch => !definition.selectedFeatureTypes.length || !branch.featureTypes.length ||
            branch.featureTypes.some(type => definition.selectedFeatureTypes.includes(type))).map(branch => ({
            ...definition, branchKey: branch.scope, concreteScope: branch.scope, backendQuery: branch.query, schemaId: branch.schemaId,
            selectedMapLayers: [{mapId: branch.mapId, layerId: branch.layerId}],
            selectedFeatureTypes: definition.selectedFeatureTypes.length
                ? definition.selectedFeatureTypes.filter(type => !branch.featureTypes.length || branch.featureTypes.includes(type))
                : branch.featureTypes,
            resultFields: featureSearchResultFields(definition, branch.scope)
        })) ?? [definition]);
        for (const definition of prepared) {
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
                const key = this.searchPresentationKey(definition.id, mapgetLayer) + "\n" + (definition.branchKey ?? "");
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
                    let replacement: SearchPresentation;
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
                        session?.results.errors.add(
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
                    if (presentation.setCoverage(this.searchCoverageRequest(definition, presentation))) {
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
    /** Creates one resource owner and routes its events into the current search run. */
    private createSearchPresentation(
        key: string, definition: FeatureSearchResolvedDefinition, mapgetLayer: MapgetLayer,
        featureTypes: string[], definitionSignature: string
    ): SearchPresentation {
        const presentation = new SearchPresentation({
            key, definition, mapgetLayer, featureTypes, definitionSignature,
            instanceId: `${definition.id}:${++this.searchPresentationRevision}`
        }, this.mapInfo, this.tileStream,
            (owner, event) => this.handleSearchStyledLayerEvent(owner, event),
            () => {
                this.pendingCoverageRefreshIds.add(definition.id);
                this.syncSearchRequestsToMapService();
            },
            message => {
                const session = this.getInternalSession(definition.id);
                if (session) {
                    session.results.errors.add(message);
                    this.progress.next(session);
                }
            });
        this.searchPresentationByLayer.set(presentation.styledLayer, presentation);
        return presentation;
    }

    private destroySearchPresentation(presentation: SearchPresentation): void {
        this.searchPresentationByLayer.delete(presentation.styledLayer);
        this.searchRenderDecisionCache.clear();
        this.subsetIngestionLoop.cancel(
            task => task.presentationKey === presentation.key
        );
        presentation.destroy();
        const session = this.getInternalSession(presentation.sessionId);
        if (session) {
            // Retire predecessor status together with its tiles so diagnostics describe current work.
            session.results.clearFilterSearchProgress(presentation.styledLayer.filterRef.filterId);
        }
        for (const sourceTileKey of [
            ...(session?.results.searchResultTilesBySourceKey.keys() ?? [])
        ]) {
            const contribution =
                session?.results.searchResultTilesBySourceKey.get(sourceTileKey);
            if (contribution?.sourceMapId === presentation.mapgetLayer.mapId &&
                contribution.sourceLayerId === presentation.mapgetLayer.layerId && sourceTileKey.startsWith(presentation.key + "\n")) {
                this.removeServerSearchResultTile({
                    searchId: presentation.sessionId,
                    sourceTileKey
                });
            }
        }
    }

    /** Stable union of selected-view coverage; request order remains significant. */
    private searchCoverageRequest(
        definition: FeatureSearchResolvedDefinition,
        presentation: SearchPresentation
    ): SearchCoverageRequest {
        const layer = presentation.mapgetLayer;
        if (layer.partitionKind === "object") {
            const level = layer.tileAssociationLevel;
            const discoveryTileIds = level === null ? [] : [...new Set(definition.selectedViewIndices.flatMap(
                viewIndex => this.viewState.visibleSearchTileIdsForLevel(viewIndex, level)))];
            return {kind: "object", discoveryTileIds};
        }
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
        return {kind: "tile", tileIds};
    }
    private searchPresentationKey(searchId: string, layer: MapgetLayer): string {
        return `${searchId}\n${layer.mapId}\n${layer.layerId}`;
    }

    private searchFeatureTypesForMapgetLayer(
        definition: FeatureSearchResolvedDefinition,
        layer: MapgetLayer
    ): string[] | null {
        const layerTypes = this.mapInfo.featureTypesForLayer(layer.mapId, layer.layerId);
        if (!definition.selectedFeatureTypes.length) {
            return layerTypes;
        }
        const selected = new Set(definition.selectedFeatureTypes);
        const result = layerTypes.filter(type => selected.has(type));
        return result.length ? result : null;
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
                .filter(state =>
                    state.status === "ready" && !state.backendPending
                ).length;
        }
        session.results.progressTotal = Math.max(1, total);
        session.results.progressDone = total === 0 ? 1 : completed;
        session.results.backendComplete = session.paused || completed >= total;
        this.updateSearchResultIngressProgress(session);
        this.updateSessionCompletion(session);
        this.progress.next(session);
    }
    /** Clears result ownership without changing the persisted definition or UI surface. */
    private clearSessionResultData(session: RuntimeSearchSession): void {
        this.pendingResultDataRebuildSessionIds.delete(session.id);
        session.results.clear();
    }

    /** Starts a fresh server progress run for a new query or mapget refresh. */
    private resetServerSearchProgress(session: RuntimeSearchSession, refresh: number): void {
        session.runId = this.generateRunId();
        session.refresh = refresh;
        session.paused = session.definition.paused;
        session.results.beginRun(session.runId, session.paused);
        session.startTime = Date.now();
        session.endTime = 0;
        session.timeElapsed = this.formatTime(0);
    }

    /** Prepares an existing session to receive result chunks for a newer mapget refresh. */
    private resetSessionForServerRefresh(session: RuntimeSearchSession, refresh: number): void {
        this.clearSessionResultData(session);
        this.resetServerSearchProgress(session, refresh);
    }

    /** Clears one session and installs a fresh search group for the supplied query. */
    private resetSessionSearch(session: RuntimeSearchSession, definition: FeatureSearchStateEntry): void {
        session.definition = definition;
        session.schemaAnalysis = this.initialSchemaAnalysis(definition);
        session.preparation = undefined;
        session.lastResolvedDefinition = undefined;
        session.lastResolvedDefinitionSignature = undefined;
        this.clearSessionResultData(session);
        session.refresh = 0;
        session.paused = definition.paused;
        session.results.resetProgress(definition.paused);
        session.startTime = 0;
        session.endTime = 0;
        session.timeElapsed = this.formatTime(0);
    }

    /** Starts or refreshes one server-side search session. */
    private startSessionSearch(
        session: RuntimeSearchSession,
        definition: FeatureSearchStateEntry,
        options: { forceGenerationIds?: Iterable<string> } = {}
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

    /** Invalidates only sessions whose selected source models changed, preserving unrelated live searches. */
    private invalidateChangedSchemaAnalysis(): boolean {
        let changed = false;
        for (const session of this.searchSessions) {
            if (session.schemaAnalysis.signature === this.searchScopeAnalysisSignature(session.definition)) continue;
            session.schemaAnalysis = this.initialSchemaAnalysis(session.definition);
            changed = true;
        }
        return changed;
    }

    /** Returns the resolved definition consumed by MapTileStreamService, keeping the previous one during same-signature re-analysis. */
    private resolvedDefinitionForSession(session: RuntimeSearchSession): FeatureSearchResolvedDefinition | null {
        const signature = this.searchScopeAnalysisSignature(session.definition);
        if (!this.ensureSessionSchemaAnalysis(session, signature) || session.preparation?.status !== "ready") {
            // The old presentation remains recognizable while a confirmed
            // replacement needs a choice or schema. Do not dispatch the draft.
            return session.lastResolvedDefinition ? {...session.lastResolvedDefinition, autoUpdate: false, paused: true} : null;
        }
        const concreteScope = session.schemaAnalysis.concreteScope;
        const resolved = {
            ...session.definition, concreteScope,
            backendQuery: session.schemaAnalysis.normalizedQuery,
            resultFields: featureSearchResultFields(session.definition, concreteScope),
            branches: session.preparation.branches
        };
        session.lastResolvedDefinition = resolved;
        session.lastResolvedDefinitionSignature = signature;
        return resolved;
    }

    /** Ensures a session has async schema analysis for the current definition. */
    private ensureSessionSchemaAnalysis(session: RuntimeSearchSession, signature: string): boolean {
        if (session.schemaAnalysis.signature === signature && session.schemaAnalysis.status === "ready") {
            return true;
        }
        if (session.schemaAnalysis.signature === signature && session.preparation?.signature === signature &&
            session.preparation.status !== "preparing") return false;
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
    private requestSessionSchemaAnalysis(session: RuntimeSearchSession, signature: string): void {
        const requestKey = `${session.id}\u0000${signature}`;
        if (this.pendingSchemaAnalysisSignatures.has(requestKey)) {
            return;
        }
        this.pendingSchemaAnalysisSignatures.add(requestKey);
        session.preparation = {signature, status: "preparing", phase: "interpretation", interpretations: [], selectedIds: [], branches: [], initialStyles: []};
        this.searchSchema.requestSearchScopeAnalysis(
            session.definition.query,
            session.definition.scope,
            session.definition.selectedMapLayers,
            session.definition.selectedFeatureTypes
        ).then(analysis => {
            void this.applySearchScopeAnalysis(session.id, {...analysis, signature})
                .finally(() => this.pendingSchemaAnalysisSignatures.delete(requestKey));
        });
    }

    /** Applies a completed async schema-analysis result if the session still represents the same definition. */
    private async applySearchScopeAnalysis(sessionId: string, analysis: FeatureSearchScopeAnalysis): Promise<void> {
        const session = this.getInternalSession(sessionId);
        if (!session || analysis.signature !== this.searchScopeAnalysisSignature(session.definition)) return;
        const preparation = session.preparation!;
        try {
            if (analysis.error) throw new Error(analysis.error);
            if (!analysis.interpretations) throw new Error("Schema worker returned no search interpretations.");
            const interpretations = new Map<string, SearchInterpretation>();
            for (const branch of analysis.interpretations) {
                let meaning = interpretations.get(branch.id);
                if (!meaning) {
                    meaning = {id: branch.id, label: branch.label, kind: branch.kind, query: branch.expression, branches: []};
                    interpretations.set(branch.id, meaning);
                }
                meaning.branches.push(branch);
            }
            preparation.interpretations = [...interpretations.values()];
            if (!interpretations.size) throw new Error("No declared search meaning in the selected layers. Use an explicit field predicate.");
            const selected = session.definition.interpretationIds ?? [];
            if (selected.length > 1) {
                preparation.status = "needs-choice";
                preparation.error = "Choose exactly one interpretation. Combined interpretations are not supported.";
                this.progress.next(session);
                return;
            }
            // Scope edits clear the previous binding in SearchState. A single
            // remaining meaning then needs no extra confirmation. A stale
            // saved binding still requires a deliberate choice.
            const selectedId = selected[0] ?? (interpretations.size === 1 ? [...interpretations.keys()][0] : undefined);
            const meaning = selectedId ? interpretations.get(selectedId) : undefined;
            if (!meaning) {
                preparation.status = "needs-choice";
                if (selected.length) preparation.error = "The saved interpretation is no longer declared. Choose an interpretation again.";
                this.progress.next(session);
                return;
            }
            preparation.selectedIds = [meaning.id];
            // One meaning may occur in several layers; that is source coverage,
            // never permission to combine different semantic interpretations.
            preparation.branches = structuredClone(meaning.branches);
            preparation.phase = "style";
            this.progress.next(session);
            const automatic = !session.definition.searchStyleRules.some(rule => !rule.autoGenerated);
            const branchStyles: FeatureSearchStyleRule[][] = [];
            if (automatic) {
                const attributeBranches = preparation.branches.filter(branch => branch.scope === "attribute");
                const inventory = attributeBranches.length
                    ? await this.searchSchema.requestPreparedSearchStyleFields(attributeBranches, {recursive: true, values: "scalar"})
                    : undefined;
                for (const branch of preparation.branches) {
                    const attributeScopes = branch.attributeScopes;
                    const branchAnalysis = {
                        ...analysis,
                        rewriteSuppressed: false,
                        status: "ready" as const,
                        concreteScope: branch.scope,
                        attributeScopes,
                        matchedFieldNames: branch.matchedFieldNames ?? analysis.matchedFieldNames,
                        matchedEnumValues: branch.matchedEnumValues ?? analysis.matchedEnumValues
                    };
                    branchStyles.push(preparedSearchAutoStyleRules(
                        branch.scope === "attribute" ? inventory : undefined,
                        branchAnalysis,
                        session.definition.pinColor,
                        {mapId: branch.mapId, layerId: branch.layerId, scope: branch.scope}
                    ));
                }
            }
            if (analysis.signature !== this.searchScopeAnalysisSignature(session.definition) || session.preparation !== preparation) return;
            // Compare every source before reducing owner filters. Equal
            // appearances share a rule; different scales keep the conditions
            // that distinguish where each one applies.
            const styles = combinePreparedSearchAutoStyles(branchStyles);
            // A unique attribute name already identifies its meaning. Keep the
            // user's shorthand (e.g. SPEED_LIMIT_METRIC); the prepared branch
            // supplies the concrete attribute-root predicate for execution.
            // Explicit ambiguity choices still write their distinguishing text.
            const query = meaning.kind === "attribute" && interpretations.size === 1 && !selected.length
                ? session.definition.query
                : meaning.query;
            const definition = {
                ...session.definition,
                query,
                interpretationIds: undefined,
                // A shorthand choice can narrow the initial map selection.
                // Once explicit, the query follows subsequent user selection
                // edits, including maps where a field is currently absent.
                selectedMapLayers: meaning.query !== session.definition.query
                    ? uniqueFeatureSearchMapLayers(meaning.branches)
                    : session.definition.selectedMapLayers,
                ...(automatic ? {searchStyleRules: styles} : {})
            };
            const resolvedSignature = this.searchScopeAnalysisSignature(definition);
            if (definition.searchStyleRules.length > 50)
                throw new Error("This selection requires more than 50 distinct style rules. Narrow the selected layers or supply explicit styles.");
            preparation.initialStyles = definition.searchStyleRules;
            preparation.status = "ready";
            preparation.signature = resolvedSignature;
            // Commit definition, initial styling and resolved membership as one
            // activation. No first request can race the style component.
            this.resetSessionSearch(session, definition);
            // Preparation clears the previous run. Start its replacement's
            // clock before publishing state can dispatch any result requests;
            // leaving startTime at zero reports time since the Unix epoch.
            this.resetServerSearchProgress(session, 0);
            session.preparation = preparation;
            const scopes = preparation.branches.flatMap(branch => branch.attributeScopes);
            session.schemaAnalysis = {
                ...analysis,
                signature: resolvedSignature,
                status: "ready",
                rewriteSuppressed: false,
                rewriteSuppressionReason: "",
                concreteScope: preparation.branches.every(branch => branch.scope === "attribute") ? "attribute" : "feature",
                normalizedQuery: [...new Set(preparation.branches.map(branch => branch.query))].join(" or "),
                attributeScopes: scopes,
                attributeScopeCandidateCount: scopes.length,
                matchedFeatureTypes: [...new Set(preparation.branches.flatMap(branch => branch.featureTypes))]
            };
            session.definition = definition;
            // Publish the effective scope with its chosen meaning. The map
            // selector and persisted state must describe what is being run,
            // including when a sole interpretation was selected automatically.
            this.state.patchFeatureSearch(session.id, {
                query: definition.query,
                interpretationIds: definition.interpretationIds,
                selectedMapLayers: definition.selectedMapLayers,
                ...(automatic ? {searchStyleRules: styles} : {})
            });
            this.progress.next(session);
            this.syncSearchRequestsToMapService({forceGenerationIds: [session.id]});
        } catch (error) {
            if (analysis.signature !== this.searchScopeAnalysisSignature(session.definition) || session.preparation !== preparation) return;
            preparation.status = analysis.waitingForSchema ? "waiting-for-schema" : "invalid";
            preparation.error = String(error);
            session.schemaAnalysis = {...session.schemaAnalysis, status: analysis.waitingForSchema ? "pending" : "error", error: String(error)};
            this.progress.next(session);
        }
    }

    /** Retry schema preparation after a reported metadata failure. */
    retrySearchPreparation(searchId: string): void {
        const session = this.requireSearchSession(searchId);
        session.preparation = undefined;
        session.schemaAnalysis = this.initialSchemaAnalysis(session.definition);
        this.syncSearchRequestsToMapService();
        this.progress.next(session);
    }

    /**
     * Accept one visible rewrite as ordinary query text. Its discovery ID is
     * not persisted: adding maps prepares the accepted expression afresh.
     */
    chooseSearchInterpretations(searchId: string, ids: string[]): void {
        const session = this.requireSearchSession(searchId);
        const available = session.preparation?.interpretations ?? [];
        const selected = ids.length === 1 ? available.find(candidate => candidate.id === ids[0]) : undefined;
        if (!selected)
            rejectAction("Choose exactly one of the available interpretations", "invalid_arguments");
        this.state.patchFeatureSearch(searchId, {
            query: selected.query,
            interpretationIds: undefined,
            selectedMapLayers: uniqueFeatureSearchMapLayers(selected.branches),
            selectedMapLayersManual: true
        });
    }

    /** Returns the schema-analysis identity used to guard resolved-definition reuse. */
    private searchScopeAnalysisSignature(definition: FeatureSearchStateEntry): string {
        return this.searchSchema.searchScopeAnalysisSignature(
            definition.query,
            definition.scope,
            definition.selectedMapLayers
        ) + "\n" + JSON.stringify(definition.interpretationIds ?? []) + "\n" + JSON.stringify(definition.selectedFeatureTypes);
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
        session: RuntimeSearchSession,
        selectedMapLayers: FeatureSearchMapLayerRef[]
    ): boolean {
        const normalizedLayers = uniqueFeatureSearchMapLayers(selectedMapLayers);
        if (this.sameSelectedMapLayers(session.definition.selectedMapLayers, normalizedLayers)) {
            return false;
        }
        if (
            this.state.patchFeatureSearch(session.id, {
                selectedMapLayers: normalizedLayers,
                selectedMapLayersManual: false
            })
        ) {
            return true;
        }

        const nextDefinition = {
            ...session.definition,
            selectedMapLayers: normalizedLayers,
            selectedMapLayersManual: false
        };
        this.resetSessionSearch(session, nextDefinition);
        this.progress.next(session);
        this.syncSearchRequestsToMapService({ forceGenerationIds: [session.id] });
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
    private updateDiagnosticsForCompletedSearch(session: RuntimeSearchSession): void {
        const messages = coreLib.simfilGetDiagnostics(
            session.definition.query,
            Array.from(session.results.diagnosticsBlobs)
        );
        const executionMessages = Array.isArray(messages) ? messages : [];
        session.results.diagnostics = executionMessages.slice(0, this.diagnosticsMessageLimit);
        this.progress.next(session);
    }

    /** Computes native per-tile value summaries and merges them across the current session. */
    private async computeValueSummariesAsync(sessionId: string, revision: number): Promise<void> {
        const session = this.getInternalSession(sessionId);
        if (!session || session.results.valueSummaryRevision !== revision) {
            return;
        }

        const contributions = Array.from(session.results.searchResultTilesBySourceKey.values())
            .filter(contribution => contribution.layerBlob.length > 0)
            .sort((lhs, rhs) => session.results.compareSearchResultTileContributions(lhs, rhs));
        const resultFieldsByKey = new Map<string, SearchResultFieldValueSummary>();
        const tracesByName = new Map<string, SearchTraceValueSummary>();
        const errors: string[] = [];
        let processedTiles = 0;

        for (const contribution of contributions) {
            const currentSession = this.getInternalSession(sessionId);
            if (!currentSession || currentSession.results.valueSummaryRevision !== revision) {
                return;
            }

            try {
                const tileSummary = this.valueSummariesForContribution(contribution, session.results);
                if (tileSummary) {
                    session.results.mergeTileValueSummaries(resultFieldsByKey, tracesByName, tileSummary);
                }
            } catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
            }

            processedTiles += 1;
            if (processedTiles % SearchService.VALUE_SUMMARY_TILE_BATCH_SIZE === 0) {
                currentSession.results.valueSummaries = {
                    ...currentSession.results.valueSummaries,
                    status: "loading",
                    processedTiles,
                    totalTiles: contributions.length
                };
                this.progress.next(currentSession);
                await this.nextAnimationFrame();
            }
        }

        const finalSession = this.getInternalSession(sessionId);
        if (!finalSession || finalSession.results.valueSummaryRevision !== revision) {
            return;
        }

        const resultFields = Array.from(resultFieldsByKey.values())
            .sort((lhs, rhs) => lhs.index - rhs.index || lhs.expression.localeCompare(rhs.expression))
            .map(item => ({ ...item, summary: session.results.finalizeValueSummary(item.summary) }));
        const traces = Array.from(tracesByName.values())
            .sort((lhs, rhs) => lhs.name.localeCompare(rhs.name))
            .map(item => ({ ...item, summary: session.results.finalizeValueSummary(item.summary) }));
        const hasValues = resultFields.length > 0 || traces.length > 0;
        finalSession.results.valueSummaries = {
            status: hasValues ? "ready" : (errors.length > 0 ? "error" : "empty"),
            revision,
            processedTiles,
            totalTiles: contributions.length,
            resultFields,
            traces,
            ...(errors.length > 0 ? { error: errors.slice(0, 3).join("\n") } : {})
        };
        this.progress.next(finalSession);
    }

    /** Defers the next chunk of summary work until the browser has had a chance to paint. */
    private nextAnimationFrame(): Promise<void> {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    /** Returns the cached native summary for one contribution, reparsing the ModelPool blob on first use. */
    private valueSummariesForContribution(contribution: SearchResultTileContribution, results: SearchResults): SearchTileValueSummaries | null {
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
                // Rendering channels may have no fields (an unfinished category
                // scale), or only a subset. Sample the same channel as the list.
                contribution.resultChannelOrdinal,
                SearchResults.VALUE_SUMMARY_HISTOGRAM_LIMIT,
                SearchResults.VALUE_SUMMARY_DISTINCT_LIMIT
            );
            contribution.valueSummary = results.normalizeTileValueSummaries(rawSummaries);
            return contribution.valueSummary;
        } finally {
            subsetLayer.delete();
        }
    }

    /** Routes one directly owned search subset into list ingestion and progress. */
    private handleSearchStyledLayerEvent(
        presentation: SearchPresentation,
        event: StyledMapgetLayerEvent
    ): void {
        const session = this.getInternalSession(presentation.sessionId);
        if (!session) {
            return;
        }
        if (event.type === "generation") {
            session.results.clearFilterSearchProgress(presentation.styledLayer.filterRef.filterId);
            session.results.backendComplete = false;
            session.results.complete = false;
            this.applySearchCoverageSnapshot(session.id);
            return;
        }
        if (event.type === "status") {
            this.applyFilterSearchStatus(presentation, event.status);
            return;
        }
        if (event.type === "error") {
            session.results.errors.add(event.message);
            this.progress.next(session);
            return;
        }
        if (event.type === "tiles-removed") {
            const removedTileKeys = new Set(
                event.states.map(state => state.mapTileKey)
            );
            this.subsetIngestionLoop.cancel(task =>
                task.presentationKey === presentation.key &&
                removedTileKeys.has(task.sourceTileKey)
            );
            for (const sourceTileKey of removedTileKeys) {
                this.removeServerSearchResultTile({
                    searchId: session.id,
                    sourceTileKey: `${presentation.key}\n${sourceTileKey}`
                });
            }
            this.applySearchCoverageSnapshot(session.id);
            return;
        }
        if (event.type === "tiles-pending") {
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
            session.results.errors.add(
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
        const spatialTileId = this.searchSpatialTileId(presentation, state);
        if (spatialTileId === null) {
            session.results.errors.add(
                `Search object '${state.mapTileKey}' has no discovery tile.`
            );
            this.progress.next(session);
            return;
        }
        const requestOrder =
            presentation.coverageOrder.get(state.partitionKey)
            ?? Number.MAX_SAFE_INTEGER;
        const payloadBase: SearchResultTilePayload = {
            searchId: session.id,
            presentationKey: presentation.key,
            refresh: session.refresh,
            mapId: state.mapId,
            layerId: state.layerId,
            tileId: spatialTileId,
            sourceTileKey: state.mapTileKey,
            sourceMapId: state.mapId,
            sourceLayerId: state.layerId,
            sourceTileId: spatialTileId,
            requestOrder,
            resultCount,
            resultChannelOrdinal: presentation.compiled.resultChannelOrdinal,
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
                runId: session.runId,
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
        if (!presentation || !session || task.runId !== session.runId || !subsetBlob ||
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
            session.results.errors.add(
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
                            : []
                    ),
                    valueErrors: entry.valueErrors?.flatMap(error => {
                        const expressionIndex = task.projectedFieldIndices.indexOf(error.expressionIndex);
                        return expressionIndex < 0 ? [] : [{ ...error, expressionIndex }];
                    })
                };
            });
        } finally {
            subset.delete();
        }
        const batchOffset = task.offset;
        task.offset += limit;
        const spatialTileId = this.searchSpatialTileId(
            presentation,
            task.state
        );
        if (spatialTileId === null) {
            return true;
        }
        this.addServerSearchResultTile({
            searchId: session.id,
            presentationKey: presentation.key,
            refresh: session.refresh,
            mapId: task.state.mapId,
            layerId: task.state.layerId,
            tileId: spatialTileId,
            sourceTileKey: task.sourceTileKey,
            sourceMapId: task.state.mapId,
            sourceLayerId: task.state.layerId,
            sourceTileId: spatialTileId,
            requestOrder:
                presentation.coverageOrder.get(task.state.partitionKey)
                ?? Number.MAX_SAFE_INTEGER,
            resultCount: task.resultCount,
            resultChannelOrdinal: presentation.compiled.resultChannelOrdinal,
            resultFields: task.resultFields,
            layerBlob: subsetBlob,
            diagnostics: null,
            entries,
            entryOffset: batchOffset,
            entriesComplete: task.offset >= task.resultCount
        });
        return task.offset >= task.resultCount;
    }

    /** Spatial hint for density/marker fallback, never the object's identity. */
    private searchSpatialTileId(
        presentation: SearchPresentation,
        state: FilterTileState
    ): number | null {
        if (state.partition.kind === "tile") {
            return state.partition.id;
        }
        return presentation.spatialTileByPartition.get(state.partitionKey) ??
            null;
    }

    /** Aggregates interactive filter progress across a search's source layers. */
    private applyFilterSearchStatus(
        presentation: SearchPresentation,
        status: MapTileStreamFilterStatusPayload
    ): void {
        const session = this.getInternalSession(presentation.sessionId);
        if (!session ||
            status.generation !== presentation.styledLayer.generation) {
            return;
        }
        if (status.error) {
            session.results.errors.add(status.error);
        }
        const terminal =
            status.state === "Success" ||
            status.state === "Failed" ||
            status.state === "Aborted";
        const queued = SearchResults.nonNegativeNumber(
            status.outputTilesRequested,
            presentation.styledLayer.tileStates.size
        );
        const emitted = SearchResults.nonNegativeNumber(
            status.outputTilesEmitted,
            0
        );
        const key = [
            status.filterId,
            status.generation
        ].join("\n");
        session.results.progressByRequestKey.set(key, {
            tilesQueued: queued,
            tilesSearched: terminal ? queued : Math.min(queued, emitted),
            chunksEmitted: emitted,
            chunksReported: true,
            matches: SearchResults.nonNegativeNumber(status.entriesEmitted, 0),
            terminal
        });
        const progressEntries = [...session.results.progressByRequestKey.values()];
        const total = progressEntries.reduce(
            (sum, item) => sum + item.tilesQueued,
            0
        );
        const done = progressEntries.reduce(
            (sum, item) => sum + item.tilesSearched,
            0
        );
        session.results.progressTotal = Math.max(1, total);
        session.results.progressDone = Math.min(session.results.progressTotal, done);
        session.results.backendComplete =
            session.paused ||
            (progressEntries.length > 0 &&
                progressEntries.every(item => item.terminal));
        session.results.totalFeatureCount = progressEntries.reduce(
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
        const contributionKey = payload.presentationKey ? `${payload.presentationKey}\n${sourceTileKey}` : sourceTileKey;
        const sourceMapLayerIds = this.parseMapLayerIds(sourceTileKey);
        const fallbackTileCenter = payload.entries.some(entry => !entry.position)
            ? coreLib.getTilePosition(payload.sourceTileId)
            : null;
        for (const entry of payload.entries) {
            const { mapId, layerId } = entry.mapTileKey === sourceTileKey
                ? sourceMapLayerIds
                : this.parseMapLayerIds(entry.mapTileKey);
            const resultIndex = this.entryResultIndex(entry, results.length);
            const resultKey = this.searchResultEntryKey(contributionKey, entry.mapTileKey, resultIndex);
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
                ...(this.hasFiniteIndex(entry.attributeIndex) ? { attributeIndex: Math.floor(entry.attributeIndex) } : {}),
                ...(this.hasFiniteIndex(entry.validityIndex) ? { validityIndex: Math.floor(entry.validityIndex) } : {}),
                ...(this.hasFiniteIndex(entry.validityCount) ? { validityCount: Math.floor(entry.validityCount) } : {})
            });
        }

        const contribution: SearchResultTileContribution = {
            refresh,
            sourceTileKey: contributionKey,
            sourceMapId: payload.sourceMapId,
            sourceLayerId: payload.sourceLayerId,
            sourceTileId: payload.sourceTileId,
            requestOrder: SearchResults.nonNegativeNumber(payload.requestOrder, Number.MAX_SAFE_INTEGER),
            resultCount: payload.resultCount,
            resultChannelOrdinal: payload.resultChannelOrdinal,
            resultFields,
            results,
            diagnostics: payload.diagnostics,
            layerBlob: payload.layerBlob,
            valueSummary: null,
            points
        };
        const outcome = session.results.add(session.runId, contribution,
            payload.entryOffset !== undefined, Boolean(payload.entriesComplete));
        if (outcome === "ignored") return;
        const emitProgressNow = outcome !== "replaced" && payload.entryOffset === undefined;
        if (outcome === "replaced") this.scheduleSessionResultDataRebuild(session);
        session.results.applyProgressSnapshot(payload.tilesConsidered, payload.tilesCompleted);
        const becameComplete = this.updateSessionCompletion(session);

        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        if (becameComplete) {
            this.updateDiagnosticsForCompletedSearch(session);
        }
        if (emitProgressNow) this.progress.next(session);
        else this.scheduleProgressEmission(session);
    }
    /** Removes one source tile and coalesces the resulting list rebuild. */
    private removeServerSearchResultTile(payload: {searchId: string; sourceTileKey: string}): void {
        const session = this.getInternalSession(payload.searchId);
        if (!session || !session.results.remove(session.runId, payload.sourceTileKey)) return;
        this.updateSessionCompletion(session);
        this.scheduleSessionResultDataRebuild(session);
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

    /**
     * Count the outputs this search currently needs, not the backend's history
     * of emitted chunks. Moving the viewport or replacing a tile can emit the
     * same partition again; those frames are not additional results to await.
     * A received header is insufficient: its current rows must also have
     * finished entering the result list before the search is complete.
     */
    private updateSearchResultIngressProgress(session: RuntimeSearchSession): void {
        let total = 0;
        let done = 0;
        for (const presentation of this.searchPresentations.values()) {
            if (presentation.sessionId !== session.id) continue;
            for (const state of presentation.styledLayer.tileStates.values()) {
                ++total;
                const contribution = session.results.searchResultTilesBySourceKey.get(presentation.key ? `${presentation.key}\n${state.mapTileKey}` : state.mapTileKey);
                if (!state.backendPending &&
                    state.deliveredGeneration === presentation.styledLayer.generation &&
                    contribution && contribution.layerBlob === state.subsetBlob &&
                    contribution.results.length === contribution.resultCount) {
                    ++done;
                }
            }
        }
        session.results.updateSearchResultIngressProgress(total, done);
    }
    /** Refresh current presentation ingress before asking the result owner whether its run is complete. */
    private updateSessionCompletion(session: RuntimeSearchSession): boolean {
        this.updateSearchResultIngressProgress(session);
        return session.results.updateSessionCompletion(session.paused);
    }



    /** Schedules one result-data rebuild after a burst of source-tile replacement or eviction events. */
    private scheduleSessionResultDataRebuild(session: RuntimeSearchSession): void {
        session.results.rebuildPending = true;
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
            session.results.rebuildSessionResultData();
            if (this.updateSessionCompletion(session)) {
                this.updateDiagnosticsForCompletedSearch(session);
            }
            this.progress.next(session);
        }
    }

    /** Returns one internal live session by runtime id. */
    private getInternalSession(id: string): RuntimeSearchSession | undefined {
        return this.searchSessions.find(session => session.id === id);
    }

    /** Emits a shallow session snapshot so structural UI can re-render. */
    private notifySessionsChanged(): void {
        this.sessionsChanged.next([...this.searchSessions]);
    }

    /** Coalesces high-frequency streamed-result mutations into at most one Angular emission per frame. */
    private scheduleProgressEmission(session: RuntimeSearchSession): void {
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

    /** Updates one session's configured marker color and refreshes dependent map overlays. */
    private updateSessionColor(session: RuntimeSearchSession, color: string): void {
        const normalizedColor = this.normalizeHexColor(color);
        session.pointColor = normalizedColor;
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
    private parseMapLayerIds(mapTileKey: string): { mapId: string; layerId: string } {
        try {
            const [mapId, layerId] = coreLib.parseMapTileKey(mapTileKey);
            return { mapId: String(mapId), layerId: String(layerId) };
        } catch (_error) {
            const [mapId = "", layerId = ""] = mapTileKey.split("/");
            return { mapId, layerId };
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
        const results = entry.values[fieldIndex];
        if (!Array.isArray(results) || results.length !== 1) {
            return "";
        }
        const value = results[0];
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
        fallbackTileCenter: { x: number; y: number; z: number } | null
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
    /** Registers semantic operations and their live omnibar candidates. */
    registerActions(actions: AppActionRegistration): void {
        const observed = { observedAt: z.string() };

        const appliedSchema = z.strictObject({ status: z.literal("applied"), changed: z.boolean() });

        const resultsInput = {
            searchId: identifierSchema,
            offset: count.optional(),
            limit: z.number().int().min(1).max(100).optional(),
            runId: identifierSchema.optional(),
            refresh: count.optional()
        };

        actions.registerAction(
            {
                name: "search_feature_input",
                exposure: "omnibar",
                mutation: true,
                description:
                    "Run a Simfil expression using the current visible layers or a chosen completion scope.",
                inputSchema: z.strictObject({
                    query: boundedUnicodeString(4096, true),
                    payload: z.unknown().optional()
                }),
                outputSchema: z.strictObject({ status: z.literal("applied"), changed: z.boolean() })
            },
            (input) => {
                this.runFromActionPayload(input.query, input.payload);
                return applied();
            },
            (query, history) => this.searchInputCandidates(query, history?.payload)
        );
        actions.registerAction(
            {
                name: "viewer_start_search",
                description:
                    "Start an ordinary visible simfil search with explicit layers/views and bounded viewport " +
                    "coverage. Auto-update defaults to false. Returns searchId while browser preparation resolves schema " +
                    "meaning and initial styling. Read viewer_get_search.preparation: needs-choice requires " +
                    "viewer_choose_search_interpretations before any backend search runs. For ad-hoc labels, highlighting or " +
                    "colors from actual data fields, configure searchStyleRules with viewer_set_search; stock style " +
                    "toggles are not required. Cancelling this completed call does not stop the search. Use " +
                    "viewer_control_search for lifecycle control.",
                mutation: true,
                inputSchema: z.strictObject({
                    query: boundedUnicodeString(4096, true),
                    scope: z.enum(["auto", "feature", "attribute"]).optional(),
                    interpretationIds: z.array(identifierSchema).length(1).optional(),
                    mapLayers: z.array(mapLayerSchema).min(1).max(100),
                    viewIds: z.array(viewIdSchema).min(1).max(32),
                    tileLevels: z.array(z.number().int().min(0).max(15)).max(16).optional(),
                    autoUpdate: z.boolean().optional()
                }),
                outputSchema: z.strictObject({ status: z.literal("applied"), searchId: identifierSchema })
            },
            (input) => this.startSearch(input)
        );
        actions.registerAction(
            {
                name: "viewer_choose_search_interpretations",
                description: "Choose exactly one meaning from viewer_get_search.preparation.interpretations. " +
                    "This accepts its query as editable, portable Simfil and updates Map Layers to its initial sources. " +
                    "Adding maps later prepares the same expression against their schemas. Initial styling finishes " +
                    "before dispatch. Interpretations cannot be combined.",
                mutation: true,
                inputSchema: z.strictObject({searchId: identifierSchema, interpretationIds: z.array(identifierSchema).length(1)}),
                outputSchema: appliedSchema
            },
            input => { this.chooseSearchInterpretations(input.searchId, input.interpretationIds); return applied(); }
        );
        actions.registerAction(
            {
                name: "viewer_control_search",
                description:
                    "Pause/resume/stop/close/rerun/refresh an existing search. Stop retains partial results; close " +
                    "removes its saved definition. Rerun requires query; refresh explicitly updates viewport " +
                    "coverage.",
                mutation: true,
                inputSchema: z.strictObject({
                    searchId: identifierSchema,
                    operation: z.enum(["pause", "resume", "stop", "close", "rerun", "refresh"]),
                    query: boundedUnicodeString(4096, true).optional()
                }),
                outputSchema: appliedSchema
            },
            (input) => this.controlSearch(input)
        );
        actions.registerAction(
            {
                name: "viewer_get_search",
                description:
                    "Read one search's settings, progress and schemaAnalysis (resolved scope, normalized query and " +
                    "rewrite diagnostics). resultCount counts matching contexts: features in feature scope, " +
                    "attribute/validity contexts in attribute scope. One assignment may have several matching " +
                    "validities. While schemaAnalysis.status=pending, no final result count is available. " +
                    "searchComplete=false means resultCount is provisional, even if responseComplete=true. Starting " +
                    "an asynchronous search is enough for an honestly reported applied visualization; claim final " +
                    "counts or no matches only when searchComplete=true and status.errors is empty.",
                mutation: false,
                inputSchema: z.strictObject({ searchId: identifierSchema }),
                outputSchema: z.strictObject({
                    ...observed,
                    responseComplete: z.boolean(),
                    searchComplete: z.boolean(),
                    preparation: z.object({
                        status: z.enum(["preparing", "waiting-for-schema", "needs-choice", "ready", "invalid"]),
                        error: text.optional(), activeQuery: text.optional(),
                        selectedIds: z.array(identifierSchema).max(1),
                        interpretations: z.array(z.object({id: identifierSchema, label: text, kind: text, query: text,
                            contexts: z.array(z.object({mapId: identifierSchema, layerId: identifierSchema,
                                scope: z.enum(["feature", "attribute"])}))}))
                    }),
                    reason: bounded.reason,
                    settings: searchSettingsSchema,
                    status: z.strictObject({
                        searchId: identifierSchema,
                        query: text,
                        runId: z.string(),
                        refresh: count,
                        complete: z.boolean(),
                        paused: z.boolean(),
                        resultCount: count,
                        progressDone: count,
                        progressTotal: count,
                        errors: z.array(text).max(100)
                    }),
                    schemaAnalysis: z.strictObject({
                        status: z.enum(["pending", "ready", "error"]),
                        concreteScope: z.enum(["feature", "attribute", "mixed"]),
                        normalizedQuery: boundedUnicodeString(4096),
                        rewriteSuppressed: z.boolean(),
                        rewriteSuppressionReason: boundedUnicodeString(1024),
                        error: boundedUnicodeString(4096).optional()
                    })
                })
            },
            (input) => this.getSearch(input)
        );
        actions.registerAction(
            {
                name: "viewer_set_search",
                description:
                    "Patch one search's settings: provide only changed fields; omitted fields stay unchanged. " +
                    "renderStrategy also merges by field; arrays such as searchStyleRules replace the whole array. " +
                    "To draw matching geometry instead of bubbles: keep showResultsOnMap=true, set " +
                    "renderStrategy.showHighFiGeometry=true, disable unwanted " +
                    "showHighFiResultDots/showLowFiDots/showBucketLabels, and choose a highFidelityMaxVisibleTiles " +
                    "threshold appropriate to the view. Hiding results does not draw matching geometry. " +
                    "autoUpdate=false freezes existing results. May rerun the query; retains searchId.",
                mutation: true,
                inputSchema: z.strictObject({
                    searchId: identifierSchema,
                    settings: searchSettingsSchema.partial().extend({
                        renderStrategy: searchSettingsSchema.shape.renderStrategy.partial().optional()
                    })
                }),
                outputSchema: appliedSchema
            },
            (input) => this.setSearch(input)
        );
        actions.registerAction(
            {
                name: "viewer_get_search_results",
                description:
                    "Read a bounded slice of an existing search's result identities. Attribute results include " +
                    "attributeIndex and validityIndex; multiple rows can belong to one assignment or feature. " +
                    "Optional runId/refresh guards reject stale slices. No new query or full-feature traversal.",
                mutation: false,
                inputSchema: z.strictObject(resultsInput),
                outputSchema: z.strictObject({
                    ...observed,
                    searchId: identifierSchema,
                    runId: z.string(),
                    refresh: count,
                    offset: count,
                    total: count,
                    searchComplete: z.boolean(),
                    results: z
                        .array(
                            z.strictObject({
                                label: text,
                                mapId: identifierSchema,
                                layerId: identifierSchema,
                                featureId: identifierSchema,
                                resultIndex: count,
                                resultKey: identifierSchema,
                                mapTileKey: identifierSchema,
                                sourceTileKey: identifierSchema,
                                sourceMapId: identifierSchema,
                                sourceLayerId: identifierSchema,
                                sourceTileId: z.number().int().min(-2147483648).max(2147483647),
                                hoverFeatureId: identifierSchema,
                                attributeIndex: count.optional(),
                                validityIndex: count.optional(),
                                validityCount: count.optional()
                            })
                        )
                        .max(100),
                    ...bounded
                })
            },
            (input) => this.searchResults(input)
        );
        actions.registerAction(
            {
                name: "viewer_export_search",
                description:
                    "Return bounded JSON search configuration/results as text, without browser download or " +
                    "clipboard access. Exported partial results are explicitly marked; use runId/refresh to guard " +
                    "slices.",
                mutation: false,
                inputSchema: z.strictObject({
                    ...resultsInput,
                    include: z.enum(["configuration", "results", "both"])
                }),
                outputSchema: z.strictObject({
                    ...observed,
                    ...bounded,
                    mimeType: z.literal("application/json"),
                    content: boundedUnicodeString(180000)
                })
            },
            (input) => this.exportSearch(input)
        );
    }

    /** Registers typed state readers and writers without exposing persistence keys. */
    registerControls(actions: AppActionRegistration): void {
        actions.registerControl(
            {
                name: "app.searches",
                description:
                    "Persisted search definitions, identity colors and live progress, including hidden and paused " +
                    "searches. Use pinColor to identify requests such as the blue search; individual geometry rules " +
                    "can use different colors. Never results or style rules.",
                selectorSchema: z.strictObject({ searchId: identifierSchema.optional() }),
                valueSchema: z
                    .array(
                        z.strictObject({
                            searchId: identifierSchema,
                            query: boundedUnicodeString(4096),
                            pinColor: colorSchema.describe(
                                "Search identity/pin color; individual geometry rules may override it."
                            ),
                            enabled: z.boolean(),
                            paused: z.boolean(),
                            autoUpdate: z.boolean(),
                            showResultsOnMap: z.boolean(),
                            runtime: z
                                .strictObject({
                                    complete: z.boolean(),
                                    progressDone: indexSchema,
                                    progressTotal: indexSchema,
                                    resultCount: indexSchema,
                                    errorCount: indexSchema
                                })
                                .optional()
                        })
                    )
                    .max(100),
                readable: true,
                writable: false,
                persistence: "runtime-summary",
                synchronization: "none"
            },
            {
                read: ({ searchId }, context) => this.searchSummary(searchId, context),
                defaultTargets: () => [{}]
            }
        );
    }

    /** Bounded definition/progress read; no search is restored or started by discovery. */
    searchSummary(searchId: string | undefined, context: ControlReadContext) {
        const definitions = this.state.featureSearchState.value;
        if (searchId && !definitions.some((definition) => definition.id === searchId))
            rejectAction("The search no longer exists");
        const sessionFor = (id: string) => this.getSession(id);
        function* values() {
            for (const definition of definitions) {
                if (searchId && definition.id !== searchId) continue;
                const runtime = sessionFor(definition.id);
                yield {
                    searchId: definition.id,
                    query: context.text(definition.query),
                    pinColor: definition.pinColor,
                    enabled: definition.enabled,
                    paused: runtime?.paused ?? definition.paused,
                    autoUpdate: definition.autoUpdate,
                    showResultsOnMap: definition.showResultsOnMap,
                    ...(runtime
                        ? {
                              runtime: {
                                  complete: runtime.results.complete && runtime.schemaAnalysis.status !== "pending",
                                  progressDone: runtime.results.progressDone,
                                  progressTotal: runtime.results.progressTotal,
                                  resultCount: runtime.results.searchResults.length,
                                  errorCount:
                                      runtime.results.errors.size +
                                      (runtime.schemaAnalysis.status === "error" &&
                                      (!runtime.schemaAnalysis.error ||
                                          !runtime.results.errors.has(runtime.schemaAnalysis.error))
                                          ? 1
                                          : 0)
                              }
                          }
                        : {})
                };
            }
        }
        return context.collect(values());
    }

    /** Resolves an existing session without implicitly restoring, starting or analyzing a search. */
    requireSearchSession(searchId: string): FeatureSearchSession {
        const session = this.getSession(searchId);
        if (!session) rejectAction("The search has no active session");
        return session;
    }

    /** Validates all view/layer choices before publishing a search definition. */
    checkSearchTargets(mapLayers: Array<{ mapId: string; layerId: string }>, viewIds: string[]): void {
        for (const id of viewIds) this.viewState.requireViewIndex(id);
        for (const target of mapLayers) {
            const layer = this.mapInfo.requireLayer(target.mapId, target.layerId);
            if (layer.type === "SourceData" || !this.mapInfo.isMapLayerReady(target.mapId, target.layerId)) rejectAction("Search layers must be ready feature layers");
        }
    }

    /** Starts one visible ordinary search; configuration is complete before the first dispatch. */
    startSearch(input: {
        query: string;
        mapLayers: { mapId: string; layerId: string }[];
        viewIds: string[];
        scope?: "auto" | "feature" | "attribute";
        interpretationIds?: string[];
        tileLevels?: number[];
        autoUpdate?: boolean;
    }) {
        this.checkSearchTargets(input.mapLayers, input.viewIds);
        const session = this.run(input.query, {
            scope: input.scope,
            interpretationIds: input.interpretationIds,
            selectedMapLayers: input.mapLayers,
            selectedMapLayersManual: true,
            selectedViewIndices: input.viewIds.map((id) => this.viewState.requireViewIndex(id)),
            autoUpdate: input.autoUpdate ?? false,
            selectedTileLevels: input.tileLevels ?? []
        });
        return { status: "applied" as const, searchId: session.id };
    }

    /** Delegates lifecycle transitions to the search owner; Stop and Close intentionally differ. */
    controlSearch(input: {
        searchId: string;
        operation: "pause" | "resume" | "stop" | "close" | "rerun" | "refresh";
        query?: string;
    }) {
        const session = this.requireSearchSession(input.searchId);
        if ((input.operation === "rerun") !== (input.query !== undefined))
            rejectAction("Only rerun accepts and requires query", "invalid_arguments");
        if (input.operation !== "close" && !session.definition.enabled)
            rejectAction("Enable the search before controlling its runtime");
        if (
            (input.operation === "pause" && session.paused) ||
            (input.operation === "resume" && !session.paused)
        )
            return applied(false);
        switch (input.operation) {
            case "pause":
                this.pauseSearch(input.searchId);
                break;
            case "resume":
                this.resumeSearch(input.searchId);
                break;
            case "stop":
                this.stopSearch(input.searchId);
                break;
            case "close":
                this.closeSearch(input.searchId);
                break;
            case "rerun":
                this.rerunSearch(input.searchId, input.query!);
                break;
            case "refresh":
                this.updateSearchInArea(input.searchId);
                break;
        }
        return applied();
    }

    /** Reads persisted settings, resolved query semantics and bounded errors without schema trees. */
    getSearch(input: { searchId: string }) {
        const session = this.requireSearchSession(input.searchId);
        const {
            id: _id,
            query: _query,
            paused: _paused,
            selectedMapLayersManual: _manual,
            selectedViewIndices,
            ...settings
        } = featureSearchDefinitionExport(session.definition);
        let textOmitted = false;
        const analysis = session.schemaAnalysis;
        const boundedText = (value: string, limit: number) => {
            const bounded = unicodePrefix(value, limit);
            textOmitted ||= bounded !== value;
            return bounded;
        };
        const schemaAnalysis = {
            status: analysis.status,
            concreteScope: new Set(session.preparation?.branches.map(branch => branch.scope)).size > 1
                ? "mixed" as const : analysis.concreteScope,
            normalizedQuery: boundedText(analysis.normalizedQuery, 4096),
            rewriteSuppressed: analysis.rewriteSuppressed,
            rewriteSuppressionReason: boundedText(analysis.rewriteSuppressionReason, 1024),
            ...(analysis.error ? { error: boundedText(analysis.error, 4096) } : {})
        };
        const reportedErrors = new Set(session.results.errors);
        if (analysis.error) reportedErrors.add(analysis.error);
        if (analysis.status === "error" && !analysis.error)
            reportedErrors.add("Search schema analysis failed.");
        const candidates = function* () {
            for (const error of reportedErrors) {
                const message = unicodePrefix(error, 4096);
                textOmitted ||= message !== error;
                yield message;
            }
        };
        const errors = boundedCollection(candidates(), 100, 32000);
        const query = unicodePrefix(session.definition.query, 4096);
        textOmitted ||= query !== session.definition.query;
        const parsedSettings = searchSettingsSchema.safeParse({
            ...settings,
            selectedViewIds: selectedViewIndices.map((index) => this.viewSettings.viewIdAt(index))
        });
        if (!parsedSettings.success)
            rejectAction("Search settings exceed the public contract; narrow them in the UI first");
        // No submitted backend requests during pending analysis is not an empty completed search.
        const searchComplete = session.results.complete && analysis.status === "ready" && session.preparation?.status === "ready";
        return {
            observedAt: new Date().toISOString(),
            settings: parsedSettings.data,
            schemaAnalysis,
            responseComplete: errors.complete && !textOmitted,
            searchComplete,
            preparation: {
                status: session.preparation?.status ?? "preparing",
                error: session.preparation?.error,
                activeQuery: session.lastResolvedDefinition?.query,
                selectedIds: session.preparation?.selectedIds ?? [],
                interpretations: (session.preparation?.interpretations ?? []).map(meaning => ({
                    id: meaning.id, label: meaning.label, kind: meaning.kind, query: meaning.query,
                    contexts: meaning.branches.map(branch => ({mapId: branch.mapId, layerId: branch.layerId, scope: branch.scope}))
                }))
            },
            reason: errors.reason ?? (textOmitted ? ("text_limit" as const) : undefined),
            status: {
                searchId: session.id,
                query,
                runId: session.runId,
                refresh: session.refresh,
                complete: searchComplete,
                paused: session.paused,
                resultCount: session.results.searchResults.length,
                progressDone: session.results.progressDone,
                progressTotal: session.results.progressTotal,
                errors: errors.items
            }
        };
    }

    /** Merges a validated patch into one search, retaining unrelated fields and sibling searches. */
    setSearch(input: {
        searchId: string;
        settings: Partial<Omit<z.infer<typeof searchSettingsSchema>, "renderStrategy">> & {
            renderStrategy?: Partial<z.infer<typeof searchSettingsSchema>["renderStrategy"]>;
        };
    }) {
        const session = this.requireSearchSession(input.searchId);
        const current = this.getSearch({ searchId: input.searchId }).settings;
        const settings = searchSettingsSchema.parse({
            ...current,
            ...input.settings,
            renderStrategy: { ...current.renderStrategy, ...input.settings.renderStrategy }
        });
        this.checkSearchTargets(settings.selectedMapLayers, settings.selectedViewIds);
        const changed = !deepEquals(current, settings);
        const { selectedViewIds, interpretationIds, ...patch } = settings;
        if (changed)
            this.state.patchFeatureSearch(session.id, {
                ...patch,
                ...(Object.hasOwn(input.settings, "interpretationIds") ? {interpretationIds} : {}),
                selectedViewIndices: selectedViewIds.map((id) => this.viewState.requireViewIndex(id)),
                ...(input.settings.selectedMapLayers === undefined ? {} : { selectedMapLayersManual: true })
            });
        return applied(changed);
    }

    /** Reads a bounded result slice; generation guards make repeated exports fail visibly after a rerun. */
    searchResults(input: {
        searchId: string;
        offset?: number;
        limit?: number;
        runId?: string;
        refresh?: number;
    }) {
        const session = this.requireSearchSession(input.searchId);
        if (
            (input.runId !== undefined && input.runId !== session.runId) ||
            (input.refresh !== undefined && input.refresh !== session.refresh)
        ) {
            rejectAction(
                "The search results changed; read its status again",
                "not_available",
                "stale_search"
            );
        }
        const offset = input.offset ?? 0;
        let textOmitted = false;
        const source = function* () {
            for (let index = offset; index < session.results.searchResults.length; index++) {
                const entry = session.results.searchResults[index];
                const label = unicodePrefix(entry.label, 4096);
                textOmitted ||= label !== entry.label;
                yield { ...entry, label };
            }
        };
        const result = boundedCollection(source(), input.limit);
        const searchComplete = session.results.complete && session.schemaAnalysis.status === "ready" && session.preparation?.status === "ready";
        return {
            observedAt: new Date().toISOString(),
            searchId: session.id,
            runId: session.runId,
            refresh: session.refresh,
            offset,
            total: session.results.searchResults.length,
            searchComplete,
            results: result.items,
            complete: result.complete && searchComplete && !textOmitted,
            reason:
                result.reason ??
                (textOmitted ? ("text_limit" as const) : searchComplete ? undefined : ("loading" as const))
        };
    }

    /** Exports only the selected bounded slice, avoiding full result-tree construction and clipboard side effects. */
    exportSearch(input: {
        include: "results" | "configuration" | "both";
        searchId: string;
        offset?: number;
        limit?: number;
        runId?: string;
        refresh?: number;
    }) {
        const results = this.searchResults(input);
        const configuration =
            input.include === "results"
                ? undefined
                : {
                      ...this.getSearch({ searchId: input.searchId }).settings,
                      id: input.searchId,
                      query: this.requireSearchSession(input.searchId).definition.query,
                      paused: this.requireSearchSession(input.searchId).paused
                  };
        const payload = {
            exportedAt: new Date().toISOString(),
            searchId: input.searchId,
            configuration,
            results: input.include === "configuration" ? undefined : results
        };
        const content = JSON.stringify(payload);
        if (new TextEncoder().encode(content).length > 180000)
            rejectAction("Export exceeds the byte limit; request fewer results", "invalid_arguments");
        return {
            observedAt: payload.exportedAt,
            mimeType: "application/json" as const,
            content,
            complete: input.include === "configuration" || results.complete,
            reason: input.include === "configuration" ? undefined : results.reason
        };
    }

    /** Captures explicit view scopes before a new history entry can outlive its current layout. */
    actionPayloadForHistory(payload?: unknown): unknown {
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            const { selectedViewIndices: _legacyIndices, ...fields } = payload as Record<string, unknown>;
            const indices = featureSearchSelectedViewIndicesFromPayload(payload);
            payload = fields["selectedViewIds"] !== undefined || indices === undefined ? fields
                : { ...fields, selectedViewIds: indices.flatMap(index => this.viewSettings.viewIds[index] ? [this.viewSettings.viewIds[index]] : []) };
        }
        return payload;
    }

    /** The search owner validates the omnibar expression and resolves its explicit scope or hints. */
    private searchInputCandidates(
        query: string,
        payload?: unknown
    ): AppActionCandidate<{ query: string; payload?: unknown }>[] {
        if (!query.trim()) return [];
        // Keep an invalid draft visible with its native syntax explanation,
        // while other actions (for example coordinate jumps) remain usable.
        const error: string = coreLib.simfilQueryError(query);
        // Old positional history is migrated on first resolution; new entries capture IDs when saved.
        payload = this.actionPayloadForHistory(payload);
        return [
            {
                id: "features",
                icon: "pi-bolt",
                color: "blue",
                name: "Search Features and Attributes",
                label: "Match features with a filter expression",
                bubbles: error ? [{value: error, tone: "error"}] : [{name: "Filter", value: query}],
                enabled: !error,
                input: { query, payload },
                payload
            }
        ];
    }

}

/**
 * Search settings are validated both when a command is registered and when a
 * saved search is read or updated. Keep this shared shape here so those paths
 * agree on view scopes, style rules and rendering preferences.
 */
const text = boundedUnicodeString(4096);

const count = indexSchema;

const bounded = {
    complete: z.boolean(),
    reason: z.enum(["item_limit", "byte_limit", "text_limit", "loading"]).optional()
};

const mapLayerSchema = z.strictObject({ mapId: identifierSchema, layerId: identifierSchema });

/** Ordinary stops and named exceptions share the same bounded public color/value representation. */
const searchColorStopsSchema = z.array(z.strictObject({
    color: colorSchema,
    value: z.union([text, z.number(), z.boolean(), z.null()])
})).max(512);

const searchStyleRuleSchema = z.strictObject({
    name: text.optional(),
    autoGenerated: z.boolean().optional(),
    applicability: z.strictObject({mapId: identifierSchema.optional(), layerId: identifierSchema.optional(),
        scope: z.enum(["feature", "attribute"])}).optional(),
    geometry: z
        .array(z.enum(["any", "point", "line", "surface", "polygon", "mesh", "label"]))
        .min(1)
        .max(7),
    filter: z
        .array(
            z.strictObject({
                field: text,
                op: z.enum(["=", "==", "!=", "<", "<=", ">", ">=", "contains"]),
                value: z.union([text, z.number(), z.boolean(), z.null()]).optional(),
                customExpression: z.boolean().optional()
            })
        )
        .max(25),
    color: z.union([
        z.strictObject({ mode: z.literal("solid"), color: colorSchema }),
        z.strictObject({
            mode: z.enum(["gradient", "categories"]),
            field: text,
            customField: z.boolean().optional(),
            stops: searchColorStopsSchema,
            // Schema-generated numeric styles retain their exact meaning and
            // exceptional values when read or edited through MCP, just as in
            // the UI. Omitting these keys rejected ordinary speed gradients.
            schemaTypes: z.array(schemaTypeIdentitySchema.extend({schemaId: identifierSchema}).strict()).min(1).max(100).optional(),
            specials: searchColorStopsSchema.optional(),
            fallbackColor: colorSchema.optional()
        })
    ]),
    width: z.number().min(0).max(1000).optional(),
    pointRadius: z.number().min(0).max(1000).optional(),
    opacity: z.number().min(0).max(1).optional(),
    labelExpression: text.optional(),
    labelCustomExpression: z.boolean().optional(),
    labelBackgroundColor: colorSchema.optional()
});

const searchSettingsSchema = z.strictObject({
    interpretationIds: z.array(identifierSchema).length(1).optional(),
    scope: z.enum(["auto", "feature", "attribute"]),
    autoUpdate: z.boolean(),
    bookmarked: z.boolean(),
    enabled: z.boolean(),
    showResultsOnMap: z.boolean(),
    pinColor: colorSchema,
    selectedMapLayers: z.array(mapLayerSchema).max(100),
    selectedFeatureTypes: z.array(identifierSchema).max(100),
    selectedTileLevels: z.array(z.number().int().min(0).max(15)).max(16),
    selectedViewIds: z.array(viewIdSchema).max(32),
    searchStyleRules: z.array(searchStyleRuleSchema).max(50),
    renderStrategy: z.strictObject({
        showLowFiDots: z.boolean(),
        showBucketLabels: z.boolean(),
        showHighFiGeometry: z.boolean(),
        showHighFiResultDots: z.boolean(),
        highFidelityMaxVisibleTiles: z.number().int().min(1).max(65536),
        densityHeatGradient: z.boolean(),
        densitySizeMultiplier: z.number().min(0.5).max(3)
    })
});
