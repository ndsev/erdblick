// Copyright (c) Navigation Data Standard e.V. - See "LICENSE" file.

import { cookieValue } from "/mapcomponent/utils.js";
import { platform} from "./platform.js";
import { MapComponent } from "./mapcomponent/mapcomponent.js";

// --------------------------- Initialize Map Component --------------------------

let mapComponent = new MapComponent(platform);

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
