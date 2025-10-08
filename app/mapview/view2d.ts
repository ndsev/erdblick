import {Cartesian2, Cartographic, CesiumMath, Ellipsoid, PerspectiveFrustum, Rectangle, SceneMode} from "../integrations/cesium";
import {CAMERA_CONSTANTS, MapView} from "./view";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, CameraViewState} from "../shared/appstate.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {JumpTargetService} from "../search/jump.service";
import {InspectionService} from "../inspection/inspection.service";
import {RightClickMenuService} from "./rightclickmenu.service";
import {CoordinatesService} from "../coords/coordinates.service";

export class MapView2D extends MapView {

    constructor(id: number,
                canvasId: string,
                mapService: MapDataService,
                featureSearchService: FeatureSearchService,
                jumpService: JumpTargetService,
                inspectionService: InspectionService,
                menuService: RightClickMenuService,
                coordinatesService: CoordinatesService,
                stateService: AppStateService) {
        super(id, canvasId, SceneMode.SCENE2D, mapService, featureSearchService, jumpService,
            inspectionService, menuService, coordinatesService, stateService);
    }

    protected override setupScreenSpaceConstraints() {
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

    protected override convertCameraState(viewRectangle: [number, number, number, number] | null, cameraData: CameraViewState) {
        if (!this.isAvailable()) {
            console.debug('Cannot restore camera state: missing viewer');
            return;
        }

        try {
            // For 2D mode, use view rectangle if available
            if (viewRectangle) {
                this.viewer.camera.setView({destination: Rectangle.fromDegrees(...viewRectangle)});
            } else {
                // Apply exact forward conversion when switching from 3D to 2D
                const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius;
                const restoredHeight = this.map3DHeightTo2DHeight(
                    cameraData.destination.alt,
                    cameraData.destination.lat,
                    earthRadius);

                // Calculate appropriate rectangle size based on compensated altitude
                const visualScale = this.heightToVisualScale(restoredHeight, cameraData.destination.lat, earthRadius);
                const halfSizeDegrees = visualScale / 2;
                const halfSizeRad = CesiumMath.toRadians(halfSizeDegrees);

                this.viewer.camera.setView({
                    destination: Rectangle.fromRadians(
                        cameraData.destination.lon - halfSizeRad,
                        cameraData.destination.lat - halfSizeRad,
                        cameraData.destination.lon + halfSizeRad,
                        cameraData.destination.lat + halfSizeRad
                    )
                });
            }
        } catch (error) {
            console.error('Error restoring camera state:', error);
        }
    }

    protected override setupHandlers() {
        super.setupHandlers();
        this.setupWheelHandler();
    }

    /**
     * Setup custom wheel handler for 2D mode
     */
    private setupWheelHandler() {
        this.viewer.scene.canvas.addEventListener('wheel', (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();

            const zoomFactor = event.deltaY > 0 ? 1.1 : 0.9;

            this.zoom2D(zoomFactor);
        });
    }

    override moveUp() {
        const distance = this.get2DMovementDistance();
        this.moveCameraOnSurface(0, distance.latitudeOffset);
    }

    override moveDown() {
        const distance = this.get2DMovementDistance();
        this.moveCameraOnSurface(0, -distance.latitudeOffset);
    }

    override moveLeft() {
        const distance = this.get2DMovementDistance();
        this.moveCameraOnSurface(-distance.longitudeOffset, 0);
    }

    override moveRight() {
        const distance = this.get2DMovementDistance();
        this.moveCameraOnSurface(distance.longitudeOffset, 0);
    }

    override zoomIn() {
        try {
            if (!this.isAvailable()) {
                console.debug('Cannot zoom in: viewer not available or is destroyed');
                return;
            }

            this.zoom2D(CAMERA_CONSTANTS.ZOOM_IN_FACTOR_2D);
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

            this.zoom2D(CAMERA_CONSTANTS.ZOOM_OUT_FACTOR_2D);
        } catch (error) {
            console.error('Error zooming out:', error);
        }
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

    /**
     * Map a 3D camera height to an equivalent 2D WebMercator height
     * by preserving the visual angular field (exact, drift-free).
     */
    private map3DHeightTo2DHeight(height3D: number, latitudeRadians: number, earthRadius: number): number {
        const distortion = this.calculateMercatorDistortionFactor(latitudeRadians); // sec(phi)
        const halfAngle = Math.atan(height3D / (2 * earthRadius));
        const height2D = (2 * earthRadius) * Math.tan(distortion * halfAngle);
        // Enforce a reasonable minimum altitude for stability
        return Math.max(CAMERA_CONSTANTS.MIN_ALTITUDE_METERS, height2D);
    }

    protected override updateOnCameraChange() {
        if (!this.isAvailable()) {
            console.debug('cameraChangedHandler: viewer is destroyed or unavailable');
            return;
        }

        const camera = this.viewer.camera;
        const viewRect = camera.computeViewRectangle();
        const position = Cartographic.fromCartesian(camera.position);
        const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius;
        const restoredHeight = this.map2DHeightTo3DHeight(position.height, position.latitude, earthRadius);

        if (viewRect) {
            this.stateService.viewRectangleState.next(this.viewIndex, [
                CesiumMath.toDegrees(viewRect.west),
                CesiumMath.toDegrees(viewRect.south),
                CesiumMath.toDegrees(viewRect.east),
                CesiumMath.toDegrees(viewRect.north)
            ]);
            const center = Cartographic.fromRadians(
                (viewRect.west + viewRect.east) / 2,
                (viewRect.north + viewRect.south) / 2,
                position.height
            );
            this.stateService.setView(this.viewIndex, center, camera);
        }
        this.stateService.setView(this.viewIndex, new Cartographic(position.longitude, position.latitude, restoredHeight), camera);
    };

    protected override performConversionForMovePosition(pos: { x: number, y: number, z?: number }):
        [Cartographic, { heading: number, pitch: number, roll: number}?] {
        // In 2D mode, create a Rectangle centered on the target position
        // Use current view rectangle to preserve the exact zoom level
        const canvas = this.viewer.scene.canvas;
        let currentRect = this.viewer.camera.computeViewRectangle(
            this.viewer.scene.globe.ellipsoid
        );

        // If computeViewRectangle fails, use robust calculation
        if (!currentRect) {
            currentRect = this.computeRobustViewRectangle(canvas);
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

    protected override performSurfaceMovement(newPosition: Cartographic) {
        // In 2D mode, use setView without orientation to maintain the 2D constraints
        this.stateService.setView(this.viewIndex, newPosition);
    }

    /**
     * 2D zoom using height-based approach with WebMercator distortion compensation
     */
    private zoom2D(zoomFactor: number): void {
        try {
            // Check if the viewer is destroyed
            if (!this.isAvailable()) {
                console.debug('Cannot zoom in 2D: viewer is missing or destroyed');
                return;
            }

            const camera = this.viewer.camera;
            const currentPos = camera.positionCartographic;
            const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius;

            // Get current camera height and calculate desired new height
            const currentHeight = currentPos.height;
            const desiredHeight = currentHeight * zoomFactor;

            // Apply altitude limits using centralized constants
            const minHeight = CAMERA_CONSTANTS.MIN_ALTITUDE_METERS;
            const maxVisualScale = CAMERA_CONSTANTS.MAX_VIEW_RECTANGLE_DEGREES;
            const maxHeight = this.visualScaleToHeight(maxVisualScale, currentPos.latitude, earthRadius);

            let clampedHeight = Math.max(minHeight, Math.min(maxHeight, desiredHeight));
            let wasClampedToLimit = (clampedHeight !== desiredHeight);

            if (wasClampedToLimit) {
                console.debug('Zoom clamped to altitude limits:', {
                    desired: desiredHeight,
                    clamped: clampedHeight,
                    min: minHeight,
                    max: maxHeight
                });
            }

            // Set new camera height while preserving position
            this.stateService.setView(this.viewIndex, new Cartographic(currentPos.longitude, currentPos.latitude, clampedHeight));
        } catch (error) {
            console.error('Error in 2D zoom:', error);
        }
    }

    /**
     * Get movement distance for 2D mode based on current viewport
     */
    private get2DMovementDistance(): { longitudeOffset: number, latitudeOffset: number } {
        const currentView = this.viewer.camera.computeViewRectangle();
        if (!currentView) {
            // Fallback to default movement if view can't be computed
            return {
                longitudeOffset: this.stateService.cameraMoveUnits,
                latitudeOffset: this.stateService.cameraMoveUnits
            };
        }

        const currentWidth = currentView.east - currentView.west;
        const currentHeight = currentView.north - currentView.south;

        // Calculate movement distances using centralized constant
        const longitudeOffset = CesiumMath.toDegrees(currentWidth * CAMERA_CONSTANTS.MOVEMENT_PERCENTAGE_2D);
        const latitudeOffset = CesiumMath.toDegrees(currentHeight * CAMERA_CONSTANTS.MOVEMENT_PERCENTAGE_2D);

        // Clamp movements to reasonable values using centralized constants
        return {
            longitudeOffset: Math.max(
                CAMERA_CONSTANTS.MIN_LONGITUDE_MOVEMENT,
                Math.min(CAMERA_CONSTANTS.MAX_LONGITUDE_MOVEMENT, longitudeOffset)
            ),
            latitudeOffset: Math.max(
                CAMERA_CONSTANTS.MIN_LATITUDE_MOVEMENT,
                Math.min(CAMERA_CONSTANTS.MAX_LATITUDE_MOVEMENT, latitudeOffset)
            )
        };
    }

    /**
     * Compute viewport rectangle using robust sampling along edges
     * Workaround for Cesium's computeViewRectangle failing in 2D WebMercator
     */
    computeRobustViewRectangle(canvas: HTMLCanvasElement): Rectangle | undefined {
        try {
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

            if (validCoordinates.length < 3) {
                return undefined;
            }

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

            return Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat);

        } catch (error) {
            console.error('Error in robust rectangle calculation:', error);
            return undefined;
        }
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
                // Workaround: Robust rectangle calculation with multiple sample points
                rectangle = this.computeRobustViewRectangle(canvas);
            }

            if (!rectangle) {
                // Final fallback: Calculate viewport from camera position and height
                const cameraCartographic = this.viewer.camera.positionCartographic;
                const cameraLon = CesiumMath.toDegrees(cameraCartographic.longitude);
                const cameraLat = CesiumMath.toDegrees(cameraCartographic.latitude);
                const cameraHeight = cameraCartographic.height;

                // Calculate viewport size based on camera height with distortion compensation
                const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius;
                const visualScale = this.heightToVisualScale(
                    cameraHeight,
                    cameraCartographic.latitude,
                    earthRadius
                );

                // Create a reasonable viewport around camera position
                const halfWidth = visualScale / 2;
                const halfHeight = visualScale * (canvas.clientHeight / canvas.clientWidth) / 2;

                rectangle = Rectangle.fromDegrees(
                    cameraLon - halfWidth,
                    cameraLat - halfHeight,
                    cameraLon + halfWidth,
                    cameraLat + halfHeight
                );
            }

            // Clamp to valid WebMercator range using camera service constants
            const maxLatRad = this.getWebMercatorMaxLatitudeRad();
            rectangle = new Rectangle(
                rectangle.west,
                Math.max(rectangle.south, -maxLatRad),
                rectangle.east,
                Math.min(rectangle.north, maxLatRad)
            );

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

            // For WebMercator 2D mode, use visual scale for proper zoom level calculation
            // Calculate dimensions that represent the visual scale for accurate zoom level detection
            // In WebMercator at high latitudes, geographic bounds are larger than the visual area
            const cameraHeight = this.viewer.camera.positionCartographic.height;
            const earthRadius = this.viewer.scene.globe.ellipsoid.maximumRadius;

            // Validate camera height is reasonable
            if (!isFinite(cameraHeight) || cameraHeight <= 0) {
                console.error('Invalid camera height:', cameraHeight);
                return;
            }

            // Get camera position for distortion compensation
            const cameraCartographic = this.viewer.camera.positionCartographic;

            // Use camera service's distortion-compensated visual scale calculation
            const visualScale = this.heightToVisualScale(
                cameraHeight,
                cameraCartographic.latitude,
                earthRadius
            );

            // Validate visual scale is reasonable
            if (!isFinite(visualScale) || visualScale <= 0) {
                console.error('Invalid visual scale:', visualScale);
                return;
            }

            // Use visual scale for dimensions to ensure correct zoom level calculation
            sizeLon = visualScale;
            sizeLat = visualScale * (canvas.clientHeight / canvas.clientWidth);

            // Apply reasonable bounds using camera service constants
            const bounds = this.getSizeBounds();
            sizeLon = Math.max(bounds.minLon, Math.min(bounds.maxLon, sizeLon));
            sizeLat = Math.max(bounds.minLat, Math.min(bounds.maxLat, sizeLat));

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