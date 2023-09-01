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

    window.reloadStyle = () => {
        mapModel.reloadStyle();
    }

    window.zoomToBatch = (batchId) => {
        mapView.viewer.zoomTo(mapModel.registeredBatches.get(batchId).tileSet);
    }

    mapView.selectionTopic.subscribe(selectedFeatureWrapper => {
        if (!selectedFeatureWrapper) {
            $("#selectionPanel").hide()
            return
        }

        selectedFeatureWrapper.peek(feature => {
            $("#selectedFeatureGeoJson").text(feature.geojson())
            $("#selectedFeatureId").text(feature.id())
            $("#selectionPanel").show()
        })
    })
})

$(document).ready(function() {
    // Toggle the expanded/collapsed state of the panels when clicked
    $(".panel").click(function() {
        $(this).toggleClass("expanded");
        if ($(this).hasClass("expanded")) {
            $(this).find("pre").slideDown();
        } else {
            $(this).find("pre").slideUp();
        }
    });
});
