import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import {MapService} from "./map.service";
import {SearchResultForTile, SearchWorkerTask} from "./featurefilter.worker";
import {Color, PointPrimitiveCollection} from "./cesium";
import {FeatureTile} from "./features.model";
import {uint8ArrayFromWasm} from "./wasm";


@Injectable({providedIn: 'root'})
export class SearchService {

    currentQuery: string = ""
    workers: Array<Worker> = []
    visualization: PointPrimitiveCollection = new PointPrimitiveCollection();
    visualizationChanged: Subject<void> = new Subject<void>();
    resultsPerTile: Map<string, SearchResultForTile> = new Map<string, SearchResultForTile>();
    workQueue: Array<FeatureTile> = [];
    totalTiles: number = 0;
    doneTiles: number = 0;
    searchUpdates: Subject<SearchResultForTile> = new Subject<SearchResultForTile>();
    searchActive: Subject<boolean> = new Subject<boolean>();
    pointColor: string = "#ff69b4";
    timeElapsed: number = 0;  // TODO: Set
    totalFeatureCount: number = 0;

    constructor(private mapService: MapService) {
        // Instantiate workers.
        const maxWorkers = 1; // navigator.hardwareConcurrency || 4;
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
        if (query == this.currentQuery) {
            return;
        }

        // Clear current work queue/visualizations. TODO: Move towards
        //  an update-like function which is invoked when the user
        //  moves the viewport to run differential search on newly visible tiles.
        this.clear();
        this.currentQuery = query;

        // Fill up work queue and start processing.
        for (const [_, tile] of this.mapService.loadedTileLayers) {
            this.workQueue.push(tile);
        }
        this.totalTiles = this.workQueue.length;

        // Send a task to each worker to start processing.
        // Further tasks will be picked up in the worker's
        // onMessage callback.
        for (const worker of this.workers) {
            const tile = this.workQueue.pop();
            if (tile) {
                this.scheduleTileForWorker(worker, tile);
            }
        }

        this.searchActive.next(true);
    }

    stop() {
        this.workQueue = [];
    }

    clear() {
        this.stop();
        this.currentQuery = "";
        this.visualization.removeAll();
        this.resultsPerTile.clear();
        this.totalTiles = 0;
        this.doneTiles = 0;
        this.searchActive.next(false);
        this.totalFeatureCount = 0;
        this.timeElapsed = 0;
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

            tileResult.pointPrimitiveIndices = [];
            const color = Color.fromCssColorString(this.pointColor);
            for (const [_, __, position] of tileResult.matches) {
                tileResult.pointPrimitiveIndices.push(this.visualization.length);
                this.visualization.add({
                    position: position,
                    color: color,
                    outlineColor: Color.GHOSTWHITE
                });
            }
        }

        // Broadcast the search progress.
        ++this.doneTiles;
        this.totalFeatureCount += tileResult.numFeatures;
        this.searchUpdates.next(tileResult);
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

    percentDone() {
        if (this.totalTiles == 0) {
            return 100;
        }
        return this.doneTiles/this.totalTiles * 100;
    }

    updatePointColor() {
        const color = Color.fromCssColorString(this.pointColor);
        for (let i = 0; i < this.visualization.length; ++i) {
            this.visualization.get(i).color = color;
        }
        this.visualizationChanged.next();
    }
}