import {TileVisualization} from "./visualization.model"
import {
    Cartesian2,
    Cartesian3,
    Cartographic,
    CesiumMath,
    Color,
    Entity,
    ImageryLayer,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    UrlTemplateImageryProvider,
    Viewer,
    HeightReference,
    Billboard,
    defined
} from "./cesium";
import {ParametersService} from "./parameters.service";
import {AfterViewInit, Component, OnInit} from "@angular/core";
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
import {coreLib} from "./wasm";
import {MenuItem} from "primeng/api";
import {RightClickMenuService} from "./rightclickmenu.service";
import {AppModeService} from "./app-mode.service";

// Redeclare window with extended interface
declare let window: DebugWindow;

@Component({
    selector: 'erdblick-view',
    template: `
        <div #viewer id="mapViewContainer" class="mapviewer-renderlayer" style="z-index: 0"></div>
        <p-contextMenu *ngIf="!appModeService.isVisualizationOnly" [target]="viewer" [model]="menuItems" (onHide)="onContextMenuHide()" />
        <sourcedatadialog *ngIf="!appModeService.isVisualizationOnly"></sourcedatadialog>
    `,
    styles: [`
        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `],
    standalone: false
})
export class ErdblickViewComponent implements AfterViewInit {
    viewer!: Viewer;
    private mouseHandler: ScreenSpaceEventHandler | null = null;
    private openStreetMapLayer: ImageryLayer | null = null;
    private marker: Entity | null = null;
    private tileOutlineEntity: Entity | null = null;
    menuItems: MenuItem[] = [];
    private cameraIsMoving: boolean = false;

    /**
     * Construct a Cesium View with a Model.
     * @param mapService The map model service providing access to data
     * @param styleService
     * @param featureSearchService
     * @param parameterService The parameter service, used to update
     * @param jumpService
     * @param coordinatesService Necessary to pass mouse events to the coordinates panel
     * @param appModeService
     */
    constructor(public mapService: MapService,
                public styleService: StyleService,
                public featureSearchService: FeatureSearchService,
                public parameterService: ParametersService,
                public jumpService: JumpTargetService,
                public inspectionService: InspectionService,
                public keyboardService: KeyboardService,
                public menuService: RightClickMenuService,
                public coordinatesService: CoordinatesService,
                public appModeService: AppModeService) {

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
            // Convert lon/lat to Cartesian3 using current camera altitude.
            this.parameterService.setView(
                Cartesian3.fromDegrees(
                    pos.x,
                    pos.y,
                    pos.z !== undefined? pos.z : Cartographic.fromCartesian(this.viewer.camera.position).height),
                {
                    heading: CesiumMath.toRadians(0), // East, in radians.
                    pitch: CesiumMath.toRadians(-90), // Directly looking down.
                    roll: 0 // No rotation.
                }
            );
        });

        this.menuService.menuItems.subscribe(items => {
            this.menuItems = [...items];
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
        this.cameraIsMoving = false;

        this.mouseHandler.setInputAction((movement: any) => {
            if (this.appModeService.isVisualizationOnly) return;

            const position = movement.position;
            const cartesian = this.viewer.camera.pickEllipsoid(
                new Cartesian2(position.x, position.y),
                this.viewer.scene.globe.ellipsoid
            );
            if (defined(cartesian)) {
                const cartographic = Cartographic.fromCartesian(cartesian);
                const longitude = CesiumMath.toDegrees(cartographic.longitude);
                const latitude = CesiumMath.toDegrees(cartographic.latitude);
                this.menuService.tileIdsForSourceData.next([...Array(16).keys()].map(level => {
                    const tileId = coreLib.getTileIdFromPosition(longitude, latitude, level);
                    return {id: tileId, name: `${tileId} (level ${level})`, tileLevel: level};
                }));
            } else {
                this.menuService.tileIdsForSourceData.next([]);
            }
        }, ScreenSpaceEventType.RIGHT_DOWN);

        // Add a handler for selection.
        this.mouseHandler.setInputAction((movement: any) => {
            if (this.appModeService.isVisualizationOnly) return;

            const position = movement.position;
            let feature = this.viewer.scene.pick(position);
            if (defined(feature) && feature.primitive instanceof Billboard && feature.primitive.id.type === "SearchResult") {
                if (feature.primitive.id) {
                    const featureInfo = this.featureSearchService.searchResults[feature.primitive.id.index];
                    if (featureInfo.mapId && featureInfo.featureId) {
                        this.jumpService.highlightByJumpTargetFilter(featureInfo.mapId, featureInfo.featureId).then(() => {
                            if (this.inspectionService.selectedFeatures) {
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
            if (!defined(feature)) {
                this.inspectionService.isInspectionPanelVisible = false;
                this.menuService.tileOutline.next(null);
            }
            this.mapService.highlightFeatures(
                Array.isArray(feature?.id) ? feature.id : [feature?.id],
                false,
                coreLib.HighlightMode.SELECTION_HIGHLIGHT).then();
            // Handle position update after highlighting, because otherwise
            // there is a race condition between the parameter updates for
            // feature selection and position update.
            const coordinates = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid);
            if (coordinates !== undefined) {
                this.coordinatesService.mouseClickCoordinates.next(Cartographic.fromCartesian(coordinates));
            }
        }, ScreenSpaceEventType.LEFT_CLICK);

        // Add a handler for hover (i.e., MOUSE_MOVE) functionality.
        this.mouseHandler.setInputAction((movement: any) => {
            const position = movement.endPosition; // Notice that for MOUSE_MOVE, it's endPosition
            // Do not handle mouse move here, if the first element
            // under the cursor is not the Cesium view.
            if (document.elementFromPoint(position.x, position.y)?.tagName.toLowerCase() !== "canvas") {
                return;
            }
            // Do not handle mouse move here, if the camera is currently being moved.
            if (this.cameraIsMoving) {
                return;
            }

            if (!this.appModeService.isVisualizationOnly) {
                const coordinates = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid);
                if (coordinates !== undefined) {
                    this.coordinatesService.mouseMoveCoordinates.next(Cartographic.fromCartesian(coordinates))
                }
            }

            if (!this.appModeService.isVisualizationOnly) {
                let feature = this.viewer.scene.pick(position);
                this.mapService.highlightFeatures(
                    Array.isArray(feature?.id) ? feature.id : [feature?.id],
                    false,
                    coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
            }
        }, ScreenSpaceEventType.MOUSE_MOVE);

        // Add a handler for camera movement.
        this.viewer.camera.percentageChanged = 0.1;
        this.viewer.camera.changed.addEventListener(() => {
            this.parameterService.setCameraState(this.viewer.camera);
            this.updateViewport();
        });
        this.viewer.camera.moveStart.addEventListener(() => {
            this.cameraIsMoving = true;
        });
        this.viewer.camera.moveEnd.addEventListener(() => {
            this.cameraIsMoving = false;
        });
        this.viewer.scene.globe.baseColor = new Color(0.1, 0.1, 0.1, 1);

        // Remove fullscreen button as unnecessary
        this.viewer.fullscreenButton.destroy();

        this.parameterService.cameraViewData.pipe(distinctUntilChanged()).subscribe(cameraData => {
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

        if (!this.appModeService.isVisualizationOnly) {
            this.keyboardService.registerShortcut('q', this.zoomIn.bind(this), true);
            this.keyboardService.registerShortcut('e', this.zoomOut.bind(this), true);
            this.keyboardService.registerShortcut('w', this.moveUp.bind(this), true);
            this.keyboardService.registerShortcut('a', this.moveLeft.bind(this), true);
            this.keyboardService.registerShortcut('s', this.moveDown.bind(this), true);
            this.keyboardService.registerShortcut('d', this.moveRight.bind(this), true);
            this.keyboardService.registerShortcut('r', this.resetOrientation.bind(this), true);
        }

        // Hide the global loading spinner.
        const spinner = document.getElementById('global-spinner-container');
        if (spinner) {
            spinner.style.display = 'none';
        }

        this.menuService.tileOutline.subscribe(entity => {
            if (entity) {
                this.tileOutlineEntity = this.viewer.entities.add(entity);
                this.viewer.scene.requestRender();
            } else if (this.tileOutlineEntity) {
                this.viewer.entities.remove(this.tileOutlineEntity);
                this.viewer.scene.requestRender();
            }
        });
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
        if (west > -180 && sizeLon > 180.0) {
            sizeLon = 360.0 - sizeLon;
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
        this.moveCameraOnSurface(0, this.parameterService.cameraMoveUnits);
    }

    moveDown() {
        this.moveCameraOnSurface(0, -this.parameterService.cameraMoveUnits);
    }

    moveLeft() {
        this.moveCameraOnSurface(-this.parameterService.cameraMoveUnits, 0);
    }

    moveRight() {
        this.moveCameraOnSurface(this.parameterService.cameraMoveUnits, 0);
    }

    private moveCameraOnSurface(longitudeOffset: number, latitudeOffset: number) {
        // Get the current camera position in Cartographic coordinates (longitude, latitude, height)
        const cameraPosition = this.viewer.camera.positionCartographic;
        const lon = cameraPosition.longitude + CesiumMath.toRadians(longitudeOffset);
        const lat = cameraPosition.latitude + CesiumMath.toRadians(latitudeOffset);
        const alt = cameraPosition.height;
        const newPosition = Cartesian3.fromRadians(lon, lat, alt);
        this.parameterService.setView(newPosition, this.parameterService.getCameraOrientation());
    }

    zoomIn() {
        this.viewer.camera.zoomIn(this.parameterService.cameraZoomUnits);
    }

    zoomOut() {
        this.viewer.camera.zoomOut(this.parameterService.cameraZoomUnits);
    }

    resetOrientation() {
        this.parameterService.setView(this.parameterService.getCameraPosition(), {
            heading: CesiumMath.toRadians(0.0),
            pitch: CesiumMath.toRadians(-90.0),
            roll: 0.0
        });
    }

    onContextMenuHide() {
        if (!this.menuService.tileSourceDataDialogVisible) {
            this.menuService.tileOutline.next(null)
        }
    }
}
