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
        this.pickedFeatureOrigColor = null;
        this.hoveredFeature = null;
        this.hoveredFeatureOrigColor = null;
        this.mouseHandler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);

        // Holds the currently selected feature.
        this.selectionTopic = new rxjs.BehaviorSubject(null); // {FeatureWrapper}

        // Add a handler for selection.
        this.mouseHandler.setInputAction(movement => {
            let feature = this.viewer.scene.pick(movement.position);
            if (feature && feature.id && this.tileLayerForPrimitive.has(feature.primitive))
                this.setPickedCesiumFeature(feature);
            else
                this.setPickedCesiumFeature(null);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Add a handler for hover (i.e., MOUSE_MOVE) functionality.
        this.mouseHandler.setInputAction(movement => {
            let feature = this.viewer.scene.pick(movement.endPosition); // Notice that for MOUSE_MOVE, it's endPosition
            if (feature && feature.id && this.tileLayerForPrimitive.has(feature.primitive))
                this.setHoveredCesiumFeature(feature);
            else
                this.setHoveredCesiumFeature(null);
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        // Add a handler for camera movement.
        this.viewer.camera.percentageChanged = 0.1;
        this.viewer.camera.changed.addEventListener(() => {
            this.updateViewport();
        });

        this.tileLayerForPrimitive = new Map();

        model.tileLayerAddedTopic.subscribe(tileLayer => {
            this.viewer.scene.primitives.add(tileLayer.primitiveCollection);
            for (let i = 0; i < tileLayer.primitiveCollection.length; ++i)
                this.tileLayerForPrimitive.set(tileLayer.primitiveCollection.get(i), tileLayer);
            this.viewer.scene.requestRender();
        });

        model.tileLayerRemovedTopic.subscribe(tileLayer => {
            if (!tileLayer.primitiveCollection)
                return;
            if (this.pickedFeature && this.pickedFeature.primitive === tileLayer.primitiveCollection) {
                this.setPickedCesiumFeature(null);
            }
            if (this.hoveredFeature && this.hoveredFeature.primitive === tileLayer.primitiveCollection) {
                this.setHoveredCesiumFeature(null);
            }
            this.viewer.scene.primitives.remove(tileLayer.primitiveCollection);
            for (let i = 0; i < tileLayer.primitiveCollection.length; ++i)
                this.tileLayerForPrimitive.delete(tileLayer.primitiveCollection.get(i));
            this.viewer.scene.requestRender();
        });

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

        this.viewer.scene.globe.baseColor = new Cesium.Color(0.1, 0.1, 0.1, 1);
    }

    /**
     * Check if two cesium features are equal. A cesium feature is a
     * combination of a feature id and a primitive which contains it.
     */
    cesiumFeaturesAreEqual(f1, f2) {
        return (!f1 && !f2) || (f1 && f2 && f1.id === f2.id && f1.primitive === f1.primitive);
    }

    /**
     * Set or re-set the hovered feature.
     */
    setHoveredCesiumFeature(feature) {
        if (this.cesiumFeaturesAreEqual(feature, this.hoveredFeature))
            return;
        // Restore the previously hovered feature to its original color.
        if (this.hoveredFeature)
            this.setFeatureColor(this.hoveredFeature, this.hoveredFeatureOrigColor);
        this.hoveredFeature = null;
        if (feature && !this.cesiumFeaturesAreEqual(feature, this.pickedFeature)) {
            // Highlight the new hovered feature and remember its original color.
            this.hoveredFeatureOrigColor = this.getFeatureColor(feature);
            this.setFeatureColor(feature, Cesium.Color.YELLOW);
            this.hoveredFeature = feature;
        }
    }

    /**
     * Set or re-set the picked feature.
     */
    setPickedCesiumFeature(feature) {
        if (this.cesiumFeaturesAreEqual(feature, this.pickedFeature))
            return;
        // Restore the previously picked feature to its original color.
        if (this.pickedFeature)
            this.setFeatureColor(this.pickedFeature, this.pickedFeatureOrigColor);
        this.pickedFeature = null;
        if (feature) {
            // Highlight the new picked feature and remember its original color.
            // Make sure that the if the hovered feature is picked, we don't
            // remember the hover color as the original color.
            if (this.cesiumFeaturesAreEqual(feature, this.hoveredFeature)) {
                this.setHoveredCesiumFeature(null);
            }
            this.pickedFeatureOrigColor = this.getFeatureColor(feature);
            this.setFeatureColor(feature, Cesium.Color.YELLOW);
            this.pickedFeature = feature;
            this.selectionTopic.next(this.resolveFeature(feature.primitive, feature.id));
        }
        else {
            this.selectionTopic.next(null);
        }
    }

    /** Set the color of a cesium feature through its associated primitive. */
    setFeatureColor(feature, color) {
        if (feature.primitive.isDestroyed())
            return;
        const attributes = feature.primitive.getGeometryInstanceAttributes(feature.id);
        attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(color);
        this.viewer.scene.requestRender();
    }

    /** Read the color of a cesium feature through its associated primitive. */
    getFeatureColor(feature) {
        if (feature.primitive.isDestroyed())
            return null;
        const attributes = feature.primitive.getGeometryInstanceAttributes(feature.id);
        return Cesium.Color.fromBytes(...attributes.color);
    }

    /** Get a mapget feature from a cesium feature. */
    resolveFeature(primitive, index) {
        let tileLayer = this.tileLayerForPrimitive.get(primitive);
        if (!tileLayer) {
            console.error("Failed find tileLayer for primitive!");
            return null;
        }
        return new FeatureWrapper(index, tileLayer);
    }

    /**
     * Update the visible viewport, and communicate it to the model.
     */
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
            west: west - expandLon,
            width: sizeLon + expandLon*2,
            height: sizeLat + expandLat*2,
            camPosLon: centerLon,
            camPosLat: centerLat,
            orientation: this.viewer.camera.heading,
        });
        this.visualizeTileIds();
    }

    /**
     * Show a grid of dots for each tile that is currently determined
     * as visible, according to the associated model.
     */
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
