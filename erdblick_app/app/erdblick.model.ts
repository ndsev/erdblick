"use strict";

import {Fetch} from "./fetch.component";
import {FeatureTile} from "./features.component";
import {uint8ArrayToWasm} from "./wasm";
import {TileVisualization} from "./visualization.component";
import {BehaviorSubject, Subject} from "rxjs";
import {StyleService} from "./style.service";
import {ErdblickLayer, ErdblickMap} from "./map.service";

const infoUrl = "/sources";
const tileUrl = "/tiles";

type ViewportProperties = {
    orientation: number;
    camPosLon: number;
    south: number;
    west: number;
    width: number;
    height: number;
    camPosLat: number
};

/**
 * Erdblick view-model class. This class is responsible for keeping track
 * of the following objects:
 *  (1) available maps
 *  (2) currently loaded tiles
 *  (3) available style sheets.
 *
 * As the viewport changes, it requests new tiles from the mapget server
 * and triggers their conversion to Cesium tiles according to the active
 * style sheets.
 */
export class ErdblickModel {
    static MAX_NUM_TILES_TO_LOAD = 2048;
    static MAX_NUM_TILES_TO_VISUALIZE = 512;
    private coreLib: any;
    private styles: Map<string, any> | null;
    private maps: Object | null;
    private loadedTileLayers: Map<any, any>;
    private visualizedTileLayers: any[];
    private currentFetch: any;
    private currentViewport: ViewportProperties;
    private currentVisibleTileIds: Set<number>;
    private currentHighDetailTileIds: Set<number>;
    private tileStreamParsingQueue: any[];
    private tileVisualizationQueue: TileVisualization[];
    maxLoadTiles: number;
    maxVisuTiles: number;
    private tileParser: any;
    tileVisualizationTopic: Subject<any>;
    tileVisualizationDestructionTopic: Subject<any>;
    zoomToWgs84PositionTopic: Subject<any>;
    mapInfoTopic: Subject<any>;
    allViewportTileIds: Map<number, number> = new Map<number, number>();
    layerIdToLevel: Map<string, number> = new Map<string, number>();
    availableMapItems: BehaviorSubject<Map<string, ErdblickMap>> = new BehaviorSubject<Map<string, ErdblickMap>>(new Map<string, ErdblickMap>());

    private textEncoder: TextEncoder = new TextEncoder();

    constructor(coreLibrary: any, private styleService: StyleService) {
        this.coreLib = coreLibrary;
        this.styles = null;
        this.maps = null;
        this.loadedTileLayers = new Map();
        this.visualizedTileLayers = [];
        this.currentFetch = null;
        this.currentViewport = {
            south: .0,
            west: .0,
            width: .0,
            height: .0,
            camPosLon: .0,
            camPosLat: .0,
            orientation: .0,
        };
        this.currentVisibleTileIds = new Set();
        this.currentHighDetailTileIds = new Set();
        this.tileStreamParsingQueue = [];
        this.tileVisualizationQueue = [];
        this.maxLoadTiles = ErdblickModel.MAX_NUM_TILES_TO_LOAD;
        this.maxVisuTiles = ErdblickModel.MAX_NUM_TILES_TO_VISUALIZE;

        // Instantiate the TileLayerParser, and set its callback
        // for when a new tile is received.
        this.tileParser = new this.coreLib.TileLayerParser();

        ///////////////////////////////////////////////////////////////////////////
        //                               MODEL EVENTS                            //
        ///////////////////////////////////////////////////////////////////////////

        /// Triggered when a tile layer is freshly rendered and should be added to the frontend.
        this.tileVisualizationTopic = new Subject<any>(); // {FeatureTile}

        /// Triggered when a tile layer is being removed.
        this.tileVisualizationDestructionTopic = new Subject<any>(); // {FeatureTile}

        /// Triggered when the user requests to zoom to a map layer.
        this.zoomToWgs84PositionTopic = new Subject<any>(); // {.x,.y}

        /// Triggered when the map info is updated.
        this.mapInfoTopic = new Subject<any>(); // {<mapId>: <mapInfo>}

        ///////////////////////////////////////////////////////////////////////////
        //                                 BOOTSTRAP                             //
        ///////////////////////////////////////////////////////////////////////////

        this.reloadStyle();
        this.reloadDataSources();

        // Initial call to processTileStream, will keep calling itself
        this.processTileStream();
        this.processVisualizationTasks();
    }

    private processTileStream() {
        const startTime = Date.now();
        const timeBudget = 10; // milliseconds

        while (this.tileStreamParsingQueue.length) {
            // Check if the time budget is exceeded.
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            let [message, messageType] = this.tileStreamParsingQueue.shift();
            if (messageType === Fetch.CHUNK_TYPE_FIELDS) {
                uint8ArrayToWasm(this.coreLib, (wasmBuffer: any) => {
                    this.tileParser.readFieldDictUpdate(wasmBuffer);
                }, message);
            } else if (messageType === Fetch.CHUNK_TYPE_FEATURES) {
                this.addTileFeatureLayer(message.slice(Fetch.CHUNK_HEADER_SIZE), null, null);
            } else {
                console.error(`Encountered unknown message type ${messageType}!`);
            }
        }

        // Continue processing messages with a delay.
        const delay = this.tileStreamParsingQueue.length ? 0 : 10;
        setTimeout((_: any) => this.processTileStream(), delay);
    }

    private processVisualizationTasks() {
        const startTime = Date.now();
        const timeBudget = 20; // milliseconds

        while (this.tileVisualizationQueue.length) {
            // Check if the time budget is exceeded.
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            let tileVisu = this.tileVisualizationQueue.shift();
            this.tileVisualizationTopic.next(tileVisu);
        }

        // Continue visualizing tiles with a delay.
        const delay = this.tileVisualizationQueue.length ? 0 : 10;
        setTimeout((_: any) => this.processVisualizationTasks(), delay);
    }

    reloadStyle(styleId: string = "") {
        // Delete the old style if present.
        if (this.styles) {
            this.styles.forEach((style: any, id: string) => {
                if (style) style.delete()
            });
        }
        this.styles = new Map<string, any>();

        this.styleService.styleData.forEach((styleString: string, id: string) => {
            if (this.styleService.activatedStyles.has(id) && this.styleService.activatedStyles.get(id)) {
                const styleUint8Array = this.textEncoder.encode(styleString);
                // Parse the style description into a WASM style object.
                uint8ArrayToWasm(this.coreLib,
                    (wasmBuffer: any) => {
                        this.styles?.set(id, new this.coreLib.FeatureLayerStyle(wasmBuffer));
                    },
                    styleUint8Array);
            }
        });

        // Re-render all present batches with the new style.
        this.tileVisualizationQueue = [];
        this.visualizedTileLayers.forEach(tileVisu => this.tileVisualizationDestructionTopic.next(tileVisu));
        for (let [tileLayerId, tileLayer] of this.loadedTileLayers.entries()) {
            this.renderTileLayer(tileLayer, null);
        }
        console.log("Loaded styles.");
    }

    private reloadDataSources() {
        new Fetch(infoUrl)
        .withBufferCallback((infoBuffer: any) => {
            uint8ArrayToWasm(this.coreLib, (wasmBuffer: any) => {
                this.tileParser.setDataSourceInfo(wasmBuffer);
            }, infoBuffer)
            console.log("Loaded data source info.");
        })
        .withJsonCallback((result: any) => {
            this.maps = Object.fromEntries(result.map((mapInfo: any) => [mapInfo.mapId, mapInfo]));
            this.mapInfoTopic.next(this.maps);
        })
        .go();
    }

    ///////////////////////////////////////////////////////////////////////////
    //                          MAP UPDATE CONTROLS                          //
    ///////////////////////////////////////////////////////////////////////////

    update() {
        // Get the tile IDs for the current viewport.
        this.currentVisibleTileIds = new Set<number>();
        this.currentHighDetailTileIds = new Set<number>();
        // Level: array of tileIds
        let tileIdPerLevel = new Map<number, Array<number>>();
        for (let [_, level] of this.layerIdToLevel) {
            if (!tileIdPerLevel.has(level)) {
                const allViewportTileIds = this.coreLib.getTileIds(this.currentViewport, level, this.maxLoadTiles) as number[];
                tileIdPerLevel.set(level, allViewportTileIds);
                this.currentVisibleTileIds = new Set([
                    ...this.currentVisibleTileIds,
                    ...new Set<number>(allViewportTileIds)
                ]);
                this.currentHighDetailTileIds = new Set([
                    ...this.currentVisibleTileIds,
                    ...new Set<number>(allViewportTileIds.slice(0, this.maxVisuTiles))
                ])
            }
        }

        // Abort previous fetch operation.
        if (this.currentFetch) {
            this.currentFetch.abort();
            // Clear any unparsed messages from the previous stream.
            this.tileStreamParsingQueue = [];
        }

        // Make sure that there are no unparsed bytes lingering from the previous response stream.
        this.tileParser.reset();

        // Evict present non-required tile layers.
        let newTileLayers = new Map();
        for (let tileLayer of this.loadedTileLayers.values()) {
            if (!tileLayer.preventCulling && !this.currentVisibleTileIds.has(tileLayer.tileId))
                tileLayer.destroy();
            else
                newTileLayers.set(tileLayer.id, tileLayer);
        }
        this.loadedTileLayers = newTileLayers;

        // Request non-present required tile layers.
        // TODO: Consider tile TTL.
        let requests = [];
        if (this.maps) {
            for (let [mapName, map] of Object.entries(this.maps)) {
                for (let [layerName, layer] of Object.entries(map.layers)) {
                    // Find tile IDs which are not yet loaded for this map layer combination.
                    let requestTilesForMapLayer = []
                    const mapItem = this.availableMapItems.getValue().get(mapName);
                    if (mapItem !== undefined && mapItem.mapLayers.some(mapLayer => mapLayer.name == layerName && mapLayer.visible)) {
                        let level = this.layerIdToLevel.get(mapName + '/' + layerName);
                        if (level !== undefined) {
                            let tileIds = tileIdPerLevel.get(level);
                            if (tileIds !== undefined) {
                                for (let tileId of tileIds) {
                                    const tileMapLayerKey = this.coreLib.getTileFeatureLayerKey(mapName, layerName, tileId);
                                    if (!this.loadedTileLayers.has(tileMapLayerKey))
                                        requestTilesForMapLayer.push(Number(tileId));
                                }

                                // Only add a request if there are tiles to be loaded.
                                if (requestTilesForMapLayer)
                                    requests.push({
                                        mapId: mapName,
                                        layerId: layerName,
                                        tileIds: requestTilesForMapLayer
                                    });
                            }
                        }
                    }
                }
            }
        }

        // Update visualizations and visualization queue
        this.visualizedTileLayers = this.visualizedTileLayers.filter(tileVisu => {
            if (!this.currentVisibleTileIds.has(tileVisu.tile.tileId) && !tileVisu.tile.preventCulling) {
                this.tileVisualizationDestructionTopic.next(tileVisu);
                return false;
            }
            tileVisu.isHighDetail = this.currentHighDetailTileIds.has(tileVisu.tile.tileId) || tileVisu.tile.preventCulling;
            return true;
        });
        this.tileVisualizationQueue = this.visualizedTileLayers.filter(tileVisu => tileVisu.isDirty());

        // Launch the new fetch operation
        this.currentFetch = new Fetch(tileUrl)
        .withChunkProcessing()
        .withMethod("POST")
        .withBody({
            requests: requests,
            maxKnownFieldIds: this.tileParser.getFieldDictOffsets()
        })
        .withBufferCallback((message: any, messageType: any) => {
            // Schedule the parsing of the newly arrived tile layer,
            // but don't do it synchronously to avoid stalling the ongoing
            // fetch operation.
            this.tileStreamParsingQueue.push([message, messageType]);
        });
        this.currentFetch.go();
    }

    private addTileFeatureLayer(tileLayerBlob: any, style: any, preventCulling: any) {
        let tileLayer = new FeatureTile(this.coreLib, this.tileParser, tileLayerBlob, preventCulling);

        // Don't add a tile that is not supposed to be visible.
        if (!preventCulling) {
            if (!this.currentVisibleTileIds.has(tileLayer.tileId))
                return;
        }

        // If this one replaces an older tile with the same key,
        // then first remove the older existing one.
        if (this.loadedTileLayers.has(tileLayer.id)) {
            this.removeTileLayer(this.loadedTileLayers.get(tileLayer.id));
        }
        this.loadedTileLayers.set(tileLayer.id, tileLayer);

        // Schedule the visualization of the newly added tile layer,
        // but don't do it synchronously to avoid stalling the main thread.
        setTimeout(() => {
            this.renderTileLayer(tileLayer, style);
        })
    }

    private removeTileLayer(tileLayer: any) {
        tileLayer.destroy()
        this.visualizedTileLayers = this.visualizedTileLayers.filter(tileVisu => {
            if (tileVisu.tile.id === tileLayer.id) {
                this.tileVisualizationDestructionTopic.next(tileVisu);
                return false;
            }
            return true;
        });
        this.tileVisualizationQueue = this.tileVisualizationQueue.filter(tileVisu => {
            return tileVisu.tile.id !== tileLayer.id;
        });
        this.loadedTileLayers.delete(tileLayer.id);
    }

    private renderTileLayer(tileLayer: any, style: any) {
        if (style) {
            let visu = new TileVisualization(
                tileLayer,
                style,
                tileLayer.preventCulling || this.currentHighDetailTileIds.has(tileLayer.tileId));
            this.tileVisualizationQueue.push(visu);
            this.visualizedTileLayers.push(visu);
            return;
        }
        this.styles?.forEach((style: any, id: string) => {
            let visu = new TileVisualization(
                tileLayer,
                style,
                tileLayer.preventCulling || this.currentHighDetailTileIds.has(tileLayer.tileId));
            this.tileVisualizationQueue.push(visu);
            this.visualizedTileLayers.push(visu);
        })
    }

    // public:
    setViewport(viewport: any) {
        this.currentViewport = viewport;
        this.update();
    }
}
