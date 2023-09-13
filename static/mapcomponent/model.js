"use strict";

import {throttle} from "./utils.js";
import {Fetch} from "./fetch.js";
import {FeatureTile} from "./featuretile.js";

const styleUrl = "/styles/demo-style.yaml";
const infoUrl = "/sources";
const tileUrl = "/tiles";

export class MapViewerViewport {
    constructor(south, west, width, height, camPosLon, camPosLat, orientation) {
        this.south = south;
        this.west = west;
        this.width = width;
        this.height = height;
        this.camPosLon = camPosLon;
        this.camPosLat = camPosLat;
        this.orientation = orientation;
    }
}

export class MapViewerModel
{
    constructor(coreLibrary)
    {
        this.coreLib = coreLibrary;
        this.style = null;
        this.maps = null;
        this.glbConverter = new coreLibrary.FeatureLayerRenderer();
        this.loadedTileLayers = new Map();
        this.currentFetch = null;
        this.currentFetchId = 0;
        this.currentViewport = new MapViewerViewport;
        this.currentVisibleTileIds = new Set();

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

        /// Triggered when the user requests to zoom to a map layer
        this.zoomToWgs84PositionTopic = new rxjs.Subject(); // {.x,.y}

        /// Triggered when the map info is updated
        this.mapInfoTopic = new rxjs.Subject(); // {<mapId>: <mapInfo>}

        ///////////////////////////////////////////////////////////////////////////
        //                                 BOOTSTRAP                             //
        ///////////////////////////////////////////////////////////////////////////

        this.reloadStyle()
        this.reloadDataSources()
    }

    reloadStyle()
    {
        // Delete the old style if present.
        if (this.style)
            this.style.delete()

        // Fetch the new one.
        new Fetch(this.coreLib, styleUrl).withWasmCallback(styleYamlBuffer => {
            // Parse the style description into a WASM style object.
            this.style = new this.coreLib.FeatureLayerStyle(styleYamlBuffer);

            // Re-render all present batches with the new style.
            for (let [batchId, batch] of this.loadedTileLayers.entries()) {
                this.renderTileLayer(batch, true)
            }
            console.log("Loaded style.")
        }).go();
    }

    reloadDataSources() {
        new Fetch(this.coreLib, infoUrl)
            .withWasmCallback(infoBuffer => {
                this.tileParser.setDataSourceInfo(infoBuffer);
                console.log("Loaded data source info.")
            })
            .withJsonCallback(result => {
                this.maps = Object.fromEntries(result.map(mapInfo => [mapInfo.mapId, mapInfo]));
                this.mapInfoTopic.next(this.maps)
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
        if (this.currentFetch)
            this.currentFetch.abort()

        // Make sure that there are no unparsed bytes lingering from the previous response stream.
        this.tileParser.reset()

        // Evict present non-required tile layers.
        let newTileLayers = new Map();
        for (let tileLayer of this.loadedTileLayers.values()) {
            if (!this.currentVisibleTileIds.has(tileLayer.tileId)) {
                this.tileLayerRemovedTopic.next(tileLayer);
                tileLayer.dispose()
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
                        requestTilesForMapLayer.push(Number(tileId))
                }

                // Only add a request if there are tiles to be loaded.
                if (requestTilesForMapLayer)
                    requests.push({
                        mapId: mapName,
                        layerId: layerName,
                        tileIds: requestTilesForMapLayer
                    })
            }
        }

        let fetchId = ++(this.currentFetchId);
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
                setTimeout(_ => {
                    // Only process the buffer chunk, if the fetch operation
                    // for the chunk is the most recent one.
                    if (fetchId === this.currentFetchId) {
                        this.tileParser.parseFromStream(tileBuffer);
                    }
                    tileBuffer.delete();
                }, 0)
            }, true);
        this.currentFetch.go();
    }

    addTileLayer(tileLayer) {
        console.assert(!this.loadedTileLayers.has(tileLayer.id))
        this.loadedTileLayers.set(tileLayer.id, tileLayer)
        this.renderTileLayer(tileLayer);
    }

    renderTileLayer(tileLayer, removeFirst) {
        if (removeFirst) {
            this.tileLayerRemovedTopic.next(tileLayer)
        }
        tileLayer.render(this.glbConverter, this.style).then(wasRendered => {
            if (!wasRendered)
                return;

            // It is possible, that the tile went out of view while
            // Cesium took its time to load it. In this case, don't
            // add it to the viewport.
            const isInViewport = this.currentVisibleTileIds.has(tileLayer.tileId);
            if (isInViewport)
                this.tileLayerAddedTopic.next(tileLayer)
            else
                tileLayer.disposeRenderResult()
        })
    }

// public:

    setViewport(viewport) {
        this.currentViewport = viewport;
        this.update();
    }
}
