"use strict";

import {MapViewerViewport} from "./viewport.js";
import {throttle} from "./utils.js";
import {Fetch} from "./fetch.js";
import {MapViewerBatch} from "./batch.js";

const minViewportChangedCallDelta = 200; // ms

const styleUrl = "/styles/demo-style.yaml";
const infoUrl = "/sources";
const tileUrl = "/tiles";


export class MapViewerModel
{
    constructor(coreLibrary)
    {
        //this.coreLib = coreLibrary;

        this.style = null;
        this.sources = null;
        //this.glbConverter = new coreLibrary.FeatureLayerRenderer();

        this.registeredBatches = new Map();

        this.update = {
            running:            false,
            numLoadingBatches:  0,
            loadingBatchNames:  new Set(),
            viewport:           new MapViewerViewport(),
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

        // Names for events that are triggered for various conditions.
        //  A model client (controller/frontend) may connect to them via addEventListener()
        //  to react on them.

        /// Triggered upon GLB load finished, with the visual and picking geometry batch roots.
        /// Received by frontend and MapViewerRenderingController.
        this.BATCH_ADDED = "batchAdded"; // {batch}

        /// Triggered upon onBatchRemoved with the visual and picking geometry batch roots.
        /// Received by frontend and MapViewerRenderingController.
        this.BATCH_ABOUT_TO_BE_DISPOSED = "batchAboutToBeDisposed"; // {batch}

        /// Signaled by frontend for enabling debug features.
        this.ENABLE_DEBUG = "enableDebug"; // {}

        // Received by frontend. Fired by renderingcontroller.
        this.INITIALIZED = "initialized"; // {}

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
        let batch = new MapViewerBatch(batchName, tile)
        this.registeredBatches.set(batchName, batch)
        this.renderBatch(batch);
    }

    renderBatch(batch, removeFirst) {
        if (removeFirst) {
            let disposeEvent = {
                type: this.BATCH_ABOUT_TO_BE_DISPOSED,
                batch: batch,
            };
            this.dispatchEvent(disposeEvent);
        }
        batch.render(this.coreLib, this.glbConverter, this.style, batch => {
            this.dispatchEvent({
                type: this.BATCH_ADDED,
                batch: batch
            })
        })
    }

    removeBatch(batchName) {
        let disposeEvent = {
            type: this.BATCH_ABOUT_TO_BE_DISPOSED,
            batch: this.registeredBatches.get(batchName),
        };
        this.dispatchEvent(disposeEvent);
        disposeEvent.batch.dispose();
        this.registeredBatches.delete(batchName);
    }

// public:

    viewportChanged(viewport, jumped, camPos, alt, tilt, orientation) {
        this._viewportUpdateThrottle(viewport, jumped, camPos, alt, tilt, orientation);
    }

    isMapUpdateRunning() {
        return this.update.running
    }

    showMapElement(batchName, visualId, visible) {
        if (!this.registeredBatches.has(batchName)) {
            console.warn(`Attempt to show/hide map element ${visualId} for unknown batch ${batchName}!`);
            return;
        }
        let batch = this.registeredBatches.get(batchName);
        batch.setElementVisible(visualId, visible);
        this.dispatchEvent({
            type: this.MAP_ELEM_VISIBILE_CHANGED,
            filter: false,
            visible: visible,
            bounds: batch.mapElementAngularExtents(visualId)
        });
    }

    getMapElementCenterPosition(batchName, visualId) {
        if (!this.registeredBatches.has(batchName)) {
            console.warn(`Attempt to access map element ${visualId} for unknown batch ${batchName}!`);
            return;
        }
        let batch = this.registeredBatches.get(batchName);
        return batch.mapElementCenterPoint(visualId);
    }

    mapElementPriority(visualId) {
        let visualIdString = visualId.toString();
        let batch = this.batchPerVisualId.get(visualIdString);
        if (!batch)
            return 0;
        let elemInfo = batch.visualIdIndex[visualIdString];
        return (elemInfo.type === "line" || elemInfo.type === "point") + elemInfo.prio;
    };

    mapElementAngularExtents(visualId) {
        let visualIdString = visualId.toString();
        let batch = this.batchPerVisualId.get(visualIdString);
        if (!batch)
            return null;
        return batch.mapElementAngularExtents(visualId);
    };

    ///////////////////////////////////////////////////////////////////////////

    go() {
        this.update.runningOnServer = false;
    }
    ///////////////////////////////////////////////////////////////////////////
}
