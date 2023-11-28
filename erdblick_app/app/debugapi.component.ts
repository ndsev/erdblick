"use strict";

import {uint8ArrayFromWasm} from "./wasm";
import {Cartesian3} from "cesium";

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
    private model: any;
    private coreLib: any;

    /**
     * Initialize a new ErdblickDebugApi instance.
     * @param mapView Reference to a ErdblickView instance
     */
    constructor(mapView: any) {
        this.view = mapView;
        this.model = mapView.model;
        this.coreLib = mapView.model.coreLib;
    }

    /**
     * Update the camera position and orientation in the map view.
     *
     * @param cameraInfoStr A JSON-formatted string containing camera information.
     */
    private setCamera(cameraInfoStr: string) {
        const cameraInfo = JSON.parse(cameraInfoStr);
        this.view.viewer.camera.setView({
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
            this.view.viewer.camera.position.x,
            this.view.viewer.camera.position.y,
            this.view.viewer.camera.position.z
        ];
        const orientation = {
            heading: this.view.viewer.camera.heading,
            pitch: this.view.viewer.camera.pitch,
            roll: this.view.viewer.camera.roll
        };
        return JSON.stringify({position, orientation});
    }

    /**
     * Generate a test TileFeatureLayer, and show it.
     */
    private showTestTile() {
        let tile = uint8ArrayFromWasm(this.coreLib, (sharedArr: any) => {
            this.coreLib.generateTestTile(sharedArr, this.model.tileParser);
        })
        let style = this.coreLib.generateTestStyle();
        this.model.addTileFeatureLayer(tile, style, true);
    }
}
