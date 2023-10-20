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
        this.mapView.viewer.camera.setView({
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
            this.mapView.viewer.camera.position.x,
            this.mapView.viewer.camera.position.y,
            this.mapView.viewer.camera.position.z
        ];
        const orientation = {
            heading: this.mapView.viewer.camera.heading,
            pitch: this.mapView.viewer.camera.pitch,
            roll: this.mapView.viewer.camera.roll
        };
        return JSON.stringify({ position, orientation });
    }
}