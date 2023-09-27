"use strict";

import {ErdblickModel} from "./model.js";
import {FeatureWrapper} from "./features.js";

export class ErdblickView
{
    /**
     * Construct a Cesium View with a Model.
     * @param {ErdblickModel} model
     * @param containerDomElementId Div which hosts the Cesium view.
     */
    constructor(model, containerDomElementId)
    {
        this.model = model;
        this.viewer = new Cesium.Viewer(containerDomElementId,
            {
                imageryProvider: false,
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

        let openStreetMap = new Cesium.UrlTemplateImageryProvider({
            url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            maximumLevel: 19,
        });
        let openStreetMapLayer = this.viewer.imageryLayers.addImageryProvider(openStreetMap);
        openStreetMapLayer.alpha = 0.3;

        this.pickedFeature = null;
        this.hoveredFeature = null;
        this.mouseHandler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);

        // Holds the currently selected feature.
        this.selectionTopic = new rxjs.BehaviorSubject(null); // {FeatureWrapper}

        // Add a handler for selection.
        this.mouseHandler.setInputAction(movement => {
            // If there was a previously picked feature, reset its color.
            if (this.pickedFeature) {
                this.pickedFeature.color = Cesium.Color.WHITE; // Assuming the original color is WHITE. Adjust as necessary.
            }

            let feature = this.viewer.scene.pick(movement.position);

            if (feature instanceof Cesium.Cesium3DTileFeature) {
                feature.color = Cesium.Color.YELLOW;
                this.pickedFeature = feature; // Store the picked feature.
                this.hoveredFeature = null;
                this.selectionTopic.next(this.resolveFeature(feature.tileset, feature.featureId))
            }
            else
                this.selectionTopic.next(null);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Add a handler for hover (i.e., MOUSE_MOVE) functionality.
        this.mouseHandler.setInputAction(movement => {
            // If there was a previously hovered feature, reset its color.
            if (this.hoveredFeature) {
                this.hoveredFeature.color = Cesium.Color.WHITE; // Assuming the original color is WHITE. Adjust as necessary.
            }

            let feature = this.viewer.scene.pick(movement.endPosition); // Notice that for MOUSE_MOVE, it's endPosition

            if (feature instanceof Cesium.Cesium3DTileFeature) {
                if (feature !== this.pickedFeature) {
                    feature.color = Cesium.Color.GREEN;
                    this.hoveredFeature = feature; // Store the hovered feature.
                }
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        // Add a handler for camera movement.
        this.viewer.camera.percentageChanged = 0.1;
        this.viewer.camera.changed.addEventListener(() => {
            this.updateViewport();
        });

        this.tileLayerForTileSet = new Map();

        model.tileLayerAddedTopic.subscribe(tileLayer => {
            this.viewer.scene.primitives.add(tileLayer.tileSet);
            this.tileLayerForTileSet.set(tileLayer.tileSet, tileLayer);
        })

        model.tileLayerRemovedTopic.subscribe(tileLayer => {
            if (this.pickedFeature && this.pickedFeature.tileset === tileLayer.tileSet) {
                this.pickedFeature = null;
                this.selectionTopic.next(null);
            }
            if (this.hoveredFeature && this.hoveredFeature.tileset === tileLayer.tileSet) {
                this.hoveredFeature = null;
            }
            this.viewer.scene.primitives.remove(tileLayer.tileSet);
            this.tileLayerForTileSet.delete(tileLayer.tileSet);
        })

        model.zoomToWgs84PositionTopic.subscribe(pos => {
            this.viewer.camera.setView({
                destination: Cesium.Cartesian3.fromDegrees(pos.x, pos.y, 15000), // Converts lon/lat to Cartesian3.
                orientation: {
                    heading: Cesium.Math.toRadians(0), // East, in radians.
                    pitch: Cesium.Math.toRadians(-90), // Directly looking down.
                    roll: 0 // No rotation
                }
            });
        });

        let polylines = new Cesium.PolylineCollection();

        // Line over the equator divided into four 90-degree segments.
        this.viewer.entities.add({
            name: 'Equator',
            polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray([
                    -180, 0,   // Start
                    -90, 0,    // 1st quarter
                    0, 0,      // Halfway
                    90, 0,     // 3rd quarter
                    180, 0     // End
                ]),
                width: 2,
                material: Cesium.Color.RED.withAlpha(0.5)
            }
        });

        // Line over the antimeridian.
        this.viewer.entities.add({
            name: 'Antimeridian',
            polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray([
                    -180, -80,
                    -180, 80
                ]),
                width: 2,
                material: Cesium.Color.BLUE.withAlpha(0.5)
            }
        });

        this.viewer.scene.primitives.add(polylines);
        this.viewer.scene.globe.baseColor = new Cesium.Color(0.1, 0.1, 0.1, 1);
    }

    resolveFeature(tileSet, index) {
        let tileLayer = this.tileLayerForTileSet.get(tileSet);
        if (!tileLayer) {
            console.error("Failed find tileLayer for tileSet!");
            return null;
        }
        return new FeatureWrapper(index, tileLayer);
    }

    updateViewport() {
        let canvas = this.viewer.scene.canvas;
        let center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
        let centerCartesian = this.viewer.camera.pickEllipsoid(center);
        let centerLon, centerLat;

        if (Cesium.defined(centerCartesian)) {
            let centerCartographic = Cesium.Cartographic.fromCartesian(centerCartesian);
            centerLon = Cesium.Math.toDegrees(centerCartographic.longitude);
            centerLat = Cesium.Math.toDegrees(centerCartographic.latitude);
        } else {
            let cameraCartographic = Cesium.Cartographic.fromCartesian(this.viewer.camera.positionWC);
            centerLon = Cesium.Math.toDegrees(cameraCartographic.longitude);
            centerLat = Cesium.Math.toDegrees(cameraCartographic.latitude);
        }

        let rectangle = this.viewer.camera.computeViewRectangle();

        let west = Cesium.Math.toDegrees(rectangle.west);
        let south = Cesium.Math.toDegrees(rectangle.south);
        let east = Cesium.Math.toDegrees(rectangle.east);
        let north = Cesium.Math.toDegrees(rectangle.north);
        let sizeLon = east - west;
        let sizeLat = north - south;

        // Handle the antimeridian.
        // TODO: Must also handle north pole.
        if (west > -180 && sizeLon > 180.) {
            sizeLon = 360. - sizeLon;
        }

        // Grow the viewport rectangle by 25%
        let expandLon = sizeLon * 0.25;
        let expandLat = sizeLat * 0.25;
        this.model.setViewport({
            south: south - expandLat,
            west: west - expandLat,
            width: sizeLon + expandLon*2,
            height: sizeLat + expandLat*2,
            camPosLon: centerLon,
            camPosLat: centerLat,
            orientation: this.viewer.camera.heading,
        });
        this.visualizeTileIds();
    }

    visualizeTileIds() {
        // Remove previous points.
        if (this.points) {
            for (let i = 0; i < this.points.length; i++) {
                this.viewer.entities.remove(this.points[i]);
            }
        }

        // Get the tile IDs for the current viewport.
        let tileIds = this.model.currentVisibleTileIds;

        // Calculate total number of tile IDs.
        let totalTileIds = tileIds.size;

        // Initialize points array.
        this.points = [];

        // Counter for iteration over Set.
        let i = 0;

        // Iterate through each tile ID using Set's forEach method.
        tileIds.forEach(tileId => {
            // Get WGS84 coordinates for the tile ID
            let position = this.model.coreLib.getTilePosition(tileId);

            // Calculate the color based on the position in the list.
            let colorValue = i / totalTileIds;
            let color = Cesium.Color.fromHsl(0.6 - colorValue * 0.5, 1.0, 0.5);

            // Create a point and add it to the Cesium scene.
            let point = this.viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(position.x, position.y),
                point: {
                    pixelSize: 5,
                    color: color
                }
            });

            // Add the point to the points array.
            this.points.push(point);

            // Increment counter.
            i++;
        });
    }
}
