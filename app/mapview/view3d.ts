import {Cartesian2, Cartesian3, Cartographic, CesiumMath, Rectangle, SceneMode} from "../integrations/cesium";
import {CAMERA_CONSTANTS, MapView} from "./view";
import {MapService} from "../mapdata/map.service";
import {AppStateService} from "../shared/appstate.service";
import {combineLatest, distinctUntilChanged} from "rxjs";
import {FeatureSearchService} from "../search/feature.search.service";
import {JumpTargetService} from "../search/jump.service";
import {InspectionService} from "../inspection/inspection.service";
import {RightClickMenuService} from "./rightclickmenu.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {MarkerService} from "../coords/marker.service";

export class MapView3D extends MapView {

    constructor(id: number,
                canvasId: string,
                sceneMode: SceneMode,
                mapService: MapService,
                featureSearchService: FeatureSearchService,
                jumpService: JumpTargetService,
                inspectionService: InspectionService,
                menuService: RightClickMenuService,
                coordinatesService: CoordinatesService,
                markerService: MarkerService,
                stateService: AppStateService) {
        super(id, canvasId, sceneMode, mapService, featureSearchService, jumpService,
            inspectionService, menuService, coordinatesService, markerService, stateService);

        this.viewer.scene.mode = SceneMode.SCENE3D;
        this.setupModeConstraints();
    }

    setupModeConstraints() {
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

    protected override restoreCameraState() {
        // TODO: Query the AppStateService camera data by viewId
        if (!this.isAvailable()) {
            console.debug('Cannot restore camera state: missing viewer');
            return;
        }

        try {
            const cameraState = viewerState.cameraState;

            // For 3D mode, restore full camera state with altitude compensation if needed
            let restoredHeight = cameraState.height;

            // Apply exact inverse compensation when switching from 2D to 3D
            if (cameraState.savedFromMode === '2D') {
                const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius;
                restoredHeight = this.map2DHeightTo3DHeight(cameraState.height, cameraState.latitude, earthRadius);
                console.debug('Applied exact 2D→3D altitude mapping:', {
                    originalHeight: cameraState.height,
                    compensatedHeight: restoredHeight,
                    latitude: CesiumMath.toDegrees(cameraState.latitude)
                });
            } else if (!cameraState.savedFromMode) {
                // Backward compatibility: keep legacy behavior to avoid surprises in old persisted states
                const distortionFactor = this.calculateMercatorDistortionFactor(cameraState.latitude);
                if (distortionFactor > 1.5) {
                    restoredHeight = cameraState.height / Math.sqrt(distortionFactor);
                    console.debug('Applied backward-compatible altitude compensation:', {
                        originalHeight: cameraState.height,
                        compensatedHeight: restoredHeight,
                        partialDistortionFactor: Math.sqrt(distortionFactor),
                        latitude: CesiumMath.toDegrees(cameraState.latitude)
                    });
                }
            }

            this.stateService.setView(
                this.viewIndex,
                new Cartographic(cameraState.longitude, cameraState.latitude, restoredHeight),
                {
                    heading: cameraState.heading,
                    pitch: cameraState.pitch,
                    roll: cameraState.roll
                });
        } catch (error) {
            console.error('Error restoring camera state:', error);
        }
    }

    override moveUp() {
        this.moveCameraOnSurface(0, this.stateService.cameraMoveUnits);
    }

    override moveDown() {
        this.moveCameraOnSurface(0, -this.stateService.cameraMoveUnits);
    }

    override moveLeft() {
        this.moveCameraOnSurface(-this.stateService.cameraMoveUnits, 0);
    }

    override moveRight() {
        this.moveCameraOnSurface(this.stateService.cameraMoveUnits, 0);
    }

    override zoomIn() {
        try {
            if (!this.isAvailable()) {
                console.debug('Cannot zoom in: viewer not available or is destroyed');
                return;
            }

            this.viewer.camera.zoomIn(this.stateService.cameraZoomUnits);
        } catch (error) {
            console.error('Error zooming in:', error);
        }
    }

    override zoomOut() {
        try {
            if (!this.isAvailable()) {
                console.debug('Cannot zoom out: viewer not available or is destroyed');
                return;
            }

            this.viewer.camera.zoomOut(this.stateService.cameraZoomUnits);
        } catch (error) {
            console.error('Error zooming out:', error);
        }
    }

    protected override setupParameterSubscriptions() {
        super.setupParameterSubscriptions();

        this.subscriptions.push(
            this.stateService.cameraViewData
                .pipe(this.viewIndex, distinctUntilChanged())
                .subscribe(cameraData => {
                    if (!this.viewer) {
                        return;
                    }
                    this.viewer.camera.setView({
                        destination: Cartesian3.fromDegrees(
                            cameraData.destination.lon,
                            cameraData.destination.lat,
                            cameraData.destination.alt
                        ),
                        orientation: cameraData.orientation
                    });
                    this.updateViewport();
                })
        );
    }

    protected override performConversionForMovePosition(pos: { x: number, y: number, z?: number }):
        [Cartographic, { heading: number, pitch: number, roll: number}?] {
        return [Cartographic.fromDegrees(
            pos.x,
            pos.y,
            pos.z !== undefined ? pos.z : Cartographic.fromCartesian(
                this.viewer.camera.position
            ).height),
            {
                heading: 0.0, // East, in radians.
                pitch: CesiumMath.toRadians(CAMERA_CONSTANTS.DEFAULT_PITCH_DEGREES), // Directly looking down.
                roll: 0 // No rotation.
            }
        ];
    }

    protected override updateOnCameraChange() {
        if (!this.isAvailable()) {
            console.debug('cameraChangedHandler: viewer is destroyed or unavailable');
            return;
        }

        this.stateService.setView(
            this.viewIndex, Cartographic.fromCartesian(this.viewer.camera.position), this.viewer.camera
        );
    };

    protected override performSurfaceMovement(newPosition: Cartographic) {
        this.stateService.setView(this.viewIndex, newPosition, this.stateService.getCameraOrientation(this.viewIndex));
    }

    /**
     * Map a 2D WebMercator height to an equivalent 3D height
     * by preserving the visual angular field (exact, drift-free).
     */
    private map2DHeightTo3DHeight(height2D: number, latitudeRadians: number, earthRadius: number): number {
        const distortion = this.calculateMercatorDistortionFactor(latitudeRadians); // sec(phi)
        const halfAngle = Math.atan(height2D / (2 * earthRadius));
        const height3D = (2 * earthRadius) * Math.tan(halfAngle / distortion);
        // Enforce a reasonable minimum altitude for stability
        return Math.max(CAMERA_CONSTANTS.MIN_ALTITUDE_METERS, height3D);
    }

    override updateViewport() {
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

            // First try: Pass ellipsoid explicitly (workaround for Cesium issue)
            let rectangle = this.viewer.camera.computeViewRectangle(
                this.viewer.scene.globe.ellipsoid
            );

            if (!rectangle) {
                return;
            }

            let west = CesiumMath.toDegrees(rectangle.west);
            let south = CesiumMath.toDegrees(rectangle.south);
            let east = CesiumMath.toDegrees(rectangle.east);
            let north = CesiumMath.toDegrees(rectangle.north);
            let sizeLon = east - west;
            let sizeLat = north - south;

            // Check for suspicious viewport dimensions
            if (Math.abs(sizeLon) > 360 || Math.abs(sizeLat) > 180) {
                console.error('Suspicious viewport dimensions:', {sizeLon, sizeLat});
            }

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
                console.error('Invalid viewport dimensions:', {sizeLon, sizeLat});
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

            this.mapService.setViewport(viewportData);

        } catch (error) {
            console.error('Error updating viewport:', error);
            console.error('Error stack:', (error as Error)?.stack || 'No stack trace available');
        }
    }
}