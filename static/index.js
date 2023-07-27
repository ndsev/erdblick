import { MapComponent } from "./mapcomponent/mapcomponent.js";
// TODO: Reactivate when erdblick-core is available again
//import libErdblickCore from "./libs/core/erdblick-core.js";

// --------------------------- Initialize Map Component --------------------------
console.log("Loading core library ...")


// Replace `your_access_token` with your Cesium ion access token.
// See https://cesium.com/learn/cesiumjs-learn/cesiumjs-quickstart/ for
// reading about the token creation process. If you don't provide it,
// you will still see the GeoJSON data, but there won't be any ortho imagery.
// HINT: This is only needed if you want to access data from Cesium.ion
//       The demo will still work even if this token is not present
//Cesium.Ion.defaultAccessToken = '';
let coreLib = null;
let mapComponent = new MapComponent(coreLib);

window.loadAllTiles = () => {
    $("#log").empty()
    mapComponent.model.runUpdate();
}

// window.reloadStyle = () => { mapComponent.model.reloadStyle(); }

// window.zoomToBatch = (batchId) => {
//     let center = mapComponent.model.registeredBatches.get(batchId).tileFeatureLayer.center();
//     mapComponent.moveToPosition(center.x, center.y, center.z);
// }

/* TODO: Migrate all the logic above into the callback
         as soon as erdblick wasm works again
libErdblickCore().then(coreLib =>
{
    console.log("  ...done.")


})
*/