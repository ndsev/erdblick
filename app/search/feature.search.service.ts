import {Injectable} from "@angular/core";
import {BehaviorSubject, filter, Subject, take} from "rxjs";
import {MapDataService} from "../mapdata/map.service";
import {CompletionCandidate, CompletionCandidatesForTile, CompletionWorkerTask, DiagnosticsMessage, SearchResultForTile, SearchResultPosition, SearchWorkerTask, TraceResult} from "./search.worker";
import {Cartographic, Cartesian3, GeoMath, Rectangle} from "../integrations/geo";
import {FeatureTile} from "../mapdata/features.model";
import {coreLib, uint8ArrayFromWasm} from "../integrations/wasm";
import {JobGroup, JobGroupManager, JobGroupType} from "./job-group";
import {AppStateService, FEATURE_SEARCH_DIALOG_LAYOUT_ID, SEARCH_DOCK_TAB_ID} from "../shared/appstate.service";
import {FeatureSearchStateEntry} from "../shared/feature-search-state";

export const MAX_VISIBLE_TILES_PER_LEVEL = 69;
export const MAX_ZOOM_LEVEL = 15;
export const SAFE_ZOOM_LEVEL = 10;

/**
 * Synthetic primitive id used to correlate clustered markers back to search results.
 */
export interface SearchResultPrimitiveId {
    type: string,
    index: number
}

/**
 * Flat marker datum exposed to the deck overlay that visualizes search results.
 */
export interface SearchResultPoint {
    coordinates: [number, number];
    mapId: string;
    layerId: string;
    featureId: string;
    featureKey: string;
}

const TASK_SEARCH = 'SearchWorkerTask' as const;
const TASK_COMPLETION = 'CompletionWorkerTask' as const;

/**
 * Expands one quadtree tile id into its four children using the mapget tile-id bit layout.
 */
function generateChildrenIds(parentTileId: bigint) {
    if (parentTileId == -1n) {
        return [0n, 4294967296n];
    }

    let level = parentTileId & 0xFFFFn;
    let y = (parentTileId >> 16n) & 0xFFFFn;
    let x = parentTileId >> 32n;

    level += 1n;

    return [
        (x*2n << 32n)|(y*2n << 16n)|level,
        (x*2n + 1n << 32n)|(y*2n << 16n)|level,
        (x*2n << 32n)|(y*2n + 1n << 16n)|level,
        (x*2n + 1n << 32n)|(y*2n + 1n << 16n)|level
    ]
}

/**
 * Internal quadtree node used to cluster search-result markers by visible tile level.
 */
class FeatureSearchQuadTreeNode {
    tileId: bigint;
    parentId: bigint | null;
    level: number;
    children: Array<FeatureSearchQuadTreeNode>;
    countPerLayer: Map<string, number>;
    markers: Array<[SearchResultPrimitiveId, SearchResultPosition, string]> = [];
    rectangle: Rectangle;
    center: Cartesian3 | null;

    /**
     * Creates a quadtree node and derives its WGS84 rectangle from the mapget tile id.
     */
    constructor(tileId: bigint,
                parentTileId: bigint | null,
                level: number,
                countPerLayer: Map<string, number>,
                children: Array<FeatureSearchQuadTreeNode> = [],
                markers: Array<[SearchResultPrimitiveId, SearchResultPosition, string]> = []) {
        this.tileId = tileId;
        this.parentId = parentTileId;
        this.level = level;
        this.children = children;
        this.countPerLayer = new Map(countPerLayer.entries());
        this.markers = markers;

        const tileBox = tileId >= 0 ? coreLib.getTileBox(tileId) as Array<number> : [0, 0, 0, 0];
        this.rectangle = Rectangle.fromDegrees(tileBox[0], tileBox[1], tileBox[2], tileBox[3]);
        this.center = null;
    }

    /**
     * Returns true if the given cartographic position lies inside this node's bounds.
     */
    containsPoint(point: Cartographic) {
       return Rectangle.contains(this.rectangle, point);
    }

    /**
     * Returns true if any of the provided markers falls inside this node.
     */
    contains(markers: Array<[SearchResultPrimitiveId, SearchResultPosition, string]>) {
        return markers.some(marker =>
            this.containsPoint(marker[1].cartographicRad as Cartographic)
        );
    }

    /**
     * Returns only those markers that belong to this node's rectangle.
     */
    filterPointsForNode(markers: Array<[SearchResultPrimitiveId, SearchResultPosition, string]>) {
        return markers.filter(marker =>
            this.containsPoint(marker[1].cartographicRad as Cartographic)
        );
    }

    /**
     * Lazily creates only those child nodes that are relevant for the provided markers or center point.
     */
    addChildren(markers: Array<[SearchResultPrimitiveId, SearchResultPosition, string]> | Cartographic) {
        const existingIds = this.children.map(child => child.tileId);
        const missingIds = generateChildrenIds(this.tileId).filter(id => !existingIds.includes(id));
        for (const id of missingIds) {
            const child = new FeatureSearchQuadTreeNode(id, this.tileId, this.level + 1, new Map());
            if (Array.isArray(markers)) {
                if (child.contains(markers)) {
                    this.children.push(child);
                }
            } else {
                if (child.containsPoint(markers)) {
                    this.children.push(child);
                }
            }
        }
    }

    /**
     * Accumulates the number of results that this node contributes for one map/layer pair.
     */
    incrementCountForMapLayer(mapLayer: string, increment: number) {
        if (this.countPerLayer.has(mapLayer)) {
            const currentCount = this.countPerLayer.get(mapLayer)!;
            this.countPerLayer.set(mapLayer, currentCount + increment);
            return;
        }
        this.countPerLayer.set(mapLayer, increment);
    }
}

/**
 * Lightweight quadtree used to aggregate search matches into zoom-dependent clusters.
 */
class FeatureSearchQuadTree {
    root: FeatureSearchQuadTreeNode;
    private maxDepth: number = MAX_ZOOM_LEVEL;

    /**
     * Starts with a synthetic root that represents the full globe.
     */
    constructor() {
        this.root = new FeatureSearchQuadTreeNode(-1n, null, -1, new Map());
    }

    /**
     * Uses the average cartesian position as a stable center for clustered markers.
     */
    private calculateAveragePosition(markers: Array<[SearchResultPrimitiveId, SearchResultPosition, string]>): Cartesian3 {
        const sum = markers.reduce(
            (acc, marker) => {
                acc.x += marker[1].cartesian.x;
                acc.y += marker[1].cartesian.y;
                acc.z += marker[1].cartesian.z;
                return acc;
            },
            { x: 0, y: 0, z: 0 }
        );

        return new Cartesian3(sum.x / markers.length, sum.y / markers.length, sum.z / markers.length);
    }

    /**
     * Inserts all matches from one tile into the quadtree and propagates aggregate counts upward.
     */
    insert(tileId: bigint, mapLayerId: string, results: Array<[SearchResultPrimitiveId, SearchResultPosition, string]>) {
        const markersCenter = this.calculateAveragePosition(results);
        const markersCenterCartographic = Cartographic.fromCartesian(markersCenter);
        let currentLevel = 0;
        this.root.addChildren(results);
        let targetNode: FeatureSearchQuadTreeNode | null = this.root;
        let nodes = this.root.children;

        mainLoop: while (nodes.length > 0) {
            const next: Array<FeatureSearchQuadTreeNode> = [];
            for (let node of nodes) {
                if (node.tileId == tileId) {
                    targetNode = node;
                    break mainLoop;
                }
                if (node.containsPoint(markersCenterCartographic)) {
                    node.incrementCountForMapLayer(mapLayerId, results.length);
                    node.center = node.center ? new Cartesian3(
                        (node.center.x + markersCenter.x) / 2,
                        (node.center.y + markersCenter.y) / 2,
                        (node.center.z + markersCenter.z) / 2
                    ) : markersCenter;
                    node.addChildren(markersCenterCartographic);
                    next.push(...node.children);
                }
            }

            nodes = next;
            currentLevel++;
            if (currentLevel > this.maxDepth) {
                targetNode = null;
                break;
            }
        }

        if (targetNode) {
            targetNode.incrementCountForMapLayer(mapLayerId, results.length);
            targetNode.center = markersCenter;
            targetNode.addChildren(results);
            nodes = targetNode.children;
            while (currentLevel <= this.maxDepth) {
                const next: Array<FeatureSearchQuadTreeNode> = [];
                for (const node of nodes) {
                    const containedMarkers = node.filterPointsForNode(results);
                    if (containedMarkers.length) {
                        const subMarkersCenter = this.calculateAveragePosition(containedMarkers);
                        node.incrementCountForMapLayer(mapLayerId, containedMarkers.length);
                        node.center = subMarkersCenter;
                        if (node.level == this.maxDepth) {
                            node.markers.push(...containedMarkers);
                        } else {
                            node.addChildren(results);
                            next.push(...node.children);
                        }
                    }
                }
                nodes = next;
                currentLevel++;
            }
        }
    }

    /**
     * Iterates over all nodes that exist at the requested clustering depth.
     */
    *getNodesAtLevel(level: number): IterableIterator<FeatureSearchQuadTreeNode> {
        if (level < 0 || !this.root.children.length) {
            return;
        }

        let currentLevel = 0;
        let nodes = this.root.children;

        while (nodes.length > 0) {
            if (currentLevel == level) {
                for (const node of nodes) {
                    yield node;
                }
                return;
            }

            const next: Array<FeatureSearchQuadTreeNode> = [];
            for (const node of nodes) {
                next.push(...node.children);
            }

            nodes = next;
            currentLevel++;
        }
    }
}

/**
 * Search-specific job group that also tracks tiles whose staged data is still loading.
 *
 * Search progress intentionally stays incomplete while these tiles are pending so the UI can show
 * "Awaited tiles to load" instead of finishing too early.
 */
export class SearchState extends JobGroup {
    private pendingTileKeys: Set<string> = new Set<string>();

    /**
     * Creates a search group and optionally starts it in paused mode.
     */
    constructor(query: string, id: string, public paused = false) {
        super('search', query, id);
    }

    /**
     * Adds a tile to the outstanding-data set that blocks search completion.
     */
    markTilePending(tileKey: string): void {
        if (!tileKey) {
            return;
        }
        this.pendingTileKeys.add(tileKey);
    }

    /**
     * Removes a tile from the outstanding-data set once it can be searched or is no longer expected.
     */
    markTileReady(tileKey: string): void {
        if (!tileKey) {
            return;
        }
        this.pendingTileKeys.delete(tileKey);
    }

    /**
     * Returns how many tiles are still awaited before the search can truly finish.
     */
    getPendingTileCount(): number {
        return this.pendingTileKeys.size;
    }

    /**
     * Cancels the search and clears any pending-tile bookkeeping at the same time.
     */
    override stop(): void {
        this.pendingTileKeys.clear();
        super.stop();
    }

    /**
     * Treats the search as complete only after worker tasks finish and no awaited tile remains.
     */
    override isComplete(): boolean {
        return super.isComplete() && !this.pendingTileKeys.size;
    }

    /**
     * Extends the visible task count with still-pending tiles so the progress UI stays honest.
     */
    override getTaskCount(): number {
        return super.getTaskCount() + this.pendingTileKeys.size;
    }
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
    search: SearchState;
    query: string;
    pointColor: string;
    clusterIconAtlasUrl: string;
    timeElapsed: string;
    totalFeatureCount: number;
    searchResults: FeatureSearchResultEntry[];
    traceResults: TraceResult[];
    diagnostics: DiagnosticsMessage[];
    errors: Set<string>;
}

export interface FeatureSearchResultLayer {
    id: string;
    pointsVersion: number;
    iconAtlasUrl: string;
    iconMappingUrl: string;
    points: SearchResultPoint[];
}

export interface CompletionOwnerState {
    pending: BehaviorSubject<boolean>;
    candidates: BehaviorSubject<CompletionCandidate[]>;
    candidateList: CompletionCandidate[];
}

interface FeatureSearchSessionInternal extends FeatureSearchSession {
    resultTree: FeatureSearchQuadTree;
    resultsPerTile: Map<string, SearchResultForTile>;
    pendingSearchTilesByKey: Map<string, FeatureTile>;
    searchResultPointsByFeatureKey: Map<string, SearchResultPoint>;
    searchResultPointsCache: SearchResultPoint[];
    searchResultPointsCacheDirty: boolean;
    searchResultPointsVersion: number;
    startTime: number;
    endTime: number;
}

@Injectable({providedIn: 'root'})
/**
 * Coordinates feature search, query completion, result clustering, and search-marker overlays.
 *
 * The service keeps worker scheduling, staged tile readiness, and UI-friendly result caches in sync.
 */
export class FeatureSearchService {
    private static readonly SEARCH_ICON_ATLAS_URL = "/bundle/images/search/location-icon-atlas.png";
    private static readonly SEARCH_ICON_MAPPING_URL = "/bundle/images/search/location-icon-mapping.json";
    private static readonly LOCATION_MARKER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="48" viewBox="0 0 24 24" width="48"><path d="M12 2C8.1 2 5 5.1 5 9c0 3.3 4.2 8.6 6.6 11.6.4.5 1.3.5 1.7 0C14.8 17.6 19 12.3 19 9c0-3.9-3.1-7-7-7zm0 9.5c-1.4 0-2.5-1.1-2.5-2.5S10.6 6.5 12 6.5s2.5 1.1 2.5 2.5S13.4 11.5 12 11.5z" fill="white"/></svg>`;
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

    workers: Array<Worker> = [];
    private workerBusy: Array<boolean> = [];
    private workersReady: Promise<void> | null = null;

    jobGroupManager: JobGroupManager = new JobGroupManager();
    currentCompletion: JobGroup | null = null;
    private currentCompletionOwnerId = FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID;
    taskIdCounter: number = 0;
    taskGroupIdCounter: number = 0;
    private searchSessionCounter = 0;
    private searchScheduleCursor = 0;

    readonly sessionsChanged = new BehaviorSubject<FeatureSearchSession[]>([]);
    readonly progress: BehaviorSubject<FeatureSearchSession|null> = new BehaviorSubject<FeatureSearchSession|null>(null);
    readonly diagnosticsMessages: BehaviorSubject<DiagnosticsMessage[]> = new BehaviorSubject<DiagnosticsMessage[]>([]);
    diagnosticsMessageLimit: number = 25;

    private readonly completionStates = new Map<string, CompletionOwnerState>();
    readonly completionPending = this.completionStateForOwner(FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID).pending;
    readonly completionCandidates = this.completionStateForOwner(FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID).candidates;
    completionCandidateLimit: number = 15;

    showFeatureSearchDialog: boolean = false;

    private readonly searchSessions: FeatureSearchSessionInternal[] = [];
    private readonly searchSessionByGroupId = new Map<string, FeatureSearchSessionInternal>();
    private searchResultLayersVersionValue = 0;
    private tintedAtlasByColor = new Map<string, string>();
    private baseAtlasImagePromise: Promise<HTMLImageElement> | null = null;
    private locationMarkerGraphicUrl: string | null = null;

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
        this.mapService.tileDataChanged.subscribe(change => {
            if (!this.searchSessions.some(session => session.pendingSearchTilesByKey.has(change.tileKey))) {
                return;
            }
            this.enqueueReadyPendingSearchTiles();
        });
    }

    /** Returns the newest search group for legacy callers that only know about one search. */
    get currentSearch(): SearchState | null {
        return this.latestSession()?.search ?? null;
    }

    get pointColor(): string {
        return this.latestSession()?.pointColor ?? FeatureSearchService.DEFAULT_SEARCH_COLORS[0];
    }

    set pointColor(color: string) {
        const session = this.latestSession();
        if (session) {
            session.pointColor = color;
        }
    }

    get timeElapsed(): string {
        return this.latestSession()?.timeElapsed ?? this.formatTime(0);
    }

    get totalFeatureCount(): number {
        return this.latestSession()?.totalFeatureCount ?? 0;
    }

    get searchResults(): FeatureSearchResultEntry[] {
        return this.latestSession()?.searchResults ?? [];
    }

    get traceResults(): TraceResult[] {
        return this.latestSession()?.traceResults ?? [];
    }

    get errors(): Set<string> {
        return this.latestSession()?.errors ?? new Set<string>();
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
    private sessionDockOrder(session: FeatureSearchSessionInternal | FeatureSearchSession): number {
        const order = this.stateService.getDialogLayout(session.layoutId)?.dockOrder;
        if (typeof order === 'number' && Number.isFinite(order)) {
            return order;
        }
        const index = this.searchSessions.findIndex(candidate => candidate.id === session.id);
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    }

    /**
     * Returns the static mapping JSON that pairs atlas sprites with cluster-marker states.
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

    get searchResultPointsVersion(): number {
        return this.searchResultLayersVersionValue;
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
                points: this.getSessionSearchResultPoints(session)
            }))
            .filter(layer => layer.points.length > 0);
    }

    /**
     * Returns the cached flat search-marker list across all sessions.
     */
    getSearchResultPoints(): SearchResultPoint[] {
        return this.searchSessions.flatMap(session => this.getSessionSearchResultPoints(session));
    }

    /**
     * Lazily initializes the worker pool the first time search or completion is used.
     */
    public initializeWorkers(): Promise<void> {
        if (!this.workersReady) {
            this.workersReady = this.initWorkers();
        }
        return this.workersReady;
    }

    /**
     * Boots the first module worker, then clones its script into additional workers via a blob URL.
     */
    private async initWorkers(): Promise<void> {
        const maxWorkers = navigator.hardwareConcurrency || 4;
        if (maxWorkers <= 0) {
            return;
        }

        const firstWorker = new Worker(new URL('./search.worker', import.meta.url), {type: 'module'});
        const workerModuleUrl = await this.waitForWorkerReady(firstWorker);
        this.registerWorker(firstWorker, 0);

        const workerBlobUrl = await this.fetchWorkerBlobUrl(workerModuleUrl);
        for (let i = 1; i < maxWorkers; i++) {
            const worker = new Worker(workerBlobUrl, {type: 'module'});
            this.registerWorker(worker, i);
        }
    }

    /**
     * Waits for the worker handshake that reveals the resolved module URL.
     */
    private waitForWorkerReady(worker: Worker): Promise<string> {
        return new Promise((resolve) => {
            const handler = (event: MessageEvent<any>) => {
                const result = event.data;
                if (result?.type !== 'WorkerReady') {
                    return;
                }
                worker.removeEventListener('message', handler);
                resolve(result.scriptUrl as string);
            };
            worker.addEventListener('message', handler);
            worker.postMessage({type: 'WorkerInit'});
        });
    }

    /**
     * Fetches the compiled worker module once so subsequent workers can reuse a cached blob URL.
     */
    private async fetchWorkerBlobUrl(workerModuleUrl: string): Promise<string> {
        const response = await fetch(workerModuleUrl, {cache: 'force-cache'});
        if (!response.ok) {
            throw new Error(`Failed to fetch search worker module (${response.status} ${response.statusText})`);
        }
        const blob = await response.blob();
        return URL.createObjectURL(blob);
    }

    /**
     * Installs the common message handler that feeds worker results back into the active job groups.
     */
    private registerWorker(worker: Worker, index: number) {
        this.workers[index] = worker;
        this.workerBusy[index] = false;
        worker.onmessage = (event: MessageEvent<any>) => {
            const result = event.data;
            this.workerBusy[index] = false;

            switch (result.type) {
                case 'SearchResultForTile':
                    this.addSearchResult(result as SearchResultForTile);
                    break;
                case 'CompletionCandidatesForTile':
                    this.addCompletionCandidates(result as CompletionCandidatesForTile);
                    break;
            }

            // Notify the job-group after merging the payload so completion callbacks see final state.
            if (result.taskId) {
                this.jobGroupManager.completeTask(result.taskId, result);
            }

            this.scheduleNextTask(index);
        };
    }

    /** Reconciles persisted feature-search definitions with runtime worker sessions. */
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
        this.runWorkers();
    }

    /** Applies non-structural definition changes to an existing runtime session. */
    private applyFeatureSearchDefinition(session: FeatureSearchSessionInternal, definition: FeatureSearchStateEntry): void {
        const previous = session.definition;
        const normalizedColor = this.normalizeHexColor(definition.pinColor);

        if (session.query !== definition.query) {
            this.resetSessionSearch(session, definition);
            this.updateSessionColor(session, normalizedColor);
            this.startSessionSearch(session, definition);
            return;
        }

        session.definition = definition;
        if (session.pointColor !== normalizedColor) {
            this.updateSessionColor(session, normalizedColor);
        }
        if (session.search.paused !== definition.paused) {
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
        if (!this.stateService.patchFeatureSearch(sessionId, {query, paused: false})) {
            this.resetSessionSearch(session, {
                ...session.definition,
                query,
                paused: false
            });
            this.startSessionSearch(session, session.definition);
        }
    }

    // Send a task to each worker to start processing.
    // Further tasks will be picked up in the worker's
    // onMessage callback.
    /**
     * Fills idle workers with the next available search or completion task.
     */
    private runWorkers() {
        this.workers.forEach((worker, index) => {
            if (this.workerBusy[index]) {
                return;
            }
            this.scheduleNextTask(index);
        });
    }

    /** Applies a pause to runtime worker dispatch for one session. */
    private applySearchPause(session: FeatureSearchSessionInternal): void {
        session.search.paused = true;
        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        this.progress.next(session);
    }

    /** Resumes runtime worker dispatch for one session. */
    private applySearchResume(session: FeatureSearchSessionInternal): void {
        session.search.paused = false;
        this.progress.next(session);
        this.runWorkers();
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

    /** Resumes one paused search and hands queued work back to idle workers. */
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
        session.pendingSearchTilesByKey.clear();
        session.search.stop();
        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        session.search.paused = false;
        session.definition = {
            ...session.definition,
            paused: true
        };
        if (!this.stateService.patchFeatureSearch(sessionId, {paused: true})) {
            this.progress.next(session);
        }
    }

    /** Legacy pause API for the newest search. */
    pause(): void {
        const session = this.latestSession();
        if (session) {
            this.pauseSearch(session.id);
        }
    }

    /** Legacy resume API for the newest search. */
    resume(): void {
        const session = this.latestSession();
        if (session) {
            this.resumeSearch(session.id);
        }
    }

    /** Legacy stop API for the newest search. */
    stop(): void {
        const session = this.latestSession();
        if (session) {
            this.stopSearch(session.id);
        }
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

    /** Rebuilds the newest search session's marker atlas after direct pointColor assignment. */
    updatePointColor(): void {
        const session = this.latestSession();
        if (session) {
            this.updateSessionColor(session, session.pointColor);
        }
    }

    /** Switches one session between docked and floating representations. */
    setSessionDocked(sessionId: string, docked: boolean): void {
        const session = this.getInternalSession(sessionId);
        if (!session) {
            return;
        }
        this.stateService.setSurfaceDocked(session.layoutId, docked, SEARCH_DOCK_TAB_ID);
        if (docked) {
            this.stateService.dockActiveTab = SEARCH_DOCK_TAB_ID;
            this.stateService.isDockOpen = true;
        }
        this.notifySessionsChanged();
    }

    /** Closes one search session and removes its worker, dock, and marker state. */
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
        this.searchSessionByGroupId.delete(session.search.id);
        this.jobGroupManager.removeGroup(session.search.id);
        this.stateService.removeDialogLayout(session.layoutId);
        this.bumpSearchResultLayersVersion();
        this.notifySessionsChanged();
        this.progress.next(null);
        if (this.stateService.isDockAutoCollapsible
            && !this.stateService.selection.some(panel => !panel.undocked)
            && this.getDockedSessions().length === 0) {
            this.stateService.isDockOpen = false;
        }
        return true;
    }

    /** Resets every live search session. Primarily kept for legacy callers. */
    clear(): void {
        this.stateService.featureSearches = [];
        for (const session of [...this.searchSessions]) {
            this.closeRuntimeSearch(session.id);
        }
        this.currentCompletion?.stop();
        this.currentCompletion = null;
        for (const state of this.completionStates.values()) {
            state.candidateList = [];
            state.pending.next(false);
            state.candidates.next([]);
        }
    }

    /** Creates a runtime session with independent result, diagnostics, and marker state. */
    private createSession(definition: FeatureSearchStateEntry): FeatureSearchSessionInternal {
        const session: FeatureSearchSessionInternal = {
            id: definition.id,
            layoutId: FeatureSearchService.layoutIdForSearch(definition.id),
            definition,
            search: new SearchState(definition.query, this.generateTaskGroupId(), definition.paused),
            query: definition.query,
            pointColor: this.normalizeHexColor(definition.pinColor),
            clusterIconAtlasUrl: FeatureSearchService.SEARCH_ICON_ATLAS_URL,
            timeElapsed: this.formatTime(0),
            totalFeatureCount: 0,
            searchResults: [],
            traceResults: [],
            diagnostics: [],
            errors: new Set<string>(),
            resultTree: new FeatureSearchQuadTree(),
            resultsPerTile: new Map<string, SearchResultForTile>(),
            pendingSearchTilesByKey: new Map<string, FeatureTile>(),
            searchResultPointsByFeatureKey: new Map<string, SearchResultPoint>(),
            searchResultPointsCache: [],
            searchResultPointsCacheDirty: false,
            searchResultPointsVersion: 0,
            startTime: 0,
            endTime: 0
        };
        return session;
    }

    /** Clears one session and installs a fresh search group for the supplied query. */
    private resetSessionSearch(session: FeatureSearchSessionInternal, definition: FeatureSearchStateEntry): void {
        this.searchSessionByGroupId.delete(session.search.id);
        this.jobGroupManager.removeGroup(session.search.id);
        session.definition = definition;
        session.search = new SearchState(definition.query, this.generateTaskGroupId(), definition.paused);
        session.query = definition.query;
        session.resultTree = new FeatureSearchQuadTree();
        session.resultsPerTile.clear();
        session.pendingSearchTilesByKey.clear();
        if (this.clearSessionSearchResultPoints(session)) {
            this.bumpSearchResultLayersVersion();
        }
        session.searchResults = [];
        session.traceResults = [];
        session.diagnostics = [];
        session.errors.clear();
        session.totalFeatureCount = 0;
        session.startTime = 0;
        session.endTime = 0;
        session.timeElapsed = this.formatTime(0);
    }

    /** Enqueues all available tile work for one session and starts idle workers. */
    private startSessionSearch(session: FeatureSearchSessionInternal, definition: FeatureSearchStateEntry): void {
        session.definition = definition;
        session.search = session.search.query === definition.query
            ? session.search
            : new SearchState(definition.query, this.generateTaskGroupId(), definition.paused);
        session.search.paused = definition.paused;
        session.query = definition.query;
        session.startTime = Date.now();
        this.jobGroupManager.addGroup(session.search);
        this.searchSessionByGroupId.set(session.search.id, session);

        for (const tile of this.orderedTilesForSearchProcessing()) {
            if (!this.mapService.isTileInspectionDataComplete(tile)) {
                if (this.isTileStillExpected(tile)) {
                    session.pendingSearchTilesByKey.set(tile.mapTileKey, tile);
                    session.search.markTilePending(tile.mapTileKey);
                }
                continue;
            }
            this.enqueueSearchTask(tile, session.search);
        }

        session.search.onComplete((group: JobGroup) => {
            this.getDiagnosticsForCompletedSearch(group.id);
        });

        this.progress.next(session);
        this.enqueueReadyPendingSearchTiles();
        this.maybeStartDiagnosticsForCompletedSearch(session.search);
        this.runWorkers();
    }

    /// Generate a new task id
    /**
     * Generates a unique task id for worker bookkeeping and callback routing.
     */
    private generateTaskId(): string {
        return `task_${Date.now()}_${++this.taskIdCounter}`;
    }

    /// Generate a new task-group id
    /**
     * Generates a unique group id so stale worker responses can be ignored safely.
     */
    private generateTaskGroupId(): string {
        return `group_${Date.now()}_${++this.taskGroupIdCounter}`;
    }

    /**
     * Aggregates all raw diagnostics blobs for the completed search that is still current in the UI.
     */
    private getDiagnosticsForCompletedSearch(searchGroupId: string) {
        const completedSearchGroup = this.jobGroupManager.getGroup(searchGroupId);
        const session = this.searchSessionByGroupId.get(searchGroupId);
        if (!completedSearchGroup || !session || session.search.id !== searchGroupId) {
            return;
        }

        const messages = coreLib.simfilGetDiagnostics(completedSearchGroup.query, Array.from(completedSearchGroup.getDiagnostics()))
        session.diagnostics = messages.slice(0, this.diagnosticsMessageLimit);
        this.diagnosticsMessages.next(session.diagnostics);
        this.progress.next(session);
    }

    /**
     * Starts diagnostics aggregation only when the completed group still matches the visible search.
     */
    private maybeStartDiagnosticsForCompletedSearch(group: JobGroup): void {
        if (group.type !== 'search' || !group.isComplete()) {
            return;
        }
        const session = this.searchSessionByGroupId.get(group.id);
        if (!session || session.search.id !== group.id) {
            return;
        }
        console.debug(`Search group completed (id: ${group.id}). Collecting diagnostics for query ${group.query}`);
        this.getDiagnosticsForCompletedSearch(group.id);
    }

    /** Returns the completion stream pair owned by one input surface. */
    public completionStateForOwner(ownerId: string): CompletionOwnerState {
        const normalizedOwnerId = ownerId || FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID;
        let state = this.completionStates.get(normalizedOwnerId);
        if (!state) {
            state = {
                pending: new BehaviorSubject<boolean>(false),
                candidates: new BehaviorSubject<CompletionCandidate[]>([]),
                candidateList: []
            };
            this.completionStates.set(normalizedOwnerId, state);
        }
        return state;
    }

    /**
     * Cancels any in-flight completion job before a newer query supersedes it.
     */
    public clearCurrentCompletion(ownerId: string = FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID) {
        const normalizedOwnerId = ownerId || FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID;
        if (this.currentCompletion && this.currentCompletionOwnerId === normalizedOwnerId) {
            this.currentCompletion.stop();
            this.currentCompletion = null;
        }
        const state = this.completionStateForOwner(normalizedOwnerId);
        state.candidateList = [];
        state.pending.next(false);
        state.candidates.next([]);
    }

    /**
     * Starts a completion fan-out across the currently prioritized tiles for the legacy omnibox owner.
     */
    public completeQuery(query: string, point: number | undefined) {
        this.completeQueryForOwner(FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID, query, point);
    }

    /**
     * Starts a completion fan-out across the currently prioritized tiles.
     */
    public completeQueryForOwner(ownerId: string, query: string, point: number | undefined) {
        const normalizedOwnerId = ownerId || FeatureSearchService.DEFAULT_COMPLETION_OWNER_ID;
        this.clearCurrentCompletion(this.currentCompletionOwnerId);
        const state = this.completionStateForOwner(normalizedOwnerId);

        // Create completion job group
        const completionGroup = this.jobGroupManager.createGroup('completion', query, this.generateTaskGroupId());
        this.currentCompletion = completionGroup
        this.currentCompletionOwnerId = normalizedOwnerId;
        completionGroup.onComplete((group: JobGroup) => {
            console.debug(`Completion group completed (id: ${group.id}, current: ${this.currentCompletion?.id})`)
            if (this.currentCompletion?.id === group.id) {
                this.completionStateForOwner(normalizedOwnerId).pending.next(false);
            }
        })

        // Build one task per tile
        const tileParser = this.mapService.tileLayerParser;
        const limit = this.completionCandidateLimit;
        const makeTask = (tile: FeatureTile): CompletionWorkerTask | null => {
            const tileBlobs = tile.stageBlobs().map(stageBlob => stageBlob.blob);
            if (!tileBlobs.length) {
                return null;
            }
            const taskId = this.generateTaskId();
            const task: CompletionWorkerTask = {
                type: TASK_COMPLETION,
                tileBlobs,
                fieldDictBlob: uint8ArrayFromWasm((buf) => {
                    tileParser?.getFieldDict(buf, tile.nodeId)
                })!,
                dataSourceInfo: uint8ArrayFromWasm((buf) => {
                    tileParser?.getDataSourceInfo(buf, tile.mapName)
                })!,
                query: query,
                point: point || query.length,
                nodeId: tile.nodeId,
                limit: limit,
                taskId: taskId,
                groupId: completionGroup.id
            };

            this.jobGroupManager.addTask(task);
            return task;
        };

        state.candidateList = [];
        state.pending.next(true);
        state.candidates.next([]);

        for (const tile of this.orderedTilesForSearchProcessing()) {
            makeTask(tile);
        }
        this.runWorkers();
    }

    /**
     * Merges completion candidates from one tile, deduplicating by final query text.
     */
    private addCompletionCandidates(candidates: CompletionCandidatesForTile) {
        if (candidates.groupId !== this.currentCompletion?.id)
            return;

        const state = this.completionStateForOwner(this.currentCompletionOwnerId);
        state.candidateList = state.candidateList
            .concat(candidates.candidates)
            .filter((item, index, array) => array.findIndex(other => other.query === item.query) === index) // Remove duplicates
            .slice(0, this.completionCandidateLimit);

        state.candidates.next(state.candidateList);
    }

    /**
     * Integrates one tile's matches into the visible result tree, overlays, traces, and diagnostics.
     */
    private addSearchResult(tileResult: SearchResultForTile) {
        const groupId = tileResult.groupId;
        if (!groupId) {
            return;
        }
        const session = this.searchSessionByGroupId.get(groupId);
        if (!session || session.search.id !== groupId) {
            return;
        }

        if (tileResult.error) {
            session.errors.add(tileResult.error);
        }

        // Add trace results
        for (let [key, trace] of Object.entries(tileResult.traces || {})) {
            session.traceResults.push({
                name: `${key}`,
                calls: trace.calls,
                totalus: trace.totalus,
                values: trace.values,
            })
        }

        // Add diagnostics to the current search group
        if (tileResult.diagnostics) {
            session.search.addDiagnostics(tileResult.diagnostics);
        }

        const seenFeatureKeys = new Set<string>();
        const dedupedMatches = tileResult.matches.filter(([mapTileKey, featureId]) => {
            const canonicalTileKey = (() => {
                try {
                    const [mapId, layerId, tileId] = coreLib.parseMapTileKey(mapTileKey);
                    return coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
                } catch {
                    return mapTileKey;
                }
            })();
            const dedupeKey = `${canonicalTileKey}|${featureId}`;
            if (seenFeatureKeys.has(dedupeKey)) {
                return false;
            }
            seenFeatureKeys.add(dedupeKey);
            return true;
        });

        // Add visualizations and register the search result.
        if (dedupedMatches.length && tileResult.tileId) {
            const mapTileKey = dedupedMatches[0][0];
            const {mapId, layerId} = this.parseMapLayerIds(mapTileKey);
            const mapLayerId = `${mapId}/${layerId}`;
            session.resultsPerTile.set(mapTileKey, {
                ...tileResult,
                matches: dedupedMatches
            });
            let addedPoint = false;
            const treeResults: Array<[SearchResultPrimitiveId, SearchResultPosition, string]> = [];
            for (const result of dedupedMatches) {
                if (result[2].cartographic) {
                    result[2].cartographicRad = Cartographic.fromDegrees(
                        result[2].cartographic.x,
                        result[2].cartographic.y,
                        result[2].cartographic.z
                    );
                }
                result[2].cartographic = null;
                addedPoint = this.tryAddSearchResultPoint(session, mapId, layerId, result[1], result[2]) || addedPoint;
                const featureId = result[1];
                const id: SearchResultPrimitiveId = {type: "SearchResult", index: session.searchResults.length};
                session.searchResults.push({label: `${featureId}`, mapId: mapId, layerId: layerId, featureId: featureId});
                treeResults.push([id, result[2], mapLayerId]);
            }
            if (addedPoint) {
                session.searchResultPointsVersion += 1;
                this.bumpSearchResultLayersVersion();
            }
            session.resultTree.insert(tileResult.tileId, mapLayerId, treeResults);
        }

        // Broadcast the search progress.
        session.endTime = Date.now();
        session.timeElapsed = this.formatTime(session.endTime - session.startTime);
        session.totalFeatureCount += tileResult.numFeatures;
        this.progress.next(session);
    }

    /**
     * Chooses the next task for a worker, round-robin across active searches before completion work.
     */
    private scheduleNextTask(workerIndex: number) {
        let nextTask = undefined;
        const attemptedSearchIds = new Set<string>();
        while (!nextTask && attemptedSearchIds.size < this.searchSessions.length) {
            const searchSession = this.nextRunnableSearchSession();
            if (!searchSession || attemptedSearchIds.has(searchSession.id)) {
                break;
            }
            attemptedSearchIds.add(searchSession.id);
            nextTask = searchSession.search.takeTask();
        }
        if (!nextTask && this.currentCompletion && !this.currentCompletion.isComplete()) {
            nextTask = this.currentCompletion.takeTask();
        }

        if (!nextTask) {
            return;
        }
        console.debug(`Scheduling task id=${nextTask.taskId || 'null'} group=${nextTask.groupId || 'null'}`);
        this.workerBusy[workerIndex] = true;
        this.workers[workerIndex].postMessage(nextTask);
    }

    /** Returns the newest live session for compatibility with older callers. */
    private latestSession(): FeatureSearchSessionInternal | undefined {
        return this.searchSessions[this.searchSessions.length - 1];
    }

    /** Returns one internal live session by runtime id. */
    private getInternalSession(id: string): FeatureSearchSessionInternal | undefined {
        return this.searchSessions.find(session => session.id === id);
    }

    /** Emits a shallow session snapshot so structural UI can re-render. */
    private notifySessionsChanged(): void {
        this.sessionsChanged.next([...this.searchSessions]);
    }

    /** Chooses the next active search in round-robin order. */
    private nextRunnableSearchSession(): FeatureSearchSessionInternal | undefined {
        if (!this.searchSessions.length) {
            return undefined;
        }
        for (let offset = 0; offset < this.searchSessions.length; offset++) {
            const index = (this.searchScheduleCursor + offset) % this.searchSessions.length;
            const session = this.searchSessions[index];
            if (!session.search.isComplete() && !session.search.paused) {
                this.searchScheduleCursor = (index + 1) % this.searchSessions.length;
                return session;
            }
        }
        return undefined;
    }

    /** Returns one session's cached marker list, rebuilding it only after mutations. */
    private getSessionSearchResultPoints(session: FeatureSearchSessionInternal): SearchResultPoint[] {
        if (session.searchResultPointsCacheDirty) {
            session.searchResultPointsCache = Array.from(session.searchResultPointsByFeatureKey.values());
            session.searchResultPointsCacheDirty = false;
        }
        return session.searchResultPointsCache;
    }

    /** Clears one session's marker caches and returns whether anything changed. */
    private clearSessionSearchResultPoints(session: FeatureSearchSessionInternal): boolean {
        if (!session.searchResultPointsByFeatureKey.size
            && !session.searchResultPointsCache.length
            && !session.searchResultPointsCacheDirty) {
            return false;
        }
        session.searchResultPointsByFeatureKey.clear();
        session.searchResultPointsCache = [];
        session.searchResultPointsCacheDirty = false;
        session.searchResultPointsVersion += 1;
        return true;
    }

    /** Bumps the aggregate marker-layer version consumed by the map overlay. */
    private bumpSearchResultLayersVersion(): void {
        this.searchResultLayersVersionValue += 1;
    }

    /** Updates one session's configured marker color and lazily resolves its tinted atlas. */
    private updateSessionColor(session: FeatureSearchSessionInternal, color: string): void {
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
     * Returns the currently focused view's prioritized tile list, which also defines search order.
     */
    private orderedTilesForSearchProcessing(): FeatureTile[] {
        const viewCount = this.stateService.numViewsState.getValue();
        if (viewCount <= 0) {
            return [];
        }
        const focusedView = this.stateService.focusedView;
        const viewIndex = Math.max(0, Math.min(viewCount - 1, focusedView));
        return this.mapService.getPrioritisedTiles(viewIndex);
    }

    /**
     * Returns whether the viewport still expects this tile, even if its data has not finished loading yet.
     */
    private isTileStillExpected(tile: FeatureTile): boolean {
        return this.mapService.getRequestedMaxStageForTile(tile) !== null;
    }

    /**
     * Builds a search-worker payload from the currently loaded stage blobs for one tile.
     */
    private createSearchTask(tile: FeatureTile, search: SearchState): SearchWorkerTask | null {
        const tileBlobs = tile.stageBlobs().map(stageBlob => stageBlob.blob);
        if (!tileBlobs.length) {
            return null;
        }
        const tileParser = this.mapService.tileLayerParser;
        return {
            type: TASK_SEARCH,
            tileId: tile.tileId,
            tileBlobs,
            fieldDictBlob: uint8ArrayFromWasm((buf) => {
                tileParser?.getFieldDict(buf, tile.nodeId)
            })!,
            query: search.query,
            dataSourceInfo: uint8ArrayFromWasm((buf) => {
                tileParser?.getDataSourceInfo(buf, tile.mapName)
            })!,
            nodeId: tile.nodeId,
            taskId: this.generateTaskId(),
            groupId: search.id
        };
    }

    /**
     * Adds a search task to the job manager if the tile currently exposes any searchable blobs.
     */
    private enqueueSearchTask(tile: FeatureTile, search: SearchState): boolean {
        const task = this.createSearchTask(tile, search);
        if (!task) {
            return false;
        }
        this.jobGroupManager.addTask(task);
        return true;
    }

    /**
     * Revisits tiles that were waiting for staged data and enqueues them as soon as they become searchable.
     */
    private enqueueReadyPendingSearchTiles() {
        let anyEnqueuedTask = false;

        for (const session of this.searchSessions) {
            if (!session.pendingSearchTilesByKey.size) {
                continue;
            }

            let stateChanged = false;
            let enqueuedTask = false;
            for (const [tileKey] of Array.from(session.pendingSearchTilesByKey.entries())) {
                const tile = this.mapService.loadedTileLayers.get(tileKey);
                if (!tile || tile.disposed) {
                    session.pendingSearchTilesByKey.delete(tileKey);
                    session.search.markTileReady(tileKey);
                    stateChanged = true;
                    continue;
                }
                if (!this.mapService.isTileInspectionDataComplete(tile)) {
                    if (!this.isTileStillExpected(tile)) {
                        session.pendingSearchTilesByKey.delete(tileKey);
                        session.search.markTileReady(tileKey);
                        stateChanged = true;
                    }
                    continue;
                }
                session.pendingSearchTilesByKey.delete(tileKey);
                session.search.markTileReady(tileKey);
                enqueuedTask = this.enqueueSearchTask(tile, session.search) || enqueuedTask;
                stateChanged = true;
            }

            if (stateChanged) {
                this.progress.next(session);
                this.maybeStartDiagnosticsForCompletedSearch(session.search);
            }
            anyEnqueuedTask = anyEnqueuedTask || enqueuedTask;
        }
        if (anyEnqueuedTask) {
            this.runWorkers();
        }
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
     * Adds a unique search marker if the match exposes a valid cartographic position.
     */
    private tryAddSearchResultPoint(
        session: FeatureSearchSessionInternal,
        mapId: string,
        layerId: string,
        featureId: string,
        position: SearchResultPosition
    ): boolean {
        const cartographicRad = position.cartographicRad;
        if (!cartographicRad) {
            return false;
        }
        const lon = GeoMath.toDegrees(cartographicRad.longitude);
        const lat = GeoMath.toDegrees(cartographicRad.latitude);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            return false;
        }
        const featureKey = `${mapId}/${layerId}/${featureId}`;
        if (session.searchResultPointsByFeatureKey.has(featureKey)) {
            return false;
        }
        session.searchResultPointsByFeatureKey.set(featureKey, {
            coordinates: [lon, lat],
            mapId,
            layerId,
            featureId,
            featureKey
        });
        session.searchResultPointsCacheDirty = true;
        return true;
    }

    /**
     * Lazily recolors the cluster icon atlas so marker styling tracks the configured highlight color.
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
