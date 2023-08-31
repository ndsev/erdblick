"use strict";

import {throttle} from "./utils.js";
import {Fetch} from "./fetch.js";
import {FeatureLayerTileSet} from "./featurelayer.js";

const minViewportChangedCallDelta = 200; // ms

const styleUrl = "/styles/demo-style.yaml";
const infoUrl = "/sources";
const tileUrl = "/tiles";


export class MapViewerModel
{
    constructor(coreLibrary)
    {
        this.coreLib = coreLibrary;

        this.style = null;
        this.sources = null;
        this.glbConverter = new coreLibrary.FeatureLayerRenderer();

        this.registeredBatches = new Map();

        this.update = {
            running:            false,
            numLoadingBatches:  0,
            loadingBatchNames:  new Set(),
            fetch:              null,
            stream:             null
        };

        this._viewportUpdateThrottle = throttle(
            minViewportChangedCallDelta,
            (viewport, jumped, camPos, alt, tilt, orientation) =>
            {
                this.update.viewport = viewport.clone();
                // this.update()
            }
        );

        ///////////////////////////////////////////////////////////////////////////
        //                               MODEL EVENTS                            //
        ///////////////////////////////////////////////////////////////////////////

        /// Triggered upon GLB load finished, with the visual and picking geometry batch roots.
        /// Received by frontend and MapViewerRenderingController.
        this.batchAddedTopic = new rxjs.Subject(); // {MapViewerBatch}

        /// Triggered upon onBatchRemoved with the visual and picking geometry batch roots.
        /// Received by frontend and MapViewerRenderingController.
        this.batchRemovedTopic = new rxjs.Subject(); // {MapViewerBatch}

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
            for (let [batchId, batch] of this.registeredBatches.entries()) {
                this.renderBatch(batch, true)
            }
            console.log("Loaded style.")
        }).go();
    }

    reloadSources() {
        new Fetch(this.coreLib, infoUrl)
            .withWasmCallback(infoBuffer => {
                if (this.update.stream)
                    this.update.stream.delete()
                this.update.stream = new this.coreLib.TileLayerParser(infoBuffer);
                this.update.stream.onTileParsed(tile => {
                    this.addBatch(tile)
                    $("#log").append(`<span>Loaded ${tile.id()}</span>&nbsp;<button onclick="zoomToBatch('${tile.id()}')">Focus</button><br>`)
                });
                console.log("Loaded data source info.")
            })
            .withJsonCallback(result => {this.sources = result;})
            .go();
    }

    ///////////////////////////////////////////////////////////////////////////
    //                          MAP UPDATE CONTROLS                          //
    ///////////////////////////////////////////////////////////////////////////

    runUpdate() {
        // TODO
        //  if (this.update.fetch)
        //      this.update.fetch.abort()
        //  if (this.update.stream)
        //      this.update.stream.clear()

        // TODO: Remove present batches

        let requests = []
        for (let dataSource of this.sources) {
            for (let [layerName, layer] of Object.entries(dataSource.layers)) {
                requests.push({
                    mapId: dataSource.mapId,
                    layerId: layerName,
                    tileIds: layer.coverage
                })
            }
        }

        new Fetch(this.coreLib, tileUrl)
            .withChunkProcessing()
            .withMethod("POST")
            // TODO: Add fields dict offset info to request
            .withBody({requests: requests})
            .withWasmCallback(tileBuffer => {
                this.update.stream.parse(tileBuffer);
            })
            .go();
    }

    addBatch(tile) {
        let batchName = tile.id();
        let batch = new FeatureLayerTileSet(batchName, tile)
        this.registeredBatches.set(batchName, batch)
        this.renderBatch(batch);
    }

    renderBatch(batch, removeFirst) {
        if (removeFirst) {
            this.batchRemovedTopic.next(batch)
        }
        batch.render(this.coreLib, this.glbConverter, this.style, batch => {
            this.batchAddedTopic.next(batch)
        })
    }

    removeBatch(batchName) {
        this.batchRemovedTopic.next(this.registeredBatches.get(batchName));
        this.registeredBatches.delete(batchName);
    }

// public:

    viewportChanged(viewport, jumped, camPos, alt, tilt, orientation) {
        this._viewportUpdateThrottle(viewport, jumped, camPos, alt, tilt, orientation);
    }

    go() {
        // TODO: Implement Initial Data Request
    }
}
