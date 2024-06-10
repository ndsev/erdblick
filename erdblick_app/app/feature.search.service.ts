import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import {MapService} from "./map.service";
import {SearchResultForTile, SearchWorkerTask} from "./featurefilter.worker";
import {Color, BillboardCollection, Cartesian2, Cartesian3} from "./cesium";
import {FeatureTile} from "./features.model";
import {uint8ArrayFromWasm} from "./wasm";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {PointPrimitiveCollection} from "cesium";


@Injectable({providedIn: 'root'})
export class FeatureSearchService {

    currentQuery: string = ""
    workers: Array<Worker> = []
    visualization: BillboardCollection = new BillboardCollection();
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
        for (const [_, tile] of this.mapService.loadedTileLayers) {
            this.workQueue.push(tile);
        }
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
        this.visualization.removeAll();
        this.resultsPerTile.clear();
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

            tileResult.billboardPrimitiveIndices = [];
            for (const [_, __, position] of tileResult.matches) {
                tileResult.billboardPrimitiveIndices.push(this.visualization.length);
                this.visualization.add({
                    position: position,
                    image: this.markerGraphics(),
                    width: 32,
                    height: 32,
                    pixelOffset: new Cartesian2(0, -10),
                    eyeOffset: new Cartesian3(0, 0, -100)
                });
            }
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