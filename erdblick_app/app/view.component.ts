"use strict";

import {FeatureWrapper} from "./features.model";
import {TileVisualization} from "./visualization.model"
import {BehaviorSubject} from "rxjs"
import {
    Cartesian2,
    Cartesian3,
    Cartographic,
    Color,
    ColorGeometryInstanceAttribute,
    ImageryLayer,
    Math,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    UrlTemplateImageryProvider,
    Viewer
} from "./cesium";
import {ParametersService} from "./parameters.service";
import {AfterViewInit, Component} from "@angular/core";
import {MapService} from "./map.service";
import {Feature} from "../../build/libs/core/erdblick-core";
import {InspectionService} from "./inspection.service";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
import {StyleService} from "./style.service";

// Redeclare window with extended interface
declare let window: DebugWindow;

@Component({
    selector: 'erdblick-view',
    template: `
        <div id="mapViewContainer" class="mapviewer-renderlayer" style="z-index: 0"></div>
    `,
    styles: [`
        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `]
})
export class ErdblickViewComponent implements AfterViewInit {
    viewer!: Viewer;
    private pickedFeature: any = null;
    private pickedFeatureOrigColor: Color | null = null;
    private hoveredFeature: any = null;
    private hoveredFeatureOrigColor: Color | null = null;
    private mouseHandler: ScreenSpaceEventHandler | null = null;
    selectionTopic: BehaviorSubject<FeatureWrapper | null>;
    private tileVisForPrimitive: Map<any, TileVisualization>;
    private openStreetMapLayer: ImageryLayer | null = null;
    private selectionVisualizations: TileVisualization[]

    /**
     * Construct a Cesium View with a Model.
     * @param mapService The map model service providing access to data
     * @param styleService
     * @param inspectionService
     * @param parameterService The parameter service, used to update
     */
    constructor(public mapService: MapService,
                public styleService: StyleService,
                public inspectionService: InspectionService,
                public parameterService: ParametersService) {

        // Holds the currently selected feature.
        this.selectionTopic = new BehaviorSubject<FeatureWrapper | null>(null); // {FeatureWrapper}

        // Holds visualizations for the current selection for all present styles.
        this.selectionVisualizations = [];

        this.tileVisForPrimitive = new Map();

        this.mapService.tileVisualizationTopic.subscribe((tileVis: TileVisualization) => {
            tileVis.render(this.viewer).then(wasRendered => {
                if (wasRendered) {
                    tileVis.forEachPrimitive((primitive: any) => {
                        this.tileVisForPrimitive.set(primitive, tileVis);
                    })
                    this.viewer.scene.requestRender();
                }
            });
        });

        this.mapService.tileVisualizationDestructionTopic.subscribe((tileVis: TileVisualization) => {
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

        this.mapService.zoomToWgs84PositionTopic.subscribe((pos: Cartesian2) => {
            this.parameterService.cameraViewData.next({
                destination: Cartesian3.fromDegrees(pos.x, pos.y, 15000), // Converts lon/lat to Cartesian3.
                orientation: {
                    heading: Math.toRadians(0), // East, in radians.
                    pitch: Math.toRadians(-90), // Directly looking down.
                    roll: 0 // No rotation
                }
            });
        });

        this.selectionTopic.subscribe(selectedFeatureWrapper => {
            if (!selectedFeatureWrapper) {
                this.inspectionService.isInspectionPanelVisible = false;
                return;
            }

            selectedFeatureWrapper.peek((feature: Feature) => {
                this.inspectionService.selectedFeatureGeoJsonText = feature.geojson() as string;
                this.inspectionService.selectedFeatureIdText = feature.id() as string;
                this.inspectionService.isInspectionPanelVisible = true;
                this.inspectionService.loadFeatureData();
            })
        });
    }

    ngAfterViewInit() {
        this.viewer = new Viewer("mapViewContainer",
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
                infoBox: false,
                baseLayer: false
            }
        );

        this.openStreetMapLayer = this.viewer.imageryLayers.addImageryProvider(this.getOpenStreetMapLayerProvider());
        this.openStreetMapLayer.alpha = 0.3;

        this.mouseHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);

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
            const parameters = this.parameterService.parameters.getValue();
            if (parameters) {
                const currentPositionCartographic = Cartographic.fromCartesian(
                    Cartesian3.fromElements(
                        this.viewer.camera.position.x, this.viewer.camera.position.y, this.viewer.camera.position.z
                    )
                );
                parameters.lon = Math.toDegrees(currentPositionCartographic.longitude);
                parameters.lat = Math.toDegrees(currentPositionCartographic.latitude);
                parameters.alt = currentPositionCartographic.height;
                parameters.heading = this.viewer.camera.heading;
                parameters.pitch = this.viewer.camera.pitch;
                parameters.roll = this.viewer.camera.roll;
                this.parameterService.parameters.next(parameters);
            }
            this.updateViewport();
        });
        this.viewer.scene.globe.baseColor = new Color(0.1, 0.1, 0.1, 1);

        // Remove fullscreen button as unnecessary
        this.viewer.fullscreenButton.destroy();

        this.parameterService.cameraViewData.subscribe(cameraData => {
            if (cameraData) {
                this.viewer.camera.setView({
                    destination: cameraData.destination,
                    orientation: cameraData.orientation
                });
            }
        });

        this.parameterService.osmEnabled.subscribe(enabled => {
            this.updateOpenStreetMapLayer(enabled ? this.parameterService.osmOpacityValue.getValue() / 100: 0);
        });

        this.parameterService.osmOpacityValue.subscribe(value => {
            this.updateOpenStreetMapLayer(value / 100);
        });

        // Add debug API that can be easily called from browser's debug console
        window.ebDebug = new ErdblickDebugApi(this.mapService, this.parameterService, this);

        this.parameterService.viewportToBeUpdated.subscribe(toBeUpdated => {
            if (toBeUpdated) this.updateViewport();
        });
    }

    /**
     * Check if two cesium features are equal. A cesium feature is a
     * combination of a feature id and a primitive which contains it.
     */
    private cesiumFeaturesAreEqual(f1: any, f2: any) {
        return (!f1 && !f2) || (f1 && f2 && f1.id === f2.id && f1.primitive === f1.primitive);
    }

    /** Check if the given feature is known and can be selected. */
    isKnownCesiumFeature(f: any) {
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
        if (this.hoveredFeature && this.hoveredFeatureOrigColor) {
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
        if (this.pickedFeature && this.pickedFeatureOrigColor) {
            this.setFeatureColor(this.pickedFeature, this.pickedFeatureOrigColor);
        }
        this.pickedFeature = null;
        this.selectionVisualizations.forEach(visu => this.mapService.tileVisualizationDestructionTopic.next(visu));
        this.selectionVisualizations = [];

        // Get the actual mapget feature for the picked Cesium feature.
        let resolvedFeature = feature ? this.resolveFeature(feature.primitive, feature.id) : null;
        if (!resolvedFeature) {
            this.selectionTopic.next(null);
            return;
        }

        // Highlight the new picked feature and remember its original color.
        // Make sure that if the hovered feature is picked, we don't
        // remember the hover color as the original color.
        if (this.cesiumFeaturesAreEqual(feature, this.hoveredFeature)) {
            this.setHoveredCesiumFeature(null);
        }
        this.pickedFeatureOrigColor = this.getFeatureColor(feature);
        if (this.pickedFeatureOrigColor) {
            this.setFeatureColor(feature, Color.YELLOW);
            this.pickedFeature = feature;
            this.selectionTopic.next(resolvedFeature);
        }

        // Apply additional highlight styles.
        for (let [styleId, styleData] of this.styleService.allStyles()) {
            if (styleData.featureLayerStyle) {
                let visu = new TileVisualization(
                    resolvedFeature!.featureTile,
                    (tileKey: string)=>this.mapService.getFeatureTile(tileKey),
                    styleData.featureLayerStyle,
                    true,
                    feature.id);
                this.mapService.tileVisualizationTopic.next(visu);
                this.selectionVisualizations.push(visu);
            }
        }
    }

    /** Set the color of a cesium feature through its associated primitive. */
    private setFeatureColor(feature: any, color: Color) {
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
    private getFeatureColor(feature: any): Color | null {
        if (feature.primitive.color !== undefined) {
            // Special treatment for point primitives.
            return feature.primitive.color.clone();
        }
        if (feature.primitive.isDestroyed()) {
            return null;
        }
        const attributes = feature.primitive.getGeometryInstanceAttributes(feature.id);
        if (attributes.color === undefined) {
            return null;
        }
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
    updateViewport() {
        let canvas = this.viewer.scene.canvas;
        let center = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
        let centerCartesian = this.viewer.camera.pickEllipsoid(center);
        let centerLon, centerLat;

        if (centerCartesian !== undefined) {
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
        this.mapService.setViewport({
            south: south - expandLat,
            west: west - expandLon,
            width: sizeLon + expandLon * 2,
            height: sizeLat + expandLat * 2,
            camPosLon: centerLon,
            camPosLat: centerLat,
            orientation: -this.viewer.camera.heading + Math.PI * .5,
        });
    }

    private getOpenStreetMapLayerProvider() {
        return new UrlTemplateImageryProvider({
            url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            maximumLevel: 19,
        });
    }

    updateOpenStreetMapLayer(opacity: number) {
        if (this.openStreetMapLayer) {
            this.openStreetMapLayer.alpha = opacity;
            this.viewer.scene.requestRender();
        }
    }
}
