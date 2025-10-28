import {
    Camera,
    Cartesian2,
    Cartesian3,
    Cartographic,
    CesiumMath,
    Ellipsoid,
    PerspectiveFrustum,
    Rectangle,
    SceneMode
} from "../integrations/cesium";
import {CAMERA_CONSTANTS, MapView} from "./view";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, CameraViewState} from "../shared/appstate.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {JumpTargetService} from "../search/jump.service";
import {RightClickMenuService} from "./rightclickmenu.service";
import {CoordinatesService} from "../coords/coordinates.service";

export class MapView2D extends MapView {

    constructor(id: number,
                canvasId: string,
                mapService: MapDataService,
                featureSearchService: FeatureSearchService,
                jumpService: JumpTargetService,
                menuService: RightClickMenuService,
                coordinatesService: CoordinatesService,
                stateService: AppStateService) {
        super(id, canvasId, SceneMode.SCENE2D, mapService, featureSearchService,
              jumpService, menuService, coordinatesService, stateService);
    }

    protected override setupScreenSpaceConstraints() {
        // Enable 2D map interactions
        const scene = this.viewer.scene;

        // Disable camera rotation and tilting in 2D
        scene.screenSpaceCameraController.enableRotate = false;
        scene.screenSpaceCameraController.enableTilt = false;

        // Enable standard 2D interactions
        scene.screenSpaceCameraController.enableTranslate = true;
        scene.screenSpaceCameraController.enableZoom = true;
        scene.screenSpaceCameraController.enableLook = false;
        scene.screenSpaceCameraController.minimumZoomDistance = 10;
        scene.screenSpaceCameraController.maximumZoomDistance = CAMERA_CONSTANTS.MAX_ALTITUDE_METERS * 4; // NOT SURE WHY THIS REQUIRES A MULTIPLICATION FACTOR
    }

    protected override updateOnAppStateChange(cameraData: CameraViewState) {
        if (!this.isAvailable()) {
            console.debug('Cannot restore camera state: missing viewer');
            return;
        }

        const tracking3DCam = new Camera(this.viewer.scene);
        tracking3DCam.setView({
            destination: Cartesian3.fromDegrees(
                cameraData.destination.lon,
                cameraData.destination.lat,
                Math.min(cameraData.destination.alt, CAMERA_CONSTANTS.MAX_ALTITUDE_METERS)),
            orientation: this.viewer.camera
        });
        const rectangle = tracking3DCam.computeViewRectangle();
        if (rectangle) {
            this.viewer.camera.setView({destination: rectangle});
            return;
        }
    }

    protected override moveCameraOnSurface(longitudeOffset: number, latitudeOffset: number) {
        try {
            // Check if the viewer is destroyed
            if (!this.isAvailable()) {
                console.debug('Cannot move camera: viewer  not available or is destroyed');
                return;
            }

            const viewRect = this.computeViewRectangle();
            if (!viewRect) {
                return;
            }
            
            const tracking3DCam = new Camera(this.viewer.scene);
            tracking3DCam.setView({destination: viewRect, orientation: this.viewer.camera});
            const cameraPosition = tracking3DCam.positionCartographic;
            this.stateService.setView(this._viewIndex, new Cartographic(
                cameraPosition.longitude + CesiumMath.toRadians(longitudeOffset),
                cameraPosition.latitude + CesiumMath.toRadians(latitudeOffset),
                cameraPosition.height));
        } catch (error) {
            console.error('Error moving camera:', error);
        }
    }

    protected override setupHandlers() {
        super.setupHandlers();
    }

    protected override updateOnCameraChange() {
        if (!this.isAvailable()) {
            console.debug('cameraChangedHandler: viewer is destroyed or unavailable');
            return;
        }

        const camera = this.viewer.camera;
        const viewRect = this.computeViewRectangle();
        if (!viewRect) {
            return;
        }

        const tracking3DCam = new Camera(this.viewer.scene);
        tracking3DCam.setView({destination: viewRect, orientation: camera});
        this.stateService.setView(this._viewIndex, Cartographic.fromCartesian(tracking3DCam.position));
    };

    protected override performConversionForMovePosition(pos: { x: number, y: number, z?: number }):
        [Cartographic, { heading: number, pitch: number, roll: number}?] {
        // In 2D mode, create a Rectangle centered on the target position
        // Use current view rectangle to preserve the exact zoom level
        let currentRect = this.viewer.camera.computeViewRectangle(
            this.viewer.scene.globe.ellipsoid
        );

        // If computeViewRectangle fails, use robust calculation
        if (!currentRect) {
            currentRect = this.computeViewRectangle();
        }

        if (currentRect) {
            // Calculate the current view size
            const currentWidth = currentRect.east - currentRect.west;
            const currentHeight = currentRect.north - currentRect.south;

            // Center the rectangle on the target position with same dimensions
            const centerLon = CesiumMath.toRadians(pos.x);
            const centerLat = CesiumMath.toRadians(pos.y);
            const reducedWidth = currentWidth / 20
            const reducedHeight = currentHeight / 20;

            const rectangle = new Rectangle(
                centerLon - reducedWidth,
                centerLat - reducedHeight,
                centerLon + reducedWidth,
                centerLat + reducedHeight
            );

            const center = Rectangle.center(rectangle, new Cartographic());

            // Calculate height to match the rectangle
            const width = rectangle.east - rectangle.west;
            const height = rectangle.north - rectangle.south;
            const maxAngularSize = Math.max(width, height);
            // FOV of Cesium camera (vertical, radians)
            const frustum = this.viewer.camera.frustum;
            const fov = frustum instanceof PerspectiveFrustum && frustum.fovy
                ? frustum.fovy
                : CesiumMath.toRadians(60);
            center.height = (maxAngularSize / fov) * Ellipsoid.WGS84.maximumRadius;

            return [center, undefined];
        } else {
            // Fallback: use position-only movement without changing zoom
            const cameraHeight = this.viewer.camera.positionCartographic.height;
            return [Cartographic.fromDegrees(pos.x, pos.y, cameraHeight), undefined];
        }
    }

    protected override computeViewRectangle(): Rectangle | undefined {
        // First try: Pass ellipsoid explicitly (workaround for Cesium issue)
        let rectangle = this.viewer.camera.computeViewRectangle(
            this.viewer.scene.globe.ellipsoid
        );

        const canvas = this.viewer.scene.canvas;

        if (!rectangle) {
            // Workaround: Robust rectangle calculation with multiple sample points
            const samplePoints: Array<{ x: number, y: number }> = [];
            const width = canvas.clientWidth;
            const height = canvas.clientHeight;
            const steps = 10; // Sample every 10th pixel along edges

            // Sample along edges and add interior points
            for (let x = 0; x <= width; x += Math.max(1, Math.floor(width / steps))) {
                samplePoints.push({x, y: 0});      // top edge
                samplePoints.push({x, y: height}); // bottom edge
            }
            for (let y = 0; y <= height; y += Math.max(1, Math.floor(height / steps))) {
                samplePoints.push({x: 0, y});      // left edge
                samplePoints.push({x: width, y});  // right edge
            }

            // Add interior points for better coverage
            samplePoints.push({x: width / 2, y: height / 2});   // center
            samplePoints.push({x: width / 4, y: height / 4});   // quarter points
            samplePoints.push({x: 3 * width / 4, y: height / 4});
            samplePoints.push({x: width / 4, y: 3 * height / 4});
            samplePoints.push({x: 3 * width / 4, y: 3 * height / 4});

            const validCoordinates: Array<{ lon: number, lat: number }> = [];

            // Try to pick ellipsoid intersection for each sample point
            for (const point of samplePoints) {
                const cartesian = this.viewer.camera.pickEllipsoid(
                    new Cartesian2(point.x, point.y),
                    this.viewer.scene.globe.ellipsoid
                );

                if (cartesian) {
                    const cartographic = Cartographic.fromCartesian(cartesian);
                    const lon = CesiumMath.toDegrees(cartographic.longitude);
                    const lat = CesiumMath.toDegrees(cartographic.latitude);

                    // Validate coordinates
                    if (isFinite(lon) && isFinite(lat) &&
                        lon >= -180 && lon <= 180 &&
                        lat >= -90 && lat <= 90) {
                        validCoordinates.push({lon, lat});
                    }
                }
            }

            if (validCoordinates.length >= 2) {
                // Find bounding box of valid coordinates
                const lons = validCoordinates.map(coord => coord.lon);
                const lats = validCoordinates.map(coord => coord.lat);

                let minLon = Math.min(...lons);
                let maxLon = Math.max(...lons);
                let minLat = Math.min(...lats);
                let maxLat = Math.max(...lats);

                // Handle longitude wrapping around ±180°
                if (maxLon - minLon > 180) {
                    // Likely crossing antimeridian, use camera position as reference
                    const cameraPos = this.viewer.camera.positionCartographic;
                    const cameraLon = CesiumMath.toDegrees(cameraPos.longitude);

                    const areLonsCorrect = validCoordinates.every(coord => Math.abs(coord.lon - cameraLon) <= 180);

                    if (!areLonsCorrect) {
                        const reprojectedLons = validCoordinates.map(coord => {
                            let lon = coord.lon;
                            if (lon - cameraLon > 180) {
                                lon -= 360;
                            } else if (cameraLon - lon > 180) {
                                lon += 360;
                            }
                            return lon;
                        });
                        minLon = Math.min(...reprojectedLons);
                        maxLon = Math.max(...reprojectedLons);
                    }
                }

                rectangle = Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat);
            }
        }

        if (!rectangle) {
            console.error('Rectangle not found :(');
            return;
        }

        // Clamp to valid WebMercator range using camera constants
        rectangle = new Rectangle(
            rectangle.west,
            Math.max(rectangle.south, -CAMERA_CONSTANTS.WEBMERCATOR_MAX_LATITUDE_RAD),
            rectangle.east,
            Math.min(rectangle.north, CAMERA_CONSTANTS.WEBMERCATOR_MAX_LATITUDE_RAD)
        );

        return rectangle;
    }
}
