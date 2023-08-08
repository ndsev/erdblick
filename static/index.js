import { MapViewerView } from "./mapcomponent/view.js";
import { MapViewerModel } from "./mapcomponent/model.js";
import libErdblickCore from "./libs/core/erdblick-core.js";

// --------------------------- Initialize Map Componesnt --------------------------
console.log("Loading core library ...")

libErdblickCore().then(coreLib =>
{
    console.log("  ...done.")

    let mapModel = new MapViewerModel(coreLib);
    let mapView = new MapViewerView(mapModel, 'cesiumContainer');

    window.loadAllTiles = () => {
        $("#log").empty()
        mapModel.runUpdate();
    }

    window.reloadStyle = () => {
        mapModel.reloadStyle();
    }

    window.zoomToBatch = (batchId) => {
        mapView.viewer.zoomTo(mapModel.registeredBatches.get(batchId).tileSet);
    }
})
