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
        let blackPixelBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';

        this.viewer = new Cesium.Viewer(containerDomElementId,
            {
                // Create a SingleTileImageryProvider that uses the black pixel
                imageryProvider: new Cesium.SingleTileImageryProvider({
                    url: blackPixelBase64,
                    rectangle: Cesium.Rectangle.MAX_VALUE,
                    tileWidth: 1,
                    tileHeight: 1
                }),
                baseLayerPicker: false,
                animation: false,
                geocoder: false,
                homeButton: false,
                sceneModePicker: false,
                selectionIndicator: false,
                timeline: false,
                navigationHelpButton: false,
                navigationInstructionsInitiallyVisible: false,
                requestRenderMode: true,
                maximumRenderTimeChange: Infinity,
                infoBox: false
            }
        );

        // let openStreetMap = new Cesium.UrlTemplateImageryProvider({
        //     url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        //     maximumLevel: 19,
        // });
        // let openStreetMapLayer = this.viewer.imageryLayers.addImageryProvider(openStreetMap);
        // openStreetMapLayer.alpha = 0.5;

        this.pickedFeature = null;
        this.hoveredFeature = null;
        this.mouseHandler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);

        /// Holds the currently selected feature
        this.selectionTopic = new rxjs.BehaviorSubject(null); // {Feature}

        // Add a handler for selection
        this.mouseHandler.setInputAction(movement => {
            // If there was a previously picked feature, reset its color
            if (this.pickedFeature) {
                this.pickedFeature.color = Cesium.Color.WHITE; // Assuming the original color is WHITE. Adjust as necessary.
            }

            let feature = this.viewer.scene.pick(movement.position);

            if (feature instanceof Cesium.Cesium3DTileFeature) {
                feature.color = Cesium.Color.YELLOW;
                this.pickedFeature = feature; // Store the picked feature
                this.hoveredFeature = null;
                this.selectionTopic.next(this.resolveFeature(feature.tileset, feature.featureId))
            }
            else
                this.selectionTopic.next(null);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Add a handler for hover (i.e., MOUSE_MOVE) functionality
        this.mouseHandler.setInputAction(movement => {
            // If there was a previously hovered feature, reset its color
            if (this.hoveredFeature) {
                this.hoveredFeature.color = Cesium.Color.WHITE; // Assuming the original color is WHITE. Adjust as necessary.
            }

            let feature = this.viewer.scene.pick(movement.endPosition); // Notice that for MOUSE_MOVE, it's endPosition

            if (feature instanceof Cesium.Cesium3DTileFeature) {
                if (feature !== this.pickedFeature) {
                    feature.color = Cesium.Color.GREEN;
                    this.hoveredFeature = feature; // Store the hovered feature
                }
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        this.batchForTileSet = new Map();

        model.batchAddedTopic.subscribe(batch => {
            this.viewer.scene.primitives.add(batch.tileSet);
            this.batchForTileSet.set(batch.tileSet, batch);
        })

        model.batchRemovedTopic.subscribe(batch => {
            this.viewer.scene.primitives.remove(batch.tileSet);
            this.batchForTileSet.delete(batch.tileSet);
        })
    }

    resolveFeature(tileSet, index) {
        let batch = this.batchForTileSet.get(tileSet);
        if (!batch) {
            console.error("Failed find batch for tileSet!");
            return null;
        }
        return batch.tileFeatureLayer.at(index);
    }
}
