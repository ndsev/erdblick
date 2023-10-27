"use strict";

import {Fetch} from "./fetch.js";
import {FeatureTile} from "./features.js";
import {uint8ArrayToWasm} from "./wasm.js";
import {TileVisualization} from "./visualization.js";

const styleUrl = "/styles/demo-style.yaml";
const infoUrl = "/sources";
const tileUrl = "/tiles";

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
export class ErdblickModel
{
    static MAX_NUM_TILES_TO_LOAD = 2048;
    static MAX_NUM_TILES_TO_VISUALIZE = 512;

    constructor(coreLibrary)
    {
        this.coreLib = coreLibrary;
        this.style = null;
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
        this.tileVisualizationTopic = new rxjs.Subject(); // {FeatureTile}

        /// Triggered when a tile layer is being removed.
        this.tileVisualizationDestructionTopic = new rxjs.Subject(); // {FeatureTile}

        /// Triggered when the user requests to zoom to a map layer.
        this.zoomToWgs84PositionTopic = new rxjs.Subject(); // {.x,.y}

        /// Triggered when the map info is updated.
        this.mapInfoTopic = new rxjs.Subject(); // {<mapId>: <mapInfo>}

        ///////////////////////////////////////////////////////////////////////////
        //                                 BOOTSTRAP                             //
        ///////////////////////////////////////////////////////////////////////////

        this.reloadStyle();
        this.reloadDataSources();

        // Initial call to processTileStream, will keep calling itself
        this.processTileStream();
        this.processVisualizationTasks();
    }

    processTileStream() {
        const startTime = Date.now();
        const timeBudget = 10; // milliseconds

        while (this.tileStreamParsingQueue.length) {
            // Check if the time budget is exceeded.
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            let [message, messageType] = this.tileStreamParsingQueue.shift();
            if (messageType === Fetch.CHUNK_TYPE_FIELDS) {
                uint8ArrayToWasm(this.coreLib, wasmBuffer => {
                    this.tileParser.readFieldDictUpdate(wasmBuffer);
                }, message);
            } else if (messageType === Fetch.CHUNK_TYPE_FEATURES) {
                this.addTileFeatureLayer(message.slice(Fetch.CHUNK_HEADER_SIZE));
            } else {
                console.error(`Encountered unknown message type ${messageType}!`);
            }
        }

        // Continue processing messages with a delay.
        const delay = this.tileStreamParsingQueue.length ? 0 : 10;
        setTimeout(_ => this.processTileStream(), delay);
    }

    processVisualizationTasks() {
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
        setTimeout(_ => this.processVisualizationTasks(), delay);
    }

    reloadStyle()
    {
        // Delete the old style if present.
        if (this.style)
            this.style.delete();

        // Fetch the new one.
        new Fetch(styleUrl).withBufferCallback(styleYamlBuffer => {
            // Parse the style description into a WASM style object.
            uint8ArrayToWasm(this.coreLib, wasmBuffer => {
                this.style = new this.coreLib.FeatureLayerStyle(wasmBuffer);
            }, styleYamlBuffer)

            // Re-render all present batches with the new style.
            this.tileVisualizationQueue = [];
            this.visualizedTileLayers.forEach(tileVisu => this.tileVisualizationDestructionTopic.next(tileVisu));
            for (let [tileLayerId, tileLayer] of this.loadedTileLayers.entries()) {
                this.renderTileLayer(tileLayer);
            }
            console.log("Loaded style.");
        }).go();
    }

    reloadDataSources() {
        new Fetch(infoUrl)
            .withBufferCallback(infoBuffer => {
                uint8ArrayToWasm(this.coreLib, wasmBuffer => {
                    this.tileParser.setDataSourceInfo(wasmBuffer);
                }, infoBuffer)
                console.log("Loaded data source info.");
            })
            .withJsonCallback(result => {
                this.maps = Object.fromEntries(result.map(mapInfo => [mapInfo.mapId, mapInfo]));
                this.mapInfoTopic.next(this.maps);
            })
            .go();
    }

    ///////////////////////////////////////////////////////////////////////////
    //                          MAP UPDATE CONTROLS                          //
    ///////////////////////////////////////////////////////////////////////////

    update()
    {
        // Get the tile IDs for the current viewport.
        const allViewportTileIds = this.coreLib.getTileIds(this.currentViewport, 13, this.maxLoadTiles);
        this.currentVisibleTileIds = new Set(allViewportTileIds);
        this.currentHighDetailTileIds = new Set(allViewportTileIds.slice(0, this.maxVisuTiles))

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
        //  TODO: Consider tile TTL.
        let requests = []
        for (let [mapName, map] of Object.entries(this.maps)) {
            for (let [layerName, layer] of Object.entries(map.layers))
            {
                // Find tile IDs which are not yet loaded for this map layer combination.
                let requestTilesForMapLayer = []
                for (let tileId of allViewportTileIds) {
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
            .withBufferCallback((message, messageType) => {
                // Schedule the parsing of the newly arrived tile layer,
                // but don't do it synchronously to avoid stalling the ongoing
                // fetch operation.
                this.tileStreamParsingQueue.push([message, messageType]);
            });
        this.currentFetch.go();
    }

    addTileFeatureLayer(tileLayerBlob, style, preventCulling) {
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

    removeTileLayer(tileLayer) {
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

    renderTileLayer(tileLayer, style) {
        style = style || this.style;
        let visu = new TileVisualization(
            tileLayer,
            style,
            tileLayer.preventCulling || this.currentHighDetailTileIds.has(tileLayer.tileId));
        this.tileVisualizationQueue.push(visu);
        this.visualizedTileLayers.push(visu);
    }

// public:

    setViewport(viewport) {
        this.currentViewport = viewport;
        this.update();
    }
}
