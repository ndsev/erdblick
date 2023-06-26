"use strict";

import {MapViewerModel} from "./model.js";
import {MapViewerRenderingController} from "./renderingcontroller.js";
import {MapViewerConst} from "./consts.js";
import {SingleShotTimer} from "./timer.js";


export function MapComponent(platform, coreLib)
{
    console.log("Constructing Map Component ...");
    let scope = this;

// public:

    scope.model = new MapViewerModel(platform, coreLib);
    console.log("  ... (1/2) constructed Map Viewer Model ("+scope.model+").");

    let renderingController = new MapViewerRenderingController(scope.model, platform);
    scope.renderingController = renderingController;
    console.log("  ... (2/3) constructed Rendering Controller ("+renderingController+").");

    let cameraController = renderingController.cameraController;
    console.log("  ... (3/3) constructed Camera Controller ("+cameraController+").");

    /// Keep the last picked coordinates from the marker placed by the user
    scope.lastPickedCoords = null;
    /// Forward camera-orientation-changed event
    cameraController.addEventListener(
        cameraController.CAM_POS_CHANGED,
        (event) => {
            event.type = scope.model.CAM_POS_CHANGED;
            scope.model.dispatchEvent(event)
        }
    );

// public:

    ///////////////////////////////////////////////////////////////////////////
    //                             EVENT HANDLERS                            //
    ///////////////////////////////////////////////////////////////////////////

    scope.onKeyPressed = (event) =>
    {
        // Do not process key events that are directed to a text input
        if (event.target.tagName.toLowerCase() === "input" || event.target.tagName.toLowerCase() === "textarea") {
            return;
        }

        if (event.key === platform.key.Plus)
            cameraController.fastZoomIn();
        else if (event.key === platform.key.Minus)
            cameraController.fastZoomOut();
        else if (event.key === platform.key.Left)
            cameraController.turnCameraAroundGlobeRelative(MapViewerConst.movementSpeedPerArrowKeyStroke, 0);
        else if (event.key === platform.key.Right)
            cameraController.turnCameraAroundGlobeRelative(-MapViewerConst.movementSpeedPerArrowKeyStroke, 0);
        else if (event.key === platform.key.Up)
            cameraController.turnCameraAroundGlobeRelative(0, MapViewerConst.movementSpeedPerArrowKeyStroke);
        else if (event.key === platform.key.Down)
            cameraController.turnCameraAroundGlobeRelative(0, -MapViewerConst.movementSpeedPerArrowKeyStroke);
        else if (event.key === platform.key.D)
            scope.model.dispatchEvent({type: scope.model.ENABLE_DEBUG});
    };

    scope.onMousePositionChanged = (event) => {
        cameraController.notifyMouseMoved(event.clientX, event.clientY);
        renderingController.mousePositionChanged(event.clientX, event.clientY);
    };

    scope.onMousePressed = (event) => {
        cameraController.notifyMouseDown(event.shiftKey ? platform.mouse.Right : event.button)
    };

    scope.onWheel = (event) => {
        cameraController.notifyWheel(event.deltaY)
    };

    scope.onMouseReleased = (event) => {
        if (cameraController.mouseDown && !cameraController.draggingActive)
        {
            switch(event.button)
            {
            case platform.mouse.Left:
                let pickingEvent = {
                    coords: null,
                    elementId: renderingController.selectPixel(event.clientX, event.clientY),
                    userSelection: true,
                    type: scope.model.POSITION_PICKED
                };

                let wgs84Pos = cameraController.screenCoordsToWgs84(event.clientX, event.clientY);
                if(wgs84Pos)
                {
                    // TODO: Dispatch Picking event
                }
                else {
                    renderingController.clearHighlights();
                    scope.model.dispatchEvent(pickingEvent)
                }
                break;

            case platform.mouse.Right:
                if(!event.shiftKey)
                    cameraController.fastZoomIn(true);
                else
                    cameraController.fastZoomOut(true)
            }
        }

        cameraController.notifyMouseReleased()
    };

    scope.onTouchStart = (ev) => {
        cameraController.notifyTouchStart(ev.touches)
    };

    scope.onTouchMove =
        (ev) => {
            cameraController.notifyTouchMove(ev.touches)
        };

    scope.onTouchEnd = (ev) => {
        if (!cameraController.draggingActive)
            scope.onMouseReleased({
                clientX: cameraController.pointerPosition().x,
                clientY: cameraController.pointerPosition().y,
                button: platform.mouse.Left
            });
        cameraController.notifyTouchEnd(ev.touches)
    };

    ///////////////////////////////////////////////////////////////////////////
    //                               UTILITIES                               //
    ///////////////////////////////////////////////////////////////////////////
    
    scope.moveToPosition = (wgsLon, wgsLat, level) => {
        cameraController.moveToCoords(wgsLon, wgsLat, true);
        if (level !== undefined) {
            cameraController.zoomToGridLevel(level);
        }
    };

    scope.setSubTileStateFun = (fun) => {
        renderingController.viewport().setSubTileStateFun(fun);
    };

    scope.setFpsMonitorFun = (fun) => {
        renderingController.setFpsMonitorFun(fun);
    };

    scope.showPickingScene = (show) => {
        renderingController.showPickingScene(show);
    };

    scope.showHoverHighlights = (show) => {
        renderingController.showHoverHighlights(show)
    };

    scope.showWireframes = (show) => {
        renderingController.showWireframes(show)
    };

    scope.showGlobeGrid = (show) => {
        renderingController.showGlobeGrid(show)
    };

    scope.showGlobe = (show) => {
        renderingController.showGlobe(show)
    };

    scope.showShadow = (value) => {
        renderingController.showShadow(value)
    };

    scope.gridLevel = (value) => {
        renderingController.gridLevel(value)
    };

    scope.getUsedGridLevel = () => {
        if (renderingController.getGridLevel() > -1) {
            return renderingController.getGridLevel();
        }
        return this.gridAutoLevel();
    };

    scope.gridAutoLevel = () => {
        return scope.renderingController.viewport().gridAutoLevel();
    };

    scope.terrainExcentricity = (value) => {
        renderingController.terrainExcentricity(value)
    };

    scope.terrainColor = (value) => {
        renderingController.terrainColor(value)
    };

    scope.resetCameraOrientation = () => {
        cameraController.resetCameraOrientation()
    };

    scope.highlightVisualId = (vid) => {
        renderingController.highlight(vid);
    };

    scope.pickedWgs84Coords = (resultFun) => {
        if (!scope.lastPickedCoords) {
            return cameraController.getCameraWgs84Coords();
        }
        return {x: scope.lastPickedCoords.wgsLon, y: scope.lastPickedCoords.wgsLat};
    }

    ///////////////////////////////////////////////////////////////////////////
    //                             WEBGL TRIGGERS                            //
    ///////////////////////////////////////////////////////////////////////////

    scope.glInitialize = (targetCanvas) => {
        renderingController.initialize(targetCanvas);
        scope.model.go()
    };

    scope.glResize = () => {
        renderingController.resize()
    };
}
