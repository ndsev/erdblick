"use strict";

import {MapViewerModel} from "./model.js";
import {CesiumController} from "./cesiumcontroller.js";
import {CesiumViewer} from "./cesiumviewer.js";

export class MapComponent
{
    constructor(coreLib)
    {
        console.log("Constructing Map Component ...");

        this.model = new MapViewerModel(coreLib);
        console.log("  ... (1/3) constructed Map Viewer Model ("+this.model+").");

        this.viewer = new CesiumViewer();
        console.log("  ... (2/3) constructed Map Viewer Viewer ("+this.viewer+").");

        this.controller = new CesiumController(this.viewer, this.model);
        console.log("  ... (3/3) constructed Map Viewer Controller ("+this.controller+").");
    }

    moveToPosition(wgsLon, wgsLat, level) {
        // TODO: Implement
    };

}
