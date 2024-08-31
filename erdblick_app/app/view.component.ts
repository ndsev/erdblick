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
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    UrlTemplateImageryProvider,
    Viewer,
    HeightReference,
    Billboard,
    BoundingSphere,
    HeadingPitchRange,
    defined
} from "./cesium";
import {ParametersService} from "./parameters.service";
import {AfterViewInit, Component} from "@angular/core";
import {MapService} from "./map.service";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
import {StyleService} from "./style.service";
import {FeatureSearchService, MAX_ZOOM_LEVEL, SearchResultPrimitiveId} from "./feature.search.service";
import {CoordinatesService} from "./coordinates.service";
import {JumpTargetService} from "./jump.service";
import {distinctUntilChanged} from "rxjs";
import {SearchResultPosition} from "./featurefilter.worker";
import {InspectionService} from "./inspection.service";
import {KeyboardService} from "./keyboard.service";

// Redeclare window with extended interface
declare let window: DebugWindow;

/**
 * Determine if two lists of feature wrappers have the same features.
 */
function featureSetsEqual(rhs: FeatureWrapper[], lhs: FeatureWrapper[]) {
    return rhs.length === lhs.length && rhs.every(rf => lhs.some(lf => rf.equals(lf)));
}

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
    private mouseHandler: ScreenSpaceEventHandler | null = null;
    private openStreetMapLayer: ImageryLayer | null = null;
    private marker: Entity | null = null;

    /**
     * Construct a Cesium View with a Model.
     * @param mapService The map model service providing access to data
     * @param styleService
     * @param featureSearchService
     * @param parameterService The parameter service, used to update
     * @param jumpService
     * @param coordinatesService Necessary to pass mouse events to the coordinates panel
     */
    constructor(public mapService: MapService,
                public styleService: StyleService,
                public featureSearchService: FeatureSearchService,
                public parameterService: ParametersService,
                public jumpService: JumpTargetService,
                public inspectionService: InspectionService,
                public keyboardService: KeyboardService,
                public coordinatesService: CoordinatesService) {

        this.mapService.tileVisualizationTopic.subscribe((tileVis: TileVisualization) => {
            tileVis.render(this.viewer).then(wasRendered => {
                if (wasRendered) {
                    this.viewer.scene.requestRender();
                }
            });
        });

        this.mapService.tileVisualizationDestructionTopic.subscribe((tileVis: TileVisualization) => {
            tileVis.destroy(this.viewer);
            this.viewer.scene.requestRender();
        });

        this.mapService.moveToWgs84PositionTopic.subscribe((pos: {x: number, y: number, z?: number}) => {
            this.parameterService.cameraViewData.next({
                // Convert lon/lat to Cartesian3 using current camera altitude.
                destination: Cartesian3.fromDegrees(
                    pos.x,
                    pos.y,
                    pos.z !== undefined? pos.z : Cartographic.fromCartesian(this.viewer.camera.position).height),
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
            if (defined(feature) && feature.primitive instanceof Billboard && feature.primitive.id.type === "SearchResult") {
                if (feature.primitive.id) {
                    const featureInfo = this.featureSearchService.searchResults[feature.primitive.id.index];
                    if (featureInfo.mapId && featureInfo.featureId) {
                        this.jumpService.highlightFeature(featureInfo.mapId, featureInfo.featureId).then(() => {
                            if (this.inspectionService.selectedFeature) {
                                this.inspectionService.zoomToFeature();
                            }
                        });
                    }
                } else {
                    this.mapService.moveToWgs84PositionTopic.next({
                        x: feature.primitive.position.x,
                        y: feature.primitive.position.y,
                        z: feature.primitive.position.z + 1000
                    });
                }
            }
            this.setPickedCesiumFeature(feature);
        }, ScreenSpaceEventType.LEFT_CLICK);

        // Add a handler for hover (i.e., MOUSE_MOVE) functionality.
        this.mouseHandler.setInputAction((movement: any) => {
            const position = movement.endPosition; // Notice that for MOUSE_MOVE, it's endPosition
            const coordinates = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid);
            if (coordinates !== undefined) {
                this.coordinatesService.mouseMoveCoordinates.next(Cartographic.fromCartesian(coordinates))
            }
            let feature = this.viewer.scene.pick(position);
            this.setHoveredCesiumFeature(feature);
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
            if (parameters.marker && parameters.markedPosition.length == 2) {
                this.addMarker(Cartesian3.fromDegrees(
                    Number(parameters.markedPosition[0]),
                    Number(parameters.markedPosition[1]))
                );
            } else {
                if (this.marker) {
                    this.viewer.entities.remove(this.marker);
                }
            }
        });

        // Add debug API that can be easily called from browser's debug console
        window.ebDebug = new ErdblickDebugApi(this.mapService, this.parameterService, this);

        this.viewer.scene.primitives.add(this.featureSearchService.visualization);
        this.featureSearchService.visualizationChanged.subscribe(_ => {
            this.renderFeatureSearchResultTree(this.mapService.zoomLevel.getValue());
            this.viewer.scene.requestRender();
        });

        this.mapService.zoomLevel.pipe(distinctUntilChanged()).subscribe(level => {
            this.renderFeatureSearchResultTree(level);
        });

        this.jumpService.markedPosition.subscribe(position => {
            if (position.length >= 2) {
                this.parameterService.setMarkerState(true);
                this.parameterService.setMarkerPosition(Cartographic.fromDegrees(position[1], position[0]));
            }
        });

        this.inspectionService.originAndNormalForFeatureZoom.subscribe(values => {
            const [origin, normal] = values;
            const direction = Cartesian3.subtract(normal, new Cartesian3(), new Cartesian3());
            const endPoint = Cartesian3.add(origin, direction, new Cartesian3());
            Cartesian3.normalize(direction, direction);
            Cartesian3.negate(direction, direction);
            const up = this.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(endPoint, new Cartesian3());
            const right = Cartesian3.cross(direction, up, new Cartesian3());
            Cartesian3.normalize(right, right);
            const cameraUp = Cartesian3.cross(right, direction, new Cartesian3());
            Cartesian3.normalize(cameraUp, cameraUp);
            this.viewer.camera.flyTo({
                destination: endPoint,
                orientation: {
                    direction: direction,
                    up: cameraUp,
                }
            });
        });

        this.keyboardService.registerShortcuts(['q', 'Q'], this.zoomIn.bind(this));
        this.keyboardService.registerShortcuts(['e', 'E'], this.zoomOut.bind(this));
        this.keyboardService.registerShortcuts(['w', 'W'], this.moveUp.bind(this));
        this.keyboardService.registerShortcuts(['a', 'A'], this.moveLeft.bind(this));
        this.keyboardService.registerShortcuts(['s', 'S'], this.moveDown.bind(this));
        this.keyboardService.registerShortcuts(['d', 'D'], this.moveRight.bind(this));
        this.keyboardService.registerShortcuts(['r', 'R'], this.resetOrientation.bind(this));
    }

    /**
     * Set or re-set the hovered feature.
     */
    private setHoveredCesiumFeature(feature: any) {
        // Get the actual mapget features for the picked Cesium feature.
        let resolvedFeatures = this.resolveMapgetFeatures(feature);
        if (!resolvedFeatures.length) {
            this.mapService.hoverTopic.next([]);
            return;
        }

        if (featureSetsEqual(this.mapService.selectionTopic.getValue(), resolvedFeatures)) {
            return;
        }
        if (featureSetsEqual(this.mapService.hoverTopic.getValue(), resolvedFeatures)) {
            return;
        }

        this.mapService.hoverTopic.next(resolvedFeatures);
    }

    /**
     * Set or re-set the picked feature.
     */
    private setPickedCesiumFeature(feature: any) {
        // Get the actual mapget features for the picked Cesium feature.
        let resolvedFeatures = this.resolveMapgetFeatures(feature);
        if (!resolvedFeatures.length) {
            this.mapService.selectionTopic.next([]);
            return;
        }

        if (featureSetsEqual(this.mapService.selectionTopic.getValue(), resolvedFeatures)) {
            return;
        }
        if (featureSetsEqual(this.mapService.hoverTopic.getValue(), resolvedFeatures)) {
            this.setHoveredCesiumFeature(null);
        }

        this.mapService.selectionTopic.next(resolvedFeatures);
    }

    /**
     * Resolve a Cesium primitive feature ID to a list of mapget FeatureWrappers.
     */
    private resolveMapgetFeatures(feature: any) {
        let resolvedFeatures: FeatureWrapper[] = [];
        for (const fid of Array.isArray(feature?.id) ? feature.id : [feature?.id]) {
            if (fid == "hover-highlight") {
                return this.mapService.hoverTopic.getValue();
            }
            if (fid == "selection-highlight") {
                return this.mapService.selectionTopic.getValue();
            }
            const resolvedFeature = this.mapService.resolveFeature(fid);
            if (resolvedFeature) {
                resolvedFeatures.push(resolvedFeature);
            }
        }
        return resolvedFeatures;
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
        if (this.marker) {
            this.viewer.entities.remove(this.marker);
        }

        this.marker = this.viewer.entities.add({
            position: cartesian,
            billboard: {
                image: this.featureSearchService.markerGraphics(),
                width: 32,
                height: 32,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                pixelOffset: new Cartesian2(0, -12),
                eyeOffset: new Cartesian3(0, 0, -100)
            }
        });
    }
    
    renderFeatureSearchResultTree(level: number) {
        this.featureSearchService.visualization.removeAll();
        const color = Color.fromCssColorString(this.featureSearchService.pointColor);
        let markers: Array<[SearchResultPrimitiveId, SearchResultPosition]> = [];
        const nodes = this.featureSearchService.resultTree.getNodesAtLevel(level);
        for (const node of nodes) {
            if (node.markers.length) {
                markers.push(...node.markers);
            } else if (node.count > 0 && node.center) {
                this.featureSearchService.visualization.add({
                    position: node.center,
                    image: this.featureSearchService.getPinGraphics(node.count),
                    width: 64,
                    height: 64,
                    eyeOffset: new Cartesian3(0, 0, -50)
                });
            }
        }

        if (markers.length) {
            markers.forEach(marker => {
                this.featureSearchService.visualization.add({
                    id: marker[0],
                    position: marker[1].cartesian as Cartesian3,
                    image: this.featureSearchService.markerGraphics(),
                    width: 32,
                    height: 32,
                    pixelOffset: new Cartesian2(0, -10),
                    eyeOffset: new Cartesian3(0, 0, -20),
                    color: color
                });
            });
        }
    }

    moveUp() {
        this.viewer.camera.moveUp(this.parameterService.CAMERA_MOVE_AMOUNT);
    }

    moveDown() {
        this.viewer.camera.moveDown(this.parameterService.CAMERA_MOVE_AMOUNT);
    }

    moveLeft() {
        this.viewer.camera.moveLeft(this.parameterService.CAMERA_MOVE_AMOUNT);
    }

    moveRight() {
        this.viewer.camera.moveRight(this.parameterService.CAMERA_MOVE_AMOUNT);
    }

    zoomIn() {
        this.viewer.camera.zoomIn(this.parameterService.CAMERA_ZOOM_AMOUNT);
    }

    zoomOut() {
        this.viewer.camera.zoomOut(this.parameterService.CAMERA_ZOOM_AMOUNT);
    }

    resetOrientation() {
        this.parameterService.setView(this.parameterService.getCameraPosition(), {
            heading: CesiumMath.toRadians(0.0),
            pitch: CesiumMath.toRadians(-90.0),
            roll: 0.0
        });
    }
}
