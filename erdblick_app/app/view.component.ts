"use strict";

import {FeatureWrapper} from "./features.model";
import {TileVisualization} from "./visualization.model"
import {
    Cartesian2,
    Cartesian3,
    Cartographic,
    CesiumMath,
    Color,
    ColorGeometryInstanceAttribute,
    Entity,
    ImageryLayer,
    LabelStyle,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    UrlTemplateImageryProvider,
    VerticalOrigin,
    Viewer,
    HeightReference
} from "./cesium";
import {ParametersService} from "./parameters.service";
import {AfterViewInit, Component} from "@angular/core";
import {MapService} from "./map.service";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
import {StyleService} from "./style.service";
import {FeatureSearchService} from "./feature.search.service";
import {CoordinatesService} from "./coordinates.service";
import {JumpTargetService} from "./jump.service";

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
    private tileVisForPrimitive: Map<any, TileVisualization>;
    private openStreetMapLayer: ImageryLayer | null = null;
    private marker: Entity | null = null;
    private markerIcon: string = `
    <svg xmlns="http://www.w3.org/2000/svg" height="48" viewBox="0 0 24 24" width="48">
      <path d="M12 2C8.1 2 5 5.1 5 9c0 3.3 4.2 8.6 6.6 11.6.4.5 1.3.5 1.7 0C14.8 17.6 19 12.3 19 9c0-3.9-3.1-7-7-7zm0 9.5c-1.4 0-2.5-1.1-2.5-2.5S10.6 6.5 12 6.5s2.5 1.1 2.5 2.5S13.4 11.5 12 11.5z" fill="ghostwhite"/>
    </svg>`;

    /**
     * Construct a Cesium View with a Model.
     * @param mapService The map model service providing access to data
     * @param parameterService The parameter service, used to update
     * @param coordinatesService Necessary to pass mouse events to the coordinates panel
     */
    constructor(public mapService: MapService,
                public styleService: StyleService,
                public searchService: FeatureSearchService,
                public parameterService: ParametersService,
                public jumpService: JumpTargetService,
                public coordinatesService: CoordinatesService) {

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

        this.mapService.moveToWgs84PositionTopic.subscribe((pos: {x: number, y: number}) => {
            this.parameterService.cameraViewData.next({
                // Convert lon/lat to Cartesian3 using current camera altitude.
                destination: Cartesian3.fromDegrees(
                    pos.x,
                    pos.y,
                    Cartographic.fromCartesian(this.viewer.camera.position).height),
                orientation: {
                    heading: CesiumMath.toRadians(0), // East, in radians.
                    pitch: CesiumMath.toRadians(-90), // Directly looking down.
                    roll: 0 // No rotation.
                }
            });
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
            const position = movement.position;
            const coordinates = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid);
            if (coordinates !== undefined) {
                this.coordinatesService.mouseClickCoordinates.next(Cartographic.fromCartesian(coordinates));
            }
            let feature = this.viewer.scene.pick(position);
            if (this.isKnownCesiumFeature(feature)) {
                this.setPickedCesiumFeature(feature);
            } else {
                this.setPickedCesiumFeature(null);
            }
        }, ScreenSpaceEventType.LEFT_CLICK);

        // Add a handler for hover (i.e., MOUSE_MOVE) functionality.
        this.mouseHandler.setInputAction((movement: any) => {
            const position = movement.endPosition; // Notice that for MOUSE_MOVE, it's endPosition
            const coordinates = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid);
            if (coordinates !== undefined) {
                this.coordinatesService.mouseMoveCoordinates.next(Cartographic.fromCartesian(coordinates))
            }
            let feature = this.viewer.scene.pick(position);
            if (this.isKnownCesiumFeature(feature)) {
                this.setHoveredCesiumFeature(feature);
            } else {
                this.setHoveredCesiumFeature(null);
            }
        }, ScreenSpaceEventType.MOUSE_MOVE);

        // Add a handler for camera movement.
        this.viewer.camera.percentageChanged = 0.1;
        this.viewer.camera.changed.addEventListener(() => {
            this.parameterService.setCameraState(this.viewer.camera);
            this.updateViewport();
        });
        this.viewer.scene.globe.baseColor = new Color(0.1, 0.1, 0.1, 1);

        // Remove fullscreen button as unnecessary
        this.viewer.fullscreenButton.destroy();

        this.parameterService.cameraViewData.subscribe(cameraData => {
            this.viewer.camera.setView({
                destination: cameraData.destination,
                orientation: cameraData.orientation
            });
            this.updateViewport();
        });

        this.parameterService.parameters.subscribe(parameters => {
            if (this.openStreetMapLayer) {
                this.openStreetMapLayer.show = parameters.osm;
                this.updateOpenStreetMapLayer(parameters.osmOpacity / 100);
            }
            if (parameters.marker && parameters.marked_position.length == 2) {
                this.addMarker(Cartesian3.fromDegrees(
                    Number(parameters.marked_position[0]),
                    Number(parameters.marked_position[1]))
                );
            } else {
                if (this.marker) {
                    this.viewer.entities.remove(this.marker);
                }
            }
        });

        // Add debug API that can be easily called from browser's debug console
        window.ebDebug = new ErdblickDebugApi(this.mapService, this.parameterService, this);

        this.viewer.scene.primitives.add(this.searchService.visualization);
        this.searchService.visualizationChanged.subscribe(_ => {
            this.viewer.scene.requestRender();
        });

        this.jumpService.markedPosition.subscribe(position => {
            if (position.length >= 2) {
                this.addMarker(Cartesian3.fromDegrees(position[1], position[0]));
            }
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
        if (this.cesiumFeaturesAreEqual(feature, this.hoveredFeature)) {
            return;
        }
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
        if (this.pickedFeature && this.cesiumFeaturesAreEqual(feature, this.pickedFeature)) {
            return;
        }

        // Restore the previously picked feature to its original color.
        if (this.pickedFeature && this.pickedFeatureOrigColor) {
            this.setFeatureColor(this.pickedFeature, this.pickedFeatureOrigColor);
        }
        this.pickedFeature = null;

        // Get the actual mapget feature for the picked Cesium feature.
        let resolvedFeature = feature ? this.resolveFeature(feature.primitive, feature.id) : null;
        if (!resolvedFeature) {
            this.mapService.selectionTopic.next(null);
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
            this.mapService.selectionTopic.next(resolvedFeature);
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
        if (feature.primitive.isDestroyed()) {
            return;
        }
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
            centerLon = CesiumMath.toDegrees(centerCartographic.longitude);
            centerLat = CesiumMath.toDegrees(centerCartographic.latitude);
        } else {
            let cameraCartographic = Cartographic.fromCartesian(this.viewer.camera.positionWC);
            centerLon = CesiumMath.toDegrees(cameraCartographic.longitude);
            centerLat = CesiumMath.toDegrees(cameraCartographic.latitude);
        }

        let rectangle = this.viewer.camera.computeViewRectangle();
        if (!rectangle) {
            // This might happen when looking into space.
            return;
        }

        let west = CesiumMath.toDegrees(rectangle.west);
        let south = CesiumMath.toDegrees(rectangle.south);
        let east = CesiumMath.toDegrees(rectangle.east);
        let north = CesiumMath.toDegrees(rectangle.north);
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


    addMarker(cartesian: Cartesian3) {
        const markerIcon = `data:image/svg+xml;base64,${btoa(this.markerIcon)}`

        if (this.marker) {
            this.viewer.entities.remove(this.marker);
        }

        this.marker = this.viewer.entities.add({
            position: cartesian,
            billboard: {
                image: markerIcon,
                width: 32,
                height: 32,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                pixelOffset: new Cartesian2(0, -12),
            }
        });
    }
}
