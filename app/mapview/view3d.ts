import {Cartesian2, Cartesian3, Cartographic, CesiumMath, SceneMode} from "../integrations/cesium";
import {CAMERA_CONSTANTS, MapView} from "./view";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, CameraViewState} from "../shared/appstate.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {JumpTargetService} from "../search/jump.service";
import {InspectionService} from "../inspection/inspection.service";
import {RightClickMenuService} from "./rightclickmenu.service";
import {CoordinatesService} from "../coords/coordinates.service";

export class MapView3D extends MapView {

    constructor(id: number,
                canvasId: string,
                sceneMode: SceneMode,
                mapService: MapDataService,
                featureSearchService: FeatureSearchService,
                jumpService: JumpTargetService,
                inspectionService: InspectionService,
                menuService: RightClickMenuService,
                coordinatesService: CoordinatesService,
                stateService: AppStateService) {
        super(id, canvasId, sceneMode, mapService, featureSearchService, jumpService,
            inspectionService, menuService, coordinatesService, stateService);

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

    protected override convertCameraState(viewRectangle: [number, number, number, number] | null, cameraData: CameraViewState) {
        if (!this.isAvailable()) {
            console.debug('Cannot restore camera state: missing viewer');
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

            this.mapService.setViewport(this.viewIndex, viewportData);

        } catch (error) {
            console.error('Error updating viewport:', error);
            console.error('Error stack:', (error as Error)?.stack || 'No stack trace available');
        }
    }
}