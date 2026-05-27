import {Injectable} from "@angular/core";
import {BehaviorSubject, filter, Subject, take} from "rxjs";
import {
    FeatureSearchDataPlaneRequest,
    MapDataService,
    SearchResultTileEntry,
    SearchResultTileEvictedPayload,
    SearchResultTilePayload
} from "../mapdata/map.service";
import {CompletionCandidate, DiagnosticsMessage, TraceResult} from "./search.model";
import {GeoMath} from "../integrations/geo";
import {coreLib} from "../integrations/wasm";
import {AppStateService, FEATURE_SEARCH_DIALOG_LAYOUT_ID, SEARCH_DOCK_TAB_ID} from "../shared/appstate.service";
import {FeatureSearchStateEntry} from "../shared/feature-search-state";
import {MapTileStreamSearchStatusPayload} from "../mapdata/tilestream";

/**
 * Flat marker datum exposed to the deck overlay that visualizes search results.
 */
export interface SearchResultPoint {
    coordinates: [number, number];
    mapId: string;
    layerId: string;
    tileId: bigint;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: bigint;
    featureId: string;
    featureKey: string;
}

export interface SearchResultPointBucket {
    sourceTileKey: string;
    mapId: string;
    layerId: string;
    tileId: bigint;
    points: SearchResultPoint[];
}

export interface SearchResultPinMarker {
    coordinates: [number, number];
    count: number;
    mapId: string;
    layerId: string;
    tileId: bigint;
    featureId: string;
    featureKey: string;
    featureKeys: string[];
}

export interface SearchResultPinMaterializationRequest {
    sourceTileKeys: Iterable<string>;
    targetLevel: number;
}

export interface FeatureSearchResultEntry {
    label: string;
    mapId: string;
    layerId: string;
    featureId: string;
}

export interface FeatureSearchSession {
    id: string;
    layoutId: string;
    definition: FeatureSearchStateEntry;
    runId: string;
    refresh: number;
    updateSerial: number;
    generationSerial: number;
    paused: boolean;
    progressDone: number;
    progressTotal: number;
    complete: boolean;
    startTime: number;
    endTime: number;
    pointColor: string;
    clusterIconAtlasUrl: string;
    timeElapsed: string;
    totalFeatureCount: number;
    searchResults: FeatureSearchResultEntry[];
    traceResults: TraceResult[];
    diagnostics: DiagnosticsMessage[];
    diagnosticsBlobs: Uint8Array[];
    errors: Set<string>;
    progressByRequestKey: Map<string, SearchRequestProgress>;
    searchResultTilesBySourceKey: Map<string, SearchResultTileContribution>;
    searchResultPointsByFeatureKey: Map<string, SearchResultPoint>;
    searchResultPointsCache: SearchResultPoint[];
    searchResultPointBucketsCache: SearchResultPointBucket[];
    searchResultPointsCacheDirty: boolean;
    searchResultPointsVersion: number;
    searchResultPinIndex: SearchResultPinIndex;
}

interface SearchRequestProgress {
    tilesQueued: number;
    tilesSearched: number;
    matches: number;
    terminal: boolean;
}

interface SearchResultTileContribution {
    refresh: number;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: bigint;
    resultCount: number;
    results: FeatureSearchResultEntry[];
    traceResults: TraceResult[];
    diagnostics: Uint8Array | null;
    points: SearchResultPoint[];
}

export interface FeatureSearchResultLayer {
    id: string;
    pointsVersion: number;
    iconAtlasUrl: string;
    iconMappingUrl: string;
    points: SearchResultPoint[];
    pointBuckets: SearchResultPointBucket[];
    pinIndex: SearchResultPinIndex;
}

export interface CompletionOwnerState {
    candidates: BehaviorSubject<CompletionCandidate[]>;
    candidateList: CompletionCandidate[];
}

interface SearchResultPinNodeDelta {
    key: string;
    mapId: string;
    layerId: string;
    tileId: bigint;
    level: number;
    count: number;
    lonSum: number;
    latSum: number;
    samples: SearchResultPoint[];
}

interface SearchResultPinContribution {
    maxLevel: number;
    deltasByLevel: Map<number, Map<string, SearchResultPinNodeDelta>>;
}

/**
 * Stores low-fidelity search pins as per-source-tile mapget-tile deltas.
 *
 * The index deliberately avoids a global spatial clustering rebuild. Result-tile eviction only removes the matching
 * contribution; each view materializes visible source-tile keys into already aggregated markers.
 */
export class SearchResultPinIndex {
    private static readonly MAX_SAMPLE_FEATURES = 25;
    private readonly contributionsBySourceTileKey = new Map<string, SearchResultPinContribution>();

    /** Returns whether the index currently has no source-tile contributions. */
    get isEmpty(): boolean {
        return this.contributionsBySourceTileKey.size === 0;
    }

    /** Replaces one source-tile contribution with tile-level marker deltas. */
    addContribution(sourceTileKey: string, points: readonly SearchResultPoint[]): void {
        if (!points.length) {
            this.contributionsBySourceTileKey.delete(sourceTileKey);
            return;
        }

        const contribution: SearchResultPinContribution = {
            maxLevel: 0,
            deltasByLevel: new Map<number, Map<string, SearchResultPinNodeDelta>>()
        };
        for (const point of points) {
            this.addPointToContribution(contribution, point);
        }
        this.contributionsBySourceTileKey.set(sourceTileKey, contribution);
    }

    /** Removes one source-tile contribution without touching unrelated result tiles. */
    removeContribution(sourceTileKey: string): boolean {
        return this.contributionsBySourceTileKey.delete(sourceTileKey);
    }

    /** Clears every indexed pin contribution for a full search refresh or session reset. */
    clear(): void {
        this.contributionsBySourceTileKey.clear();
    }

    /** Materializes visible source-tile contributions into tile-aggregated pin markers for one deck view. */
    materialize(request: SearchResultPinMaterializationRequest): SearchResultPinMarker[] {
        const requestedLevel = Math.max(0, Math.floor(request.targetLevel));
        const mergedDeltas = new Map<string, SearchResultPinNodeDelta>();
        for (const sourceTileKey of request.sourceTileKeys) {
            const contribution = this.contributionsBySourceTileKey.get(sourceTileKey);
            if (!contribution) {
                continue;
            }
            const effectiveLevel = Math.min(requestedLevel, contribution.maxLevel);
            const deltasForLevel = contribution.deltasByLevel.get(effectiveLevel);
            if (!deltasForLevel) {
                continue;
            }
            for (const delta of deltasForLevel.values()) {
                this.mergeMaterializedDelta(mergedDeltas, delta);
            }
        }

        return Array.from(mergedDeltas.values())
            .filter(delta => delta.count > 0 && delta.samples.length > 0)
            .map(delta => this.markerFromDelta(delta))
            .sort((lhs, rhs) => {
                if (lhs.tileId === rhs.tileId) {
                    return lhs.featureKey.localeCompare(rhs.featureKey);
                }
                return lhs.tileId < rhs.tileId ? -1 : 1;
            });
    }

    /** Adds one point to every ancestor tile delta used for later view-level materialization. */
    private addPointToContribution(contribution: SearchResultPinContribution, point: SearchResultPoint): void {
        let tileId = point.sourceTileId;
        let level = Number(coreLib.getTileLevel(tileId));
        contribution.maxLevel = Math.max(contribution.maxLevel, level);

        while (level >= 0) {
            let deltasForLevel = contribution.deltasByLevel.get(level);
            if (!deltasForLevel) {
                deltasForLevel = new Map<string, SearchResultPinNodeDelta>();
                contribution.deltasByLevel.set(level, deltasForLevel);
            }

            const nodeKey = `${point.sourceMapId}\n${point.sourceLayerId}\n${tileId.toString()}`;
            let delta = deltasForLevel.get(nodeKey);
            if (!delta) {
                delta = {
                    key: nodeKey,
                    mapId: point.sourceMapId,
                    layerId: point.sourceLayerId,
                    tileId,
                    level,
                    count: 0,
                    lonSum: 0,
                    latSum: 0,
                    samples: []
                };
                deltasForLevel.set(nodeKey, delta);
            }
            this.addPointToDelta(delta, point);
            if (level === 0) {
                break;
            }
            tileId = this.parentTileId(tileId, level);
            level -= 1;
        }
    }

    /** Accumulates point counts, average-position sums, and a bounded inspection sample. */
    private addPointToDelta(delta: SearchResultPinNodeDelta, point: SearchResultPoint): void {
        delta.count += 1;
        delta.lonSum += point.coordinates[0];
        delta.latSum += point.coordinates[1];
        if (delta.samples.length < SearchResultPinIndex.MAX_SAMPLE_FEATURES) {
            // Samples are intentionally bounded because materialized aggregate markers may cover many result features.
            delta.samples.push(point);
        }
    }

    /** Merges one pre-aggregated source-tile delta into the visible-view result set. */
    private mergeMaterializedDelta(
        mergedDeltas: Map<string, SearchResultPinNodeDelta>,
        delta: SearchResultPinNodeDelta
    ): void {
        const existing = mergedDeltas.get(delta.key);
        if (!existing) {
            mergedDeltas.set(delta.key, {
                ...delta,
                samples: [...delta.samples]
            });
            return;
        }

        existing.count += delta.count;
        existing.lonSum += delta.lonSum;
        existing.latSum += delta.latSum;
        for (const sample of delta.samples) {
            if (existing.samples.length >= SearchResultPinIndex.MAX_SAMPLE_FEATURES) {
                break;
            }
            existing.samples.push(sample);
        }
    }

    /** Converts the internal aggregate delta into the flat marker object consumed by Deck. */
    private markerFromDelta(delta: SearchResultPinNodeDelta): SearchResultPinMarker {
        const representative = delta.samples[0];
        return {
            coordinates: [delta.lonSum / delta.count, delta.latSum / delta.count],
            count: delta.count,
            mapId: representative.mapId,
            layerId: representative.layerId,
            tileId: delta.tileId,
            featureId: representative.featureId,
            featureKey: representative.featureKey,
            featureKeys: delta.samples.map(sample => sample.featureKey)
        };
    }

    /** Computes the parent id for a mapget tile id at a known non-root level. */
    private parentTileId(tileId: bigint, level: number): bigint {
        const x = tileId >> 32n;
        const y = (tileId >> 16n) & 0xffffn;
        const parentLevel = BigInt(level - 1);
        return ((x >> 1n) << 32n) | ((y >> 1n) << 16n) | parentLevel;
    }
}

@Injectable({providedIn: 'root'})
/**
 * Coordinates feature search, query completion, result indexing, and search-marker overlays.
 *
 * Search execution is delegated to mapget; this service keeps server progress and UI-friendly result caches in sync.
 */
export class FeatureSearchService {
    private static readonly SEARCH_ICON_ATLAS_URL = "/bundle/images/search/location-icon-atlas.png";
    private static readonly SEARCH_ICON_MAPPING_URL = "/bundle/images/search/location-icon-mapping.json";
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

    static layoutIdForSearch(searchId: string): string {
        return `${FEATURE_SEARCH_DIALOG_LAYOUT_ID}:${searchId}`;
    }

    private searchRunCounter = 0;
    private searchSessionCounter = 0;

    readonly sessionsChanged = new BehaviorSubject<FeatureSearchSession[]>([]);
    readonly progress: BehaviorSubject<FeatureSearchSession|null> = new BehaviorSubject<FeatureSearchSession|null>(null);
    diagnosticsMessageLimit: number = 25;

    private readonly completionStates = new Map<string, CompletionOwnerState>();
    readonly completionCandidates = this.completionStateForOwner(FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID).candidates;
    completionCandidateLimit: number = 15;

    showFeatureSearchDialog: boolean = false;

    private readonly searchSessions: FeatureSearchSession[] = [];
    private searchResultLayersVersionValue = 0;
    private tintedAtlasByColor = new Map<string, string>();
    private baseAtlasImagePromise: Promise<HTMLImageElement> | null = null;
    private locationMarkerGraphicUrl: string | null = null;
    private pendingResultDataRebuildSessionIds = new Set<string>();
    private resultDataRebuildRaf: number | null = null;

    public fixedDiagnosticsSearchQuery: Subject<string> = new Subject<string>();

    /**
     * Initializes marker styling and listens for staged tile updates that can unblock pending searches.
     */
    constructor(private mapService: MapDataService,
                private stateService: AppStateService) {
        this.stateService.ready.pipe(
            filter((ready): ready is true => ready),
            take(1)
        ).subscribe(() => {
            this.resetStaleDockState();
            this.reconcileFeatureSearchState(this.stateService.featureSearches);
        });
        this.stateService.featureSearchState.subscribe(entries => {
            if (!this.stateService.ready.getValue()) {
                return;
            }
            this.reconcileFeatureSearchState(entries);
        });
        this.mapService.searchResultTileReceived.subscribe(payload => {
            this.addServerSearchResultTile(payload);
        });
        this.mapService.searchResultTileEvicted.subscribe(payload => {
            this.removeServerSearchResultTile(payload);
        });
        this.mapService.searchStatusReceived.subscribe(status => {
            this.applyServerSearchStatus(status);
        });
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
     * Returns the static mapping JSON that pairs atlas sprites with numbered pin-marker states.
     */
    getSearchClusterIconMappingUrl(): string {
        return FeatureSearchService.SEARCH_ICON_MAPPING_URL;
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
                iconAtlasUrl: session.clusterIconAtlasUrl,
                iconMappingUrl: FeatureSearchService.SEARCH_ICON_MAPPING_URL,
                points: this.getSessionSearchResultPoints(session),
                pointBuckets: this.getSessionSearchResultPointBuckets(session),
                pinIndex: session.searchResultPinIndex
            }))
            .filter(layer => layer.points.length > 0);
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
                this.startSessionSearch(nextSession, definition);
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
        const previousFields = this.withFieldsForSearch(previous);
        const nextFields = this.withFieldsForSearch(definition);
        const searchGenerationChanged = previous.query !== definition.query
            || previous.scope !== definition.scope
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
        if (previous.showResultsOnMap !== definition.showResultsOnMap) {
            this.bumpSearchResultLayersVersion();
            this.progress.next(session);
        }
        if (previous.autoUpdate !== definition.autoUpdate) {
            this.progress.next(session);
        }
        if (JSON.stringify(previous.searchStyleRules ?? []) !== JSON.stringify(definition.searchStyleRules ?? [])) {
            this.bumpSearchResultLayersVersion();
            this.progress.next(session);
        }
        this.syncSearchRequestsToMapService();
    }

    /** Selects the next default pin color for a newly created search. */
    private nextDefaultSearchColor(): string {
        const color = FeatureSearchService.DEFAULT_SEARCH_COLORS[
            this.searchSessionCounter % FeatureSearchService.DEFAULT_SEARCH_COLORS.length
        ];
        this.searchSessionCounter += 1;
        return color;
    }

    /** Starts a new feature search over the currently prioritized tiles. */
    run(query: string): FeatureSearchSession {
        const entry = this.stateService.addFeatureSearch({
            query,
            pinColor: this.nextDefaultSearchColor()
        });
        const layoutId = FeatureSearchService.layoutIdForSearch(entry.id);
        if (this.getDockedSessions().length > 0 || this.stateService.hasDockedSurface(SEARCH_DOCK_TAB_ID)) {
            this.stateService.setSurfaceDocked(layoutId, true, SEARCH_DOCK_TAB_ID);
            this.moveDockedSurfaceToTop(layoutId);
            this.notifySessionsChanged();
        }
        let session = this.getInternalSession(entry.id);
        if (!session) {
            this.reconcileFeatureSearchState(this.stateService.featureSearches);
            session = this.getInternalSession(entry.id);
        }
        return session!;
    }

    /** Replaces one session's query/results while preserving its surface and color. */
    rerunSearch(sessionId: string, query: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        const nextDefinition: FeatureSearchStateEntry = {
            ...session.definition,
            query,
            paused: false
        };
        session.generationSerial += 1;
        this.resetSessionSearch(session, nextDefinition);
        this.startSessionSearch(session, nextDefinition);
        this.stateService.patchFeatureSearch(sessionId, {query, paused: false});
    }

    /** Requests one differential refresh over the currently visible map area. */
    updateSearchInArea(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        session.updateSerial += 1;
        session.paused = false;
        session.definition = {
            ...session.definition,
            paused: false
        };
        this.resetServerSearchProgress(session, session.refresh);
        this.progress.next(session);
        this.syncSearchRequestsToMapService();
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
        session.complete = true;
        session.progressDone = session.progressTotal;
        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        this.progress.next(session);
        this.syncSearchRequestsToMapService();
    }

    /** Resumes runtime server dispatch for one session. */
    private applySearchResume(session: FeatureSearchSession): void {
        session.paused = false;
        session.progressDone = 0;
        session.progressTotal = 1;
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
        if (!session) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {paused: true})) {
            this.applySearchPause(session);
        }
    }

    /** Resumes one paused search and hands it back to mapget. */
    resumeSearch(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        if (!this.stateService.patchFeatureSearch(sessionId, {paused: false})) {
            this.applySearchResume(session);
        }
    }

    /** Stops one search without clearing its partial result state. */
    stopSearch(sessionId: string): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        session.complete = true;
        session.progressDone = session.progressTotal;
        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        session.paused = false;
        session.definition = {
            ...session.definition,
            paused: true
        };
        if (!this.stateService.patchFeatureSearch(sessionId, {paused: true})) {
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

    /** Places a newly docked search before older docked searches, matching inspection dock behavior. */
    private moveDockedSurfaceToTop(layoutId: string): void {
        const existingOrder = this.getDockedSessions()
            .map(session => session.layoutId)
            .filter(id => id !== layoutId);
        this.stateService.reorderDockedSurfaces(SEARCH_DOCK_TAB_ID, [layoutId, ...existingOrder]);
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
            updateSerial: 0,
            generationSerial: 0,
            paused,
            progressDone: paused ? 1 : 0,
            progressTotal: 1,
            complete: paused,
            startTime: 0,
            endTime: 0,
            pointColor: this.normalizeHexColor(definition.pinColor),
            clusterIconAtlasUrl: FeatureSearchService.SEARCH_ICON_ATLAS_URL,
            timeElapsed: this.formatTime(0),
            totalFeatureCount: 0,
            searchResults: [],
            traceResults: [],
            diagnostics: [],
            diagnosticsBlobs: [],
            errors: new Set<string>(),
            progressByRequestKey: new Map<string, SearchRequestProgress>(),
            searchResultTilesBySourceKey: new Map<string, SearchResultTileContribution>(),
            searchResultPointsByFeatureKey: new Map<string, SearchResultPoint>(),
            searchResultPointsCache: [],
            searchResultPointBucketsCache: [],
            searchResultPointsCacheDirty: false,
            searchResultPointsVersion: 0,
            searchResultPinIndex: new SearchResultPinIndex()
        };
        return session;
    }

    /** Extracts server-side result-field expressions needed by search-result styling. */
    private withFieldsForSearch(definition: FeatureSearchStateEntry): string[] {
        const fields = new Set<string>();
        for (const rule of definition.searchStyleRules ?? []) {
            for (const filter of rule.filter ?? []) {
                if (filter.field?.trim()) {
                    fields.add(filter.field.trim());
                }
            }
            const color = rule.color;
            if ((color.mode === "gradient" || color.mode === "categories") && color.field.trim()) {
                fields.add(color.field.trim());
            }
        }
        return Array.from(fields).sort();
    }

    /** Synchronizes the UI/session search state into MapDataService's `/tiles` request data plane. */
    private syncSearchRequestsToMapService(): void {
        const requests: FeatureSearchDataPlaneRequest[] = this.searchSessions.map(session => ({
            searchId: session.id,
            query: session.definition.query,
            scope: session.definition.scope,
            autoUpdate: session.definition.autoUpdate,
            updateSerial: session.updateSerial,
            generationSerial: session.generationSerial,
            paused: session.definition.paused || session.paused,
            showResultsOnMap: session.definition.showResultsOnMap,
            pinColor: session.definition.pinColor,
            searchStyleRules: session.definition.searchStyleRules,
            withFields: this.withFieldsForSearch(session.definition)
        }));
        this.mapService.setFeatureSearchRequests(requests);
    }

    /** Clears only result-side state; the persisted search definition and UI surface stay intact. */
    private clearSessionResultData(session: FeatureSearchSession): void {
        this.pendingResultDataRebuildSessionIds.delete(session.id);
        session.searchResultTilesBySourceKey.clear();
        if (this.clearSessionSearchResultPoints(session)) {
            this.bumpSearchResultLayersVersion();
        }
        session.searchResults = [];
        session.traceResults = [];
        session.diagnostics = [];
        session.diagnosticsBlobs = [];
        session.errors.clear();
        session.totalFeatureCount = 0;
    }

    /** Starts a fresh server progress run for a new query or mapget refresh. */
    private resetServerSearchProgress(session: FeatureSearchSession, refresh: number): void {
        session.runId = this.generateRunId();
        session.refresh = refresh;
        session.paused = session.definition.paused;
        session.progressDone = session.paused ? 1 : 0;
        session.progressTotal = 1;
        session.progressByRequestKey.clear();
        session.complete = session.paused;
        session.startTime = Date.now();
        session.endTime = 0;
        session.timeElapsed = this.formatTime(0);
    }

    /** Prepares an existing session to receive result chunks for a newer mapget refresh. */
    private resetSessionForServerRefresh(session: FeatureSearchSession, refresh: number): void {
        this.clearSessionResultData(session);
        this.resetServerSearchProgress(session, refresh);
    }

    /** Clears one session and installs a fresh search group for the supplied query. */
    private resetSessionSearch(session: FeatureSearchSession, definition: FeatureSearchStateEntry): void {
        session.definition = definition;
        this.clearSessionResultData(session);
        session.refresh = 0;
        session.paused = definition.paused;
        session.progressDone = definition.paused ? 1 : 0;
        session.progressTotal = 1;
        session.progressByRequestKey.clear();
        session.complete = definition.paused;
        session.startTime = 0;
        session.endTime = 0;
        session.timeElapsed = this.formatTime(0);
    }

    /** Starts or refreshes one server-side search session. */
    private startSessionSearch(session: FeatureSearchSession, definition: FeatureSearchStateEntry): void {
        session.definition = definition;
        this.resetServerSearchProgress(session, session.refresh);
        this.progress.next(session);
        this.syncSearchRequestsToMapService();
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
        session.diagnostics = messages.slice(0, this.diagnosticsMessageLimit);
        this.progress.next(session);
    }

    /** Returns the completion stream pair owned by one input surface. */
    public completionStateForOwner(ownerId: string): CompletionOwnerState {
        const normalizedOwnerId = ownerId || FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID;
        let state = this.completionStates.get(normalizedOwnerId);
        if (!state) {
            state = {
                candidates: new BehaviorSubject<CompletionCandidate[]>([]),
                candidateList: []
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
        const state = this.completionStateForOwner(normalizedOwnerId);
        state.candidateList = [];
        state.candidates.next([]);
    }

    /**
     * Completes a query for the legacy omnibox owner.
     */
    public completeQuery(query: string, point: number | undefined) {
        this.completeQueryForOwner(FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID, query, point);
    }

    /**
     * Completes a query from schema metadata. Datasources without feature-model schema provide no candidates.
     */
    public completeQueryForOwner(ownerId: string, query: string, point: number | undefined) {
        const normalizedOwnerId = ownerId || FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID;
        this.clearCurrentCompletion(normalizedOwnerId);
        const state = this.completionStateForOwner(normalizedOwnerId);
        const caret = point ?? query.length;
        state.candidateList = this.completeQueryFromSchema(query, caret).slice(0, this.completionCandidateLimit);
        state.candidates.next(state.candidateList);
    }

    /** Produces main-thread completion candidates from LayerInfo.featureModelSchema when available. */
    private completeQueryFromSchema(query: string, point: number): CompletionCandidate[] {
        try {
            const rawCandidates = this.mapService.tileLayerParser.completeSearchQuery(query, point, {
                limit: this.completionCandidateLimit
            }) as Array<any> | null | undefined;
            if (!Array.isArray(rawCandidates)) {
                return [];
            }

            return rawCandidates
                .map(item => this.toCompletionCandidate(query, item))
                .filter((candidate): candidate is CompletionCandidate => candidate !== null);
        } catch (error) {
            console.warn("Failed to complete search query from schema metadata.", error);
            return [];
        }
    }

    /** Normalizes one native SIMFIL completion object into the UI model. */
    private toCompletionCandidate(sourceQuery: string, item: any): CompletionCandidate | null {
        const range = Array.isArray(item?.range) ? item.range : [];
        const begin = Number(range[0] ?? 0);
        const end = Number(range[1] ?? 0);
        if (!Number.isFinite(begin) || !Number.isFinite(end) || typeof item?.query !== "string") {
            return null;
        }
        return {
            text: String(item.text ?? ""),
            kind: String(item.type ?? "").toLowerCase(),
            begin,
            end,
            query: item.query,
            source: sourceQuery,
            hint: typeof item.hint === "string" ? item.hint : ""
        };
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
        const traceResults: TraceResult[] = [];
        for (const [name, value] of Object.entries(payload.traces || {})) {
            const trace = value as Partial<TraceResult>;
            traceResults.push({
                name,
                calls: trace.calls ?? 0n,
                totalus: trace.totalus ?? 0n,
                values: trace.values ?? []
            });
        }

        const results: FeatureSearchResultEntry[] = [];
        const points: SearchResultPoint[] = [];
        for (const entry of payload.entries) {
            const {mapId, layerId} = this.parseMapLayerIds(entry.mapTileKey);
            const point = this.makeSearchResultPoint(
                sourceTileKey,
                payload.sourceMapId,
                payload.sourceLayerId,
                payload.sourceTileId,
                mapId,
                layerId,
                entry.featureId,
                entry
            );
            if (point) {
                points.push(point);
            }
            results.push({
                label: `${entry.featureId}`,
                mapId,
                layerId,
                featureId: entry.featureId
            });
        }

        const contribution: SearchResultTileContribution = {
            refresh,
            sourceTileKey,
            sourceMapId: payload.sourceMapId,
            sourceLayerId: payload.sourceLayerId,
            sourceTileId: payload.sourceTileId,
            resultCount: payload.resultCount,
            results,
            traceResults,
            diagnostics: payload.diagnostics,
            points
        };
        const previousContribution = session.searchResultTilesBySourceKey.get(sourceTileKey);
        session.searchResultTilesBySourceKey.set(sourceTileKey, contribution);
        let emitProgressNow = true;
        if (previousContribution) {
            session.searchResultPinIndex.removeContribution(sourceTileKey);
            session.searchResultPinIndex.addContribution(sourceTileKey, contribution.points);
            this.scheduleSessionResultDataRebuild(session);
            emitProgressNow = false;
        } else {
            this.appendSessionResultContribution(session, contribution);
        }
        this.applyProgressSnapshot(session, payload.tilesConsidered, payload.tilesCompleted);

        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        if (emitProgressNow) {
            this.progress.next(session);
        }
    }

    /** Removes UI-visible result data for one source tile that left the desired search area. */
    private removeServerSearchResultTile(payload: SearchResultTileEvictedPayload): void {
        const session = this.getInternalSession(payload.searchId);
        if (!session || !session.searchResultTilesBySourceKey.delete(payload.sourceTileKey)) {
            return;
        }
        session.searchResultPinIndex.removeContribution(payload.sourceTileKey);
        this.scheduleSessionResultDataRebuild(session);
    }

    /** Applies mapget's server-side search progress status to the matching UI session. */
    private applyServerSearchStatus(status: MapTileStreamSearchStatusPayload): void {
        const session = this.getInternalSession(status.searchId);
        if (!session) {
            return;
        }
        const refresh = Number(status.refresh ?? 0);
        if (refresh < session.refresh) {
            return;
        }
        if (refresh > session.refresh) {
            this.resetSessionForServerRefresh(session, refresh);
        }

        if (status.error) {
            session.errors.add(status.error);
        }

        const isTerminal = status.state === "Success" || status.state === "Aborted" || status.state === "Failed";
        const key = this.serverSearchStatusKey(status);
        const previous = session.progressByRequestKey.get(key);
        const queuedRaw = this.nonNegativeNumber(status.tilesQueued, previous?.tilesQueued ?? 0);
        const queued = isTerminal && queuedRaw === 0 ? Math.max(1, previous?.tilesQueued ?? 0) : queuedRaw;
        const searched = this.nonNegativeNumber(status.tilesSearched, previous?.tilesSearched ?? 0);
        const matches = this.nonNegativeNumber(status.matches, previous?.matches ?? 0);
        session.progressByRequestKey.set(key, {
            tilesQueued: queued,
            tilesSearched: isTerminal ? queued : Math.min(queued, searched),
            matches,
            terminal: isTerminal
        });

        const progressEntries = Array.from(session.progressByRequestKey.values());
        const diffProgressTotal = progressEntries.reduce((sum, item) => sum + item.tilesQueued, 0);
        session.progressTotal = Math.max(
            1,
            this.nonNegativeNumber(status.tilesConsidered, diffProgressTotal)
        );
        const completedTiles = this.nonNegativeNumber(status.tilesCompleted, 0);
        const searchedDiffTiles = progressEntries.reduce((sum, item) => sum + item.tilesSearched, 0);
        // `tilesCompleted` is the stable full-area baseline; `tilesSearched` adds
        // in-flight progress from the current differential request before mapget
        // has committed those tiles into the local completed set.
        session.progressDone = Math.min(
            session.progressTotal,
            Math.max(completedTiles, Math.min(session.progressTotal, completedTiles + searchedDiffTiles))
        );
        session.complete = session.paused || (progressEntries.length > 0 && progressEntries.every(item => item.terminal));
        session.totalFeatureCount = progressEntries.reduce((sum, item) => sum + item.matches, 0);
        if (session.complete) {
            session.endTime = Date.now();
            session.timeElapsed = this.formatTime(session.endTime - session.startTime);
            this.updateDiagnosticsForCompletedSearch(session);
        }
        this.progress.next(session);
    }

    /** Groups mapget search statuses by concrete backend request so per-layer statuses aggregate instead of replacing each other. */
    private serverSearchStatusKey(status: MapTileStreamSearchStatusPayload): string {
        return [
            status.mapId || "",
            status.layerId || "",
            status.requestKey || "",
            status.refresh ?? 0
        ].join("\n");
    }

    private nonNegativeNumber(value: unknown, fallback: number): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
    }

    /** Applies full-coverage progress snapshots from MapDataService without losing streamed result state. */
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
    }

    /** Rebuilds derived result arrays from per-tile contributions after add, replace, or eviction. */
    private rebuildSessionResultData(session: FeatureSearchSession): void {
        const nextResults: FeatureSearchResultEntry[] = [];
        const nextTraces: TraceResult[] = [];
        const nextDiagnosticsBlobs: Uint8Array[] = [];
        const nextPoints = new Map<string, SearchResultPoint>();
        let totalFeatureCount = 0;

        const contributions = Array.from(session.searchResultTilesBySourceKey.values())
            .sort((lhs, rhs) => lhs.sourceTileKey.localeCompare(rhs.sourceTileKey));
        for (const contribution of contributions) {
            totalFeatureCount += contribution.resultCount;
            nextResults.push(...contribution.results);
            nextTraces.push(...contribution.traceResults);
            if (contribution.diagnostics) {
                nextDiagnosticsBlobs.push(contribution.diagnostics);
            }
            for (const point of contribution.points) {
                if (!nextPoints.has(point.featureKey)) {
                    nextPoints.set(point.featureKey, point);
                }
            }
        }

        session.searchResults = nextResults;
        session.traceResults = nextTraces;
        session.diagnosticsBlobs = nextDiagnosticsBlobs;
        session.totalFeatureCount = totalFeatureCount;
        session.searchResultPointsByFeatureKey = nextPoints;
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
    private appendSessionResultContribution(
        session: FeatureSearchSession,
        contribution: SearchResultTileContribution
    ): void {
        session.searchResults.push(...contribution.results);
        session.traceResults.push(...contribution.traceResults);
        if (contribution.diagnostics) {
            session.diagnosticsBlobs.push(contribution.diagnostics);
        }
        session.totalFeatureCount += contribution.resultCount;
        const pinsChanged = contribution.points.length > 0;
        if (pinsChanged) {
            session.searchResultPinIndex.addContribution(contribution.sourceTileKey, contribution.points);
        }

        let pointsChanged = false;
        for (const point of contribution.points) {
            if (!session.searchResultPointsByFeatureKey.has(point.featureKey)) {
                session.searchResultPointsByFeatureKey.set(point.featureKey, point);
                pointsChanged = true;
            }
        }
        if (pointsChanged || pinsChanged) {
            session.searchResultPointsCacheDirty = true;
            session.searchResultPointsVersion += 1;
            this.bumpSearchResultLayersVersion();
        }
    }

    /** Returns one internal live session by runtime id. */
    private getInternalSession(id: string): FeatureSearchSession | undefined {
        return this.searchSessions.find(session => session.id === id);
    }

    /** Emits a shallow session snapshot so structural UI can re-render. */
    private notifySessionsChanged(): void {
        this.sessionsChanged.next([...this.searchSessions]);
    }

    /** Returns one session's cached marker list, rebuilding it only after mutations. */
    private getSessionSearchResultPoints(session: FeatureSearchSession): SearchResultPoint[] {
        if (session.searchResultPointsCacheDirty) {
            session.searchResultPointsCache = Array.from(session.searchResultPointsByFeatureKey.values());
            session.searchResultPointBucketsCache = this.buildSearchResultPointBuckets(session);
            session.searchResultPointsCacheDirty = false;
        }
        return session.searchResultPointsCache;
    }

    /** Returns one session's cached marker list grouped by source map/layer/tile. */
    private getSessionSearchResultPointBuckets(session: FeatureSearchSession): SearchResultPointBucket[] {
        if (session.searchResultPointsCacheDirty) {
            this.getSessionSearchResultPoints(session);
        }
        return session.searchResultPointBucketsCache;
    }

    /** Groups result-tile point contributions so the deck view can cull low-fidelity pins by source tile. */
    private buildSearchResultPointBuckets(session: FeatureSearchSession): SearchResultPointBucket[] {
        const buckets: SearchResultPointBucket[] = [];
        const contributions = Array.from(session.searchResultTilesBySourceKey.values())
            .sort((lhs, rhs) => lhs.sourceTileKey.localeCompare(rhs.sourceTileKey));
        for (const contribution of contributions) {
            if (!contribution.points.length) {
                continue;
            }
            buckets.push({
                sourceTileKey: contribution.sourceTileKey,
                mapId: contribution.sourceMapId,
                layerId: contribution.sourceLayerId,
                tileId: contribution.sourceTileId,
                points: contribution.points
            });
        }
        return buckets;
    }

    /** Clears one session's marker caches and returns whether anything changed. */
    private clearSessionSearchResultPoints(session: FeatureSearchSession): boolean {
        if (!session.searchResultPointsByFeatureKey.size
            && !session.searchResultPointsCache.length
            && !session.searchResultPointsCacheDirty) {
            return false;
        }
        session.searchResultPointsByFeatureKey.clear();
        session.searchResultPointsCache = [];
        session.searchResultPointBucketsCache = [];
        session.searchResultPointsCacheDirty = false;
        session.searchResultPointsVersion += 1;
        session.searchResultPinIndex.clear();
        return true;
    }

    /** Bumps the aggregate marker-layer version consumed by the map overlay. */
    private bumpSearchResultLayersVersion(): void {
        this.searchResultLayersVersionValue += 1;
    }

    /** Updates one session's configured marker color and lazily resolves its tinted atlas. */
    private updateSessionColor(session: FeatureSearchSession, color: string): void {
        const normalizedColor = this.normalizeHexColor(color);
        session.pointColor = normalizedColor;
        this.ensureTintedClusterAtlas(normalizedColor)
            .then(atlasUrl => {
                const current = this.getInternalSession(session.id);
                if (!current || current.pointColor !== normalizedColor) {
                    return;
                }
                current.clusterIconAtlasUrl = atlasUrl;
                this.bumpSearchResultLayersVersion();
                this.progress.next(current);
            })
            .catch(() => {
                const current = this.getInternalSession(session.id);
                if (!current || current.pointColor !== normalizedColor) {
                    return;
                }
                current.clusterIconAtlasUrl = FeatureSearchService.SEARCH_ICON_ATLAS_URL;
                this.bumpSearchResultLayersVersion();
                this.progress.next(current);
            });
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

    /**
     * Creates a search marker if the match exposes a valid cartographic position.
     */
    private makeSearchResultPoint(
        sourceTileKey: string,
        sourceMapId: string,
        sourceLayerId: string,
        sourceTileId: bigint,
        mapId: string,
        layerId: string,
        featureId: string,
        entry: SearchResultTileEntry
    ): SearchResultPoint | null {
        const cartographicRad = entry.position.cartographicRad;
        const cartographic = entry.position.cartographic;
        const lon = cartographicRad
            ? GeoMath.toDegrees(cartographicRad.longitude)
            : cartographic?.x;
        const lat = cartographicRad
            ? GeoMath.toDegrees(cartographicRad.latitude)
            : cartographic?.y;
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
            sourceTileKey,
            sourceMapId,
            sourceLayerId,
            sourceTileId,
            featureId,
            featureKey
        };
    }

    /**
     * Lazily recolors the numbered pin icon atlas so marker styling tracks the configured highlight color.
     */
    private async ensureTintedClusterAtlas(color: string): Promise<string> {
        const cached = this.tintedAtlasByColor.get(color);
        if (cached) {
            return cached;
        }
        const baseAtlasImage = await this.loadBaseClusterAtlasImage();
        const [targetR, targetG, targetB] = this.parseHexRgb(color);
        const canvas = document.createElement("canvas");
        canvas.width = baseAtlasImage.naturalWidth || baseAtlasImage.width;
        canvas.height = baseAtlasImage.naturalHeight || baseAtlasImage.height;
        const context = canvas.getContext("2d", {willReadFrequently: true});
        if (!context) {
            return FeatureSearchService.SEARCH_ICON_ATLAS_URL;
        }
        context.drawImage(baseAtlasImage, 0, 0);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            if (alpha === 0) {
                continue;
            }
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            if (r > 235 && g > 235 && b > 235) {
                continue;
            }
            data[i] = targetR;
            data[i + 1] = targetG;
            data[i + 2] = targetB;
            data[i + 3] = 255;
        }
        context.putImageData(imageData, 0, 0);
        const tintedAtlasUrl = canvas.toDataURL("image/png");
        this.tintedAtlasByColor.set(color, tintedAtlasUrl);
        return tintedAtlasUrl;
    }

    /**
     * Loads the shared base atlas once and reuses the promise across recoloring passes.
     */
    private loadBaseClusterAtlasImage(): Promise<HTMLImageElement> {
        if (this.baseAtlasImagePromise) {
            return this.baseAtlasImagePromise;
        }
        this.baseAtlasImagePromise = new Promise((resolve, reject) => {
            const image = new Image();
            image.decoding = "async";
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("Failed to load search cluster icon atlas."));
            image.src = FeatureSearchService.SEARCH_ICON_ATLAS_URL;
        });
        return this.baseAtlasImagePromise;
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
