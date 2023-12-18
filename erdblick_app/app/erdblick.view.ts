"use strict";

import {ErdblickModel} from "./erdblick.model";
import {FeatureWrapper} from "./features.component";
import {TileVisualization} from "./visualization.component"
import {BehaviorSubject} from "rxjs"
import {
    Viewer,
    UrlTemplateImageryProvider,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    Color,
    ColorGeometryInstanceAttribute,
    Math,
    Cartesian2,
    Cartesian3,
    Cartographic,
    defined
} from "cesium";

export class ErdblickView {
    viewer: Viewer;
    private model: ErdblickModel;
    private pickedFeature: any = null;
    private pickedFeatureOrigColor: Color | null = null;
    private hoveredFeature: any = null;
    private hoveredFeatureOrigColor: Color | null = null;
    private mouseHandler: ScreenSpaceEventHandler;
    selectionTopic: BehaviorSubject<FeatureWrapper | null>;
    private tileVisForPrimitive: Map<any, TileVisualization>;

    /**
     * Construct a Cesium View with a Model.
     * @param {ErdblickModel} model
     * @param containerDomElementId Div which hosts the Cesium view.
     */
    constructor(model: ErdblickModel, containerDomElementId: string) {
        this.model = model;
        this.viewer = new Viewer(containerDomElementId,
            {
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

        let openStreetMap = new UrlTemplateImageryProvider({
            url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            maximumLevel: 19,
        });
        let openStreetMapLayer = this.viewer.imageryLayers.addImageryProvider(openStreetMap);
        openStreetMapLayer.alpha = 0.3;

        this.mouseHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);

        // Holds the currently selected feature.
        this.selectionTopic = new BehaviorSubject<FeatureWrapper | null>(null); // {FeatureWrapper}

        // Add a handler for selection.
        this.mouseHandler.setInputAction((movement: any) => {
            let feature = this.viewer.scene.pick(movement.position);
            if (this.isKnownCesiumFeature(feature)) {
                this.setPickedCesiumFeature(feature);
            } else {
                this.setPickedCesiumFeature(null);
            }
        }, ScreenSpaceEventType.LEFT_CLICK);

        // Add a handler for hover (i.e., MOUSE_MOVE) functionality.
        this.mouseHandler.setInputAction((movement: any) => {
            let feature = this.viewer.scene.pick(movement.endPosition); // Notice that for MOUSE_MOVE, it's endPosition
            if (this.isKnownCesiumFeature(feature)) {
                this.setHoveredCesiumFeature(feature);
            } else {
                this.setHoveredCesiumFeature(null);
            }
        }, ScreenSpaceEventType.MOUSE_MOVE);

        // Add a handler for camera movement.
        this.viewer.camera.percentageChanged = 0.1;
        this.viewer.camera.changed.addEventListener(() => {
            this.updateViewport();
        });

        this.tileVisForPrimitive = new Map();

        model.tileVisualizationTopic.subscribe((tileVis: TileVisualization) => {
            tileVis.render(this.viewer);
            tileVis.forEachPrimitive((primitive: any) => {
                this.tileVisForPrimitive.set(primitive, tileVis);
            })
            this.viewer.scene.requestRender();
        });

        model.tileVisualizationDestructionTopic.subscribe((tileVis: TileVisualization) => {
            if (this.pickedFeature && this.tileVisForPrimitive.get(this.pickedFeature.primitive) === tileVis) {
                this.setPickedCesiumFeature(null);
            }
            if (this.hoveredFeature && this.tileVisForPrimitive.get(this.hoveredFeature.primitive) === tileVis) {
                this.setHoveredCesiumFeature(null);
            }
            tileVis.forEachPrimitive((primitive: any) => {
                this.tileVisForPrimitive.delete(primitive);
            })
            tileVis.destroy(this.viewer);
            this.viewer.scene.requestRender();
        });

        model.zoomToWgs84PositionTopic.subscribe((pos: Cartesian2) => {
            this.viewer.camera.setView({
                destination: Cartesian3.fromDegrees(pos.x, pos.y, 15000), // Converts lon/lat to Cartesian3.
                orientation: {
                    heading: Math.toRadians(0), // East, in radians.
                    pitch: Math.toRadians(-90), // Directly looking down.
                    roll: 0 // No rotation
                }
            });
        });

        this.viewer.scene.globe.baseColor = new Color(0.1, 0.1, 0.1, 1);
    }

    /**
     * Check if two cesium features are equal. A cesium feature is a
     * combination of a feature id and a primitive which contains it.
     */
    private cesiumFeaturesAreEqual(f1: any, f2: any) {
        return (!f1 && !f2) || (f1 && f2 && f1.id === f2.id && f1.primitive === f1.primitive);
    }

    /** Check if the given feature is known and can be selected. */
    isKnownCesiumFeature(f) {
        return f && f.id !== undefined && f.primitive !== undefined && (
            this.tileVisForPrimitive.has(f.primitive) ||
            this.tileVisForPrimitive.has(f.primitive._pointPrimitiveCollection))
    }

    /**
     * Set or re-set the hovered feature.
     */
    private setHoveredCesiumFeature(feature: any) {
        if (this.cesiumFeaturesAreEqual(feature, this.hoveredFeature))
            return;
        // Restore the previously hovered feature to its original color.
        if (this.hoveredFeature)
            if (this.hoveredFeatureOrigColor) {
                this.setFeatureColor(this.hoveredFeature, this.hoveredFeatureOrigColor);
            }
        this.hoveredFeature = null;
        if (feature && !this.cesiumFeaturesAreEqual(feature, this.pickedFeature)) {
            // Highlight the new hovered feature and remember its original color.
            this.hoveredFeatureOrigColor = this.getFeatureColor(feature);
            this.setFeatureColor(feature, Color.YELLOW);
            this.hoveredFeature = feature;
        }
    }

    /**
     * Set or re-set the picked feature.
     */
    private setPickedCesiumFeature(feature: any) {
        if (this.cesiumFeaturesAreEqual(feature, this.pickedFeature))
            return;
        // Restore the previously picked feature to its original color.
        if (this.pickedFeature)
            if (this.pickedFeatureOrigColor) {
                this.setFeatureColor(this.pickedFeature, this.pickedFeatureOrigColor);
            }
        this.pickedFeature = null;
        if (feature) {
            // Highlight the new picked feature and remember its original color.
            // Make sure that if the hovered feature is picked, we don't
            // remember the hover color as the original color.
            if (this.cesiumFeaturesAreEqual(feature, this.hoveredFeature)) {
                this.setHoveredCesiumFeature(null);
            }
            this.pickedFeatureOrigColor = this.getFeatureColor(feature);
            this.setFeatureColor(feature, Color.YELLOW);
            this.pickedFeature = feature;
            this.selectionTopic.next(this.resolveFeature(feature.primitive, feature.id));
        } else {
            this.selectionTopic.next(null);
        }
    }

    /** Set the color of a cesium feature through its associated primitive. */
    setFeatureColor(feature, color) {
        if (feature.primitive.color !== undefined) {
            // Special treatment for point primitives.
            feature.primitive.color = color;
            this.viewer.scene.requestRender();
            return;
        }
        if (feature.primitive.isDestroyed())
            return;
        const attributes = feature.primitive.getGeometryInstanceAttributes(feature.id);
        attributes.color = ColorGeometryInstanceAttribute.toValue(color);
        this.viewer.scene.requestRender();
    }

    /** Read the color of a cesium feature through its associated primitive. */
    getFeatureColor(feature) {
        if (feature.primitive.color !== undefined) {
            // Special treatment for point primitives.
            return feature.primitive.color.clone();
        }
        if (feature.primitive.isDestroyed()) {
            return null;
        }
        const attributes = feature.primitive.getGeometryInstanceAttributes(feature.id);
        return Color.fromBytes(...attributes.color);
    }

    /** Get a mapget feature from a cesium feature. */
    private resolveFeature(primitive: any, index: number) {
        let tileVis = this.tileVisForPrimitive.get(primitive);
        if (!tileVis) {
            tileVis = this.tileVisForPrimitive.get(primitive._pointPrimitiveCollection);
            if (!tileVis) {
                console.error("Failed find tileLayer for primitive!");
                return null;
            }
        }
        return new FeatureWrapper(index, tileVis.tile);
    }

    /**
     * Update the visible viewport, and communicate it to the model.
     */
    private updateViewport() {
        let canvas = this.viewer.scene.canvas;
        let center = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
        let centerCartesian = this.viewer.camera.pickEllipsoid(center);
        let centerLon, centerLat;

        if (defined(centerCartesian)) {
            let centerCartographic = Cartographic.fromCartesian(centerCartesian);
            centerLon = Math.toDegrees(centerCartographic.longitude);
            centerLat = Math.toDegrees(centerCartographic.latitude);
        } else {
            let cameraCartographic = Cartographic.fromCartesian(this.viewer.camera.positionWC);
            centerLon = Math.toDegrees(cameraCartographic.longitude);
            centerLat = Math.toDegrees(cameraCartographic.latitude);
        }

        let rectangle = this.viewer.camera.computeViewRectangle();
        if (!rectangle) {
            // This might happen when looking into space.
            return;
        }

        let west = Math.toDegrees(rectangle.west);
        let south = Math.toDegrees(rectangle.south);
        let east = Math.toDegrees(rectangle.east);
        let north = Math.toDegrees(rectangle.north);
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
            width: sizeLon + expandLon * 2,
            height: sizeLat + expandLat * 2,
            camPosLon: centerLon,
            camPosLat: centerLat,
            orientation: -this.viewer.camera.heading + Math.PI * .5,
        });
    }
}
