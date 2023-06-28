import { cookieValue } from "/mapcomponent/utils.js";
import { platform} from "./platform.js";
import { MapComponent } from "./mapcomponent/mapcomponent.js";
import libErdblickCore from "./libs/core/erdblick-core.js";
import { MapViewerBatch } from "./mapcomponent/batch.js";
import { sharedBufferFromUrl } from "./mapcomponent/buffer.js";

// --------------------------- Initialize Map Component --------------------------

console.log("Loading core library ...")

libErdblickCore().then(coreLib =>
{
    console.log("  ...done.")

    let mapComponent = new MapComponent(platform, coreLib);
    let glbConverter = new coreLib.FeatureLayerRenderer();
    let testDataProvider = new coreLib.TestDataProvider();

    const styleUrl = "styles/demo-style.yaml";
    const infoUrl = "maps/island1/info.json";
    const tileUrl = "maps/island1/island1.bin";

    let style = null;
    sharedBufferFromUrl(coreLib, styleUrl, styleYamlBuffer => {
        style = new coreLib.FeatureLayerStyle(styleYamlBuffer);
        console.log("Loaded style.")
    });

    let stream = null;
    sharedBufferFromUrl(coreLib, infoUrl, infoBuffer => {
        stream = new coreLib.TileLayerParser(infoBuffer);
        mapComponent.renderingController.cameraController.moveToCoords(11.126489719579604, 47.99422683197585);
        mapComponent.renderingController.cameraController.setCameraOrientation(1.0746333541984274, -1.5179395047543438);
        mapComponent.renderingController.cameraController.setCameraAltitude(0.8930176014438322);
        stream.onTileParsed(tile => {
            new MapViewerBatch("test", coreLib, glbConverter, style, tile, (batch)=>{
                mapComponent.model.dispatchEvent({
                    type: mapComponent.model.BATCH_ADDED,
                    batch: batch
                })
            }, ()=>{})
        });
        console.log("Loaded data source info.")
    });

    window.loadTestTile = () => {
        sharedBufferFromUrl(coreLib, tileUrl, tileBuffer => {
            stream.parse(tileBuffer);
        });
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
