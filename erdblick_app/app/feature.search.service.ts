import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import {MapService} from "./map.service";
import {SearchResultForTile, SearchWorkerTask} from "./featurefilter.worker";
import {Color, BillboardCollection, Cartographic, Cartesian3, Rectangle} from "./cesium";
import {FeatureTile} from "./features.model";
import {coreLib, uint8ArrayFromWasm} from "./wasm";

export const MAX_ZOOM_LEVEL = 15;

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
    markers: Array<Cartesian3> = [];
    rectangle: Rectangle;
    center: Cartesian3;

    constructor(tileId: bigint,
                parentTileId: bigint | null,
                level: number,
                count: number,
                children: Array<FeatureSearchQuadTreeNode> = [],
                markers: Array<Cartesian3> = []) {
        this.tileId = tileId;
        this.parentId = parentTileId;
        this.level = level;
        this.children = children;
        this.count = count;
        this.markers = markers;

        const tileBox = coreLib.getTileBox(tileId);
        this.rectangle = Rectangle.fromDegrees(...tileBox);
        const position = coreLib.getTilePosition(tileId)
        this.center = Cartesian3.fromDegrees(position.x, position.y, position.z);
    }

    private containsPoint(point: Cartesian3) {
       return Rectangle.contains(this.rectangle, Cartographic.fromCartesian(point));
    }

    contains(points: Array<Cartesian3>) {
        return points.some(point => this.containsPoint(point));
    }

    filterPointsForNode(points: Array<Cartesian3>) {
        return points.filter(point => this.containsPoint(point));
    }

    addChildren(markers: Array<Cartesian3>) {
        const existingIds = this.children.map(child => child.tileId);
        const missingIds = generateChildrenIds(this.tileId).filter(id => !existingIds.includes(id));
        for (const id of missingIds) {
            const child = new FeatureSearchQuadTreeNode(id, this.tileId, this.level + 1, 0);
            if (child.contains(markers)) {
                this.children.push(child);
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

    private calculateAveragePosition(markers: Cartesian3[]): Cartesian3 {
        const sum = markers.reduce(
            (acc, pos) => {
                acc.x += pos.x;
                acc.y += pos.y;
                acc.z += pos.z;
                return acc;
            },
            { x: 0, y: 0, z: 0 }
        );

        return new Cartesian3(sum.x / markers.length, sum.y / markers.length, sum.z / markers.length);
    }

    insert(tileId: bigint, markers: Array<Cartesian3>) {
        const markersCenter = this.calculateAveragePosition(markers);
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
                if (node.contains(markers)) {
                    node.count += markers.length;
                    node.center = markersCenter;
                    node.addChildren(markers);
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
            while(currentLevel <= this.maxDepth) {
                const next: Array<FeatureSearchQuadTreeNode> = [];
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

    currentQuery: string = ""
    workers: Array<Worker> = []
    resultTree: FeatureSearchQuadTree = new FeatureSearchQuadTree();
    visualization: BillboardCollection = new BillboardCollection();
    visualizationPositions: Array<Cartesian3> = [];
    visualizationChanged: Subject<void> = new Subject<void>();
    resultsPerTile: Map<string, SearchResultForTile> = new Map<string, SearchResultForTile>();
    workQueue: Array<FeatureTile> = [];
    totalTiles: number = 0;
    doneTiles: number = 0;
    searchUpdates: Subject<SearchResultForTile> = new Subject<SearchResultForTile>();
    isFeatureSearchActive: Subject<boolean> = new Subject<boolean>();
    pointColor: string = "#ff69b4";
    timeElapsed: string = this.formatTime(0);  // TODO: Set
    totalFeatureCount: number = 0;
    progress: Subject<number> = new Subject<number>();

    private startTime: number = 0;
    private endTime: number = 0;

    markerGraphics = () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" height="48" viewBox="0 0 24 24" width="48">
           <path d="M12 2C8.1 2 5 5.1 5 9c0 3.3 4.2 8.6 6.6 11.6.4.5 1.3.5 1.7 0C14.8 17.6 19 12.3 19 9c0-3.9-3.1-7-7-7zm0 9.5c-1.4 0-2.5-1.1-2.5-2.5S10.6 6.5 12 6.5s2.5 1.1 2.5 2.5S13.4 11.5 12 11.5z" 
            fill="white"/>
        </svg>`
        return `data:image/svg+xml;base64,${btoa(svg)}`;
    };

    constructor(private mapService: MapService) {
        // Instantiate workers.
        const maxWorkers = navigator.hardwareConcurrency || 4;
        for (let i = 0; i < maxWorkers; i++) {
            const worker = new Worker(new URL('./featurefilter.worker', import.meta.url));
            this.workers.push(worker);
            worker.onmessage = (ev: MessageEvent<SearchResultForTile>) => {
                this.addSearchResult(ev.data);
                if (this.workQueue.length > 0) {
                    const tileToProcess = this.workQueue.pop()!;
                    this.scheduleTileForWorker(worker, tileToProcess);
                }
            };
        }
    }

    run(query: string) {
        // if (query == this.currentQuery) {
        //     return;
        // }

        // Clear current work queue/visualizations. TODO: Move towards
        //  an update-like function which is invoked when the user
        //  moves the viewport to run differential search on newly visible tiles.
        this.clear();
        this.currentQuery = query;
        this.startTime = Date.now();

        // Fill up work queue and start processing.
        // TODO: What if we move / change the viewport during the search?
        this.workQueue = this.mapService.getPrioritisedTiles();
        this.totalTiles = this.workQueue.length;
        this.isFeatureSearchActive.next(true);

        // Send a task to each worker to start processing.
        // Further tasks will be picked up in the worker's
        // onMessage callback.
        for (const worker of this.workers) {
            const tile = this.workQueue.pop();
            if (tile) {
                this.scheduleTileForWorker(worker, tile);
            }
        }
    }

    stop() {
        this.workQueue = [];
        this.endTime = Date.now();
        this.timeElapsed = this.formatTime(this.endTime - this.startTime);
    }

    clear() {
        this.stop();
        this.currentQuery = "";
        this.resultTree = new FeatureSearchQuadTree();
        this.visualization.removeAll();
        this.visualizationPositions = [];
        this.resultsPerTile.clear();
        this.workQueue = [];
        this.totalTiles = 0;
        this.doneTiles = 0;
        this.progress.next(0);
        this.isFeatureSearchActive.next(false);
        this.totalFeatureCount = 0;
        this.startTime = 0;
        this.endTime = 0;
        this.timeElapsed = this.formatTime(0);
        this.visualizationChanged.next();
    }

    private addSearchResult(tileResult: SearchResultForTile) {
        // Ignore results that are not related to the ongoing query.
        if (tileResult.query != this.currentQuery) {
            return;
        }

        // Add visualizations and register the search result.
        if (tileResult.matches.length) {
            let mapTileKey = tileResult.matches[0][0];
            this.resultsPerTile.set(mapTileKey, tileResult);

            // tileResult.billboardPrimitiveIndices = [];
            let markerPositions: Array<Cartesian3> = [];
            for (const [_, __, position] of tileResult.matches) {
                markerPositions.push(new Cartesian3(position.x, position.y, position.z));
                // this.visualizationPositions.push(new Cartesian3(position.x, position.y, position.z));
                // tileResult.billboardPrimitiveIndices.push(this.visualizationPositions.length);
                // this.visualization.add({
                //     position: position,
                //     image: this.markerGraphics(),
                //     width: 32,
                //     height: 32,
                //     pixelOffset: new Cartesian2(0, -10),
                //     eyeOffset: new Cartesian3(0, 0, -100)
                // });
            }
            this.resultTree.insert(tileResult.tileId, markerPositions);
        }

        // Broadcast the search progress.
        ++this.doneTiles;
        this.progress.next(this.doneTiles/this.totalTiles * 100 | 0);
        this.endTime = Date.now();
        this.timeElapsed = this.formatTime(this.endTime - this.startTime);
        this.totalFeatureCount += tileResult.numFeatures;
        this.searchUpdates.next(tileResult);
        this.updatePointColor();
        this.visualizationChanged.next();
    }

    private scheduleTileForWorker(worker: Worker, tileToProcess: FeatureTile) {
        worker.postMessage({
            tileBlob: tileToProcess.tileFeatureLayerBlob as Uint8Array,
            fieldDictBlob: uint8ArrayFromWasm((buf) => {
                this.mapService.tileParser?.getFieldDict(buf, tileToProcess.nodeId)
            })!,
            query: this.currentQuery,
            dataSourceInfo: uint8ArrayFromWasm((buf) => {
                this.mapService.tileParser?.getDataSourceInfo(buf, tileToProcess.mapName)
            })!,
            nodeId: tileToProcess.nodeId
        } as SearchWorkerTask);
    }

    updatePointColor() {
        const color = Color.fromCssColorString(this.pointColor);
        for (let i = 0; i < this.visualization.length; ++i) {
            this.visualization.get(i).color = color;
        }
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
}
