// Copyright (c) Navigation Data Standard e.V. - See "LICENSE" file.

import { cookieValue } from "/mapcomponent/utils.js";
import { platform} from "./platform.js";
import { MapComponent } from "./mapcomponent/mapcomponent.js";
import libErdblickCore from "./libs/core/erdblick-core.js";
import { MapViewerBatch } from "./mapcomponent/batch.js";

// --------------------------- Initialize Map Component --------------------------

console.log("Loading core library ...")

libErdblickCore().then(coreLib =>
{
    console.log("  ...done.")

    let mapComponent = new MapComponent(platform, coreLib);
    let glbConverter = new coreLib.FeatureLayerRenderer();
    let testDataProvider = new coreLib.TestDataProvider();

    window.loadTestTile = () => {
        const styleUrl = "styles/demo-style.yaml";
        fetch(styleUrl).then((response) => {
            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status}`);
            }
            return response.text();
        })
        .then((styleYaml) => {
            // Prepare to pass the style configuration to FeatureLayerRenderer.
            // TODO: Write a JS wrapper class for C++ SharedUint8Array.
            let e = new TextEncoder();
            let yamlAsUtf8 = e.encode(styleYaml);
            let yamlLength = yamlAsUtf8.length;
            const yamlCppArr = new coreLib.SharedUint8Array(yamlLength);
            const yamlCppArrPtr = Number(yamlCppArr.getPointer());
            // Creating an Uint8Array on top of the buffer is essential!
            const memoryView = new Uint8Array(coreLib.HEAPU8.buffer);
            for (let i = 0; i < yamlLength; i++) {
                memoryView[yamlCppArrPtr + i] = yamlAsUtf8[i];
            }
            const s = new coreLib.FeatureLayerStyle(yamlCppArr);

            // Prepare a TileFeatureLayer for visualization.
            const testLayerPtr = testDataProvider.getTestLayer(
                mapComponent.renderingController.cameraController.getCameraWgs84Coords().x,
                mapComponent.renderingController.cameraController.getCameraWgs84Coords().y,
                mapComponent.renderingController.viewport().gridAutoLevel());

            // Visualize it
            new MapViewerBatch("test", coreLib, glbConverter, s, testLayerPtr, (batch)=>{
                mapComponent.model.dispatchEvent({
                    type: mapComponent.model.BATCH_ADDED,
                    batch: batch
                })
            }, ()=>{})
        })
    };

    // ----------------------- Initialize input event handlers -----------------------

    function stopProp(ev) {
        if(ev.stopPropagation){
            ev.stopPropagation();
        }
        ev.preventDefault();
        ev.cancelBubble = true;
    }

    let canvasContainer = $("#mapviewer-canvas-container")[0];
    let pointerIsMouse = false;

    canvasContainer.addEventListener("touchstart", function(ev){
        if (pointerIsMouse)
            return true;
        stopProp(ev);
        mapComponent.onTouchStart(ev);
        return false;
    }, false);

    canvasContainer.addEventListener("touchmove", function(ev){
        stopProp(ev);
        mapComponent.onTouchMove(ev);
        return false;
    }, false);

    document.addEventListener("touchend", function(ev) {
        mapComponent.onTouchEnd(ev);
        return true;
    }, false);

    canvasContainer.addEventListener("mousedown", function(ev){
        pointerIsMouse = true;
        stopProp(ev);
        mapComponent.onMousePressed(ev);
        return false;
    }, false);

    canvasContainer.addEventListener("mousemove", function(ev){
        stopProp(ev);
        mapComponent.onMousePositionChanged(ev);
        return false;
    }, false);

    document.addEventListener("mouseup", function(ev){
        mapComponent.onMouseReleased(ev);
        return true;
    }, false);

    document.addEventListener("contextmenu", function(ev){
        stopProp(ev);
        return false
    }, false);

    window.addEventListener("keydown", function(ev){mapComponent.onKeyPressed(ev); return true;}, false);
    window.addEventListener("resize", function(){mapComponent.glResize();}, false);

    addWheelListener(canvasContainer, function(ev){
        stopProp(ev);
        mapComponent.onWheel(ev);
        return false;
    });

    // ---------------------------------- Bootstrap ----------------------------------

    $(()=>{ // On document ready
        mapComponent.glInitialize($("#mapviewer-canvas-container")[0])
    })
})
