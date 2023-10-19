"use strict";

import {Fetch} from "./fetch.js";
import {FeatureTile} from "./features.js";

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
    constructor(coreLibrary)
    {
        this.coreLib = coreLibrary;
        this.style = null;
        this.maps = null;
        this.loadedTileLayers = new Map();
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
        this.tileStreamParsingQueue = [];

        // Instantiate the TileLayerParser, and set its callback
        // for when a new tile is received.
        this.tileParser = new this.coreLib.TileLayerParser();
        this.tileParser.onTileParsedFromStream(tileFeatureLayer => {
            const isInViewport = this.currentVisibleTileIds.has(tileFeatureLayer.tileId());
            const alreadyLoaded = this.loadedTileLayers.has(tileFeatureLayer.id());
            if (isInViewport && !alreadyLoaded) {
                let tile = new FeatureTile(this.coreLib, this.tileParser, tileFeatureLayer);
                this.addTileLayer(tile);
            }
            else
                tileFeatureLayer.delete();
        });

        ///////////////////////////////////////////////////////////////////////////
        //                               MODEL EVENTS                            //
        ///////////////////////////////////////////////////////////////////////////

        /// Triggered when a tile layer is freshly rendered and should be added to the frontend.
        this.tileLayerAddedTopic = new rxjs.Subject(); // {FeatureTile}

        /// Triggered when a tile layer is being removed.
        this.tileLayerRemovedTopic = new rxjs.Subject(); // {FeatureTile}

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
    }

    processTileStream()
    {
        if (this.tileStreamParsingQueue.length) {
            let message = this.tileStreamParsingQueue.shift();
            this.tileParser.parseFromStream(message);
            message.delete();
        }
        // Keep processing messages. ASAP if more messages exist, 10ms delay otherwise.
        setTimeout(_ => this.processTileStream(), this.tileStreamParsingQueue.length ? 0 : 10);
    }

    reloadStyle()
    {
        // Delete the old style if present.
        if (this.style)
            this.style.delete();

        // Fetch the new one.
        new Fetch(this.coreLib, styleUrl).withWasmCallback(styleYamlBuffer => {
            // Parse the style description into a WASM style object.
            this.style = new this.coreLib.FeatureLayerStyle(styleYamlBuffer);

            // Re-render all present batches with the new style.
            for (let [batchId, batch] of this.loadedTileLayers.entries()) {
                this.renderTileLayer(batch, true);
            }
            console.log("Loaded style.");
        }).go();
    }

    reloadDataSources() {
        new Fetch(this.coreLib, infoUrl)
            .withWasmCallback(infoBuffer => {
                this.tileParser.setDataSourceInfo(infoBuffer);
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
        const allViewportTileIds = this.coreLib.getTileIds(this.currentViewport, 13, 512);
        this.currentVisibleTileIds = new Set(allViewportTileIds);

        // Abort previous fetch operation.
        if (this.currentFetch) {
            this.currentFetch.abort();
            // Clear any unparsed messages
            this.tileStreamParsingQueue.forEach(message => message.delete());
            this.tileStreamParsingQueue = [];
        }

        // Make sure that there are no unparsed bytes lingering from the previous response stream.
        this.tileParser.reset();

        // Evict present non-required tile layers.
        let newTileLayers = new Map();
        for (let tileLayer of this.loadedTileLayers.values()) {
            if (!this.currentVisibleTileIds.has(tileLayer.tileId)) {
                this.tileLayerRemovedTopic.next(tileLayer);
                tileLayer.dispose();
            }
            else
                newTileLayers.set(tileLayer.id, tileLayer);
        }
        this.loadedTileLayers = newTileLayers;

        // Request non-present required tile layers.
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

        this.currentFetch = new Fetch(this.coreLib, tileUrl)
            .withChunkProcessing()
            .withMethod("POST")
            .withBody({
                requests: requests,
                maxKnownFieldIds: this.tileParser.fieldDictOffsets()
            })
            .withWasmCallback(tileBuffer => {
                // Schedule the parsing of the newly arrived tile layer,
                // but don't do it synchronously to avoid stalling the ongoing
                // fetch operation.
                this.tileStreamParsingQueue.push(tileBuffer);
            }, true);
        this.currentFetch.go();
    }

    addTileLayer(tileLayer) {
        if (this.loadedTileLayers.has(tileLayer.id)) {
            throw new Error(`Refusing to add tile layer ${tileLayer.id}, which is already present.`);
        }
        this.loadedTileLayers.set(tileLayer.id, tileLayer);
        // Schedule the visualization of the newly added tile layer,
        // but don't do it synchronously to avoid stalling the main thread.
        setTimeout(() => {
            this.renderTileLayer(tileLayer);
        })
    }

    renderTileLayer(tileLayer, removeFirst) {
        if (removeFirst) {
            this.tileLayerRemovedTopic.next(tileLayer);
        }
        tileLayer.render(this.glbConverter, this.style).then(wasRendered => {
            if (!wasRendered)
                return;

            // It is possible, that the tile went out of view while
            // we took our time to visualize it. In this case, don't
            // add it to the viewport.
            const isInViewport = this.currentVisibleTileIds.has(tileLayer.tileId);
            if (isInViewport)
                this.tileLayerAddedTopic.next(tileLayer);
            else
                tileLayer.disposeRenderResult();
        })
    }

// public:

    setViewport(viewport) {
        this.currentViewport = viewport;
        this.update();
    }
}
