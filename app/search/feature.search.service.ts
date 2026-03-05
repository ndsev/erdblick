import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import {MapDataService} from "../mapdata/map.service";
import {CompletionCandidate, CompletionCandidatesForTile, CompletionWorkerTask, DiagnosticsMessage, DiagnosticsResultsForTile, DiagnosticsWorkerTask, SearchResultForTile, SearchResultPosition, SearchWorkerTask, TraceResult, WorkerResult, WorkerTask} from "./search.worker";
import {Cartographic, Cartesian3, Rectangle} from "../integrations/geo";
import {FeatureTile} from "../mapdata/features.model";
import {coreLib, uint8ArrayFromWasm} from "../integrations/wasm";
import {JobGroup, JobGroupManager, JobGroupType} from "./job-group";
import {AppStateService} from "../shared/appstate.service";

export const MAX_VISIBLE_TILES_PER_LEVEL = 69;
export const MAX_ZOOM_LEVEL = 15;
export const SAFE_ZOOM_LEVEL = 10;

export interface SearchResultPrimitiveId {
    type: string,
    index: number
}

const TASK_SEARCH = 'SearchWorkerTask' as const;
const TASK_DIAGNOSTICS = 'DiagnosticsWorkerTask' as const;
const TASK_COMPLETION = 'CompletionWorkerTask' as const;

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

class FeatureSearchQuadTreeNode {
    tileId: bigint;
    parentId: bigint | null;
    level: number;
    children: Array<FeatureSearchQuadTreeNode>;
    countPerLayer: Map<string, number>;
    markers: Array<[SearchResultPrimitiveId, SearchResultPosition, string]> = [];
    rectangle: Rectangle;
    center: Cartesian3 | null;

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

    containsPoint(point: Cartographic) {
       return Rectangle.contains(this.rectangle, point);
    }

    contains(markers: Array<[SearchResultPrimitiveId, SearchResultPosition, string]>) {
        return markers.some(marker =>
            this.containsPoint(marker[1].cartographicRad as Cartographic)
        );
    }

    filterPointsForNode(markers: Array<[SearchResultPrimitiveId, SearchResultPosition, string]>) {
        return markers.filter(marker =>
            this.containsPoint(marker[1].cartographicRad as Cartographic)
        );
    }

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

    incrementCountForMapLayer(mapLayer: string, increment: number) {
        if (this.countPerLayer.has(mapLayer)) {
            const currentCount = this.countPerLayer.get(mapLayer)!;
            this.countPerLayer.set(mapLayer, currentCount + increment);
            return;
        }
        this.countPerLayer.set(mapLayer, increment);
    }
}

class FeatureSearchQuadTree {
    root: FeatureSearchQuadTreeNode;
    private maxDepth: number = MAX_ZOOM_LEVEL;

    constructor() {
        this.root = new FeatureSearchQuadTreeNode(-1n, null, -1, new Map());
    }

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
            let next: Array<FeatureSearchQuadTreeNode> = [];
            while (currentLevel <= this.maxDepth) {
                next = [];
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

export class SearchState extends JobGroup {
    constructor(query: string, id: string, public paused = false) {
        super('search', query, id);
    }
}

@Injectable({providedIn: 'root'})
export class FeatureSearchService {
    private static readonly SEARCH_ICON_ATLAS_URL = "/bundle/images/search/location-icon-atlas.png";
    private static readonly SEARCH_ICON_MAPPING_URL = "/bundle/images/search/location-icon-mapping.json";

    workers: Array<Worker> = []
    private workerBusy: Array<boolean> = [];
    private diagnosticsQueue: Array<WorkerTask> = [];
    private workersReady: Promise<void> | null = null;

    jobGroupManager: JobGroupManager = new JobGroupManager();
    currentCompletion: JobGroup | null = null;
    taskIdCounter: number = 0;
    taskGroupIdCounter: number = 0;

    resultTree: FeatureSearchQuadTree = new FeatureSearchQuadTree();
    resultsPerTile: Map<string, SearchResultForTile> = new Map<string, SearchResultForTile>();

    currentSearch: SearchState|null = null;
    pointColor: string = "#ea4336";
    timeElapsed: string = this.formatTime(0);
    totalFeatureCount: number = 0;
    progress: Subject<SearchState|null> = new Subject<SearchState|null>();
    searchResults: Array<{ label: string; mapId: string; layerId: string; featureId: string }> = [];
    traceResults: Array<any> = [];

    diagnosticsMessages: Subject<DiagnosticsMessage[]> = new Subject<DiagnosticsMessage[]>();
    diagnosticsMessageLimit: number = 25;
    private diagnosticsMessagesList: DiagnosticsMessage[] = [];

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

    public fixedDiagnosticsSearchQuery: Subject<string> = new Subject<string>();

    constructor(private mapService: MapDataService,
                private stateService: AppStateService) {
        this.updatePointColor();
    }

    getSearchClusterIconAtlasUrl(): string {
        return this.clusterIconAtlasUrl;
    }

    getSearchClusterIconMappingUrl(): string {
        return FeatureSearchService.SEARCH_ICON_MAPPING_URL;
    }

    public initializeWorkers(): Promise<void> {
        if (!this.workersReady) {
            this.workersReady = this.initWorkers();
        }
        return this.workersReady;
    }

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

    private async fetchWorkerBlobUrl(workerModuleUrl: string): Promise<string> {
        const response = await fetch(workerModuleUrl, {cache: 'force-cache'});
        if (!response.ok) {
            throw new Error(`Failed to fetch search worker module (${response.status} ${response.statusText})`);
        }
        const blob = await response.blob();
        return URL.createObjectURL(blob);
    }

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
                case 'DiagnosticsResultsForTile':
                    this.addDiagnostics(result as DiagnosticsResultsForTile);
                    break;
            }

            this.scheduleNextTask(index);
        };
    }

    run(query: string) {
        // Fresh search.
        this.clear();
        this.startTime = Date.now();

        this.currentSearch = new SearchState(query, this.generateTaskGroupId());
        this.jobGroupManager.addGroup(this.currentSearch);

        // Set up completion callback to trigger diagnostics after
        // all tasks of the group are done. Note: This will only ever
        // be called if a search truly finishes (is not superseded by a newer one).
        this.currentSearch.onComplete((group: JobGroup) => {
            console.debug(`Search group completed (id: ${group.id}). Collecting diagnostics for query ${group.query}`);
            this.startDiagnosticsForCompletedSearch(group.query, group.id);
        });

        const tileParser = this.mapService.tileLayerParser;
        const makeTask = (tile: FeatureTile): SearchWorkerTask | null => {
            const tileBlobs = tile.stageBlobs().map(stageBlob => stageBlob.blob);
            if (!tileBlobs.length) {
                return null;
            }
            const taskId = this.generateTaskId();
            const task: SearchWorkerTask = {
                type: TASK_SEARCH,
                tileId: tile.tileId,
                tileBlobs,
                fieldDictBlob: uint8ArrayFromWasm((buf) => {
                    tileParser?.getFieldDict(buf, tile.nodeId)
                })!,
                query: query,
                dataSourceInfo: uint8ArrayFromWasm((buf) => {
                    tileParser?.getDataSourceInfo(buf, tile.mapName)
                })!,
                nodeId: tile.nodeId,
                taskId: taskId,
                groupId: this.currentSearch!.id
            };

            this.jobGroupManager.addTask(task);
            return task;
        };

        for (const tile of this.orderedTilesForSearchProcessing()) {
            makeTask(tile);
        }

        this.progress.next(this.currentSearch);
        this.runWorkers();
    }

    // Send a task to each worker to start processing.
    // Further tasks will be picked up in the worker's
    // onMessage callback.
    private runWorkers() {
        this.workers.forEach((worker, index) => {
            if (this.workerBusy[index]) {
                return;
            }
            this.scheduleNextTask(index);
        });
    }

    pause() {
        if (!this.currentSearch) {
            return;
        }
        this.currentSearch.paused = true;
        this.endTime = Date.now();
        this.timeElapsed = this.formatTime(this.endTime - this.startTime);
        this.progress.next(this.currentSearch);
    }

    resume() {
        if (!this.currentSearch) {
            return;
        }
        this.currentSearch.paused = false;
        this.progress.next(this.currentSearch);
        this.runWorkers();
    }

    stop() {
        if (!this.currentSearch) {
            return;
        }
        this.currentSearch.stop();
        this.endTime = Date.now();
        this.timeElapsed = this.formatTime(this.endTime - this.startTime);
        this.currentSearch.paused = false;
        this.progress.next(this.currentSearch);
    }

    clear() {
        this.stop();
        this.resultTree = new FeatureSearchQuadTree();
        this.resultsPerTile.clear();
        this.progress.next(null);
        this.searchResults = [];
        this.traceResults = [];
        this.diagnosticsMessagesList = [];
        this.diagnosticsMessages.next([]);
        this.totalFeatureCount = 0;
        this.startTime = 0;
        this.endTime = 0;
        this.timeElapsed = this.formatTime(0);
        this.errors.clear();
        this.completionCandidateList = [];
        this.completionPending.next(false);
        this.completionCandidates.next([]);
        if (this.currentSearch) {
            this.jobGroupManager.removeGroup(this.currentSearch.id)
        }
        this.currentSearch = null;
        this.jobGroupManager.clearCompleted();
        this.currentCompletion = null;
    }

    /// Generate a new task id
    private generateTaskId(): string {
        return `task_${Date.now()}_${++this.taskIdCounter}`;
    }

    /// Generate a new task-group id
    private generateTaskGroupId(): string {
        return `group_${Date.now()}_${++this.taskGroupIdCounter}`;
    }

    private startDiagnosticsForCompletedSearch(query: string, searchGroupId: string) {
        const completedSearchGroup = this.jobGroupManager.getGroup(searchGroupId);
        if (!completedSearchGroup || this.currentSearch?.id !== searchGroupId) {
            return;
        }

        const diagnosticsGroup = this.jobGroupManager.createGroup('diagnostics', query, this.generateTaskGroupId());

        const tileParser = this.mapService.tileLayerParser;
        const makeDiagnosticsTask = (tile: FeatureTile): DiagnosticsWorkerTask | null => {
            const tileBlobs = tile.stageBlobs().map(stageBlob => stageBlob.blob);
            if (!tileBlobs.length) {
                return null;
            }
            const taskId = this.generateTaskId();
            const task: DiagnosticsWorkerTask = {
                type: TASK_DIAGNOSTICS,
                tileBlobs,
                fieldDictBlob: uint8ArrayFromWasm((buf) => {
                    tileParser?.getFieldDict(buf, tile.nodeId)
                })!,
                query: query,
                dataSourceInfo: uint8ArrayFromWasm((buf) => {
                    tileParser?.getDataSourceInfo(buf, tile.mapName)
                })!,
                nodeId: tile.nodeId,
                diagnostics: Array.from(completedSearchGroup.getDiagnostics()),
                taskId: taskId,
                groupId: diagnosticsGroup.id,
            };

            this.jobGroupManager.addTask(task);
            return task;
        };

        let diagTasks: DiagnosticsWorkerTask[] = [];
        for (const tile of this.orderedTilesForSearchProcessing()) {
            const task = makeDiagnosticsTask(tile);
            if (task) {
                diagTasks.push(task);
            }
        }
        this.diagnosticsQueue.push(...diagTasks);
        this.runWorkers();
    }

    public clearCurrentCompletion() {
        // Remove all pending completion tasks
        this.currentCompletion?.stop();
        this.currentCompletion = null;
    }

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

    private addCompletionCandidates(candidates: CompletionCandidatesForTile) {
        if (candidates.groupId !== this.currentCompletion?.id)
            return;

        this.completionCandidateList = this.completionCandidateList
            .concat(candidates.candidates)
            .filter((item, index, array) => array.findIndex(other => other.query === item.query) === index) // Remove duplicates
            .slice(0, this.completionCandidateLimit);

        this.completionCandidates.next(this.completionCandidateList);
    }

    private addDiagnostics(result : DiagnosticsResultsForTile) {
        this.diagnosticsMessagesList = this.diagnosticsMessagesList
            .concat(result.messages)
            .filter((item, index, array) => {
                return array.findIndex(other => {
                    return other.message === item.message && other.location?.offset === item.location?.offset;
                }) === index
            })
            .slice(0, this.diagnosticsMessageLimit);
        this.diagnosticsMessages.next(this.diagnosticsMessagesList);
    }

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
            let canonicalTileKey = mapTileKey;
            try {
                const [mapId, layerId, tileId] = coreLib.parseMapTileKey(mapTileKey);
                canonicalTileKey = coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
            } catch (_error) {
                canonicalTileKey = mapTileKey;
            }
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
            const [mapId, layerId, _] = coreLib.parseMapTileKey(mapTileKey);
            const mapLayerId = `${mapId}/${layerId}`;
            this.resultsPerTile.set(mapTileKey, {
                ...tileResult,
                matches: dedupedMatches
            });
            this.resultTree.insert(tileResult.tileId, mapLayerId, dedupedMatches.map(result => {
                if (result[2].cartographic) {
                    result[2].cartographicRad = Cartographic.fromDegrees(
                        result[2].cartographic.x,
                        result[2].cartographic.y,
                        result[2].cartographic.z
                    );
                }
                result[2].cartographic = null;
                const featureId = result[1];
                const id: SearchResultPrimitiveId = {type: "SearchResult", index: this.searchResults.length};
                this.searchResults.push({label: `${featureId}`, mapId: mapId, layerId: layerId, featureId: featureId});
                return [id, result[2], mapLayerId];
            }));
        }

        // Broadcast the search progress.
        this.endTime = Date.now();
        this.timeElapsed = this.formatTime(this.endTime - this.startTime);
        this.totalFeatureCount += tileResult.numFeatures;
        this.progress.next(this.currentSearch);
    }

    private scheduleNextTask(workerIndex: number) {
        let nextTask = undefined;
        if (this.currentSearch && !this.currentSearch.isComplete() && !this.currentSearch.paused) {
            nextTask = this.currentSearch.takeTask();
        }
        else if (this.diagnosticsQueue.length) {
            nextTask = this.diagnosticsQueue.shift();
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

    private orderedTilesForSearchProcessing(): FeatureTile[] {
        const viewCount = this.stateService.numViewsState.getValue();
        if (viewCount <= 0) {
            return [];
        }
        const focusedView = this.stateService.focusedView;
        const viewIndex = Math.max(0, Math.min(viewCount - 1, focusedView));
        return this.mapService.getPrioritisedTiles(viewIndex);
    }

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

    private parseHexRgb(color: string): [number, number, number] {
        return [
            parseInt(color.slice(1, 3), 16),
            parseInt(color.slice(3, 5), 16),
            parseInt(color.slice(5, 7), 16)
        ];
    }

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
