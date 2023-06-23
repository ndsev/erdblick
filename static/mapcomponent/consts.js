"use strict";

/**
 * @constant {Object} MapViewerConst
 */
export const MapViewerConst = (() => {
    /// Radius of the representation of the globe that is used
    let globeRenderRadius = 1024;
    let worldToSceneScale = globeRenderRadius / 6371;

    /// Speed of movement per arrow key/button stroke in any direction
    /// Fraction of current viewport arc on sphere.
    let movementSpeedPerArrowKeyStroke = .1;

    /// Exponent for zoomSpeedPerWheelTurn
    let zoomSpeedPerKeyStroke = 5;

    /// Factor for camera-globe distance
    let zoomSpeedPerWheelTurn = 1.1;

    /// Vertical field-of-view of mapviewer camera frustum
    let cameraFov = 50;

    /// Max/min camera pitch (ccw rotation around camera-local X axis)
    let cameraMaxPitch = Math.PI*.45;
    let cameraMinPitch = 0;

    /// Factor on minimum/maximum camera latitude to prevent gimbal lock
    let latClampFactor = .85;

    /// Minimum amount of pixels the mouse needs to move on either axis,
    /// before a drag move is recognized.
    let minPointerMoveBeforeDrag = 3;

    /// Maximum number of parallel GLB requests before available URIs are queued
    let maxNumParallelBatchRequests = 8;

    /// Maximum elevation that can be achieved with heightmaps
    let maxElevation = 16.383 * worldToSceneScale;

    /// Minimum ms between pointer-move event callbacks.
    let minPointerMoveDelta = 33;

    /// Debounce time to limit flickering redraws of outer rendertiles while zooming is in progress.
    let zoomRedrawThreshold = 250;

    return {
        globeRenderRadius: globeRenderRadius,
        minCameraGlobeDistance: globeRenderRadius * 0.000002,
        maxCameraGlobeDistance: globeRenderRadius * 2,
        worldToSceneScale: worldToSceneScale,
        movementSpeedPerArrowKeyStroke: movementSpeedPerArrowKeyStroke,
        zoomSpeedPerKeyStroke: zoomSpeedPerKeyStroke,
        zoomSpeedPerWheelTurn: zoomSpeedPerWheelTurn,
        cameraFov: cameraFov,
        cameraMaxPitch: cameraMaxPitch,
        cameraMinPitch: cameraMinPitch,
        cameraPitchInterval: cameraMaxPitch - cameraMinPitch,
        latClampFactor: latClampFactor,
        minPointerMoveBeforeDrag: minPointerMoveBeforeDrag,
        maxNumParallelBatchRequests: maxNumParallelBatchRequests,
        maxElevation: maxElevation,
        minPointerMoveDelta: minPointerMoveDelta,
        zoomRedrawThreshold: zoomRedrawThreshold
    };
})();
