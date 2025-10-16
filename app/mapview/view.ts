import {
    UrlTemplateImageryProvider,
    ImageryLayer,
    Color,
    Cartesian2,
    Cartesian3,
    Cartographic,
    CesiumMath,
    Entity, GeographicProjection,
    SceneMode,
    Viewer,
    ScreenSpaceEventHandler,
    WebMercatorProjection,
    Rectangle,
    BillboardCollection,
    defined,
    ScreenSpaceEventType,
    Billboard,
    HeightReference
} from "../integrations/cesium";
import {AppStateService, CameraViewState, VIEW_SYNC_POSITION, VIEW_SYNC_PROJECTION} from "../shared/appstate.service";
import {MapDataService} from "../mapdata/map.service";
import {TileVisualization} from "./visualization.model";
import {combineLatest, distinctUntilChanged, Subscription} from "rxjs";
import {FeatureSearchService, SearchResultPrimitiveId} from "../search/feature.search.service";
import {coreLib} from "../integrations/wasm";
import {environment} from "../environments/environment";
import {JumpTargetService} from "../search/jump.service";
import {InspectionService} from "../inspection/inspection.service";
import {RightClickMenuService} from "./rightclickmenu.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {SearchResultPosition} from "../search/search.worker";
import {MergedPointsTile, MergedPointVisualization} from "./pointmerge.service";

/**
 * Camera constants object to centralize all numerical values for easier maintenance
 * and to support WebMercator distortion compensation
 */
export interface CameraConstants {
    // Earth and projection constants
    readonly WEBMERCATOR_MAX_LATITUDE: number;
    readonly WEBMERCATOR_MAX_LATITUDE_RAD: number;

    // Altitude limits and defaults
    readonly MIN_ALTITUDE_METERS: number;
    readonly MAX_ALTITUDE_METERS: number;
    readonly DEFAULT_PITCH_DEGREES: number;

    // Movement and zoom parameters
    readonly MOVEMENT_PERCENTAGE_2D: number;
    readonly ZOOM_IN_FACTOR_2D: number;
    readonly ZOOM_OUT_FACTOR_2D: number;

    // Clamp limits for safety
    readonly MAX_LONGITUDE_MOVEMENT: number;
    readonly MIN_LONGITUDE_MOVEMENT: number;
    readonly MAX_LATITUDE_MOVEMENT: number;
    readonly MIN_LATITUDE_MOVEMENT: number;
    readonly MAX_SIZE_LONGITUDE: number;
    readonly MIN_SIZE_LONGITUDE: number;
    readonly MAX_SIZE_LATITUDE: number;
    readonly MIN_SIZE_LATITUDE: number;

    // Camera state restoration fallback values
    readonly FALLBACK_RECTANGLE_HALF_SIZE_RAD: number;
}

export const CAMERA_CONSTANTS: CameraConstants = {
    // Earth and projection constants
    WEBMERCATOR_MAX_LATITUDE: 85.05113, // WebMercatorProjection.MaximumLatitude
    WEBMERCATOR_MAX_LATITUDE_RAD: CesiumMath.toRadians(85.05113),

    // Altitude limits and defaults
    MIN_ALTITUDE_METERS: 10, // Minimum camera altitude for reasonable zoom
    MAX_ALTITUDE_METERS: 2000000, // Maximum camera altitude for reasonable zoom
    DEFAULT_PITCH_DEGREES: -90.0, // Top-down view for camera

    // Movement and zoom parameters
    MOVEMENT_PERCENTAGE_2D: 0.1, // Move by 10% of current view size in 2D
    ZOOM_IN_FACTOR_2D: 0.8, // 20% zoom in
    ZOOM_OUT_FACTOR_2D: 1.25, // 25% zoom out

    // Clamp limits for safety
    MAX_LONGITUDE_MOVEMENT: 45, // Maximum degrees longitude movement
    MIN_LONGITUDE_MOVEMENT: 0.001, // Minimum degrees longitude movement
    MAX_LATITUDE_MOVEMENT: 45, // Maximum degrees latitude movement
    MIN_LATITUDE_MOVEMENT: 0.001, // Minimum degrees latitude movement
    MAX_SIZE_LONGITUDE: 360, // Maximum longitude size for viewport
    MIN_SIZE_LONGITUDE: 0.001, // Minimum longitude size for viewport
    MAX_SIZE_LATITUDE: 180, // Maximum latitude size for viewport
    MIN_SIZE_LATITUDE: 0.001, // Minimum latitude size for viewport

    // Camera state restoration fallback values
    FALLBACK_RECTANGLE_HALF_SIZE_RAD: 0.01 // ~0.57 degrees fallback rectangle size
};

interface MarkerParams {
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

export class MapView {
    private mouseHandler: ScreenSpaceEventHandler | null = null;
    private openStreetMapLayer: ImageryLayer | null = null;
    isDestroyingViewer = false;
    protected _viewIndex: number;
    viewer!: Viewer;
    canvasId: string;
    tileOutlineEntity: Entity | null = null;
    cameraIsMoving: boolean = false;
    protected readonly sceneMode: SceneMode;
    protected subscriptions: Subscription[] = [];
    protected featureSearchVisualization: BillboardCollection | null = null;
    protected markerCollection: BillboardCollection | null = null;
    private ignoreNextCamAppStateUpdate: boolean = false;

    get viewIndex() {
        return this._viewIndex;
    }

    /**
     * Centralized camera constants for consistent calculations across all methods
     */
    constructor(id: number,
                canvasId: string,
                sceneMode: SceneMode,
                protected mapService: MapDataService,
                protected featureSearchService: FeatureSearchService,
                protected jumpService: JumpTargetService,
                protected inspectionService: InspectionService,
                protected menuService: RightClickMenuService,
                protected coordinatesService: CoordinatesService,
                protected stateService: AppStateService) {
        this._viewIndex = id;
        this.canvasId = canvasId;
        this.sceneMode = sceneMode;

        this.subscriptions.push(
            this.mapService.tileVisualizationTopic.subscribe((tileVis: TileVisualization) => {
                // Safety check: ensure viewer exists and is not destroyed
                if (!this.isAvailable()) {
                    console.debug('Cannot render tile visualization: viewer not available');
                    return;
                }

                // Do not render the tile here if it is not dedicated to this view.
                if (tileVis.viewIndex !== this._viewIndex) {
                    return;
                }

                tileVis.render(this.viewer).then(wasRendered => {
                    if (wasRendered && this.isAvailable()) {
                        this.viewer.scene.requestRender();
                    }
                });
            })
        );

        this.subscriptions.push(
            this.mapService.tileVisualizationDestructionTopic.subscribe((tileVis: TileVisualization) => {
                // Safety check: ensure viewer exists and is not destroyed
                if (!this.isAvailable()) {
                    console.debug('Cannot destroy tile visualization: viewer not available');
                    return;
                }

                // Do not destroy the tile here if it is not dedicated to this view.
                if (tileVis.viewIndex !== this._viewIndex) {
                    return;
                }

                tileVis.destroy(this.viewer);
                if (this.isAvailable()) {
                    this.viewer.scene.requestRender();
                }
            })
        );

        this.subscriptions.push(
            this.mapService.mergedTileVisualizationDestructionTopic.subscribe((tileVis: MergedPointsTile) => {
                // Safety check: ensure viewer exists and is not destroyed
                if (!this.isAvailable()) {
                    console.debug('Cannot destroy merged points tile: viewer not available');
                    return;
                }

                // Do not destroy the tile here if it is not dedicated to this view.
                if (tileVis.viewIndex !== this._viewIndex) {
                    return;
                }

                tileVis.remove(this.viewer);
                if (this.isAvailable()) {
                    this.viewer.scene.requestRender();
                }
            })
        )

        this.subscriptions.push(
            this.mapService.moveToWgs84PositionTopic.subscribe((pos: { targetView: number, x: number, y: number, z?: number }) => {
                // Safety check: ensure viewer exists and is not destroyed
                if (!this.isAvailable()) {
                    console.debug('Cannot move to WGS84 position: viewer not available');
                    return;
                }

                if (pos.targetView !== this._viewIndex) {
                    return;
                }
                const [destination, orientation] = this.performConversionForMovePosition(pos);
                if (orientation) {
                    this.stateService.setView(this._viewIndex, destination, orientation);
                } else {
                    this.stateService.setView(this._viewIndex, destination);
                }
            })
        );
    }

    protected performConversionForMovePosition(pos: { x: number, y: number, z?: number }):
        [Cartographic, { heading: number, pitch: number, roll: number}?] {
        throw Error("Not implemented");
    }

    async setup() {
        try {
            const mapProjection =
                this.sceneMode.valueOf() === SceneMode.SCENE2D ? new WebMercatorProjection() : new GeographicProjection();

            // TODO: Wait for the viewer to be initialised to proceed with the rest of the method
            //  Maybe wrap it in Promise or something?
            this.viewer = new Viewer(this.canvasId, {
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
                sceneMode: this.sceneMode,
                mapProjection: mapProjection
            });

            // Restore OpenStreetMap layer
            if (this.openStreetMapLayer) {
                this.openStreetMapLayer.alpha = this.stateService.osmOpacityState.getValue(this._viewIndex);
                this.openStreetMapLayer.show = this.stateService.osmEnabledState.getValue(this._viewIndex);
            }

            // Recreate OpenStreetMap layer
            this.openStreetMapLayer = this.viewer.imageryLayers.addImageryProvider(
                this.getOpenStreetMapLayerProvider()
            );

            // Set globe appearance
            this.viewer.scene.globe.baseColor = new Color(0.1, 0.1, 0.1, 1);

            // Remove fullscreen button
            if (this.viewer.fullscreenButton &&
                !this.viewer.fullscreenButton.isDestroyed()) {
                this.viewer.fullscreenButton.destroy();
            }

            // Trigger viewport update to fetch tiles for the new viewer
            this.updateViewport();

            // Recreate marker collection
            this.markerCollection = new BillboardCollection({
                scene: this.viewer.scene
            });
            this.viewer.scene.primitives.add(this.markerCollection);

            // Recreate feature search visualization collection for new viewer
            this.featureSearchVisualization = new BillboardCollection({
                scene: this.viewer.scene
            });
            this.viewer.scene.primitives.add(this.featureSearchVisualization);

            // Re-render existing search results if any
            if (this.featureSearchService.searchResults.length > 0) {
                this.renderFeatureSearchResultTree(this.mapService.zoomLevel.getValue());
            }

            // Set up handlers, listeners and subscriptions
            this.setupHandlers();
            this.setupAppStateSubscriptions();
            this.setupServiceSubscriptions();
            this.viewer.camera.changed.addEventListener(this.updateOnCameraChangedHandler);
            this.viewer.camera.moveStart.addEventListener(this.cameraMoveStartHandler);
            this.viewer.camera.moveEnd.addEventListener(this.cameraMoveEndHandler);

            // Force a render to ensure everything is displayed
            if (this.viewer && this.viewer.scene) {
                this.viewer.scene.requestRender();
            }

            // TODO: What does it do?
            this.viewer.camera.percentageChanged = 0.1;

            this.setupScreenSpaceConstraints();
        } catch (error) {
            console.error('Error creating viewer:', error);
        }
    }

    protected setupHandlers() {
        this.mouseHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
        this.setupMouseEventHandlers();
    }

    /**
     * Setup parameter subscriptions
     */
    protected setupAppStateSubscriptions() {
        this.subscriptions.push(
            combineLatest([
                this.stateService.osmEnabledState.pipe(this._viewIndex),
                this.stateService.osmOpacityState.pipe(this._viewIndex)
            ]).subscribe(([osmEnabled, osmOpacity]) => {
                if (this.openStreetMapLayer) {
                    this.openStreetMapLayer.show = osmEnabled;
                    if (this.openStreetMapLayer && this.viewer && this.viewer.scene) {
                        this.openStreetMapLayer.alpha = osmOpacity / 100;
                        this.viewer.scene.requestRender();
                    }
                }
            })
        );

        this.subscriptions.push(
            combineLatest([
                this.stateService.markerState,
                this.stateService.markedPositionState
            ]).subscribe(([markerEnabled, markedPosition]) => {
                if (markerEnabled && markedPosition.length === 2) {
                    const markerPosition = Cartesian3.fromDegrees(
                        Number(markedPosition[0]),
                        Number(markedPosition[1])
                    );
                    this.addMarker(markerPosition);
                } else {
                    this.clearMarkers();
                }
            })
        );

        this.subscriptions.push(
            this.stateService.cameraViewDataState.pipe(this._viewIndex).subscribe(cameraViewData => {
                if (this.ignoreNextCamAppStateUpdate) {
                    this.ignoreNextCamAppStateUpdate = false;
                    return;
                }
                this.updateOnAppStateChange(cameraViewData);
                this.updateViewport();
            })
        );
    }

    protected setupScreenSpaceConstraints() {
        throw Error("Not Implemented");
    }

    /**
     * Setup event handlers and subscriptions for mouse handler
     */
    private setupMouseEventHandlers() {
        if (!this.mouseHandler) {
            return;
        }

        this.mouseHandler.setInputAction((movement: any) => {
            if (environment.visualizationOnly) {
                return;
            }

            // Focus on this view
            this.stateService.focusedView = this._viewIndex;

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
            if (environment.visualizationOnly) {
                return;
            }

            // Focus on this view
            this.stateService.focusedView = this._viewIndex;

            const position = movement.position;
            let feature = this.viewer.scene.pick(position);
            if (defined(feature) && feature.primitive instanceof Billboard && feature.primitive?.id?.type === "SearchResult") {
                if (feature.primitive.id) {
                    const featureInfo = this.featureSearchService.searchResults[feature.primitive.id.index];
                    if (featureInfo.mapId && featureInfo.featureId) {
                        this.jumpService.highlightByJumpTargetFilter(this._viewIndex, featureInfo.mapId, featureInfo.featureId).then(() => {
                            if (this.inspectionService.selectedFeatures) {
                                this.inspectionService.zoomToFeature();
                            }
                        });
                    }
                } else {
                    // Convert Cartesian3 position to WGS84 degrees
                    const cartographic = Cartographic.fromCartesian(feature.primitive.position);
                    this.mapService.moveToWgs84PositionTopic.next({
                        targetView: this._viewIndex,
                        x: CesiumMath.toDegrees(cartographic.longitude),
                        y: CesiumMath.toDegrees(cartographic.latitude),
                        z: cartographic.height + 1000
                    });
                }
            }
            if (!defined(feature)) {
                this.inspectionService.isInspectionPanelVisible = false;
                this.menuService.tileOutline.next(null);
            }
            this.mapService.highlightFeatures(
                Array.isArray(feature?.id) ? [this._viewIndex, feature.id] : [[this._viewIndex, feature?.id]],
                false,
                coreLib.HighlightMode.SELECTION_HIGHLIGHT).then();
            // Handle position update after highlighting, because otherwise
            // there is a race condition between the parameter updates for
            // feature selection and position update.
            const coordinates = this.viewer.camera.pickEllipsoid(
                position, this.viewer.scene.globe.ellipsoid
            );
            if (coordinates !== undefined) {
                this.coordinatesService.mouseClickCoordinates.next(Cartographic.fromCartesian(coordinates));
            }
        }, ScreenSpaceEventType.LEFT_CLICK);

        // Add a handler for hover (i.e., MOUSE_MOVE) functionality.
        this.mouseHandler.setInputAction((movement: any) => {
            const position = movement.endPosition; // Notice that for MOUSE_MOVE, it's endPosition
            // Do not handle mouse move here if the first element
            // under the cursor is not the Cesium view.
            if (document.elementFromPoint(position.x, position.y)?.tagName.toLowerCase() !== "canvas") {
                return;
            }
            // Do not handle mouse move here if the camera is currently being moved.
            if (this.cameraIsMoving) {
                return;
            }

            if (!environment.visualizationOnly) {
                const coordinates = this.viewer.camera.pickEllipsoid(
                    position, this.viewer.scene.globe.ellipsoid
                );
                if (coordinates !== undefined) {
                    this.coordinatesService.mouseMoveCoordinates.next(Cartographic.fromCartesian(coordinates))
                }

                let feature = this.viewer.scene.pick(position);
                this.mapService.highlightFeatures(
                    Array.isArray(feature?.id) ? [this._viewIndex, feature.id] : [[this._viewIndex, feature?.id]],
                    false,
                    coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
            }
        }, ScreenSpaceEventType.MOUSE_MOVE);
    }

    /**
     * Setup additional subscriptions for services
     */
    private setupServiceSubscriptions() {
        this.subscriptions.push(
            this.featureSearchService.visualizationChanged.subscribe(_ => {
                // Add safety check before accessing viewer
                if (this.isAvailable()) {
                    this.renderFeatureSearchResultTree(this.mapService.zoomLevel.getValue());
                    this.viewer.scene.requestRender();
                }
            })
        );

        this.subscriptions.push(
            this.mapService.zoomLevel.pipe(distinctUntilChanged()).subscribe(level => {
                this.renderFeatureSearchResultTree(level);
            })
        );

        this.subscriptions.push(
            this.jumpService.markedPosition.subscribe(position => {
                if (position.length >= 2) {
                    this.stateService.setMarkerState(true);
                    this.stateService.setMarkerPosition(Cartographic.fromDegrees(position[1], position[0]));
                }
            })
        );

        this.subscriptions.push(
            this.inspectionService.originAndNormalForFeatureZoom.subscribe(values => {
                // Add safety check before accessing viewer
                if (!this.isAvailable()) {
                    return;
                }

                const [origin, normal] = values;
                const direction = Cartesian3.subtract(normal, new Cartesian3(), new Cartesian3());
                const endPoint = Cartesian3.add(origin, direction, new Cartesian3());
                Cartesian3.normalize(direction, direction);
                Cartesian3.negate(direction, direction);
                const up = this.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(
                    endPoint, new Cartesian3()
                );
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
            })
        );

        this.subscriptions.push(
            this.menuService.tileOutline.subscribe(entity => {
                if (!this.isAvailable()) {
                    console.log('Viewer unavailable or destroyed, skipping outline update');
                    return;
                }
                if (entity) {
                    if (this.tileOutlineEntity) {
                        this.viewer.entities.remove(this.tileOutlineEntity);
                        this.tileOutlineEntity = null;
                    }
                    this.tileOutlineEntity = this.viewer.entities.add(entity);
                    this.viewer.scene.render();
                } else if (this.tileOutlineEntity) {
                    this.viewer.entities.remove(this.tileOutlineEntity);
                    this.tileOutlineEntity = null;
                    this.viewer.scene.render();
                }
            })
        );
    }

    public async destroy() {
        // Early return if viewer is already null or destroyed
        if (!this.isAvailable()) {
            console.debug('Viewer already null or destroyed, skipping destruction');
            return;
        }

        if (this.isDestroyingViewer) {
            console.debug('Viewer already in destruction process.');
            return;
        }
        this.isDestroyingViewer = true;

        try {
            // Clean up subscriptions first to prevent race conditions
            this.subscriptions.forEach(sub => sub.unsubscribe());
            this.subscriptions = [];

            // Clean up mouse handler
            if (this.mouseHandler) {
                if (!this.mouseHandler.isDestroyed()) {
                    this.mouseHandler.destroy();
                }
                this.mouseHandler = null;
            }

            // Remove event listeners
            if (this.viewer.camera) {
                this.viewer.camera.changed.removeEventListener(this.updateOnCameraChangedHandler);
                this.viewer.camera.moveStart.removeEventListener(this.cameraMoveStartHandler);
                this.viewer.camera.moveEnd.removeEventListener(this.cameraMoveEndHandler);
            }

            // Clean up collections and entities references
            this.markerCollection = null;
            this.featureSearchVisualization = null;
            this.tileOutlineEntity = null;
            this.openStreetMapLayer = null;
            if (this.featureSearchService.visualization && !this.featureSearchService.visualization.isDestroyed()) {
                this.featureSearchService.visualization.destroy();
            }
            // CRITICAL: Clean up all tiles and visualizations bound to the old viewer
            // This ensures they can be recreated for the new viewer
            if (this.isAvailable()) {
                this.mapService.clearAllTileVisualizations(this.viewer);
            }
            this.mapService.clearAllLoadedTiles();

            // Check if still not destroyed before calling destroy
            if (!this.viewer.isDestroyed()) {
                this.viewer.destroy();
            }

            // Clear viewer reference regardless
            this.viewer = null as any;
        } catch (error) {
            console.error('Error during viewer destruction:', error);
            // Clear references even on error
            this.viewer = null as any;
            this.mouseHandler = null;
            this.openStreetMapLayer = null;
            this.markerCollection = null;
            this.featureSearchVisualization = null;
            this.tileOutlineEntity = null;

            this.isDestroyingViewer = false;
        }
        console.debug('MapViewComponent: cleaning up resources');

        // Clear all references
        this.mouseHandler = null;
        this.openStreetMapLayer = null;
        this.markerCollection = null;
        this.tileOutlineEntity = null;

        this.isDestroyingViewer = false;
    }

    private baseCameraMoveM = 100.0;
    private baseCameraZoomM = 100.0;
    private scalingFactor = 1;

    get cameraMoveUnits() {
        return this.baseCameraMoveM * this.scalingFactor / 75000;
    }

    get cameraZoomUnits() {
        return this.baseCameraZoomM * this.scalingFactor;
    }

    private updateScalingFactor(altitude: number): void {
        if (!Number.isFinite(altitude) || altitude <= 0) {
            this.scalingFactor = 1;
            return;
        }
        this.scalingFactor = Math.pow(altitude / 1000, 1.1) / 2;
    }

    moveUp() {
        throw new Error("Not Implemented!");
    }

    moveDown() {
        throw new Error("Not Implemented!");
    }

    moveLeft() {
        throw new Error("Not Implemented!");
    }

    moveRight() {
        throw new Error("Not Implemented!");
    }

    zoomIn() {
        throw new Error("Not Implemented!");
    }

    zoomOut() {
        throw new Error("Not Implemented!");
    }

    resetOrientation() {
        try {
            // Check if the viewer is destroyed
            if (!this.isAvailable()) {
                console.debug('Cannot reset orientation: viewer  not available or is destroyed');
                return;
            }

            this.stateService.setView(this._viewIndex, this.viewer.camera.positionCartographic, {
                heading: 0.0,
                pitch: CesiumMath.toRadians(CAMERA_CONSTANTS.DEFAULT_PITCH_DEGREES),
                roll: 0.0
            });
        } catch (error) {
            console.error('Error resetting orientation:', error);
        }
    }

    protected moveCameraOnSurface(longitudeOffset: number, latitudeOffset: number) {
        try {
            // Check if the viewer is destroyed
            if (!this.isAvailable()) {
                console.debug('Cannot move camera: viewer  not available or is destroyed');
                return;
            }

            // Get the current camera position in Cartographic coordinates (longitude, latitude, height)
            const cameraPosition = this.viewer.camera.positionCartographic;
            const lon = cameraPosition.longitude + CesiumMath.toRadians(longitudeOffset);
            const lat = cameraPosition.latitude + CesiumMath.toRadians(latitudeOffset);
            const alt = cameraPosition.height;
            const newPosition = new Cartographic(lon, lat, alt);
            this.performSurfaceMovement(newPosition);
        } catch (error) {
            console.error('Error moving camera:', error);
        }
    }

    protected performSurfaceMovement(newPosition: Cartographic) {
        throw new Error("Not Implemented!");
    }

    protected updateOnCameraChange() {
        throw new Error("Not Implemented!");
    }

    cameraMoveStartHandler = () => {
        this.cameraIsMoving = true;
    };

    cameraMoveEndHandler = () => {
        this.cameraIsMoving = false;
    };

    /**
     * Restore camera state from saved state
     */
    protected updateOnAppStateChange(cameraData: CameraViewState) {
        throw new Error('Not Implemented');
    }

    /**
     * Update the visible viewport, and communicate it to the model.
     */
    protected updateViewport() {
        try {
            // Check if the viewer is destroyed
            if (!this.isAvailable()) {
                console.debug('Cannot update viewport: viewer is destroyed or unavailable');
                return;
            }

            let canvas = this.viewer.scene.canvas;
            if (!canvas) {
                console.debug('Cannot update viewport: canvas not available');
                return;
            }

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

            const rectangle = this.computeViewRectangle();
            if (!rectangle) {
                return;
            }

            let west = CesiumMath.toDegrees(rectangle.west);
            let south = CesiumMath.toDegrees(rectangle.south);
            let east = CesiumMath.toDegrees(rectangle.east);
            let north = CesiumMath.toDegrees(rectangle.north);
            let sizeLon = Math.abs(east - west);
            let sizeLat = Math.abs(north - south);

            // Check for suspicious viewport dimensions
            if (Math.abs(sizeLon) > 360 || Math.abs(sizeLat) > 180) {
                console.error('Suspicious viewport dimensions:', {sizeLon, sizeLat});
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

            this.mapService.setViewport(this._viewIndex, viewportData);
        } catch (error) {
            console.error('Error updating viewport:', error);
            console.error('Error stack:', (error as Error)?.stack || 'No stack trace available');
        }
    }

    updateOnCameraChangedHandler = () => {
        try {
            const position = this.viewer.camera.positionCartographic;
            this.ignoreNextCamAppStateUpdate = true;
            this.updateScalingFactor(position.height);
            this.updateOnCameraChange();
            this.updateViewport();
        } catch (error) {
            console.error('Error on camera change update:', error);
        }
    }

    isAvailable() {
        return !!this.viewer && !!this.viewer.scene && typeof this.viewer.isDestroyed === 'function' && !this.viewer.isDestroyed();
    }

    private getOpenStreetMapLayerProvider() {
        return new UrlTemplateImageryProvider({
            url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            maximumLevel: 19,
        });
    }

    getSceneMode(): SceneMode {
        return this.sceneMode;
    }

    ///////////////////// Marker logic /////////////////////

    clearMarkers() {
        if (this.markerCollection) {
            try {
                this.markerCollection.removeAll();
                if (this.viewer && this.viewer.scene) {
                    this.viewer.scene.requestRender();
                }
            } catch (e) {
                console.error('Error clearing markers:', e);
            }
        }
    }

    addMarker(cartesian: Cartesian3) {
        // Ensure collection and viewer exist
        if (!this.markerCollection || !this.isAvailable()) {
            console.debug('Cannot add marker: MarkerCollection or viewer not initialized or is destroyed');
            return false;
        }

        // Clear any existing markers in the collection
        try {
            this.markerCollection.removeAll();
        } catch (e) {
            console.error('Error clearing markers:', e);
            return false;
        }

        // Add marker using the same approach as search results
        try {
            const params: MarkerParams = {
                position: cartesian,
                image: this.featureSearchService.markerGraphics(),
                width: 32,
                height: 32
            };
            if (this.sceneMode.valueOf() === SceneMode.SCENE2D) {
                params.disableDepthTestDistance = Number.POSITIVE_INFINITY;
            } else {
                params.pixelOffset = new Cartesian2(0, -10);
                params.eyeOffset = new Cartesian3(0, 0, -50);
                params.heightReference = HeightReference.CLAMP_TO_GROUND;
            }

            this.markerCollection.add(params);

            // Ensure the marker collection is properly added to the scene
            if (this.isAvailable() && this.viewer.scene.primitives) {
                if (!this.viewer.scene.primitives.contains(this.markerCollection)) {
                    this.viewer.scene.primitives.add(this.markerCollection);
                }
                this.viewer.scene.primitives.raiseToTop(this.markerCollection);
                this.viewer.scene.requestRender();
            }
            return true;
        } catch (e) {
            console.error('Error adding marker:', e);
            return false;
        }
    }

    renderFeatureSearchResultTree(level: number) {
        try {
            if (!this.featureSearchVisualization || !this.isAvailable()) {
                console.debug('Cannot render feature search results: FeatureSearchVisualization or viewer not initialized or is destroyed');
                return;
            }

            this.featureSearchVisualization.removeAll();
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
                    const params: MarkerParams = {
                        position: node.center,
                        image: this.featureSearchService.getPinGraphics(node.count),
                        width: 64,
                        height: 64
                    };
                    if (this.sceneMode.valueOf() === SceneMode.SCENE2D) {
                        params.disableDepthTestDistance = Number.POSITIVE_INFINITY;
                    } else {
                        params.eyeOffset = new Cartesian3(0, 0, -50);
                    }
                    this.featureSearchVisualization.add(params);
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

                    const params: MarkerParams = {
                        id: marker[0],
                        position: markerPosition,
                        image: this.featureSearchService.markerGraphics(),
                        width: 32,
                        height: 32,
                        color: color
                    };
                    if (this.sceneMode.valueOf() === SceneMode.SCENE2D) {
                        params.disableDepthTestDistance = Number.POSITIVE_INFINITY;
                    } else {
                        params.pixelOffset = new Cartesian2(0, -10);
                        params.eyeOffset = new Cartesian3(0, 0, -50);
                    }
                    if (this.featureSearchVisualization) {
                        this.featureSearchVisualization.add(params);
                    }
                });
            }

            if (this.isAvailable() && this.viewer.scene.primitives) {
                this.viewer.scene.primitives.raiseToTop(this.featureSearchVisualization);
            }
        } catch (error) {
            console.error('Error rendering feature search result tree:', error);
        }
    }

    protected computeViewRectangle(): Rectangle | undefined {
        throw Error("Not implemented");
    }
}
