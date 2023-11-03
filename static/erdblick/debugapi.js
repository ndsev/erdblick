"use strict";

/**
 * Debugging utility class designed for usage with the browser's debug console.
 *
 * Extends the actual application with debugging/dev functionality without
 * contaminating the application's primary codebase or an addition of a dedicated
 * GUI.
 */
export class ErdblickDebugApi {

    /**
     * Initialize a new ErdblickDebugApi instance.
     * @param mapView Reference to a ErdblickView instance
     */
    constructor(mapView) {
        this.view = mapView;
        this.model = mapView.model;
        this.coreLib = mapView.model.coreLib;
    }

    /**
     * Update the camera position and orientation in the map view.
     *
     * @param cameraInfoStr A JSON-formatted string containing camera information.
     */
    setCamera(cameraInfoStr) {
        const cameraInfo = JSON.parse(cameraInfoStr);
        this.view.viewer.camera.setView({
            destination: Cesium.Cartesian3.fromArray(cameraInfo.position),
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
    getCamera() {
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
        return JSON.stringify({ position, orientation });
    }

    /** Flies to the specified location. */
    flyTo(lon, lat) {
        this.view.viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1000),
            orientation: {
                heading: Cesium.Math.toRadians(0),
                pitch: Cesium.Math.toRadians(-90),
                roll: 0.0
            },
            duration: 1
        });
    }

    /**
     * Generate a test TileFeatureLayer, and show it.
     */
    showTestTile() {
        let tile = this.coreLib.generateTestTile();
        let style = this.coreLib.generateTestStyle();
        this.model.addTileLayer(tile, style, true);
    }
}
