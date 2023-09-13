import { ErdblickView } from "./erdblick/view.js";
import { ErdblickModel } from "./erdblick/model.js";
import libErdblickCore from "./libs/core/erdblick-core.js";

// --------------------------- Initialize Map Componesnt --------------------------
console.log("Loading core library ...")

libErdblickCore().then(coreLib =>
{
    console.log("  ...done.")

    let mapModel = new ErdblickModel(coreLib);
    let mapView = new ErdblickView(mapModel, 'mapViewContainer');

    window.reloadStyle = () => {
        mapModel.reloadStyle();
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

    mapModel.mapInfoTopic.subscribe(mapInfo => {
        let mapSettingsBox = $("#maps");
        mapSettingsBox.empty()
        for (let [mapName, map] of Object.entries(mapInfo)) {
            for (let [layerName, layer] of Object.entries(map.layers)) {
                let mapsEntry = $(`<div><span>${mapName} / ${layerName}</span>&nbsp;<button>Focus</button></div>`);
                $(mapsEntry.find("button")).on("click", _=>{
                    // Grab first tile id from coverage and zoom to it.
                    // TODO: Zoom to extent of map instead.
                    if (layer.coverage[0] !== undefined)
                        mapModel.zoomToWgs84PositionTopic.next(coreLib.getTilePosition(BigInt(layer.coverage[0])));
                })
                mapSettingsBox.append(mapsEntry)
            }
        }
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
