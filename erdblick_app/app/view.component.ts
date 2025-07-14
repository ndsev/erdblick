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
    Matrix3,
    WebMercatorProjection,
    GeographicProjection,
    Ellipsoid
} from "./cesium";
import {ParametersService} from "./parameters.service";
import {AfterViewInit, Component, OnDestroy, OnInit} from "@angular/core";
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
import {Subject} from "rxjs";

// Redeclare window with extended interface
declare let window: DebugWindow;

interface MarkersParams {
    id?: SearchResultPrimitiveId;
    position: Cartesian3;
    image?: string;
    width: number;
    height: number;
    eyeOffset?: Cartesian3;
    pixelOffset?: Cartesian2;
    color?: Color;
    disableDepthTestDistance?: number;
    heightReference?: HeightReference;
}

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
            bottom: 30px;
            right: 75px;
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
export class ErdblickViewComponent implements AfterViewInit, OnDestroy {
    viewer!: Viewer;
    private mouseHandler: ScreenSpaceEventHandler | null = null;
    private openStreetMapLayer: ImageryLayer | null = null;
    private markerCollection: BillboardCollection | null = null;
    private tileOutlineEntity: Entity | null = null;
    menuItems: MenuItem[] = [];
    private cameraIsMoving: boolean = false;
    private ignoreNextCameraUpdate: boolean = false;
    is2DMode: boolean;
    private debugHeartbeatInterval: any = null;
    private lastUpdateTime: number = 0;
    
    // Cache to prevent drift when switching between modes
    private modeSwitch3DState: {altitude: number, centerLon: number, centerLat: number} | null = null;
    private modeSwitch2DState: {viewRectHeight: number, centerLon: number, centerLat: number} | null = null;
    
    // State to preserve during viewer reinitialization
    private viewerState: {
        openStreetMapLayerAlpha: number;
        openStreetMapLayerShow: boolean;
        markerPositions: Cartesian3[];
        tileOutlineEntity: Entity | null;
        cameraState: any;
        menuItems: MenuItem[];
    } | null = null;

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
            // Safety check: ensure viewer exists and is not destroyed
            if (!this.viewer || (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed())) {
                console.warn('Cannot render tile visualization: viewer not available');
                return;
            }
            
            tileVis.render(this.viewer).then(wasRendered => {
                if (wasRendered && this.viewer && this.viewer.scene) {
                    // Double-check viewer is still available after async operation
                    if (typeof this.viewer.isDestroyed === 'function' && !this.viewer.isDestroyed()) {
                    this.viewer.scene.requestRender();
                    }
                }
            });
        });

        this.mapService.tileVisualizationDestructionTopic.subscribe((tileVis: TileVisualization) => {
            // Safety check: ensure viewer exists and is not destroyed
            if (!this.viewer || (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed())) {
                console.warn('Cannot destroy tile visualization: viewer not available');
                return;
            }
            
            tileVis.destroy(this.viewer);
            if (this.viewer && this.viewer.scene) {
            this.viewer.scene.requestRender();
            }
        });

        this.mapService.moveToWgs84PositionTopic.subscribe((pos: {x: number, y: number, z?: number}) => {
            // Safety check: ensure viewer exists and is not destroyed
            if (!this.viewer || !this.viewer.camera || (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed())) {
                console.warn('Cannot move to WGS84 position: viewer not available');
                return;
            }
            
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
        // Initialize viewer with appropriate projection
        this.createViewer(this.is2DMode).then(() => {
            // Continue with the rest of the initialization
            this.completeViewerInitialization();
        }).catch((error) => {
            console.error('Failed to initialize viewer:', error);
            // Show user-friendly error or fallback behavior
            alert('Failed to initialize the map viewer. Please refresh the page.');
        });
    }

    /**
     * Complete the viewer initialization process after viewer is created
     */
    private completeViewerInitialization() {
        // Setup parameter subscriptions and event handlers
        this.setupParameterSubscriptions();
        this.setupEventHandlers();
        
        // Hide the global loading spinner
        const spinner = document.getElementById('global-spinner-container');
        if (spinner) {
            spinner.style.display = 'none';
        }
        
        console.log('Debug: ErdblickViewComponent initialization completed');
        
        // Start debug heartbeat to monitor system responsiveness
        this.startDebugHeartbeat();
    }

    private startDebugHeartbeat() {
        // Clear any existing heartbeat
        if (this.debugHeartbeatInterval) {
            clearInterval(this.debugHeartbeatInterval);
        }
        
        this.debugHeartbeatInterval = setInterval(() => {
            const now = Date.now();
            const timeSinceLastUpdate = now - this.lastUpdateTime;
            
            if (timeSinceLastUpdate > 10000) { // 10 seconds
                console.warn('Debug: No viewport updates for over 10 seconds - system may be stuck');
                
                // Log current viewer state when there's an issue
                if (this.viewer && this.viewer.camera) {
                    try {
                        const cameraPos = this.viewer.camera.positionCartographic;
                        const lon = CesiumMath.toDegrees(cameraPos.longitude);
                        const lat = CesiumMath.toDegrees(cameraPos.latitude);
                        console.log(`Debug: Camera stuck at ${lon.toFixed(3)}, ${lat.toFixed(3)}`);
                    } catch (error) {
                        console.error('Debug: Error getting camera position:', error);
                    }
                }
            }
        }, 5000); // Every 5 seconds
    }

    /**
     * Setup parameter subscriptions
     */
    private setupParameterSubscriptions() {
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
                // Handle async mode change properly
                this.applySceneModeChange(parameters.mode2d).catch(error => {
                    console.error('Failed to change scene mode:', error);
                });
            }
            
            // Handle marker parameters - try immediately, but don't retry here
            // The viewerReinitializationComplete subscription will handle restoration after mode changes
            if (parameters.marker && parameters.markedPosition.length == 2) {
                const markerPosition = Cartesian3.fromDegrees(
                    Number(parameters.markedPosition[0]),
                    Number(parameters.markedPosition[1])
                );
                
                this.addMarker(markerPosition);
            } else {
                // Clear markers when marker is disabled or no position
                if (this.markerCollection) {
                    try {
                        this.markerCollection.removeAll();
                        if (this.viewer && this.viewer.scene) {
                            this.viewer.scene.requestRender();
                        }
                    } catch (e) {
                        console.warn('Error clearing markers:', e);
                    }
                }
            }
        });
    }

    /**
     * Setup event handlers and subscriptions
     */
    private setupEventHandlers() {
        if (!this.mouseHandler) return;

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

        // Setup additional subscriptions and services
        this.setupAdditionalSubscriptions();
        this.setupKeyboardShortcuts();
    }

    /**
     * Setup additional subscriptions for services
     */
    private setupAdditionalSubscriptions() {
        // Add debug API that can be easily called from browser's debug console
        window.ebDebug = new ErdblickDebugApi(this.mapService, this.parameterService, this);

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
     * Setup keyboard shortcuts
     */
    private setupKeyboardShortcuts() {
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
    }

    /**
     * Update the visible viewport, and communicate it to the model.
     */
    updateViewport() {
        console.log('Debug: === updateViewport() ENTRY ===');
        this.lastUpdateTime = Date.now(); // Track last update time for heartbeat
        
        // Safety check for viewer existence
        if (!this.viewer || !this.viewer.scene || !this.viewer.camera) {
            console.warn('Cannot update viewport: viewer not available');
            return;
        }

        try {
            // Check if viewer is destroyed
            if (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed()) {
                console.warn('Cannot update viewport: viewer is destroyed');
                return;
            }

            console.log('Debug: Viewer validation passed');

        let canvas = this.viewer.scene.canvas;
        if (!canvas) {
            console.warn('Cannot update viewport: canvas not available');
            return;
        }

        console.log('Debug: Canvas validation passed, dimensions:', { width: canvas.clientWidth, height: canvas.clientHeight });

        let center = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
        let centerCartesian = this.viewer.camera.pickEllipsoid(center);
        let centerLon, centerLat;

        console.log('Debug: Center cartesian:', centerCartesian);

        if (centerCartesian !== undefined) {
            let centerCartographic = Cartographic.fromCartesian(centerCartesian);
            centerLon = CesiumMath.toDegrees(centerCartographic.longitude);
            centerLat = CesiumMath.toDegrees(centerCartographic.latitude);
            console.log('Debug: Center from pickEllipsoid:', { centerLon, centerLat });
        } else {
            let cameraCartographic = Cartographic.fromCartesian(this.viewer.camera.positionWC);
            centerLon = CesiumMath.toDegrees(cameraCartographic.longitude);
            centerLat = CesiumMath.toDegrees(cameraCartographic.latitude);
            console.log('Debug: Center from camera position:', { centerLon, centerLat });
        }

        console.log('Debug: About to compute view rectangle');
        let rectangle = this.viewer.camera.computeViewRectangle();
        if (!rectangle) {
            console.warn('Debug: computeViewRectangle returned null, using fallback calculation');
            
            // Fallback: Calculate viewport from camera position and height
            const cameraCartographic = this.viewer.camera.positionCartographic;
            const cameraLon = CesiumMath.toDegrees(cameraCartographic.longitude);
            const cameraLat = CesiumMath.toDegrees(cameraCartographic.latitude);
            const cameraHeight = cameraCartographic.height;
            
            // Calculate viewport size based on camera height
            const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius;
            const visualAngularSize = 2 * Math.atan(cameraHeight / (2 * earthRadius));
            const visualScale = CesiumMath.toDegrees(visualAngularSize);
            
            // Create a reasonable viewport around camera position
            const halfWidth = visualScale / 2;
            const halfHeight = visualScale * (canvas.clientHeight / canvas.clientWidth) / 2;
            
            // Create fallback rectangle
            rectangle = Rectangle.fromDegrees(
                cameraLon - halfWidth,
                cameraLat - halfHeight,
                cameraLon + halfWidth,
                cameraLat + halfHeight
            );
            
            console.log('Debug: Fallback rectangle created:', {
                west: CesiumMath.toDegrees(rectangle.west),
                south: CesiumMath.toDegrees(rectangle.south),
                east: CesiumMath.toDegrees(rectangle.east),
                north: CesiumMath.toDegrees(rectangle.north)
            });
        }

        console.log('Debug: View rectangle computed successfully');

        let west = CesiumMath.toDegrees(rectangle.west);
        let south = CesiumMath.toDegrees(rectangle.south);
        let east = CesiumMath.toDegrees(rectangle.east);
        let north = CesiumMath.toDegrees(rectangle.north);
        let sizeLon = east - west;
        let sizeLat = north - south;

        console.log('Debug: Basic rectangle:', { west, south, east, north, sizeLon, sizeLat });

        // Check for longitude wrapping issues
        if (Math.abs(sizeLon) > 360 || Math.abs(sizeLat) > 180) {
            console.error('Debug: Suspicious viewport dimensions:', { sizeLon, sizeLat });
        }

        // For WebMercator mode, we need to handle both coordinate accuracy and zoom level accuracy
        if (this.is2DMode) {
            console.log('Debug: Starting 2D mode viewport calculation');
            
            // Sample viewport corners to get accurate geographic bounds for positioning
            const samplePoints = [
                new Cartesian2(0, 0),                                    // top-left
                new Cartesian2(canvas.clientWidth, 0),                  // top-right  
                new Cartesian2(canvas.clientWidth, canvas.clientHeight), // bottom-right
                new Cartesian2(0, canvas.clientHeight),                 // bottom-left
                new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2) // center
            ];
            
            let minLon = Infinity, maxLon = -Infinity;
            let minLat = Infinity, maxLat = -Infinity;
            let validSampleCount = 0;
            
            for (const point of samplePoints) {
                try {
                    const cartesian = this.viewer.camera.pickEllipsoid(point);
                    if (cartesian) {
                        const cartographic = Cartographic.fromCartesian(cartesian);
                        const lon = CesiumMath.toDegrees(cartographic.longitude);
                        const lat = CesiumMath.toDegrees(cartographic.latitude);
                        
                        // Validate coordinates are within reasonable bounds
                        if (isFinite(lon) && isFinite(lat) && 
                            lon >= -180 && lon <= 180 && 
                            lat >= -85 && lat <= 85) {
                            
                            minLon = Math.min(minLon, lon);
                            maxLon = Math.max(maxLon, lon);
                            minLat = Math.min(minLat, lat);
                            maxLat = Math.max(maxLat, lat);
                            validSampleCount++;
                        } else {
                            console.warn('Invalid coordinate sample:', { lon, lat, point });
                        }
                    }
                } catch (error) {
                    console.error('Error sampling viewport point:', point, error);
                }
            }
            
            console.log(`Debug: Valid samples: ${validSampleCount}, bounds: [${minLon}, ${minLat}, ${maxLon}, ${maxLat}]`);
            
            // Use the sampled bounds for accurate positioning
            if (validSampleCount >= 2 && isFinite(minLon) && isFinite(maxLon) && isFinite(minLat) && isFinite(maxLat)) {
                west = minLon;
                east = maxLon;
                south = minLat;
                north = maxLat;
                
                // Update center to match the actual geographic center
                centerLon = (west + east) / 2;
                centerLat = (south + north) / 2;
                
                console.log('Debug: Using sampled bounds for center calculation');
            } else {
                console.warn('Insufficient valid samples, falling back to camera-based calculation');
                // Fallback to camera position if sampling fails
                const cameraCartographic = this.viewer.camera.positionCartographic;
                centerLon = CesiumMath.toDegrees(cameraCartographic.longitude);
                centerLat = CesiumMath.toDegrees(cameraCartographic.latitude);
                
                // Use a reasonable viewport size based on camera height
                const cameraHeight = cameraCartographic.height;
                const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius;
                const visualAngularSize = 2 * Math.atan(cameraHeight / (2 * earthRadius));
                const visualScale = CesiumMath.toDegrees(visualAngularSize);
                
                west = centerLon - visualScale / 2;
                east = centerLon + visualScale / 2;
                south = centerLat - visualScale / 2;
                north = centerLat + visualScale / 2;
                
                console.log('Debug: Using camera-based fallback calculation');
            }
            
            // Debug: Log the center coordinates being calculated
            console.log('2D Viewport Debug:', {
                originalCenter: { lon: centerLon, lat: centerLat },
                bounds: { west, east, south, north },
                computedViewRect: {
                    west: CesiumMath.toDegrees(rectangle.west),
                    east: CesiumMath.toDegrees(rectangle.east),
                    south: CesiumMath.toDegrees(rectangle.south),
                    north: CesiumMath.toDegrees(rectangle.north)
                },
                cameraPosition: {
                    lon: CesiumMath.toDegrees(this.viewer.camera.positionCartographic.longitude),
                    lat: CesiumMath.toDegrees(this.viewer.camera.positionCartographic.latitude)
                }
            });
            
            // Calculate dimensions that represent the visual scale for accurate zoom level detection
            // In WebMercator at high latitudes, geographic bounds are larger than visual area
            // Use camera height to derive visual scale factor
            const cameraHeight = this.viewer.camera.positionCartographic.height;
            const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius;
            
            // Validate camera height is reasonable
            if (!isFinite(cameraHeight) || cameraHeight <= 0) {
                console.error('Invalid camera height:', cameraHeight);
                return; // Skip this update if camera height is invalid
            }
            
            try {
                // Derive visual scale from camera height
                // This represents the visual angular size regardless of projection distortion
                const visualAngularSize = 2 * Math.atan(cameraHeight / (2 * earthRadius));
                const visualScale = CesiumMath.toDegrees(visualAngularSize);
                
                // Validate visual scale is reasonable
                if (!isFinite(visualScale) || visualScale <= 0) {
                    console.error('Invalid visual scale:', visualScale);
                    return;
                }
                
                // Use visual scale for dimensions to ensure correct zoom level calculation
                // This makes the backend think we're at the visual zoom level, not the geographic zoom level
                sizeLon = visualScale;
                sizeLat = visualScale * (canvas.clientHeight / canvas.clientWidth); // Maintain aspect ratio
                
                // Apply reasonable bounds to prevent extreme values
                sizeLon = Math.max(0.001, Math.min(360, sizeLon));
                sizeLat = Math.max(0.001, Math.min(180, sizeLat));
                
                console.log('Debug: Visual scale calculation completed:', { cameraHeight, visualScale, sizeLon, sizeLat });
                
            } catch (error) {
                console.error('Error in visual scale calculation:', error);
                // Use geographic bounds as fallback
                sizeLon = east - west;
                sizeLat = north - south;
                console.log('Debug: Using geographic bounds as fallback:', { sizeLon, sizeLat });
            }
        }

        // Don't handle antimeridian - let Cesium's continuous chaining work naturally
        // The sizeLon can be any value in continuous 2D mode

        // Final validation of all viewport parameters
        if (!isFinite(centerLon) || !isFinite(centerLat) || 
            !isFinite(west) || !isFinite(east) || !isFinite(south) || !isFinite(north) ||
            !isFinite(sizeLon) || !isFinite(sizeLat)) {
            console.error('Invalid viewport parameters detected, skipping update:', {
                centerLon, centerLat, west, east, south, north, sizeLon, sizeLat
            });
            return;
        }

        // Ensure dimensions are positive
        if (sizeLon <= 0 || sizeLat <= 0) {
            console.error('Invalid viewport dimensions:', { sizeLon, sizeLat });
            return;
        }

        // Grow the viewport rectangle by 25%
        let expandLon = sizeLon * 0.25;
        let expandLat = sizeLat * 0.25;
        
        const viewportData = {
            south: south - expandLat,
            west: west - expandLon,
            width: sizeLon + expandLon * 2,
            height: sizeLat + expandLat * 2,
            camPosLon: centerLon,
            camPosLat: centerLat,
            orientation: -this.viewer.camera.heading + Math.PI * .5,
        };
        
        // Final validation of viewport data
        if (!isFinite(viewportData.south) || !isFinite(viewportData.west) ||
            !isFinite(viewportData.width) || !isFinite(viewportData.height) ||
            !isFinite(viewportData.camPosLon) || !isFinite(viewportData.camPosLat) ||
            !isFinite(viewportData.orientation)) {
            console.error('Invalid viewport data calculated, skipping update:', viewportData);
            return;
        }
        
        // Debug: Log the viewport data being sent to backend
        console.log('Viewport being sent to backend:', viewportData);
        
        console.log('Debug: About to call mapService.setViewport()');
        this.mapService.setViewport(viewportData);
        console.log('Debug: mapService.setViewport() completed');
        console.log('Debug: === updateViewport() EXIT ===');
        
        } catch (error) {
            console.error('Error updating viewport:', error);
            console.error('Error stack:', (error as Error)?.stack || 'No stack trace available');
        }
    }

    private getOpenStreetMapLayerProvider() {
        return new UrlTemplateImageryProvider({
            url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            maximumLevel: 19,
        });
    }

    updateOpenStreetMapLayer(opacity: number) {
        if (this.openStreetMapLayer && this.viewer && this.viewer.scene) {
            this.openStreetMapLayer.alpha = opacity;
            this.viewer.scene.requestRender();
        }
    }

    addMarker(cartesian: Cartesian3) {
        // Ensure collection and viewer exist
        if (!this.markerCollection || !this.viewer || !this.viewer.scene) {
            console.warn('Cannot add marker: MarkerCollection or viewer not initialized');
            return false;
        }

        // Check if viewer is destroyed
        if (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed()) {
            console.warn('Cannot add marker: viewer is destroyed');
            return false;
        }
        
        // Clear any existing markers in the collection
        try {
            this.markerCollection.removeAll();
        } catch (e) {
            console.warn('Error clearing markers:', e);
            return false;
        }
        
        // Add marker using same approach as search results
        try {
            const params: MarkersParams = {
                position: cartesian,
                image: this.featureSearchService.markerGraphics(),
                width: 32,
                height: 32
            };
            if (this.is2DMode) {
                params.disableDepthTestDistance = Number.POSITIVE_INFINITY;
            } else {
                params.pixelOffset = new Cartesian2(0, -10);
                params.eyeOffset = new Cartesian3(0, 0, -50);
                params.heightReference = HeightReference.CLAMP_TO_GROUND;
            }
            
            const marker = this.markerCollection.add(params);
            
            // Ensure the marker collection is properly added to the scene
            if (this.viewer.scene.primitives && !this.viewer.scene.primitives.contains(this.markerCollection)) {
                this.viewer.scene.primitives.add(this.markerCollection);
            }
            
            if (this.viewer.scene.primitives) {
                this.viewer.scene.primitives.raiseToTop(this.markerCollection);
            }
            
            // Request a render to ensure the marker is visible
            this.viewer.scene.requestRender();
            
            console.debug('Focus marker added successfully');
            return true;
            
        } catch (e) {
            console.error('Error adding marker:', e);
            return false;
        }
    }

    renderFeatureSearchResultTree(level: number) {
        if (!this.viewer || !this.viewer.scene) {
            console.warn('Cannot render feature search results: viewer not initialized');
            return;
        }

        // Check if viewer is destroyed
        if (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed()) {
            console.warn('Cannot render feature search results: viewer is destroyed');
            return;
        }

        try {
        this.featureSearchService.visualization.removeAll();
        const color = Color.fromCssColorString(this.featureSearchService.pointColor);
        let markers: Array<[SearchResultPrimitiveId, SearchResultPosition]> = [];
            
        // Use the level parameter directly - backend now receives correct viewport coordinates
        const nodes = this.featureSearchService.resultTree.getNodesAtLevel(level);
            
        for (const node of nodes) {
            if (node.markers.length) {
                markers.push(...node.markers);
            } else if (node.count > 0 && node.center) {
                // For cluster centers, always use the center position directly
                // The backend coordinates are now correctly aligned with the projection
                const params: MarkersParams = {
                    position: node.center,
                    image: this.featureSearchService.getPinGraphics(node.count),
                    width: 64,
                    height: 64
                };
                if (this.is2DMode) {
                    params.disableDepthTestDistance = Number.POSITIVE_INFINITY;
                } else {
                    params.eyeOffset = new Cartesian3(0, 0, -50);
                }
                this.featureSearchService.visualization.add(params);
            }
        }

        if (markers.length) {
            markers.forEach(marker => {
                // Always use cartographicRad if available, otherwise fall back to cartesian
                // This ensures consistent positioning across projections
                let markerPosition: Cartesian3;
                if (marker[1].cartographicRad) {
                    markerPosition = Cartesian3.fromRadians(
                        marker[1].cartographicRad.longitude,
                        marker[1].cartographicRad.latitude,
                        marker[1].cartographicRad.height
                    );
                } else {
                    markerPosition = marker[1].cartesian as Cartesian3;
                }

                const params: MarkersParams = {
                    id: marker[0],
                    position: markerPosition,
                    image: this.featureSearchService.markerGraphics(),
                    width: 32,
                    height: 32,
                    color: color
                };
                if (this.is2DMode) {
                    params.disableDepthTestDistance = Number.POSITIVE_INFINITY;
                } else {
                    params.pixelOffset = new Cartesian2(0, -10);
                    params.eyeOffset = new Cartesian3(0, 0, -50);
                }
                this.featureSearchService.visualization.add(params);
            });
        }
                
        if (this.viewer && this.viewer.scene && this.viewer.scene.primitives) {
            this.viewer.scene.primitives.raiseToTop(this.featureSearchService.visualization);
        }
        } catch (error) {
            console.error('Error rendering feature search result tree:', error);
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
        // Safety check for viewer existence
        if (!this.viewer || !this.viewer.camera) {
            console.warn('Cannot move camera: viewer not available');
            return;
        }

        try {
            // Check if viewer is destroyed
            if (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed()) {
                console.warn('Cannot move camera: viewer is destroyed');
                return;
            }

        // Get the current camera position in Cartographic coordinates (longitude, latitude, height)
        const cameraPosition = this.viewer.camera.positionCartographic;
        const lon = cameraPosition.longitude + CesiumMath.toRadians(longitudeOffset);
        const lat = cameraPosition.latitude + CesiumMath.toRadians(latitudeOffset);
        const alt = cameraPosition.height;
        
        if (this.is2DMode) {
            // In 2D mode, use setView to maintain the 2D constraints
            // Ignore the camera change event to preserve mode switch cache
            this.ignoreNextCameraUpdate = true;
            this.viewer.camera.setView({
                destination: Cartesian3.fromRadians(lon, lat, alt)
            });
        } else {
            // 3D mode - use parameter service
            const newPosition = Cartesian3.fromRadians(lon, lat, alt);
            this.parameterService.setView(newPosition, this.parameterService.getCameraOrientation());
            }
        } catch (error) {
            console.warn('Error moving camera:', error);
        }
    }

    zoomIn() {
        if (!this.viewer || !this.viewer.camera) {
            console.warn('Cannot zoom in: viewer not available');
            return;
        }

        try {
        if (this.is2DMode) {
            this.zoom2D(0.8); // Zoom in by 20%
        } else {
            this.viewer.camera.zoomIn(this.parameterService.cameraZoomUnits);
            }
        } catch (error) {
            console.warn('Error zooming in:', error);
        }
    }

    zoomOut() {
        if (!this.viewer || !this.viewer.camera) {
            console.warn('Cannot zoom out: viewer not available');
            return;
        }

        try {
        if (this.is2DMode) {
            this.zoom2D(1.25); // Zoom out by 25%
        } else {
            this.viewer.camera.zoomOut(this.parameterService.cameraZoomUnits);
            }
        } catch (error) {
            console.warn('Error zooming out:', error);
        }
    }

    resetOrientation() {
        if (!this.viewer || !this.viewer.camera) {
            console.warn('Cannot reset orientation: viewer not available');
            return;
        }

        try {
        if (this.is2DMode) {
            // In 2D mode, just reset to north-up orientation
            // Ignore the camera change event to preserve mode switch cache
            this.ignoreNextCameraUpdate = true;
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
        } catch (error) {
            console.warn('Error resetting orientation:', error);
        }
    }

    onContextMenuHide() {
        if (!this.menuService.tileSourceDataDialogVisible) {
            this.menuService.tileOutline.next(null)
        }
    }

    toggleSceneMode() {
        // Don't allow toggling if already changing modes
        if (this._isChangingMode) {
            console.warn('Mode change already in progress, ignoring toggle request');
            return;
        }
        
        this.parameterService.setCameraMode(!this.is2DMode);
    }

    /**
     * Updated scene mode change to use viewer reinitialization
     */
    private async applySceneModeChange(is2D: boolean) {
        // Prevent multiple mode changes at once
        if (this._isChangingMode) {
            console.warn('Mode change already in progress');
            return;
        }

        // Prevent mode change during destruction
        if (this._isDestroyingViewer) {
            console.warn('Mode change prevented: viewer destruction in progress');
            return;
        }

        this._isChangingMode = true;
        
        try {
            // Recreate viewer with appropriate projection
            await this.recreateViewerForMode(is2D);
            // Update mode flag only after successful reinitialization
            this.setupSceneMode(is2D);
            this.restoreParameterMarker();
        } catch (error) {
            console.error('Error during scene mode change:', error);
            // Show user-friendly message
            console.warn('Scene mode change failed. Retrying with fallback...');
            
            // Don't throw the error, just log it and continue
            // The viewer should still be in a usable state due to fallback creation
            
        } finally {
            this._isChangingMode = false;
        }
    }

    // Add flag to prevent concurrent mode changes
    private _isChangingMode = false;
    private _isDestroyingViewer = false;

    /**
     * Recreate the viewer with different projection for 2D/3D modes
     * This is necessary because Cesium doesn't support dynamic projection switching
     */
    private async recreateViewerForMode(is2D: boolean) {
        // Prevent multiple simultaneous reinitializations
        if (this.viewerState) {
            console.warn('Viewer reinitialization already in progress');
            return;
        }

        // Also check if we're currently destroying
        if (this._isDestroyingViewer) {
            console.warn('Cannot reinitialize: viewer destruction in progress');
            return;
        }

        try {
            // Save current state
            this.saveViewerState();

            // Destroy current viewer
            await this.destroyViewer();

            // Small delay to ensure DOM is ready
            await new Promise(resolve => setTimeout(resolve, 150));

            // Create new viewer with appropriate projection
            await this.createViewer(is2D);

            // Restore state
            this.restoreViewerState();
            
        } catch (error) {
            console.error('Error during viewer reinitialization:', error);
            // Reset state on error to prevent future issues
            this.viewerState = null;
            this._isDestroyingViewer = false;
            
            // Try to create a basic viewer as fallback
            try {
                console.log('Attempting fallback viewer creation...');
                await this.createViewer(is2D);
            } catch (fallbackError) {
                console.error('Fallback viewer creation failed:', fallbackError);
                throw new Error('Failed to create viewer. Please refresh the page.');
            }
        }
    }

    /**
     * Save the current viewer state before reinitialization
     */
    private saveViewerState() {
        if (!this.viewer) {
            console.warn('Cannot save viewer state: viewer is null');
            return;
        }

        try {
            // Check if viewer is destroyed
            if (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed()) {
                console.warn('Cannot save viewer state: viewer is destroyed');
                return;
            }

            const markerPositions: Cartesian3[] = [];
            if (this.markerCollection) {
                try {
                    for (let i = 0; i < this.markerCollection.length; i++) {
                        const marker = this.markerCollection.get(i);
                        if (marker && marker.position) {
                            markerPositions.push(marker.position);
                        }
                    }
                } catch (e) {
                    console.warn('Error collecting marker positions:', e);
                }
            }

            this.viewerState = {
                openStreetMapLayerAlpha: this.openStreetMapLayer?.alpha || 0.3,
                openStreetMapLayerShow: this.openStreetMapLayer?.show || false,
                markerPositions: markerPositions,
                tileOutlineEntity: this.tileOutlineEntity,
                cameraState: this.getCurrentCameraState(),
                menuItems: [...this.menuItems]
            };
        } catch (error) {
            console.warn('Error saving viewer state:', error);
            // Don't throw, just continue without saving state
        }
    }

    /**
     * Get current camera state for preservation
     */
    private getCurrentCameraState() {
        if (!this.viewer || !this.viewer.camera) return null;

        try {
            const camera = this.viewer.camera;
            const position = camera.positionCartographic;
            
            return {
                longitude: position.longitude,
                latitude: position.latitude,
                height: position.height,
                heading: camera.heading,
                pitch: camera.pitch,
                roll: camera.roll,
                viewRectangle: camera.computeViewRectangle()
            };
        } catch (e) {
            console.warn('Error getting camera state:', e);
            return null;
        }
    }

    /**
     * Destroy the current viewer and clean up resources
     */
    private async destroyViewer(): Promise<void> {
        // Early return if viewer is already null or destroyed
        if (!this.viewer || (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed())) {
            console.warn('Viewer already null or destroyed, skipping destruction');
            return;
        }
        
        if (this._isDestroyingViewer) {
            console.warn('Viewer already in destruction process.');
            return;
        }
        this._isDestroyingViewer = true;

        return new Promise((resolve) => {
            try {
                // Clean up mouse handler first
                if (this.mouseHandler) {
                    try {
                        if (!this.mouseHandler.isDestroyed()) {
                            this.mouseHandler.destroy();
                        }
                    } catch (e) {
                        console.warn('Error destroying mouse handler:', e);
                    }
                    this.mouseHandler = null;
                }
                
                // Clean up collections and entities references
                this.markerCollection = null;
                this.tileOutlineEntity = null;
                this.openStreetMapLayer = null;
                
                // Clean up feature search visualization collection
                if (this.featureSearchService.visualization && !this.featureSearchService.visualization.isDestroyed()) {
                    try {
                        this.featureSearchService.visualization.destroy();
                    } catch (e) {
                        console.warn('Error destroying feature search visualization:', e);
                    }
                }
                
                // Destroy viewer with multiple safety checks
                if (this.viewer) {
                    try {
                        // Check if viewer is still valid before operations
                        if (typeof this.viewer.isDestroyed === 'function' && !this.viewer.isDestroyed()) {
                            // Remove event listeners first
                            if (this.viewer.camera) {
                                try {
                                    this.viewer.camera.changed.removeEventListener(this.cameraChangedHandler);
                                    this.viewer.camera.moveStart.removeEventListener(this.cameraMoveStartHandler);
                                    this.viewer.camera.moveEnd.removeEventListener(this.cameraMoveEndHandler);
                                } catch (e) {
                                    console.warn('Error removing camera event listeners:', e);
                                }
                            }

                                                // Destroy the viewer - final safety check with try-catch
                            if (typeof this.viewer.destroy === 'function' && !this.viewer.isDestroyed()) {
                                try {
                                    this.viewer.destroy();
                                } catch (e) {
                                    console.warn('Error calling viewer.destroy() - viewer may have been destroyed already:', e);
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('Error during viewer destruction:', e);
                    }
                    
                    // Clear viewer reference regardless
                    this.viewer = null as any;
                }
                
                // Small delay to ensure DOM cleanup completes
            setTimeout(() => {
                    this._isDestroyingViewer = false;
                    resolve();
                }, 100);
                
            } catch (error) {
                console.error('Error during viewer destruction:', error);
                this._isDestroyingViewer = false;
                // Clear references even on error
                this.viewer = null as any;
                this.mouseHandler = null;
                this.markerCollection = null;
                this.tileOutlineEntity = null;
                this.openStreetMapLayer = null;
                resolve(); // Continue anyway
            }
        });
    }

    /**
     * Create a new viewer with appropriate projection
     */
    private async createViewer(is2D: boolean): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const mapProjection = is2D ? new WebMercatorProjection() : new GeographicProjection();
                
                this.viewer = new Viewer("mapViewContainer", {
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
                    sceneMode: is2D ? SceneMode.SCENE2D : SceneMode.SCENE3D,
                    mapProjection: mapProjection
                });

                // Small delay to ensure viewer is fully initialized
                setTimeout(async () => {
                    try {
                        // Setup all viewer components
                        await this.setupViewerComponents();
                        resolve();
                    } catch (error) {
                        console.error('Error initializing viewer components:', error);
                        reject(error);
                    }
                }, 100);
                
            } catch (error) {
                console.error('Error creating viewer:', error);
                reject(error);
            }
        });
    }

    /**
     * Setup viewer components after creation
     */
    private async setupViewerComponents(): Promise<void> {
        try {
            // Initialize scene mode constraints
            this.setupSceneMode(this.is2DMode);

            // Recreate OpenStreetMap layer
            this.openStreetMapLayer = this.viewer.imageryLayers.addImageryProvider(this.getOpenStreetMapLayerProvider());
            
            // Recreate mouse handler
            this.mouseHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
            this.setupMouseHandlers();

            // Setup camera event handlers
            this.setupCameraHandlers();

            // Setup custom wheel handler for 2D mode
            this.setupWheelHandler();

            // Set globe appearance
            this.viewer.scene.globe.baseColor = new Color(0.1, 0.1, 0.1, 1);

            // Remove fullscreen button
            if (this.viewer.fullscreenButton && !this.viewer.fullscreenButton.isDestroyed()) {
                this.viewer.fullscreenButton.destroy();
            }

            // Recreate marker collection
            this.markerCollection = new BillboardCollection({
                scene: this.viewer.scene
            });
            this.viewer.scene.primitives.add(this.markerCollection);

            // Recreate feature search visualization collection for new viewer
            this.featureSearchService.visualization = new BillboardCollection({
                scene: this.viewer.scene
            });
            this.viewer.scene.primitives.add(this.featureSearchService.visualization);

            // Re-render existing search results if any
            if (this.featureSearchService.searchResults.length > 0) {
                this.renderFeatureSearchResultTree(this.mapService.zoomLevel.getValue());
            }
            
        } catch (error) {
            console.error('Error during viewer component initialization:', error);
            throw error;
        }
    }

    /**
     * Restore markers based on current parameters
     * This handles the case where parameter subscriptions fired before markerCollection was ready
     */
    private restoreParameterMarker() {
        try {
            const currentParams = this.parameterService.parameters.getValue();
            if (currentParams.marker && currentParams.markedPosition.length === 2) {
                const markerPosition = Cartesian3.fromDegrees(
                    Number(currentParams.markedPosition[0]),
                    Number(currentParams.markedPosition[1])
                );
                const success = this.addMarker(markerPosition);
                if (success) {
                    console.debug('Parameter-driven focus marker restored after viewer reinitialization');
                } else {
                    console.warn('Failed to restore parameter-driven focus marker');
                }
            }
        } catch (error) {
            console.warn('Error restoring parameter markers:', error);
        }
    }

    /**
     * Setup mouse event handlers
     */
    private setupMouseHandlers() {
        if (!this.mouseHandler) return;

        // Right click handler
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

        // Left click handler
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
            // Handle position update after highlighting
            const coordinates = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid);
            if (coordinates !== undefined) {
                this.coordinatesService.mouseClickCoordinates.next(Cartographic.fromCartesian(coordinates));
            }
        }, ScreenSpaceEventType.LEFT_CLICK);

        // Mouse move handler
        this.mouseHandler.setInputAction((movement: any) => {
            const position = movement.endPosition;
            if (document.elementFromPoint(position.x, position.y)?.tagName.toLowerCase() !== "canvas") {
                return;
            }
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
    }

    /**
     * Setup camera event handlers
     */
    private setupCameraHandlers() {
        this.viewer.camera.percentageChanged = 0.1;
        this.viewer.camera.changed.addEventListener(this.cameraChangedHandler);
        this.viewer.camera.moveStart.addEventListener(this.cameraMoveStartHandler);
        this.viewer.camera.moveEnd.addEventListener(this.cameraMoveEndHandler);
    }

    /**
     * Setup custom wheel handler for 2D mode
     */
    private setupWheelHandler() {
        this.viewer.scene.canvas.addEventListener('wheel', (event: WheelEvent) => {
            if (this.is2DMode) {
                event.preventDefault();
                event.stopPropagation();
                
                const zoomFactor = event.deltaY > 0 ? 1.1 : 0.9;
                const rect = this.viewer.scene.canvas.getBoundingClientRect();
                const mousePosition = new Cartesian2(
                    event.clientX - rect.left,
                    event.clientY - rect.top
                );
                
                this.zoom2D(zoomFactor, mousePosition);
            }
        });
    }

    /**
     * Restore viewer state after reinitialization
     */
    private restoreViewerState() {
        if (!this.viewerState || !this.viewer) {
            console.warn('Cannot restore viewer state: missing state or viewer');
            return;
        }

        try {
            // Restore OpenStreetMap layer
            if (this.openStreetMapLayer) {
                this.openStreetMapLayer.alpha = this.viewerState.openStreetMapLayerAlpha;
                this.openStreetMapLayer.show = this.viewerState.openStreetMapLayerShow;
            }

            // Restore markers
            if (this.markerCollection && this.viewerState.markerPositions.length > 0) {
                this.viewerState.markerPositions.forEach(position => {
                    this.addMarker(position);
                });
            }

            // Restore camera state
            this.restoreCameraState();

            // Restore menu items
            this.menuItems = this.viewerState.menuItems;

            // Clear saved state
            this.viewerState = null;
            
            // Force a render to ensure everything is displayed
            if (this.viewer && this.viewer.scene) {
        this.viewer.scene.requestRender();
            }
            
        } catch (error) {
            console.error('Error restoring viewer state:', error);
            // Clear state on error to prevent future issues
            this.viewerState = null;
        }
    }

    /**
     * Restore camera state from saved state
     */
    private restoreCameraState() {
        if (!this.viewerState?.cameraState || !this.viewer || !this.viewer.camera) {
            console.warn('Cannot restore camera state: missing state, viewer, or camera');
            return;
        }

        try {
            const cameraState = this.viewerState.cameraState;
            this.ignoreNextCameraUpdate = true;

            if (this.is2DMode) {
                // For 2D mode, use view rectangle if available
                if (cameraState.viewRectangle) {
                    this.viewer.camera.setView({
                        destination: cameraState.viewRectangle
                    });
                } else {
                    // Fallback to center position
                    this.viewer.camera.setView({
                        destination: Rectangle.fromRadians(
                            cameraState.longitude - 0.01,
                            cameraState.latitude - 0.01,
                            cameraState.longitude + 0.01,
                            cameraState.latitude + 0.01
                        )
                    });
                }
            } else {
                // For 3D mode, restore full camera state
                this.viewer.camera.setView({
                    destination: Cartesian3.fromRadians(
                        cameraState.longitude, 
                        cameraState.latitude, 
                        cameraState.height
                    ),
                    orientation: {
                        heading: cameraState.heading,
                        pitch: cameraState.pitch,
                        roll: cameraState.roll
                    }
                });
            }
        } catch (error) {
            console.error('Error restoring camera state:', error);
        }
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
        scene.screenSpaceCameraController.enableZoom = false; // Disable Cesium's zoom to use only our custom handler
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
     * Calculate the minimum view rectangle height for 2D mode (1 meter in degrees)
     */
    private getMinViewRectangleHeight(): number {
        // Minimum corresponds to about 100 meters altitude using natural scaling
        // This provides a reasonable minimum zoom level
        const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius; // Use viewer's ellipsoid maximum radius
        const minAltitude = 100; // meters
        return 2 * Math.atan(minAltitude / (2 * earthRadius));
    }

    /**
     * Calculate the maximum view rectangle height for 2D mode (45 degrees)
     */
    private getMaxViewRectangleHeight(): number {
        // Limit to 45 degrees to prevent excessive zoom out
        // This provides a reasonable world view without black bars
        return CesiumMath.toRadians(45);
    }

    /**
     * Convert 3D camera altitude to appropriate 2D view rectangle size
     * @param altitude The 3D camera altitude in meters
     * @param pitch The 3D camera pitch angle in radians (negative for looking down)
     * @returns The height of the view rectangle in radians that shows equivalent area
     */
    private altitude3DToViewRectangle2D(altitude: number, pitch: number): number {
        // Use Cesium's natural relationship between altitude and view rectangle
        // Based on the relationship: higher altitude = larger view rectangle
        // This creates a more natural zoom level mapping
        
        // Convert altitude to angular view size
        // At sea level, 1 degree ≈ 111320 meters, but we use a more natural scaling
        // that accounts for the fact that in 2D mode, the view is more direct
        const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius; // Use viewer's ellipsoid maximum radius
        const viewAngle = 2 * Math.atan(altitude / (2 * earthRadius));
        
        // Apply bounds
        const minHeight = this.getMinViewRectangleHeight();
        const maxHeight = this.getMaxViewRectangleHeight();
        
        const clampedHeight = Math.max(minHeight, Math.min(maxHeight, viewAngle));
        
        return clampedHeight;
    }

    /**
     * Convert 2D view rectangle size to appropriate 3D camera altitude
     * @param viewRectHeight The height of the view rectangle in radians
     * @param desiredPitch The desired 3D camera pitch angle in radians (negative for looking down)
     * @returns The altitude in meters that shows equivalent area
     */
    private viewRectangle2DToAltitude3D(viewRectHeight: number, desiredPitch: number = CesiumMath.toRadians(-45)): number {
        // Reverse the altitude to view rectangle calculation
        // Use Cesium's natural relationship
        
        const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius; // Use viewer's ellipsoid maximum radius
        const altitude = (2 * earthRadius) * Math.tan(viewRectHeight / 2);
        
        // Apply bounds
        const minAltitude = 100;
        const maxAltitude = 50000000;
        
        const clampedAltitude = Math.max(minAltitude, Math.min(maxAltitude, altitude));
        
        return clampedAltitude;
    }

    /**
     * Get movement distance for 2D mode based on current viewport
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
        
        // Calculate movement distances
        const longitudeOffset = CesiumMath.toDegrees(currentWidth * movementPercentage);
        const latitudeOffset = CesiumMath.toDegrees(currentHeight * movementPercentage);
        
        // Clamp movements to reasonable values
        const maxLonMovement = 45; // Maximum 45 degrees longitude movement
        const minLonMovement = 0.001;
        const maxLatMovement = 45; // Maximum 45 degrees latitude movement
        const minLatMovement = 0.001;
        
        return {
            longitudeOffset: Math.max(minLonMovement, Math.min(maxLonMovement, longitudeOffset)),
            latitudeOffset: Math.max(minLatMovement, Math.min(maxLatMovement, latitudeOffset))
        };
    }

    /**
     * 2D zoom using height-based approach with proper limit conversion
     */
    private zoom2D(zoomFactor: number, cursorPosition?: Cartesian2): void {
        if (!this.viewer || !this.viewer.camera) {
            console.warn('Cannot zoom in 2D: viewer not available');
            return;
        }

        try {
            // Check if viewer is destroyed
            if (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed()) {
                console.warn('Cannot zoom in 2D: viewer is destroyed');
                return;
            }

        const camera = this.viewer.camera;
        
        // Get current camera height
        const currentHeight = camera.positionCartographic.height;
        const newHeight = currentHeight * zoomFactor;
        
        // Convert height to equivalent view rectangle height using natural relationship
        const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius; // Use viewer's ellipsoid maximum radius
        const newViewRectHeight = 2 * Math.atan(newHeight / (2 * earthRadius));
        
        // Apply zoom limits based on view rectangle height
        const minViewRectHeight = this.getMinViewRectangleHeight();
        const maxViewRectHeight = this.getMaxViewRectangleHeight();
        
        if (newViewRectHeight < minViewRectHeight || newViewRectHeight > maxViewRectHeight) {
            console.warn('Zoom blocked by view rectangle limits');
            return;
        }
        
        // Set new camera height directly while preserving position
        const currentPos = camera.positionCartographic;
        const newPosition = Cartesian3.fromRadians(
            currentPos.longitude,
            currentPos.latitude,
            newHeight
        );
        
        // Ignore the camera change event for this programmatic zoom
        this.ignoreNextCameraUpdate = true;
        
        camera.setView({
            destination: newPosition
        });
        } catch (error) {
            console.warn('Error in 2D zoom:', error);
        }
    }

    // Store event handler references for proper cleanup
    private cameraChangedHandler = () => {
        console.log('Debug: cameraChangedHandler called, ignoreNextCameraUpdate =', this.ignoreNextCameraUpdate);
        
        try {
            // Check if viewer is still valid
            if (!this.viewer || !this.viewer.camera) {
                console.error('Debug: cameraChangedHandler - viewer or camera is null');
                return;
            }
            
            if (typeof this.viewer.isDestroyed === 'function' && this.viewer.isDestroyed()) {
                console.error('Debug: cameraChangedHandler - viewer is destroyed');
                return;
            }
            
            // Log camera position for debugging
            const cameraPos = this.viewer.camera.positionCartographic;
            const lon = CesiumMath.toDegrees(cameraPos.longitude);
            const lat = CesiumMath.toDegrees(cameraPos.latitude);
            console.log('Debug: Camera position:', { lon, lat, height: cameraPos.height });
            
            // Check for extreme coordinates that might cause issues
            if (!isFinite(lon) || !isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
                console.error('Debug: Invalid camera coordinates detected:', { lon, lat });
                return;
            }
            
            if (!this.ignoreNextCameraUpdate) {
                this.modeSwitch2DState = null;
                this.modeSwitch3DState = null;
                
                console.log('Debug: Processing camera update');
                
                if (this.is2DMode) {
                    this.parameterService.set2DCameraState(this.viewer.camera);
                } else {
                    this.parameterService.setCameraState(this.viewer.camera);
                }
            } else {
                console.log('Debug: Ignoring camera update (ignoreNextCameraUpdate = true)');
            }
            
            this.ignoreNextCameraUpdate = false;
            console.log('Debug: About to call updateViewport()');
            this.updateViewport();
            console.log('Debug: updateViewport() completed successfully');
            
        } catch (error) {
            console.error('Debug: Error in cameraChangedHandler:', error);
        }
    };

    private cameraMoveStartHandler = () => {
        console.log('Debug: cameraMoveStartHandler called');
        this.cameraIsMoving = true;
    };

    private cameraMoveEndHandler = () => {
        console.log('Debug: cameraMoveEndHandler called');
        this.cameraIsMoving = false;
    };

    /**
     * Component cleanup when destroyed
     */
    ngOnDestroy() {
        console.log('ErdblickViewComponent: cleaning up resources');
        
        // Don't allow mode changes during destruction
        this._isChangingMode = true;
        
        // Clean up debug heartbeat
        if (this.debugHeartbeatInterval) {
            clearInterval(this.debugHeartbeatInterval);
            this.debugHeartbeatInterval = null;
        }
        
        // Clean up resources without async to avoid hanging
        if (this.mouseHandler) {
            try {
                if (!this.mouseHandler.isDestroyed()) {
                    this.mouseHandler.destroy();
                }
            } catch (e) {
                console.warn('Error destroying mouse handler:', e);
            }
            this.mouseHandler = null;
        }
        
        if (this.viewer) {
            try {
                if (typeof this.viewer.isDestroyed === 'function' && !this.viewer.isDestroyed()) {
                    // Remove event listeners before destroying
                    if (this.viewer.camera) {
                        try {
                            this.viewer.camera.changed.removeEventListener(this.cameraChangedHandler);
                            this.viewer.camera.moveStart.removeEventListener(this.cameraMoveStartHandler);
                            this.viewer.camera.moveEnd.removeEventListener(this.cameraMoveEndHandler);
                        } catch (e) {
                            console.warn('Error removing camera event listeners in ngOnDestroy:', e);
                        }
                    }
                    
                    this.viewer.destroy();
                }
            } catch (e) {
                console.warn('Error destroying viewer in ngOnDestroy:', e);
            }
            this.viewer = null as any;
        }
        
        // Clear all references
        this.mouseHandler = null;
        this.openStreetMapLayer = null;
        this.markerCollection = null;
        this.tileOutlineEntity = null;
        this.viewerState = null;
        
        // Reset flags
        this._isChangingMode = false;
        this._isDestroyingViewer = false;
    }
}
