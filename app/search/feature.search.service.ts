import {Injectable} from "@angular/core";
import {BehaviorSubject, filter, Subject, take} from "rxjs";
import {MapDataService} from "../mapdata/map.service";
import {CompletionCandidate, CompletionCandidatesForTile, CompletionWorkerTask, DiagnosticsMessage, SearchResultForTile, SearchResultPosition, SearchWorkerTask, TraceResult, WorkerResult, WorkerTask} from "./search.worker";
import {Cartographic, Cartesian3, GeoMath, Rectangle} from "../integrations/geo";
import {FeatureTile} from "../mapdata/features.model";
import {coreLib, uint8ArrayFromWasm} from "../integrations/wasm";
import {JobGroup, JobGroupManager, JobGroupType} from "./job-group";
import {AppStateService, FEATURE_SEARCH_DIALOG_LAYOUT_ID, SEARCH_DOCK_TAB_ID} from "../shared/appstate.service";

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

    workers: Array<Worker> = []
    private workerBusy: Array<boolean> = [];
    private workersReady: Promise<void> | null = null;

    jobGroupManager: JobGroupManager = new JobGroupManager();
    currentCompletion: JobGroup | null = null;
    taskIdCounter: number = 0;
    taskGroupIdCounter: number = 0;

    resultTree: FeatureSearchQuadTree = new FeatureSearchQuadTree();
    resultsPerTile: Map<string, SearchResultForTile> = new Map<string, SearchResultForTile>();
    private pendingSearchTilesByKey = new Map<string, FeatureTile>();
    private searchResultPointsByFeatureKey = new Map<string, SearchResultPoint>();
    private searchResultPointsCache: SearchResultPoint[] = [];
    private searchResultPointsCacheDirty = false;
    private searchResultPointsVersionValue = 0;

    currentSearch: SearchState|null = null;
    pointColor: string = "#ea4336";
    timeElapsed: string = this.formatTime(0);
    totalFeatureCount: number = 0;
    progress: BehaviorSubject<SearchState|null> = new BehaviorSubject<SearchState|null>(null);
    searchResults: Array<{ label: string; mapId: string; layerId: string; featureId: string }> = [];
    traceResults: Array<any> = [];

    diagnosticsMessages: BehaviorSubject<DiagnosticsMessage[]> = new BehaviorSubject<DiagnosticsMessage[]>([]);
    diagnosticsMessageLimit: number = 25;

    completionPending: Subject<boolean> = new Subject<boolean>();
    completionCandidates: Subject<CompletionCandidate[]> = new Subject<CompletionCandidate[]>();
    completionCandidateLimit: number = 15;
    private completionCandidateList: CompletionCandidate[] = [];

    showFeatureSearchDialog: boolean = false;

    private startTime: number = 0;
    private endTime: number = 0;
    public errors: Set<string> = new Set();
    private tintedAtlasByColor = new Map<string, string>();
    private baseAtlasImagePromise: Promise<HTMLImageElement> | null = null;
    private clusterIconAtlasUrl = FeatureSearchService.SEARCH_ICON_ATLAS_URL;
    private locationMarkerGraphicUrl: string | null = null;

    public fixedDiagnosticsSearchQuery: Subject<string> = new Subject<string>();

    /**
     * Initializes marker styling and listens for staged tile updates that can unblock pending searches.
     */
    constructor(private mapService: MapDataService,
                private stateService: AppStateService) {
        this.updatePointColor();
        this.stateService.ready.pipe(
            filter((ready): ready is true => ready),
            take(1)
        ).subscribe(() => this.resetStaleDockState());
        this.mapService.tileDataChanged.subscribe(change => {
            if (!this.pendingSearchTilesByKey.has(change.tileKey)) {
                return;
            }
            this.enqueueReadyPendingSearchTiles();
        });
    }

    /** Removes persisted dock chrome for searches that cannot survive a page reload. */
    private resetStaleDockState(): void {
        if (!this.currentSearch && this.stateService.isSurfaceDocked(FEATURE_SEARCH_DIALOG_LAYOUT_ID)) {
            this.stateService.setSurfaceDocked(FEATURE_SEARCH_DIALOG_LAYOUT_ID, false, SEARCH_DOCK_TAB_ID);
        }
    }

    /**
     * Returns the icon atlas currently used for clustered search markers.
     */
    getSearchClusterIconAtlasUrl(): string {
        return this.clusterIconAtlasUrl;
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
        return this.searchResultPointsVersionValue;
    }

    /**
     * Returns the cached flat search-marker list, rebuilding it only when the underlying map changes.
     */
    getSearchResultPoints(): SearchResultPoint[] {
        if (this.searchResultPointsCacheDirty) {
            this.searchResultPointsCache = Array.from(this.searchResultPointsByFeatureKey.values());
            this.searchResultPointsCacheDirty = false;
        }
        return this.searchResultPointsCache;
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

            // Notify the job-group if the task has an id
            if (result.taskId) {
                this.jobGroupManager.completeTask(result.taskId, result);
            }

            switch (result.type) {
                case 'SearchResultForTile':
                    this.addSearchResult(result as SearchResultForTile);
                    break;
                case 'CompletionCandidatesForTile':
                    this.addCompletionCandidates(result as CompletionCandidatesForTile);
                    break;
            }

            this.scheduleNextTask(index);
        };
    }

    /**
     * Starts a fresh feature search over the currently prioritized tiles.
     *
     * Tiles whose staged data is still incomplete remain in a pending set until tileDataChanged says they are ready.
     */
    run(query: string) {
        // Fresh search.
        this.clear();
        this.startTime = Date.now();

        this.currentSearch = new SearchState(query, this.generateTaskGroupId());
        this.jobGroupManager.addGroup(this.currentSearch);

        this.pendingSearchTilesByKey.clear();

        for (const tile of this.orderedTilesForSearchProcessing()) {
            if (!this.mapService.isTileInspectionDataComplete(tile)) {
                if (this.isTileStillExpected(tile)) {
                    this.pendingSearchTilesByKey.set(tile.mapTileKey, tile);
                    this.currentSearch.markTilePending(tile.mapTileKey);
                }
                continue;
            }
            this.enqueueSearchTask(tile, this.currentSearch);
        }

        // Set up completion callback to trigger diagnostics after
        // all tasks of the group are done. Note: This will only ever
        // be called if a search truly finishes (is not superseded by a newer one).
        this.currentSearch.onComplete((group: JobGroup) => {
            this.getDiagnosticsForCompletedSearch(group.id);
        });

        this.progress.next(this.currentSearch);
        this.enqueueReadyPendingSearchTiles();
        this.maybeStartDiagnosticsForCompletedSearch(this.currentSearch);
        this.runWorkers();
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

    /**
     * Pauses dispatch of further search tasks while preserving current partial results.
     */
    pause() {
        if (!this.currentSearch) {
            return;
        }
        this.currentSearch.paused = true;
        this.endTime = Date.now();
        this.timeElapsed = this.formatTime(this.endTime - this.startTime);
        this.progress.next(this.currentSearch);
    }

    /**
     * Resumes a paused search and hands queued work back to idle workers.
     */
    resume() {
        if (!this.currentSearch) {
            return;
        }
        this.currentSearch.paused = false;
        this.progress.next(this.currentSearch);
        this.runWorkers();
    }

    /**
     * Stops the active search without clearing the partial result state.
     */
    stop() {
        if (!this.currentSearch) {
            return;
        }
        this.pendingSearchTilesByKey.clear();
        this.currentSearch.stop();
        this.endTime = Date.now();
        this.timeElapsed = this.formatTime(this.endTime - this.startTime);
        this.currentSearch.paused = false;
        this.progress.next(this.currentSearch);
    }

    /**
     * Resets all search, completion, diagnostics, and overlay state to the idle baseline.
     */
    clear() {
        if (this.currentSearch) {
            this.jobGroupManager.removeGroup(this.currentSearch.id);
        }
        this.currentSearch = null;
        this.resultTree = new FeatureSearchQuadTree();
        this.resultsPerTile.clear();
        this.pendingSearchTilesByKey.clear();
        this.clearSearchResultPoints();
        this.searchResults = [];
        this.traceResults = [];
        this.diagnosticsMessages.next([]);
        this.totalFeatureCount = 0;
        this.startTime = 0;
        this.endTime = 0;
        this.timeElapsed = this.formatTime(0);
        this.errors.clear();
        this.completionCandidateList = [];
        this.completionPending.next(false);
        this.completionCandidates.next([]);
        this.progress.next(null);
        this.jobGroupManager.clearCompleted();
        this.currentCompletion = null;
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
        if (!completedSearchGroup || this.currentSearch?.id !== searchGroupId) {
            return;
        }

        const messages = coreLib.simfilGetDiagnostics(completedSearchGroup.query, Array.from(completedSearchGroup.getDiagnostics()))
        this.diagnosticsMessages.next(messages.slice(0, this.diagnosticsMessageLimit));
    }

    /**
     * Starts diagnostics aggregation only when the completed group still matches the visible search.
     */
    private maybeStartDiagnosticsForCompletedSearch(group: JobGroup): void {
        if (group.type !== 'search' || !group.isComplete()) {
            return;
        }
        if (!this.currentSearch || this.currentSearch.id !== group.id) {
            return;
        }
        console.debug(`Search group completed (id: ${group.id}). Collecting diagnostics for query ${group.query}`);
        this.getDiagnosticsForCompletedSearch(group.id);
    }

    /**
     * Cancels any in-flight completion job before a newer query supersedes it.
     */
    public clearCurrentCompletion() {
        // Remove all pending completion tasks
        this.currentCompletion?.stop();
        this.currentCompletion = null;
    }

    /**
     * Starts a completion fan-out across the currently prioritized tiles.
     */
    public completeQuery(query: string, point: number | undefined) {
        this.clearCurrentCompletion();

        // Create completion job group
        const completionGroup = this.jobGroupManager.createGroup('completion', query, this.generateTaskGroupId());
        this.currentCompletion = completionGroup
        completionGroup.onComplete((group: JobGroup) => {
            console.debug(`Completion group completed (id: ${group.id}, current: ${this.currentCompletion?.id})`)
            if (this.currentCompletion?.id === group.id)
                this.completionPending.next(false);
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

        this.completionCandidateList = [];
        this.completionPending.next(true);
        this.completionCandidates.next([]);

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

        this.completionCandidateList = this.completionCandidateList
            .concat(candidates.candidates)
            .filter((item, index, array) => array.findIndex(other => other.query === item.query) === index) // Remove duplicates
            .slice(0, this.completionCandidateLimit);

        this.completionCandidates.next(this.completionCandidateList);
    }

    /**
     * Integrates one tile's matches into the visible result tree, overlays, traces, and diagnostics.
     */
    private addSearchResult(tileResult: SearchResultForTile) {
        if (!this.currentSearch) {
            return;
        }

        // Ignore results that are not related to the ongoing query.
        if (tileResult.groupId !== this.currentSearch.id) {
            return;
        }

        if (tileResult.error) {
            this.errors.add(tileResult.error);
        }

        // Add trace results
        for (let [key, trace] of Object.entries(tileResult.traces || {})) {
            this.traceResults.push({
                name: `${key}`,
                calls: trace.calls,
                totalus: trace.totalus,
                values: trace.values,
            })
        }

        // Add diagnostics to the current search group
        if (tileResult.diagnostics) {
            this.currentSearch.addDiagnostics(tileResult.diagnostics);
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
            this.resultsPerTile.set(mapTileKey, {
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
                addedPoint = this.tryAddSearchResultPoint(mapId, layerId, result[1], result[2]) || addedPoint;
                const featureId = result[1];
                const id: SearchResultPrimitiveId = {type: "SearchResult", index: this.searchResults.length};
                this.searchResults.push({label: `${featureId}`, mapId: mapId, layerId: layerId, featureId: featureId});
                treeResults.push([id, result[2], mapLayerId]);
            }
            if (addedPoint) {
                this.searchResultPointsVersionValue += 1;
            }
            this.resultTree.insert(tileResult.tileId, mapLayerId, treeResults);
        }

        // Broadcast the search progress.
        this.endTime = Date.now();
        this.timeElapsed = this.formatTime(this.endTime - this.startTime);
        this.totalFeatureCount += tileResult.numFeatures;
        this.progress.next(this.currentSearch);
    }

    /**
     * Chooses the next task for a worker, preferring search over completion while a search is active.
     */
    private scheduleNextTask(workerIndex: number) {
        let nextTask = undefined;
        if (this.currentSearch && !this.currentSearch.isComplete() && !this.currentSearch.paused) {
            nextTask = this.currentSearch.takeTask();
        }
        else if (this.currentCompletion && !this.currentCompletion.isComplete()) {
            nextTask = this.currentCompletion.takeTask();
        }

        if (!nextTask) {
            return;
        }
        console.debug(`Scheduling task id=${nextTask.taskId || 'null'} group=${nextTask.groupId || 'null'}`);
        this.workerBusy[workerIndex] = true;
        this.workers[workerIndex].postMessage(nextTask);
    }

    /**
     * Rebuilds the cluster marker atlas for the current highlight color and notifies listeners.
     */
    updatePointColor() {
        const normalizedColor = this.normalizeHexColor(this.pointColor);
        this.pointColor = normalizedColor;
        this.ensureTintedClusterAtlas(normalizedColor)
            .then(atlasUrl => {
                this.clusterIconAtlasUrl = atlasUrl;
                this.progress.next(this.currentSearch);
            })
            .catch(() => {
                this.clusterIconAtlasUrl = FeatureSearchService.SEARCH_ICON_ATLAS_URL;
                this.progress.next(this.currentSearch);
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
        const activeSearch = this.currentSearch;
        if (!activeSearch || !this.pendingSearchTilesByKey.size) {
            return;
        }

        let stateChanged = false;
        let enqueuedTask = false;

        for (const [tileKey] of Array.from(this.pendingSearchTilesByKey.entries())) {
            const tile = this.mapService.loadedTileLayers.get(tileKey);
            if (!tile || tile.disposed) {
                this.pendingSearchTilesByKey.delete(tileKey);
                activeSearch.markTileReady(tileKey);
                stateChanged = true;
                continue;
            }
            if (!this.mapService.isTileInspectionDataComplete(tile)) {
                if (!this.isTileStillExpected(tile)) {
                    this.pendingSearchTilesByKey.delete(tileKey);
                    activeSearch.markTileReady(tileKey);
                    stateChanged = true;
                }
                continue;
            }
            this.pendingSearchTilesByKey.delete(tileKey);
            activeSearch.markTileReady(tileKey);
            enqueuedTask = this.enqueueSearchTask(tile, activeSearch) || enqueuedTask;
            stateChanged = true;
        }

        if (!stateChanged) {
            return;
        }

        this.progress.next(activeSearch);
        this.maybeStartDiagnosticsForCompletedSearch(activeSearch);
        if (enqueuedTask) {
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
        if (this.searchResultPointsByFeatureKey.has(featureKey)) {
            return false;
        }
        this.searchResultPointsByFeatureKey.set(featureKey, {
            coordinates: [lon, lat],
            mapId,
            layerId,
            featureId,
            featureKey
        });
        this.searchResultPointsCacheDirty = true;
        return true;
    }

    /**
     * Clears the marker caches and bumps the version only when something actually changed.
     */
    private clearSearchResultPoints(): void {
        if (!this.searchResultPointsByFeatureKey.size
            && !this.searchResultPointsCache.length
            && !this.searchResultPointsCacheDirty) {
            return;
        }
        this.searchResultPointsByFeatureKey.clear();
        this.searchResultPointsCache = [];
        this.searchResultPointsCacheDirty = false;
        this.searchResultPointsVersionValue += 1;
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
            data[i] = Math.round((r / 255) * targetR);
            data[i + 1] = Math.round((g / 255) * targetG);
            data[i + 2] = Math.round((b / 255) * targetB);
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
