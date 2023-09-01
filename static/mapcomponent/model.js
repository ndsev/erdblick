"use strict";

import {throttle} from "./utils.js";
import {Fetch} from "./fetch.js";
import {FeatureTile} from "./featuretile.js";

const minViewportChangedCallDelta = 200; // ms

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
        this.sources = null;
        this.glbConverter = new coreLibrary.FeatureLayerRenderer();
        this.loadedTileLayers = new Map();
        this.currentFetch = null;
        this.currentTileStream = null;
        this.currentViewport = new MapViewerViewport;
        this.currentVisibleTileIds = new Set();

        ///////////////////////////////////////////////////////////////////////////
        //                               MODEL EVENTS                            //
        ///////////////////////////////////////////////////////////////////////////

        /// Triggered when a tile layer is freshly rendered and should be added to the frontend.
        this.tileLayerAddedTopic = new rxjs.Subject(); // {FeatureTile}

        /// Triggered when a tile layer is being removed.
        this.tileLayerRemovedTopic = new rxjs.Subject(); // {FeatureTile}

        ///////////////////////////////////////////////////////////////////////////
        //                                 BOOTSTRAP                             //
        ///////////////////////////////////////////////////////////////////////////

        this.reloadStyle()
        this.reloadSources()
    }

    reloadStyle() {
        if (this.style)
            this.style.delete()
        new Fetch(this.coreLib, styleUrl).withWasmCallback(styleYamlBuffer => {
            this.style = new this.coreLib.FeatureLayerStyle(styleYamlBuffer);
            for (let [batchId, batch] of this.loadedTileLayers.entries()) {
                this.renderTileLayer(batch, true)
            }
            console.log("Loaded style.")
        }).go();
    }

    reloadSources() {
        new Fetch(this.coreLib, infoUrl)
            .withWasmCallback(infoBuffer => {
                if (this.currentTileStream)
                    this.currentTileStream.delete()
                this.currentTileStream = new this.coreLib.TileLayerParser(infoBuffer);
                this.currentTileStream.onTileParsed(tileFeatureLayer => {
                    this.addTileLayer(new FeatureTile(tileFeatureLayer))
                });
                console.log("Loaded data source info.")
            })
            .withJsonCallback(result => {
                this.sources = result;
                for (let source of this.sources) {
                    $("#maps").append(`<span>Map ${source.mapId}</span>&nbsp;<button onclick="zoomToBatch('${tile.id()}')">Focus</button><br>`)
                }
            })
            .go();
    }

    ///////////////////////////////////////////////////////////////////////////
    //                          MAP UPDATE CONTROLS                          //
    ///////////////////////////////////////////////////////////////////////////

    update()
    {
        // Get the tile IDs for the current viewport.
        const requestTileIdList = this.coreLib.getTileIds(this.currentViewport, 13, 512);
        this.currentVisibleTileIds = new Set(requestTileIdList);

        // Abort previous fetch operation.
        if (this.currentFetch)
            this.currentFetch.abort()

        // Make sure that there are no unparsed bytes lingering from the previous response stream.
        this.currentTileStream.reset()

        // Evict present non-required tile layers.
        let newTileLayers = new Map();
        for (let tileLayer of this.loadedTileLayers.values()) {
            if (!this.currentVisibleTileIds.has(tileLayer.tileId)) {
                this.tileLayerRemovedTopic.next(tileLayer.id);
                tileLayer.dispose()
            }
            else
                newTileLayers.set(tileLayer.id, tileLayer);
        }
        this.loadedTileLayers = newTileLayers;

        // Request non-present required tile layers.
        let requests = []
        for (let dataSource of this.sources) {
            for (let [layerName, layer] of Object.entries(dataSource.layers))
            {
                // Find tile IDs which are not yet loaded for this map layer combination.
                let requestTilesForMapLayer = []
                for (let tileId of requestTilesForMapLayer) {
                    const tileMapLayerKey = this.coreLib.getTileFeatureLayerKey(dataSource.mapId, layerName, tileId);
                    if (!this.loadedTileLayers.has(tileMapLayerKey))
                        requestTilesForMapLayer.push(tileId)
                }

                // Only add a request if there are tiles to be loaded.
                if (requestTilesForMapLayer)
                    requests.push({
                        mapId: dataSource.mapId,
                        layerId: layerName,
                        tileIds: requestTilesForMapLayer
                    })
            }
        }

        this.currentFetch = new Fetch(this.coreLib, tileUrl)
            .withChunkProcessing()
            .withMethod("POST")
            .withBody({
                requests: requests,
                maxKnownFieldIds: this.currentTileStream.fieldDictOffsets()
            })
            .withWasmCallback(tileBuffer => {
                this.currentTileStream.parse(tileBuffer);
            });
        this.currentFetch.go();
    }

    addTileLayer(tileLayer) {
        this.loadedTileLayers.set(tileLayer.id, tileLayer)
        this.renderTileLayer(tileLayer);
    }

    renderTileLayer(tileLayer, removeFirst) {
        if (removeFirst) {
            this.tileLayerRemovedTopic.next(tileLayer)
        }
        tileLayer.render(this.coreLib, this.glbConverter, this.style, _ => {
            this.tileLayerAddedTopic.next(tileLayer)
        })
    }

// public:

    setViewport(viewport) {
        this.currentViewport = viewport;
        this.update();
    }
}
