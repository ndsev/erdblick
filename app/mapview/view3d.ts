import {Cartesian3, Cartographic, CesiumMath, Rectangle, SceneMode} from "../integrations/cesium";
import {CAMERA_CONSTANTS, MapView} from "./view";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, CameraViewState} from "../shared/appstate.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {JumpTargetService} from "../search/jump.service";
import {RightClickMenuService} from "./rightclickmenu.service";
import {CoordinatesService} from "../coords/coordinates.service";

export class MapView3D extends MapView {

    constructor(id: number,
                canvasId: string,
                mapService: MapDataService,
                featureSearchService: FeatureSearchService,
                jumpService: JumpTargetService,
                menuService: RightClickMenuService,
                coordinatesService: CoordinatesService,
                stateService: AppStateService) {
        super(id, canvasId, SceneMode.SCENE3D, mapService, featureSearchService,
              jumpService, menuService, coordinatesService, stateService);
    }

    protected override setupScreenSpaceConstraints() {
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

    protected override updateOnAppStateChange(cameraData: CameraViewState) {
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
            this._viewIndex, Cartographic.fromCartesian(this.viewer.camera.position), this.viewer.camera
        );
    };

    protected override computeViewRectangle(): Rectangle | undefined {
        return this.viewer.camera.computeViewRectangle(
            this.viewer.scene.globe.ellipsoid
        );
    }

    protected override moveCameraOnSurface(longitudeOffset: number, latitudeOffset: number) {
        try {
            // Check if the viewer is destroyed
            if (!this.isAvailable()) {
                console.debug('Cannot move camera: viewer not available or is destroyed');
                return;
            }

            // Get the current camera position in Cartographic coordinates (longitude, latitude, height)
            const cameraPosition = this.viewer.camera.positionCartographic;
            this.stateService.setView(this._viewIndex, new Cartographic(
                cameraPosition.longitude + CesiumMath.toRadians(longitudeOffset),
                cameraPosition.latitude + CesiumMath.toRadians(latitudeOffset),
                cameraPosition.height), this.stateService.getCameraOrientation(this._viewIndex));
        } catch (error) {
            console.error('Error moving camera:', error);
        }
    }
}