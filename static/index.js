import { cookieValue } from "/mapcomponent/utils.js";
import { platform} from "./platform.js";
import { MapComponent } from "./mapcomponent/mapcomponent.js";
import libErdblickCore from "./libs/core/erdblick-core.js";
import { MapViewerBatch } from "./mapcomponent/batch.js";
import { Fetch } from "./mapcomponent/fetch.js";

// --------------------------- Initialize Map Component --------------------------

console.log("Loading core library ...")

libErdblickCore().then(coreLib =>
{
    console.log("  ...done.")

    let mapComponent = new MapComponent(platform, coreLib);
    let glbConverter = new coreLib.FeatureLayerRenderer();

    const styleUrl = "/styles/demo-style.yaml";
    const infoUrl = "/sources";
    const tileUrl = "/tiles";

    // ------- Fetch style --------
    let style = null;
    new Fetch(coreLib, styleUrl).withWasmCallback(styleYamlBuffer => {
        style = new coreLib.FeatureLayerStyle(styleYamlBuffer);
        console.log("Loaded style.")
    }).go();

    // -------- Fetch info --------
    let stream = null;
    let info = null;
    new Fetch(coreLib, infoUrl)
        .withWasmCallback((infoBuffer, response) => {
            stream = new coreLib.TileLayerParser(infoBuffer);
            stream.onTileParsed(tile => {
                new MapViewerBatch("test", coreLib, glbConverter, style, tile, (batch)=>{
                    mapComponent.model.dispatchEvent({
                        type: mapComponent.model.BATCH_ADDED,
                        batch: batch
                    })
                }, ()=>{})
            });
            console.log("Loaded data source info.")
        })
        .withJsonCallback(result => {info = result;})
        .go();

    // --- Fetch tiles on-demand ---
    window.loadTestTile = () =>
    {
        mapComponent.renderingController.cameraController.moveToCoords(11.126489719579604, 47.99422683197585);
        mapComponent.renderingController.cameraController.setCameraOrientation(1.0746333541984274, -1.5179395047543438);
        mapComponent.renderingController.cameraController.setCameraAltitude(0.8930176014438322);

        let requests = []
        for (let dataSource of info) {
            for (let [layerName, layer] of Object.entries(dataSource.layers)) {
                requests.push({
                    mapId: dataSource.mapId,
                    layerId: layerName,
                    tileIds: layer.coverage
                })
            }
        }
        console.log(requests);

        new Fetch(coreLib, tileUrl)
            .withChunkProcessing()
            .withMethod("POST")
            .withBody({requests: requests})
            .withWasmCallback(tileBuffer => {
                stream.parse(tileBuffer);
            })
            .go();
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
