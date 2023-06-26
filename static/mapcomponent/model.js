"use strict";

import {EventDispatcher} from "../deps/three.js";
import {MapViewerViewport} from "./viewport.js";
import {throttle} from "./utils.js";


const minViewportChangedCallDelta = 200; // ms


export class MapViewerModel extends EventDispatcher
{

    constructor(platform, coreLibrary)
    {
        super();

        this.globeSphere = null;
        this.platform = platform

        this.registeredBatches = new Map();
        this.batchPerVisualId = new Map();

        this.update = {
            running:            false,
            numLoadingBatches:  0,
            loadingBatchNames:  new Set(),
            queuedBatches:      new Map(),  // points from batchname to seqno
            queuedBatchesToRemove: new Set(),
            viewport:           new MapViewerViewport(),

            heightmap: {
                dirty:          true,
                fetching:       false
            }
        };

        this._viewportUpdateThrottle = throttle(
            minViewportChangedCallDelta,
            (viewport, jumped, camPos, alt, tilt, orientation) =>
            {
                this.update.heightmap.dirty |= !this.update.viewport.equals(viewport);
                this.update.viewport = viewport.clone();
                // mapViewerService.viewportChanged(viewport.wgs84(), jumped, camPos, alt, tilt, orientation, () => {});
            }
        );

        ///////////////////////////////////////////////////////////////////////////
        //                               MODEL EVENTS                            //
        ///////////////////////////////////////////////////////////////////////////

        // Names for events that are triggered for various conditions.
        //  A model client (controller/frontend) may connect to them via addEventListener()
        //  to react on them.

        /// Triggered directly upon onNewBatchAvailable with the new update.queuedBatches.size.
        /// Received by frontend.
        this.BATCH_QUEUE_SIZE = "queueSizeChanged"; // {queueSize, deleteQueueSize}

        /// Triggered upon GLB load finished, with the visual and picking geometry batch roots.
        /// Received by frontend and MapViewerRenderingController.
        this.BATCH_ADDED = "batchAdded"; // {batch, queueSize}

        /// Triggered upon onBatchRemoved with the visual and picking geometry batch roots.
        /// Received by frontend and MapViewerRenderingController.
        this.BATCH_ABOUT_TO_BE_DISPOSED = "batchAboutToBeDisposed"; // {batch, queueSize}

        /// Triggered upon onClearBatches
        /// Received by frontend and MapViewerRenderingController.
        this.CLEAR_MAP_ELEMENT_BATCHES = "clearMapElementBatches";

        /// Triggered by the parent mapcomponent on mouse click.
        /// Received by frontend
        this.POSITION_PICKED = "positionPicked"; // {elementId, longitude, latitude, coords, userSelection : bool}

        // Triggered upon calling MapViewerModel.optionsChanged()
        // Received by Rendering COntroller to show/hide highlight geometry
        this.MAP_ELEM_VISIBILE_CHANGED = "mapElemVisibleChanged"; // {<filter>: <regex>, <visible>: <bool>}

        /// Extension status from `libmapviewer_typedefs.h ExtensionStatus`
        this.extensionStatus = {
            Default: 0,
            NoData: 1,
            Custom: 2
        };

        /// Signaled by frontend for enabling debug features.
        this.ENABLE_DEBUG = "enableDebug"; // {}

        // Received by model, forwarded to frontend for compass
        this.CAM_POS_CHANGED = "camPosChanged";

        // Received by rendering controller when GET heightmapapi/heightmap returns
        this.VIEWPORT_HEIGHTMAP = "viewportHeightmap";

        // Received by frontend, when a label position or visibility changes
        this.LABEL_STATE_CHANGED = "labelStateChanged"; // {states: [{labelId, styleId, text, position, visible, deleted}]}

        // Received by frontend. Fired by renderingcontroller.
        this.INITIALIZED = "initialized"; // {}

        // Received by frontend for feature searches. Fired by mapcomponent.
        this.SEARCH_STATE = "searchState"; // {state: 'searching'|'found'|'notfound', timeout: int}
    }

    setGlobe(globe) {
       this.globeSphere = globe;
    }

    ///////////////////////////////////////////////////////////////////////////
    //                          MAP UPDATE CONTROLS                          //
    ///////////////////////////////////////////////////////////////////////////

    removeRegisteredBatch(batchName, suppressRedraw) {
        let disposeEvent = {
            type: this.BATCH_ABOUT_TO_BE_DISPOSED,
            batchName: batchName,
            queueSize: this.update.queuedBatches.size,
            batch: this.registeredBatches.get(batchName),
            suppressRedraw: suppressRedraw
        };
        this.dispatchEvent(disposeEvent);
        disposeEvent.batch.dispose();
        Object.keys(disposeEvent.batch.visualIdIndex).forEach((visualId) => {
            this.batchPerVisualId.delete(visualId)
        });
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
        this.globeSphere.globeTextureLoadPromise.then(() =>
        {
            this.dispatchEvent({type: this.INITIALIZED});
        });
    }
    ///////////////////////////////////////////////////////////////////////////
}
