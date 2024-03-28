"use strict";

import {uint8ArrayFromWasm} from "./wasm";
import {Cartesian3} from "cesium";
import {CoreService} from "./core.service";
import {MapService} from "./map.service";
import {FeatureLayerStyle} from "../../build/libs/core/erdblick-core";
import {f} from "../../static/bundle/cesium/Workers/chunk-LYPPBP4Q";

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
    constructor(public coreService: CoreService,
                public mapService: MapService,
                mapView: any) {
        this.view = mapView;
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
        let tile = uint8ArrayFromWasm(this.coreService.coreLib, (sharedArr: any) => {
            if (this.coreService.coreLib !== undefined) {
                this.coreService.coreLib.generateTestTile(sharedArr, this.mapService.mapModel.tileParser);
            }
        })
        if (this.coreService.coreLib !== undefined) {
            let style = this.coreService.coreLib.generateTestStyle();
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
}
