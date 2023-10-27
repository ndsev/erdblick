"use strict";

import {ErdblickModel} from "./model.js";
import {FeatureWrapper} from "./features.js";
import {TileVisualization} from "./visualization.js"

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
            if (feature && feature.id !== undefined && this.tileVisForPrimitive.has(feature.primitive))
                this.setPickedCesiumFeature(feature);
            else
                this.setPickedCesiumFeature(null);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Add a handler for hover (i.e., MOUSE_MOVE) functionality.
        this.mouseHandler.setInputAction(movement => {
            let feature = this.viewer.scene.pick(movement.endPosition); // Notice that for MOUSE_MOVE, it's endPosition
            if (feature && feature.id !== undefined && this.tileVisForPrimitive.has(feature.primitive))
                this.setHoveredCesiumFeature(feature);
            else
                this.setHoveredCesiumFeature(null);
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        // Add a handler for camera movement.
        this.viewer.camera.percentageChanged = 0.1;
        this.viewer.camera.changed.addEventListener(() => {
            this.updateViewport();
        });

        this.tileVisForPrimitive = new Map();

        model.tileVisualizationTopic.subscribe(tileVis => {
            tileVis.render(this.viewer);
            tileVis.forEachPrimitive(primitive => {
                this.tileVisForPrimitive.set(primitive, tileVis);
            })
            this.viewer.scene.requestRender();
        });

        model.tileVisualizationDestructionTopic.subscribe(tileVis => {
            if (this.pickedFeature && this.tileVisForPrimitive.get(this.pickedFeature.primitive) === tileVis) {
                this.setPickedCesiumFeature(null);
            }
            if (this.hoveredFeature && this.tileVisForPrimitive.get(this.hoveredFeature.primitive) === tileVis) {
                this.setHoveredCesiumFeature(null);
            }
            tileVis.forEachPrimitive(primitive => {
                this.tileVisForPrimitive.delete(primitive);
            })
            tileVis.destroy(this.viewer);
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
        let tileVis = this.tileVisForPrimitive.get(primitive);
        if (!tileVis) {
            console.error("Failed find tileLayer for primitive!");
            return null;
        }
        return new FeatureWrapper(index, tileVis.tile);
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
    }
}
