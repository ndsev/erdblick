import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import {MapService} from "../mapdata/map.service";
import {CompletionCandidate, CompletionCandidatesForTile, CompletionWorkerTask, DiagnosticsMessage, DiagnosticsResultsForTile, DiagnosticsWorkerTask, SearchResultForTile, SearchResultPosition, SearchWorkerTask, TraceResult, WorkerResult, WorkerTask} from "./search.worker";
import {BillboardCollection, Cartographic, Cartesian3, Rectangle} from "../integrations/cesium";
import {FeatureTile} from "../mapdata/features.model";
import {coreLib, uint8ArrayFromWasm} from "../integrations/wasm";
import {JobGroup, JobGroupManager} from "./job-group";
import {AppStateService} from "../shared/appstate.service";

export const MAX_ZOOM_LEVEL = 15;

export interface SearchResultPrimitiveId {
    type: string,
    index: number
}

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
    count: number;
    markers: Array<[SearchResultPrimitiveId, SearchResultPosition]> = [];
    rectangle: Rectangle;
    center: Cartesian3 | null;

    constructor(tileId: bigint,
                parentTileId: bigint | null,
                level: number,
                count: number,
                children: Array<FeatureSearchQuadTreeNode> = [],
                markers: Array<[SearchResultPrimitiveId, SearchResultPosition]> = []) {
        this.tileId = tileId;
        this.parentId = parentTileId;
        this.level = level;
        this.children = children;
        this.count = count;
        this.markers = markers;

        const tileBox = tileId >= 0 ? coreLib.getTileBox(tileId) as Array<number> : [0, 0, 0, 0];
        this.rectangle = Rectangle.fromDegrees(tileBox[0], tileBox[1], tileBox[2], tileBox[3]);
        this.center = null;
    }

    containsPoint(point: Cartographic) {
       return Rectangle.contains(this.rectangle, point);
    }

    contains(markers: Array<[SearchResultPrimitiveId, SearchResultPosition]>) {
        return markers.some(marker =>
            this.containsPoint(marker[1].cartographicRad as Cartographic)
        );
    }

    filterPointsForNode(markers: Array<[SearchResultPrimitiveId, SearchResultPosition]>) {
        return markers.filter(marker =>
            this.containsPoint(marker[1].cartographicRad as Cartographic)
        );
    }

    addChildren(markers: Array<[SearchResultPrimitiveId, SearchResultPosition]> | Cartographic) {
        const existingIds = this.children.map(child => child.tileId);
        const missingIds = generateChildrenIds(this.tileId).filter(id => !existingIds.includes(id));
        for (const id of missingIds) {
            const child = new FeatureSearchQuadTreeNode(id, this.tileId, this.level + 1, 0);
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
}

class FeatureSearchQuadTree {
    root: FeatureSearchQuadTreeNode;
    private maxDepth: number = MAX_ZOOM_LEVEL;

    constructor() {
        this.root = new FeatureSearchQuadTreeNode(-1n, null, -1, 0);
    }

    private calculateAveragePosition(markers: Array<[SearchResultPrimitiveId, SearchResultPosition]>): Cartesian3 {
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

    insert(tileId: bigint, markers: Array<[SearchResultPrimitiveId, SearchResultPosition]>) {
        const markersCenter = this.calculateAveragePosition(markers);
        const markersCenterCartographic = Cartographic.fromCartesian(markersCenter);
        let currentLevel = 0;
        this.root.addChildren(markers);
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
                    node.count += markers.length;
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
            targetNode.count += markers.length;
            targetNode.center = markersCenter;
            targetNode.addChildren(markers);
            nodes = targetNode.children;
            let next: Array<FeatureSearchQuadTreeNode> = [];
            while (currentLevel <= this.maxDepth) {
                next = [];
                for (const node of nodes) {
                    const containedMarkers = node.filterPointsForNode(markers);
                    if (containedMarkers.length) {
                        const subMarkersCenter = this.calculateAveragePosition(containedMarkers);
                        node.count += containedMarkers.length;
                        node.center = subMarkersCenter;
                        if (node.level == this.maxDepth) {
                            node.markers.push(...containedMarkers);
                        } else {
                            node.addChildren(markers);
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

@Injectable({providedIn: 'root'})
export class FeatureSearchService {
    workers: Array<Worker> = []
    workQueue: Array<WorkerTask> = [];
    cachedWorkQueue: Array<WorkerTask> = [];

    jobGroupManager: JobGroupManager = new JobGroupManager();
    currentSearchGroup: JobGroup | null = null;
    currentCompletionGroup: JobGroup | null = null;
    taskIdCounter: number = 0;
    taskGruoupIdCounter: number = 0;

    resultTree: FeatureSearchQuadTree = new FeatureSearchQuadTree();
    visualization: BillboardCollection = new BillboardCollection();
    visualizationPositions: Array<Cartesian3> = [];
    visualizationChanged: Subject<void> = new Subject<void>();
    resultsPerTile: Map<string, SearchResultForTile> = new Map<string, SearchResultForTile>();
    totalTiles: number = 0;
    doneTiles: number = 0;
    isFeatureSearchActive: Subject<boolean> = new Subject<boolean>();
    pointColor: string = "#ea4336";
    timeElapsed: string = this.formatTime(0);
    totalFeatureCount: number = 0;
    progress: Subject<number> = new Subject<number>();
    pinGraphicsByTier: Map<number, string> = new Map<number, string>;
    searchResults: Array<any> = [];
    traceResults: Array<any> = [];

    diagnosticsMessages: Subject<DiagnosticsMessage[]> = new Subject<DiagnosticsMessage[]>();
    diagnosticsMessageLimit: number = 25;
    private diagnosticsMessagesList: DiagnosticsMessage[] = [];

    completionPending: Subject<boolean> = new Subject<boolean>();
    completionCandidates: Subject<CompletionCandidate[]> = new Subject<CompletionCandidate[]>();
    completionCandidateLimit: number = 15;
    private completionCandidateList: CompletionCandidate[] = [];

    pinTiers = [
        10000, 9000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000,
        900, 800, 700, 600, 500, 400, 300, 200, 100,
        90, 80, 70, 60, 50, 40, 30, 20, 10,
        9, 8, 7, 6, 5, 4, 3, 2, 1
    ];

    private startTime: number = 0;
    private endTime: number = 0;
    public errors: Set<string> = new Set();

    markerGraphics = () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" height="48" viewBox="0 0 24 24" width="48">
           <path d="M12 2C8.1 2 5 5.1 5 9c0 3.3 4.2 8.6 6.6 11.6.4.5 1.3.5 1.7 0C14.8 17.6 19 12.3 19 9c0-3.9-3.1-7-7-7zm0 9.5c-1.4 0-2.5-1.1-2.5-2.5S10.6 6.5 12 6.5s2.5 1.1 2.5 2.5S13.4 11.5 12 11.5z"
            fill="white"/>
        </svg>`
        return `data:image/svg+xml;base64,${btoa(svg)}`;
    };

    constructor(private mapService: MapService,
                private stateService: AppStateService) {
        // Instantiate pin graphics
        this.makeClusterPins();

        // Instantiate workers.
        const maxWorkers = navigator.hardwareConcurrency || 4;
        for (let i = 0; i < maxWorkers; i++) {
            const worker = new Worker(new URL('./search.worker', import.meta.url), {
                type: 'module'
            });
            this.workers.push(worker);
            worker.onmessage = (event: MessageEvent<WorkerResult>) => {
                const result = event.data;

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

                if (this.workQueue.length > 0) {
                    this.scheduleTask(worker, this.workQueue.pop()!);
                }
            };
        }
    }

    private createCustomPin(text: string): string {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d');
        if (context) {
            // Draw the triangle
            context.fillStyle = this.pointColor;
            context.beginPath();
            context.moveTo(20, 16); // Top left point
            context.lineTo(44, 16); // Top right point
            context.lineTo(32, 64); // Bottom point
            context.closePath();
            context.fill();

            // Draw the circle
            context.fillStyle = this.pointColor;
            context.beginPath();
            context.arc(32, 24, 20, 0, 2 * Math.PI, false);
            context.fill();

            // Draw the text
            context.fillStyle = "#ffffff";
            context.font = "bold 12px sans-serif";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(text, 32, 25);
        }
        return canvas.toDataURL();
    }

    private makeClusterPins() {
        for (const n of this.pinTiers) {
            let s = "";
            if (n / 1000 >= 1) {
                s = (n / 1000 | 0).toString().concat('k+');
            } else if (n >= 10) {
                s = n.toString().concat('+');
            } else {
                s = n.toString();
            }
            this.pinGraphicsByTier.set(n, this.createCustomPin(s));
        }
    }

    run(query: string, dirty: boolean = false) {
        // Clear current work queue/visualizations.
        // TODO: Move towards
        //  an update-like function which is invoked when the user
        //  moves the viewport to run differential search on newly visible tiles.
        if (!dirty) {
            this.clear();
            this.startTime = Date.now();
        }

        const searchGroup = this.jobGroupManager.createGroup('search', query, this.generateTaskGroupId());
        this.currentSearchGroup = searchGroup;

        // Set up completion callback to trigger diagnostics after
        // all tasks of the group are done.
        searchGroup.onComplete((group: JobGroup) => {
            console.debug(`Search group completed (id: ${group.id}). Collecting diagnostics for query ${group.query}`);
            this.startDiagnosticsForCompletedSearch(group.query);
        });

        const tileParser = this.mapService.tileParser;
        const makeTask = (tile: FeatureTile): SearchWorkerTask => {
            const taskId = this.generateTaskId();
            const task: SearchWorkerTask = {
                type: 'SearchWorkerTask',
                tileId: tile.tileId,
                tileBlob: tile.tileFeatureLayerBlob as Uint8Array,
                fieldDictBlob: uint8ArrayFromWasm((buf) => {
                    tileParser?.getFieldDict(buf, tile.nodeId)
                })!,
                query: query,
                dataSourceInfo: uint8ArrayFromWasm((buf) => {
                    tileParser?.getDataSourceInfo(buf, tile.mapName)
                })!,
                nodeId: tile.nodeId,
                taskId: taskId,
                groupId: searchGroup.id
            };

            this.jobGroupManager.addTaskToGroup(searchGroup.id, taskId, task);

            return task;
        };

        // Fill up work queue and start processing.
        // TODO: What if we move / change the viewport during the search?
        if (!this.cachedWorkQueue.length) {
            let tasks = this.mapService.getPrioritisedTiles().map(makeTask);

            this.workQueue = this.workQueue.concat(tasks);
            this.totalTiles += tasks.length;
            this.isFeatureSearchActive.next(true);
        } else {
            this.workQueue = [...this.cachedWorkQueue];
            this.cachedWorkQueue = [];
        }
        if (this.totalTiles == 0) {
            this.totalTiles = this.getTasksOfType('SearchWorkerTask').length;
        }

        this.runWorkers();
    }

    // Send a task to each worker to start processing.
    // Further tasks will be picked up in the worker's
    // onMessage callback.
    private runWorkers() {
        for (const worker of this.workers) {
            const tile = this.workQueue.pop();
            if (tile) {
                this.scheduleTask(worker, tile);
            }
        }
    }

    pause() {
        this.cachedWorkQueue = [...this.workQueue];
        this.stop();
    }

    stop() {
        this.workQueue = [];
        this.endTime = Date.now();
        this.timeElapsed = this.formatTime(this.endTime - this.startTime);
    }

    clear() {
        this.stop();
        this.resultTree = new FeatureSearchQuadTree();
        this.visualization.removeAll();
        this.visualizationPositions = [];
        this.resultsPerTile.clear();
        this.workQueue = [];
        this.cachedWorkQueue = [];
        this.totalTiles = 0;
        this.doneTiles = 0;
        this.progress.next(0);
        this.searchResults = [];
        this.traceResults = [];
        this.diagnosticsMessagesList = [];
        this.diagnosticsMessages.next([]);
        this.isFeatureSearchActive.next(false);
        this.totalFeatureCount = 0;
        this.startTime = 0;
        this.endTime = 0;
        this.timeElapsed = this.formatTime(0);
        this.visualizationChanged.next();
        this.errors.clear();
        this.completionCandidateList = [];
        this.completionPending.next(false);
        this.completionCandidates.next([]);
        this.jobGroupManager.clearCompleted();
        this.currentSearchGroup = null;
    }

    /// Generate a new task id
    private generateTaskId(): string {
        return `task_${Date.now()}_${++this.taskIdCounter}`;
    }

    /// Generate a new task-group id
    private generateTaskGroupId(): string {
        return `group_${Date.now()}_${++this.taskGruoupIdCounter}`;
    }

    private startDiagnosticsForCompletedSearch(query: string) {
        if (!this.currentSearchGroup) {
            return;
        }

        const diagnosticsGroup = this.jobGroupManager.createGroup('diagnostics', query, this.generateTaskGroupId());

        const tileParser = this.mapService.tileParser;
        const makeDiagnosticsTask = (tile: FeatureTile): DiagnosticsWorkerTask => {
            const taskId = this.generateTaskId();
            const task: DiagnosticsWorkerTask = {
                type: 'DiagnosticsWorkerTask',
                blob: tile.tileFeatureLayerBlob as Uint8Array,
                fieldDictBlob: uint8ArrayFromWasm((buf) => {
                    tileParser?.getFieldDict(buf, tile.nodeId)
                })!,
                query: query,
                dataSourceInfo: uint8ArrayFromWasm((buf) => {
                    tileParser?.getDataSourceInfo(buf, tile.mapName)
                })!,
                nodeId: tile.nodeId,
                diagnostics: Array.from(this.currentSearchGroup!.getDiagnostics()),
                taskId: taskId,
                groupId: diagnosticsGroup.id,
            };

            this.jobGroupManager.addTaskToGroup(diagnosticsGroup.id, taskId, task);

            return task;
        };

        const diagTasks = this.mapService.getPrioritisedTiles().map(makeDiagnosticsTask);
        this.workQueue = this.workQueue.concat(diagTasks);
        this.runWorkers();
    }

    private getTasksOfType(type: string) {
        return this.workQueue.filter((task: WorkerTask) => {
            return task.type === type;
        })
    }

    private clearTasksOfType(type: string) {
        this.workQueue = this.workQueue.filter((task: WorkerTask) => {
            return task.type != type;
        })
    }

    public completeQuery(query: string, point: number | undefined) {
        // Remove all pending completion tasks
        this.clearTasksOfType('CompletionWorkerTask');

        // Create completion job group
        const completionGroup = this.jobGroupManager.createGroup('completion', query, this.generateTaskGroupId());
        this.currentCompletionGroup = completionGroup
        completionGroup.onComplete((group: JobGroup) => {
            console.debug(`Completion group completed (id: ${group.id}, current: ${this.currentCompletionGroup?.id})`)
            if (this.currentCompletionGroup?.id === group.id)
                this.completionPending.next(false);
        })

        // Build one task per tile
        const tileParser = this.mapService.tileParser;
        const limit = this.completionCandidateLimit;
        const makeTask = (tile: FeatureTile): CompletionWorkerTask => {
            const taskId = this.generateTaskId();
            const task: CompletionWorkerTask = {
                type: 'CompletionWorkerTask',
                blob: tile.tileFeatureLayerBlob as Uint8Array,
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

            this.jobGroupManager.addTaskToGroup(completionGroup.id, taskId, task);

            return task;
        };

        this.completionCandidateList = [];
        this.completionPending.next(true);
        this.completionCandidates.next([]);

        this.workQueue = this.workQueue.concat(this.mapService.getPrioritisedTiles().map(makeTask));
        this.runWorkers();
    }

    private addCompletionCandidates(candidates: CompletionCandidatesForTile) {
        if (candidates.groupId !== this.currentCompletionGroup?.id)
            return;

        this.completionCandidateList = this.completionCandidateList
            .concat(candidates.candidates)
            .slice(0, this.completionCandidateLimit)
            .filter((item, index, array) => array.findIndex(other => other.query === item.query) === index) // Remove duplicates
            .sort((a: CompletionCandidate, b: CompletionCandidate) => a.text.localeCompare(b.text));

        this.completionCandidates.next(this.completionCandidateList);
    }

    private addDiagnostics(result : DiagnosticsResultsForTile) {
        this.diagnosticsMessagesList = this.diagnosticsMessagesList
            .concat(result.messages)
            .slice(0, this.diagnosticsMessageLimit)
            .filter((item, index, array) => array.findIndex(other => other.message === item.message && other.location.offset === item.location.offset) === index);
        this.diagnosticsMessages.next(this.diagnosticsMessagesList);
    }

    private addSearchResult(tileResult: SearchResultForTile) {
        // Ignore results that are not related to the ongoing query.
        if (tileResult.groupId !== this.currentSearchGroup?.id)
            return;

        if (tileResult.error)
            this.errors.add(tileResult.error);

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
        if (tileResult.diagnostics && this.currentSearchGroup) {
            this.currentSearchGroup.addDiagnostics(tileResult.diagnostics);
        }

        // Add visualizations and register the search result.
        if (tileResult.matches.length && tileResult.tileId) {
            const mapTileKey = tileResult.matches[0][0];
            const mapId = mapTileKey.split(':')[1]
            this.resultsPerTile.set(mapTileKey, tileResult);
            this.resultTree.insert(tileResult.tileId, tileResult.matches.map(result => {
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
                this.searchResults.push({label: `${featureId}`, mapId: mapId, featureId: featureId});
                return [id, result[2]];
            }));
        }

        // Broadcast the search progress.
        ++this.doneTiles;
        this.progress.next(this.doneTiles/this.totalTiles * 100 | 0);
        this.endTime = Date.now();
        this.timeElapsed = this.formatTime(this.endTime - this.startTime);
        this.totalFeatureCount += tileResult.numFeatures;
        this.visualizationChanged.next();
    }

    private scheduleTask(worker: Worker, task: WorkerTask) {
        console.debug(`Scheduling task id=${task.taskId || 'null'} group=${task.groupId || 'null'}`);
        worker.postMessage(task);
    }

    updatePointColor() {
        this.makeClusterPins();
        this.visualizationChanged.next();
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

    getPinGraphics(count: number) {
        // Find the appropriate tier for the given count
        let key = this.pinTiers.find(tier => count >= tier) || 1;
        return this.pinGraphicsByTier.get(key);
    }
}
