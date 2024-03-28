"use strict";

import {coreLib, uint8ArrayFromWasm} from "./wasm";
import {Cartesian3} from "cesium";
import {MapService} from "./map.service";
import {ErdblickViewComponent} from "./view.component";
import {ViewService} from "./view.service";

/**
 * Extend Window interface to allow custom ErdblickDebugApi property
 */
export interface DebugWindow extends Window {
    ebDebug: ErdblickDebugApi;
}

/**
 * Debugging utility class designed for usage with the browser's debug console.
 *
 * Extends the actual application with debugging/dev functionality without
 * contaminating the application's primary codebase or an addition of a dedicated
 * GUI.
 */
export class ErdblickDebugApi {
    private view: any;

    /**
     * Initialize a new ErdblickDebugApi instance.
     * @param mapView Reference to a ErdblickView instance
     */
    constructor(public mapService: MapService,
                public viewService: ViewService,
                mapView: ErdblickViewComponent) {
        this.view = mapView;
    }

    /**
     * Update the camera position and orientation in the map view.
     *
     * @param cameraInfoStr A JSON-formatted string containing camera information.
     */
    private setCamera(cameraInfoStr: string) {
        const cameraInfo = JSON.parse(cameraInfoStr);
        this.viewService.cameraViewData.next({
            destination: Cartesian3.fromArray(cameraInfo.position),
            orientation: {
                heading: cameraInfo.orientation.heading,
                pitch: cameraInfo.orientation.pitch,
                roll: cameraInfo.orientation.roll
            }
        });
    }

    /**
     * Retrieve the current camera position and orientation.
     *
     * @return A JSON-formatted string containing the current camera's position and orientation.
     */
    private getCamera() {
        const position = [
            this.viewService.cameraViewData.getValue().destination.x,
            this.viewService.cameraViewData.getValue().destination.y,
            this.viewService.cameraViewData.getValue().destination.z,
        ];
        const orientation = this.viewService.cameraViewData.getValue().orientation;
        return JSON.stringify({position, orientation});
    }

    /**
     * Generate a test TileFeatureLayer, and show it.
     */
    private showTestTile() {
        let tile = uint8ArrayFromWasm(coreLib, (sharedArr: any) => {
            coreLib.generateTestTile(sharedArr, this.mapService.mapModel.tileParser);
        });
        let style = coreLib.generateTestStyle();
        this.mapService.mapModel.addTileFeatureLayer(tile, {
            id: "_builtin",
            modified: false,
            imported: false,
            enabled: true,
            data: "",
            featureLayerStyle: style
        }, "_builtin", true);
    }
}
