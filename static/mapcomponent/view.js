import {MapViewerModel} from "./model.js";

export class MapViewerView
{
    /**
     * Construct a Cesium View with a Model.
     * @param {MapViewerModel} model
     * @param containerDomElementId Div which hosts the Cesium view.
     */
    constructor(model, containerDomElementId)
    {
        // The base64 encoding of a 1x1 black PNG
        let blackPixelBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

        this.viewer = new Cesium.Viewer(containerDomElementId,
            {
                // Create a SingleTileImageryProvider that uses the black pixel
                imageryProvider: new Cesium.SingleTileImageryProvider({
                    url: blackPixelBase64,
                    rectangle: Cesium.Rectangle.MAX_VALUE
                }),
                baseLayerPicker: false,
                animation: false,
                geocoder: false,
                homeButton: false,
                sceneModePicker: false,
                selectionIndicator: false,
                timeline: false,
                navigationHelpButton: false,
                navigationInstructionsInitiallyVisible: false
            }
        );

        let openStreetMap = new Cesium.UrlTemplateImageryProvider({
            url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            maximumLevel: 19,
        });
        let openStreetMapLayer = this.viewer.imageryLayers.addImageryProvider(openStreetMap);
        openStreetMapLayer.alpha = 0.5;

        model.batchAddedTopic.subscribe(batch => {
            this.viewer.scene.primitives.add(batch.tileSet);
            this.viewer.zoomTo(this.viewer.scene.primitives.get(this.viewer.scene.primitives.length - 1));
        })

        model.batchRemovedTopic.subscribe(batch => {
            this.viewer.scene.primitives.remove(batch.tileSet);
        })
    }
}
