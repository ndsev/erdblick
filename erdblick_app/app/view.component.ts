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
    SceneMode,
    HeightReference,
    Billboard,
    BillboardCollection,
    Rectangle,
    defined,
    Matrix3
} from "./cesium";
import {ParametersService} from "./parameters.service";
import {AfterViewInit, Component, OnInit} from "@angular/core";
import {MapService} from "./map.service";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
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
        <div class="scene-mode-toggle" *ngIf="!appModeService.isVisualizationOnly">
            <p-button
                [icon]="is2DMode ? 'pi pi-globe' : 'pi pi-map'"
                [pTooltip]="is2DMode ? 'Switch to 3D' : 'Switch to 2D'"
                tooltipPosition="left"
                (onClick)="toggleSceneMode()"
                [rounded]="true"
                severity="secondary"
                size="large">
            </p-button>
        </div>
        <div class="navigation-controls" *ngIf="!appModeService.isVisualizationOnly">
            <div class="nav-control-group">
                <p-button icon="pi pi-plus" (onClick)="zoomIn()" [rounded]="true" severity="secondary" size="small" pTooltip="Zoom In (Q)"></p-button>
                <p-button icon="pi pi-minus" (onClick)="zoomOut()" [rounded]="true" severity="secondary" size="small" pTooltip="Zoom Out (E)"></p-button>
            </div>
            <div class="nav-control-group">
                <p-button icon="pi pi-arrow-up" (onClick)="moveUp()" [rounded]="true" severity="secondary" size="small" pTooltip="Move Up (W)"></p-button>
                <div class="nav-horizontal">
                    <p-button icon="pi pi-arrow-left" (onClick)="moveLeft()" [rounded]="true" severity="secondary" size="small" pTooltip="Move Left (A)"></p-button>
                    <p-button icon="pi pi-arrow-right" (onClick)="moveRight()" [rounded]="true" severity="secondary" size="small" pTooltip="Move Right (D)"></p-button>
                </div>
                <p-button icon="pi pi-arrow-down" (onClick)="moveDown()" [rounded]="true" severity="secondary" size="small" pTooltip="Move Down (S)"></p-button>
            </div>
            <p-button icon="pi pi-refresh" (onClick)="resetOrientation()" [rounded]="true" severity="secondary" size="small" pTooltip="Reset View (R)"></p-button>
        </div>
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
        .scene-mode-toggle {
            position: absolute;
            top: 10px;
            right: 10px;
            z-index: 1;
        }
        .navigation-controls {
            position: absolute;
            bottom: 30px;
            right: 10px;
            z-index: 1;
            display: flex;
            flex-direction: column;
            gap: 10px;
            align-items: center;
        }
        .nav-control-group {
            display: flex;
            flex-direction: column;
            gap: 5px;
            align-items: center;
        }
        .nav-horizontal {
            display: flex;
            gap: 5px;
        }
    `],
    standalone: false
})
export class ErdblickViewComponent implements AfterViewInit {
    viewer!: Viewer;
    private mouseHandler: ScreenSpaceEventHandler | null = null;
    private openStreetMapLayer: ImageryLayer | null = null;
    private markerCollection: BillboardCollection | null = null;
    private tileOutlineEntity: Entity | null = null;
    menuItems: MenuItem[] = [];
    private cameraIsMoving: boolean = false;
    is2DMode: boolean;
    private ignoreNextCameraUpdate: boolean = false;
    
    // Cache to prevent drift when switching between modes
    private modeSwitch3DState: {altitude: number, centerLon: number, centerLat: number} | null = null;
    private modeSwitch2DState: {viewRectHeight: number, centerLon: number, centerLat: number} | null = null;

    /**
     * Construct a Cesium View with a Model.
     * @param mapService The map model service providing access to data
     * @param featureSearchService
     * @param parameterService The parameter service, used to update
     * @param jumpService
     * @param coordinatesService Necessary to pass mouse events to the coordinates panel
     * @param appModeService
     */
    constructor(private mapService: MapService,
                private featureSearchService: FeatureSearchService,
                private parameterService: ParametersService,
                private jumpService: JumpTargetService,
                private inspectionService: InspectionService,
                private keyboardService: KeyboardService,
                private menuService: RightClickMenuService,
                private coordinatesService: CoordinatesService,
                public appModeService: AppModeService) {

        this.is2DMode = this.parameterService.parameters.getValue().mode2d;

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
                baseLayer: false,
                sceneMode: SceneMode.SCENE2D
            }
        );
        
        // Initialize camera mode from parameters
        this.setupSceneMode(this.is2DMode);

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
            if (!this.ignoreNextCameraUpdate) {
                // Clear mode switch cache when user manually moves camera
                this.modeSwitch2DState = null;
                this.modeSwitch3DState = null;
                
                if (this.is2DMode) {
                    this.parameterService.set2DCameraState(this.viewer.camera);
                } else {
                    this.parameterService.setCameraState(this.viewer.camera);
                }
            }
            this.ignoreNextCameraUpdate = false;
            this.updateViewport();
        });
        this.viewer.camera.moveStart.addEventListener(() => {
            this.cameraIsMoving = true;
        });
        this.viewer.camera.moveEnd.addEventListener(() => {
            this.cameraIsMoving = false;
        });
        
        // Add custom wheel handler for 2D mode
        this.viewer.scene.canvas.addEventListener('wheel', (event: WheelEvent) => {
            if (this.is2DMode) {
                event.preventDefault();
                const zoomFactor = event.deltaY > 0 ? 1.1 : 0.9; // Smoother zoom steps
                
                // Get mouse position relative to canvas
                const rect = this.viewer.scene.canvas.getBoundingClientRect();
                const mousePosition = new Cartesian2(
                    event.clientX - rect.left,
                    event.clientY - rect.top
                );
                
                this.zoom2D(zoomFactor, mousePosition);
            }
        });
        this.viewer.scene.globe.baseColor = new Color(0.1, 0.1, 0.1, 1);

        // Remove fullscreen button as unnecessary
        this.viewer.fullscreenButton.destroy();

        this.parameterService.cameraViewData.pipe(distinctUntilChanged()).subscribe(cameraData => {
            this.ignoreNextCameraUpdate = true;
            if (this.is2DMode) {
                // In 2D mode, check if we have a view rectangle in parameters
                const params = this.parameterService.p();
                if (params.viewRectangle && params.viewRectangle.length === 4) {
                    this.viewer.camera.setView({
                        destination: Rectangle.fromDegrees(...params.viewRectangle)
                    });
                } else {
                    // Fallback to center position
                    const cartographic = Cartographic.fromCartesian(cameraData.destination);
                    this.viewer.camera.setView({
                        destination: Rectangle.fromDegrees(
                            CesiumMath.toDegrees(cartographic.longitude) - 1,
                            CesiumMath.toDegrees(cartographic.latitude) - 1,
                            CesiumMath.toDegrees(cartographic.longitude) + 1,
                            CesiumMath.toDegrees(cartographic.latitude) + 1
                        )
                    });
                }
            } else {
                // 3D mode
                this.viewer.camera.setView({
                    destination: cameraData.destination,
                    orientation: cameraData.orientation
                });
            }
            this.updateViewport();
        });

        this.parameterService.parameters.subscribe(parameters => {
            if (this.openStreetMapLayer) {
                this.openStreetMapLayer.show = parameters.osm;
                this.updateOpenStreetMapLayer(parameters.osmOpacity / 100);
            }
            if (this.viewer && this.is2DMode !== parameters.mode2d) {
                this.applySceneModeChange(parameters.mode2d);
            }
            if (parameters.marker && parameters.markedPosition.length == 2) {
                this.addMarker(Cartesian3.fromDegrees(
                    Number(parameters.markedPosition[0]),
                    Number(parameters.markedPosition[1]))
                );
            } else {
                if (this.markerCollection) {
                    this.markerCollection.removeAll();
                    this.viewer.scene.requestRender();
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
        
        // Create marker collection for position markers
        this.markerCollection = new BillboardCollection({
            scene: this.viewer.scene
        });
        this.viewer.scene.primitives.add(this.markerCollection);

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
            this.keyboardService.registerShortcut('t', this.toggleSceneMode.bind(this), true);
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
        // Ensure collection exists
        if (!this.markerCollection) {
            console.warn('MarkerCollection not initialized');
            return;
        }
        
        // Clear any existing markers in the collection
        this.markerCollection.removeAll();
        
        // Add marker using same approach as search results
        try {
            this.markerCollection.add({
                position: cartesian,
                image: this.featureSearchService.markerGraphics(),
                width: 32,
                height: 32,
                pixelOffset: new Cartesian2(0, -16),
                eyeOffset: new Cartesian3(0, 0, -20), // Same as search markers
                heightReference: HeightReference.CLAMP_TO_GROUND
            });
            
            this.viewer.scene.requestRender();
        } catch (e) {
            console.error('Error adding marker:', e);
        }
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
        if (this.is2DMode) {
            const distance = this.get2DMovementDistance();
            this.moveCameraOnSurface(0, distance.latitudeOffset);
        } else {
            this.moveCameraOnSurface(0, this.parameterService.cameraMoveUnits);
        }
    }

    moveDown() {
        if (this.is2DMode) {
            const distance = this.get2DMovementDistance();
            this.moveCameraOnSurface(0, -distance.latitudeOffset);
        } else {
            this.moveCameraOnSurface(0, -this.parameterService.cameraMoveUnits);
        }
    }

    moveLeft() {
        if (this.is2DMode) {
            const distance = this.get2DMovementDistance();
            this.moveCameraOnSurface(-distance.longitudeOffset, 0);
        } else {
            this.moveCameraOnSurface(-this.parameterService.cameraMoveUnits, 0);
        }
    }

    moveRight() {
        if (this.is2DMode) {
            const distance = this.get2DMovementDistance();
            this.moveCameraOnSurface(distance.longitudeOffset, 0);
        } else {
            this.moveCameraOnSurface(this.parameterService.cameraMoveUnits, 0);
        }
    }

    private moveCameraOnSurface(longitudeOffset: number, latitudeOffset: number) {
        // Get the current camera position in Cartographic coordinates (longitude, latitude, height)
        const cameraPosition = this.viewer.camera.positionCartographic;
        const lon = cameraPosition.longitude + CesiumMath.toRadians(longitudeOffset);
        const lat = cameraPosition.latitude + CesiumMath.toRadians(latitudeOffset);
        const alt = cameraPosition.height;
        
        if (this.is2DMode) {
            // In 2D mode, use setView to maintain the 2D constraints
            this.viewer.camera.setView({
                destination: Cartesian3.fromRadians(lon, lat, alt)
            });
        } else {
            // 3D mode - use parameter service
            const newPosition = Cartesian3.fromRadians(lon, lat, alt);
            this.parameterService.setView(newPosition, this.parameterService.getCameraOrientation());
        }
    }

    zoomIn() {
        if (this.is2DMode) {
            this.zoom2D(0.8); // Zoom in by 20%
        } else {
            this.viewer.camera.zoomIn(this.parameterService.cameraZoomUnits);
        }
    }

    zoomOut() {
        if (this.is2DMode) {
            this.zoom2D(1.25); // Zoom out by 25%
        } else {
            this.viewer.camera.zoomOut(this.parameterService.cameraZoomUnits);
        }
    }

    resetOrientation() {
        if (this.is2DMode) {
            // In 2D mode, just reset to north-up orientation
            this.parameterService.setView(this.parameterService.getCameraPosition(), {
                heading: 0,
                pitch: CesiumMath.toRadians(-90.0),
                roll: 0.0
            });
        } else {
            // In 3D mode, reset to default view angle
            this.parameterService.setView(this.parameterService.getCameraPosition(), {
                heading: CesiumMath.toRadians(0.0),
                pitch: CesiumMath.toRadians(-45.0), // 45-degree angle for 3D
                roll: 0.0
            });
        }
    }

    onContextMenuHide() {
        if (!this.menuService.tileSourceDataDialogVisible) {
            this.menuService.tileOutline.next(null)
        }
    }

    toggleSceneMode() {
        this.parameterService.setCameraMode(!this.is2DMode);
    }

    private applySceneModeChange(is2D: boolean) {
        this.setupSceneMode(is2D);

        // Temporarily disable camera sync to avoid feedback
        this.ignoreNextCameraUpdate = true;

        if (this.is2DMode) {
            // Switch FROM 3D TO 2D mode
            this.viewer.scene.mode = SceneMode.SCENE2D;
            this.setup2DConstraints();

            let centerLon: number;
            let centerLat: number;
            let viewRectHeight: number;

            // Check if we have a cached 2D state to restore
            if (this.modeSwitch2DState) {
                // Restore from cache to avoid drift
                centerLon = this.modeSwitch2DState.centerLon;
                centerLat = this.modeSwitch2DState.centerLat;
                viewRectHeight = this.modeSwitch2DState.viewRectHeight;
                console.log('Restoring cached 2D state');
            } else {
                // First time switching to 2D, calculate from 3D state
                const canvas = this.viewer.scene.canvas;
                const centerScreen = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
                const centerCartesian = this.viewer.camera.pickEllipsoid(centerScreen);
                
                if (centerCartesian) {
                    const centerCartographic = Cartographic.fromCartesian(centerCartesian);
                    centerLon = centerCartographic.longitude;
                    centerLat = centerCartographic.latitude;
                } else {
                    const currentPos = this.viewer.camera.positionCartographic;
                    centerLon = currentPos.longitude;
                    centerLat = currentPos.latitude;
                }

                // Store the current 3D state before conversion
                const currentPos = this.viewer.camera.positionCartographic;
                this.modeSwitch3DState = {
                    altitude: currentPos.height,
                    centerLon: centerLon,
                    centerLat: centerLat
                };

                // Convert 3D altitude to 2D view rectangle
                const current3DAltitude = currentPos.height;
                const current3DPitch = this.viewer.camera.pitch;
                viewRectHeight = this.altitude3DToViewRectangle2D(current3DAltitude, current3DPitch);
            }
            
            // Calculate aspect ratio and apply view
            const canvas = this.viewer.scene.canvas;
            const aspectRatio = canvas.clientWidth / canvas.clientHeight;
            const viewRectWidth = viewRectHeight * aspectRatio;

            setTimeout(() => {
                this.ignoreNextCameraUpdate = true;
                this.viewer.camera.setView({
                    destination: Rectangle.fromRadians(
                        centerLon - viewRectWidth / 2,
                        centerLat - viewRectHeight / 2,
                        centerLon + viewRectWidth / 2,
                        centerLat + viewRectHeight / 2
                    )
                });
            }, 50);
        } else {
            // Switch FROM 2D TO 3D mode
            this.viewer.scene.mode = SceneMode.SCENE3D;
            this.setup3DConstraints();

            let centerLon: number;
            let centerLat: number;
            let altitude: number;

            // Check if we have a cached 3D state to restore
            if (this.modeSwitch3DState) {
                // Restore from cache to avoid drift
                centerLon = this.modeSwitch3DState.centerLon;
                centerLat = this.modeSwitch3DState.centerLat;
                altitude = this.modeSwitch3DState.altitude;
                console.log('Restoring cached 3D state');
            } else {
                // First time switching to 3D, calculate from 2D state
                const current2DView = this.viewer.camera.computeViewRectangle();
                
                if (current2DView) {
                    centerLon = (current2DView.west + current2DView.east) / 2;
                    centerLat = (current2DView.south + current2DView.north) / 2;
                    
                    // Store the current 2D state before conversion
                    const current2DViewHeight = current2DView.north - current2DView.south;
                    this.modeSwitch2DState = {
                        viewRectHeight: current2DViewHeight,
                        centerLon: centerLon,
                        centerLat: centerLat
                    };
                    
                    // Convert 2D view rectangle to 3D altitude
                    altitude = this.viewRectangle2DToAltitude3D(current2DViewHeight);
                } else {
                    // Fallback if view rectangle can't be computed
                    const currentPos = this.viewer.camera.positionCartographic;
                    centerLon = currentPos.longitude;
                    centerLat = currentPos.latitude;
                    altitude = 1000000; // 1000 km
                }
            }

            setTimeout(() => {
                this.ignoreNextCameraUpdate = true;
                
                // Set camera to look straight down (orthogonal to ground), just like in 2D mode
                this.viewer.camera.setView({
                    destination: Cartesian3.fromRadians(centerLon, centerLat, altitude),
                    orientation: {
                        heading: 0, // North
                        pitch: CesiumMath.toRadians(-90), // Straight down (orthogonal)
                        roll: 0
                    }
                });
                
                // Force a render
                this.viewer.scene.requestRender();
            }, 100);
        }

        this.viewer.scene.requestRender();
    }

    private setupSceneMode(is2D: boolean) {
        this.is2DMode = is2D;
        if (this.is2DMode) {
            this.viewer.scene.mode = SceneMode.SCENE2D;
            this.setup2DConstraints();
        } else {
            this.viewer.scene.mode = SceneMode.SCENE3D;
            this.setup3DConstraints();
        }
    }

    private setup2DConstraints() {
        // Enable 2D map interactions
        const scene = this.viewer.scene;
        
        // Disable camera rotation and tilting in 2D
        scene.screenSpaceCameraController.enableRotate = false;
        scene.screenSpaceCameraController.enableTilt = false;
        
        // Enable standard 2D interactions
        scene.screenSpaceCameraController.enableTranslate = true;
        scene.screenSpaceCameraController.enableZoom = false; // Disable Cesium's zoom to use custom handler
        scene.screenSpaceCameraController.enableLook = false;
        
        // Set zoom constraints for 2D mode (not used since we disabled zoom)
        scene.screenSpaceCameraController.minimumZoomDistance = 100;
        scene.screenSpaceCameraController.maximumZoomDistance = 50000000;
    }

    private setup3DConstraints() {
        // Re-enable full 3D camera controls
        const scene = this.viewer.scene;
        
        scene.screenSpaceCameraController.enableRotate = true;
        scene.screenSpaceCameraController.enableTilt = true;
        scene.screenSpaceCameraController.enableTranslate = true;
        scene.screenSpaceCameraController.enableZoom = true; // Re-enable Cesium's zoom for 3D mode
        scene.screenSpaceCameraController.enableLook = true;
        
        // Reset zoom constraints for 3D mode
        scene.screenSpaceCameraController.minimumZoomDistance = 1;
        scene.screenSpaceCameraController.maximumZoomDistance = 50000000;
    }

    /**
     * Calculate the minimum view rectangle height for 2D mode (5 meters in degrees)
     */
    private getMinViewRectangleHeight(): number {
        // 1 degree of latitude ≈ 111,320 meters
        // 5 meters ≈ 5/111,320 ≈ 0.0000449 degrees
        return 5 / 111320;
    }

    /**
     * Calculate the maximum view rectangle height for 2D mode (world height)
     */
    private getMaxViewRectangleHeight(): number {
        // World spans from -90° to +90° latitude (180° total)
        // Use a smaller value to prevent black bars at maximum zoom out
        // This ensures the view doesn't extend beyond world boundaries
        return Math.PI * 0.5; // ~90 degrees in radians
    }

    /**
     * Calculate appropriate movement distance for 2D mode based on current view size
     * Returns movement distance as a percentage of the current view rectangle
     */
    private get2DMovementDistance(): {longitudeOffset: number, latitudeOffset: number} {
        const currentView = this.viewer.camera.computeViewRectangle();
        if (!currentView) {
            // Fallback to default movement if view can't be computed
            return {
                longitudeOffset: this.parameterService.cameraMoveUnits,
                latitudeOffset: this.parameterService.cameraMoveUnits
            };
        }

        const currentWidth = currentView.east - currentView.west;
        const currentHeight = currentView.north - currentView.south;
        
        // Move by 10% of the current view size (adjust this percentage as needed)
        const movementPercentage = 0.1;
        
        return {
            longitudeOffset: CesiumMath.toDegrees(currentWidth * movementPercentage),
            latitudeOffset: CesiumMath.toDegrees(currentHeight * movementPercentage)
        };
    }

    /**
     * Convert 3D camera altitude to appropriate 2D view rectangle size
     * @param altitude The 3D camera altitude in meters
     * @param pitch The 3D camera pitch angle in radians (negative for looking down)
     * @returns The height of the view rectangle in radians that shows equivalent area
     */
    private altitude3DToViewRectangle2D(altitude: number, pitch: number): number {
        // Use a direct linear mapping for perfect reversibility
        const scalingFactor = 0.3;
        const visibleDegrees = (altitude * scalingFactor) / 111320;
        const viewRectHeight = CesiumMath.toRadians(visibleDegrees);
        
        // Apply bounds without clamping to preserve reversibility
        const minHeight = this.getMinViewRectangleHeight();
        const maxHeight = this.getMaxViewRectangleHeight();
        
        // Only warn if out of bounds, but don't clamp to avoid drift
        if (viewRectHeight < minHeight || viewRectHeight > maxHeight) {
            console.warn(`View rectangle height ${viewRectHeight} is outside bounds [${minHeight}, ${maxHeight}]`);
        }
        
        return viewRectHeight;
    }

    /**
     * Convert 2D view rectangle size to appropriate 3D camera altitude
     * @param viewRectHeight The height of the view rectangle in radians
     * @param desiredPitch The desired 3D camera pitch angle in radians (negative for looking down)
     * @returns The altitude in meters that shows equivalent area
     */
    private viewRectangle2DToAltitude3D(viewRectHeight: number, desiredPitch: number = CesiumMath.toRadians(-45)): number {
        // Exact inverse of the 3D to 2D conversion
        const visibleDegrees = CesiumMath.toDegrees(viewRectHeight);
        const scalingFactor = 0.3; // Same scaling factor as used in altitude3DToViewRectangle2D
        const altitude = (visibleDegrees * 111320) / scalingFactor;
        
        // Apply bounds without clamping to preserve reversibility
        const minAltitude = 100;
        const maxAltitude = 50000000;
        
        // Only warn if out of bounds, but don't clamp to avoid drift
        if (altitude < minAltitude || altitude > maxAltitude) {
            console.warn(`Altitude ${altitude} is outside bounds [${minAltitude}, ${maxAltitude}]`);
        }
        
        return altitude;
    }

    /**
     * Zoom the 2D camera by a factor while maintaining cursor position
     */
    private zoom2D(zoomFactor: number, cursorPosition?: Cartesian2): void {
        const camera = this.viewer.camera;
        const currentView = camera.computeViewRectangle();
        if (!currentView) return;

        const currentHeight = currentView.north - currentView.south;
        const newHeight = currentHeight * zoomFactor;

        // Apply zoom limits
        const minHeight = this.getMinViewRectangleHeight();
        const maxHeight = this.getMaxViewRectangleHeight();
        
        if (newHeight < minHeight || newHeight > maxHeight) {
            return; // Don't zoom beyond limits
        }

        let centerLon = (currentView.west + currentView.east) / 2;
        let centerLat = (currentView.south + currentView.north) / 2;

        // Calculate current dimensions
        const currentWidth = currentView.east - currentView.west;

        // Calculate new dimensions
        const newWidth = currentWidth * zoomFactor;

        // If cursor position is provided, zoom towards it
        if (cursorPosition) {
            const worldPosition = camera.pickEllipsoid(cursorPosition, this.viewer.scene.globe.ellipsoid);
            if (worldPosition) {
                const cursorCartographic = Cartographic.fromCartesian(worldPosition);
                const cursorLon = cursorCartographic.longitude;
                const cursorLat = cursorCartographic.latitude;
                
                // Calculate cursor position as percentage of current view
                const xPercent = (cursorLon - currentView.west) / currentWidth;
                const yPercent = (cursorLat - currentView.south) / currentHeight;
                
                // Calculate new bounds keeping cursor position fixed
                let newWest = cursorLon - (newWidth * xPercent);
                let newSouth = cursorLat - (newHeight * yPercent);
                
                // Ensure bounds don't extend beyond world boundaries
                const worldLatMin = -Math.PI / 2; // -90° in radians
                const worldLatMax = Math.PI / 2;   // +90° in radians
                
                if (newSouth < worldLatMin) {
                    newSouth = worldLatMin;
                }
                if (newSouth + newHeight > worldLatMax) {
                    newSouth = worldLatMax - newHeight;
                }
                
                camera.setView({
                    destination: Rectangle.fromRadians(newWest, newSouth, newWest + newWidth, newSouth + newHeight)
                });
                return;
            }
        }

        // Fallback: zoom to center with bounds checking
        let newWest = centerLon - newWidth / 2;
        let newSouth = centerLat - newHeight / 2;
        
        // Ensure bounds don't extend beyond world boundaries
        const worldLatMin = -Math.PI / 2; // -90° in radians
        const worldLatMax = Math.PI / 2;   // +90° in radians
        
        if (newSouth < worldLatMin) {
            newSouth = worldLatMin;
        }
        if (newSouth + newHeight > worldLatMax) {
            newSouth = worldLatMax - newHeight;
        }
        
        camera.setView({
            destination: Rectangle.fromRadians(newWest, newSouth, newWest + newWidth, newSouth + newHeight)
        });
    }
}
