
export class CesiumViewer  {
    constructor() {
        // The base64 encoding of a 1x1 black PNG
        let blackPixelBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

        this.viewer = new Cesium.Viewer('cesiumContainer',
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

        //cViewer.creditContainer.innerHTML = "";

        let openStreetMap = new Cesium.UrlTemplateImageryProvider({
            url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            maximumLevel: 19,
        });
        let openStreetMapLayer = this.viewer.imageryLayers.addImageryProvider(openStreetMap);
        openStreetMapLayer.alpha = 0.5;
    }

};