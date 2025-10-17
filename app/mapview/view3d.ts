import {Cartesian3, Cartographic, CesiumMath, SceneMode, Rectangle, Entity, Color} from "../integrations/cesium";
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
                mapService: MapDataService,
                featureSearchService: FeatureSearchService,
                jumpService: JumpTargetService,
                inspectionService: InspectionService,
                menuService: RightClickMenuService,
                coordinatesService: CoordinatesService,
                stateService: AppStateService) {
        super(id, canvasId, SceneMode.SCENE3D, mapService, featureSearchService, jumpService,
            inspectionService, menuService, coordinatesService, stateService);
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

    // TODO: Make sure that we transform the offest according to the heading of the camera
    override moveUp() {
        super.moveUp();
        this.moveCameraOnSurface(0, this.cameraMoveUnits);
    }

    override moveDown() {
        super.moveDown();
        this.moveCameraOnSurface(0, -this.cameraMoveUnits);
    }

    override moveLeft() {
        super.moveLeft();
        this.moveCameraOnSurface(-this.cameraMoveUnits, 0);
    }

    override moveRight() {
        super.moveRight();
        this.moveCameraOnSurface(this.cameraMoveUnits, 0);
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

    protected override performSurfaceMovement(newPosition: Cartographic) {
        this.stateService.setView(this._viewIndex, newPosition, this.stateService.getCameraOrientation(this._viewIndex));
    }

    protected override computeViewRectangle(): Rectangle | undefined {
        return this.viewer.camera.computeViewRectangle(
            this.viewer.scene.globe.ellipsoid
        );
    }
}