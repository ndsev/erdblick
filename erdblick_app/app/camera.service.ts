import {Injectable} from "@angular/core";
import {Cartesian2, Cartesian3, Cartographic, CesiumMath, Rectangle} from "./cesium";
import {ParametersService} from "./parameters.service";
import {ViewState, ViewStateService} from "./view.state.service";

/**
 * Camera constants object to centralize all numerical values for easier maintenance
 * and to support WebMercator distortion compensation
 */
interface CameraConstants {
    // Earth and projection constants
    readonly WEBMERCATOR_MAX_LATITUDE: number;
    readonly WEBMERCATOR_MAX_LATITUDE_RAD: number;

    // Altitude limits and defaults
    readonly MIN_ALTITUDE_METERS: number;
    readonly MAX_VIEW_RECTANGLE_DEGREES: number;
    readonly DEFAULT_3D_PITCH_DEGREES: number;
    readonly DEFAULT_2D_PITCH_DEGREES: number;

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

@Injectable({providedIn: 'root'})
export class CameraService {
    ignoreNextCameraUpdate: boolean = false;
    cameraIsMoving: boolean = false;

    /**
     * Centralized camera constants for consistent calculations across all methods
     */
    private readonly CAMERA_CONSTANTS: CameraConstants = {
        // Earth and projection constants
        WEBMERCATOR_MAX_LATITUDE: 85.05113, // WebMercatorProjection.MaximumLatitude
        WEBMERCATOR_MAX_LATITUDE_RAD: CesiumMath.toRadians(85.05113),

        // Altitude limits and defaults
        MIN_ALTITUDE_METERS: 100, // Minimum camera altitude for reasonable zoom
        MAX_VIEW_RECTANGLE_DEGREES: 45, // Maximum view rectangle to prevent excessive zoom out
        DEFAULT_3D_PITCH_DEGREES: -45.0, // Default 3D viewing angle
        DEFAULT_2D_PITCH_DEGREES: -90.0, // Top-down view for 2D mode

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

    constructor(private parameterService: ParametersService,
                private viewStateService: ViewStateService) {
    }

    /**
     * Calculate WebMercator distortion factor at a given latitude
     * Based on the avgMercatorStretch calculation from core library
     * @param latitudeRadians Latitude in radians
     * @returns Distortion factor (1.0 at equator, increases towards poles)
     */
    calculateMercatorDistortionFactor(latitudeRadians: number): number {
        // Clamp to valid WebMercator range
        const clampedLat = Math.max(
            -this.CAMERA_CONSTANTS.WEBMERCATOR_MAX_LATITUDE_RAD,
            Math.min(this.CAMERA_CONSTANTS.WEBMERCATOR_MAX_LATITUDE_RAD, latitudeRadians)
        );

        // WebMercator distortion factor: sec(latitude)
        return 1.0 / Math.cos(clampedLat);
    }

    /**
     * Convert camera height to visual scale with WebMercator distortion compensation
     * @param cameraHeight Camera height in meters
     * @param latitudeRadians Latitude in radians for distortion compensation
     * @param earthRadius Earth radius in meters
     * @returns Visual angular scale in degrees
     */
    heightToVisualScale(cameraHeight: number, latitudeRadians: number, earthRadius: number): number {
        const angularSize = 2 * Math.atan(cameraHeight / (2 * earthRadius));
        const distortionFactor = this.calculateMercatorDistortionFactor(latitudeRadians);
        return CesiumMath.toDegrees(angularSize) / distortionFactor;
    }

    /**
     * Convert visual scale to camera height with WebMercator distortion compensation
     * @param visualScaleDegrees Visual scale in degrees
     * @param latitudeRadians Latitude in radians for distortion compensation
     * @param earthRadius Earth radius in meters
     * @returns Camera height in meters
     */
    visualScaleToHeight(visualScaleDegrees: number, latitudeRadians: number, earthRadius: number): number {
        const distortionFactor = this.calculateMercatorDistortionFactor(latitudeRadians);
        const compensatedScale = CesiumMath.toRadians(visualScaleDegrees * distortionFactor);
        return (2 * earthRadius) * Math.tan(compensatedScale / 2);
    }

    /**
     * Get the WebMercator maximum latitude in radians for use by other services
     * @returns Maximum latitude in radians
     */
    getWebMercatorMaxLatitudeRad(): number {
        return this.CAMERA_CONSTANTS.WEBMERCATOR_MAX_LATITUDE_RAD;
    }

    /**
     * Get size bounds for viewport dimensions
     * @returns Object with min/max longitude and latitude bounds
     */
    getSizeBounds(): { minLon: number, maxLon: number, minLat: number, maxLat: number } {
        return {
            minLon: this.CAMERA_CONSTANTS.MIN_SIZE_LONGITUDE,
            maxLon: this.CAMERA_CONSTANTS.MAX_SIZE_LONGITUDE,
            minLat: this.CAMERA_CONSTANTS.MIN_SIZE_LATITUDE,
            maxLat: this.CAMERA_CONSTANTS.MAX_SIZE_LATITUDE
        };
    }

    moveUp() {
        if (this.viewStateService.is2DMode) {
            const distance = this.get2DMovementDistance();
            this.moveCameraOnSurface(0, distance.latitudeOffset);
        } else {
            this.moveCameraOnSurface(0, this.parameterService.cameraMoveUnits);
        }
    }

    moveDown() {
        if (this.viewStateService.is2DMode) {
            const distance = this.get2DMovementDistance();
            this.moveCameraOnSurface(0, -distance.latitudeOffset);
        } else {
            this.moveCameraOnSurface(0, -this.parameterService.cameraMoveUnits);
        }
    }

    moveLeft() {
        if (this.viewStateService.is2DMode) {
            const distance = this.get2DMovementDistance();
            this.moveCameraOnSurface(-distance.longitudeOffset, 0);
        } else {
            this.moveCameraOnSurface(-this.parameterService.cameraMoveUnits, 0);
        }
    }

    moveRight() {
        if (this.viewStateService.is2DMode) {
            const distance = this.get2DMovementDistance();
            this.moveCameraOnSurface(distance.longitudeOffset, 0);
        } else {
            this.moveCameraOnSurface(this.parameterService.cameraMoveUnits, 0);
        }
    }

    zoomIn() {
        try {
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot zoom in: viewer not available or is destroyed');
                return;
            }

            if (this.viewStateService.is2DMode) {
                this.zoom2D(this.CAMERA_CONSTANTS.ZOOM_IN_FACTOR_2D);
            } else {
                this.viewStateService.viewer.camera.zoomIn(this.parameterService.cameraZoomUnits);
            }
        } catch (error) {
            console.error('Error zooming in:', error);
        }
    }

    zoomOut() {
        try {
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot zoom out: viewer not available or is destroyed');
                return;
            }

            if (this.viewStateService.is2DMode) {
                this.zoom2D(this.CAMERA_CONSTANTS.ZOOM_OUT_FACTOR_2D);
            } else {
                this.viewStateService.viewer.camera.zoomOut(this.parameterService.cameraZoomUnits);
            }
        } catch (error) {
            console.error('Error zooming out:', error);
        }
    }

    resetOrientation() {
        try {
            // Check if the viewer is destroyed
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot reset orientation: viewer  not available or is destroyed');
                return;
            }

            if (this.viewStateService.is2DMode) {
                // In 2D mode, just reset to north-up orientation
                // Ignore the camera change event to preserve mode switch cache
                this.ignoreNextCameraUpdate = true;
                this.parameterService.setView(this.parameterService.getCameraPosition(), {
                    heading: 0,
                    pitch: CesiumMath.toRadians(this.CAMERA_CONSTANTS.DEFAULT_2D_PITCH_DEGREES),
                    roll: 0.0
                });
            } else {
                // In 3D mode, reset to default view angle
                this.parameterService.setView(this.parameterService.getCameraPosition(), {
                    heading: CesiumMath.toRadians(0.0),
                    pitch: CesiumMath.toRadians(this.CAMERA_CONSTANTS.DEFAULT_3D_PITCH_DEGREES),
                    roll: 0.0
                });
            }
        } catch (error) {
            console.error('Error resetting orientation:', error);
        }
    }

    private moveCameraOnSurface(longitudeOffset: number, latitudeOffset: number) {
        try {
            // Check if the viewer is destroyed
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot move camera: viewer  not available or is destroyed');
                return;
            }

            // Get the current camera position in Cartographic coordinates (longitude, latitude, height)
            const cameraPosition = this.viewStateService.viewer.camera.positionCartographic;
            const lon = cameraPosition.longitude + CesiumMath.toRadians(longitudeOffset);
            const lat = cameraPosition.latitude + CesiumMath.toRadians(latitudeOffset);
            const alt = cameraPosition.height;

            if (this.viewStateService.is2DMode) {
                // In 2D mode, use setView to maintain the 2D constraints
                // Ignore the camera change event to preserve mode switch cache
                this.ignoreNextCameraUpdate = true;
                this.viewStateService.viewer.camera.setView({
                    destination: Cartesian3.fromRadians(lon, lat, alt)
                });
            } else {
                // 3D mode - use parameter service
                const newPosition = Cartesian3.fromRadians(lon, lat, alt);
                this.parameterService.setView(newPosition, this.parameterService.getCameraOrientation());
            }
        } catch (error) {
            console.error('Error moving camera:', error);
        }
    }

    /**
     * Get movement distance for 2D mode based on current viewport
     */
    private get2DMovementDistance(): { longitudeOffset: number, latitudeOffset: number } {
        const currentView = this.viewStateService.viewer.camera.computeViewRectangle();
        if (!currentView) {
            // Fallback to default movement if view can't be computed
            return {
                longitudeOffset: this.parameterService.cameraMoveUnits,
                latitudeOffset: this.parameterService.cameraMoveUnits
            };
        }

        const currentWidth = currentView.east - currentView.west;
        const currentHeight = currentView.north - currentView.south;

        // Calculate movement distances using centralized constant
        const longitudeOffset = CesiumMath.toDegrees(currentWidth * this.CAMERA_CONSTANTS.MOVEMENT_PERCENTAGE_2D);
        const latitudeOffset = CesiumMath.toDegrees(currentHeight * this.CAMERA_CONSTANTS.MOVEMENT_PERCENTAGE_2D);

        // Clamp movements to reasonable values using centralized constants
        return {
            longitudeOffset: Math.max(
                this.CAMERA_CONSTANTS.MIN_LONGITUDE_MOVEMENT,
                Math.min(this.CAMERA_CONSTANTS.MAX_LONGITUDE_MOVEMENT, longitudeOffset)
            ),
            latitudeOffset: Math.max(
                this.CAMERA_CONSTANTS.MIN_LATITUDE_MOVEMENT,
                Math.min(this.CAMERA_CONSTANTS.MAX_LATITUDE_MOVEMENT, latitudeOffset)
            )
        };
    }


    /**
     * 2D zoom using height-based approach with WebMercator distortion compensation
     */
    zoom2D(zoomFactor: number): void {
        try {
            // Check if viewer is destroyed
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot zoom in 2D: viewer is missing or destroyed');
                return;
            }

            const camera = this.viewStateService.viewer.camera;
            const currentPos = camera.positionCartographic;
            const earthRadius = this.viewStateService.viewer.scene.globe.ellipsoid.maximumRadius;

            // Get current camera height and calculate desired new height
            const currentHeight = currentPos.height;
            const desiredHeight = currentHeight * zoomFactor;

            // Apply altitude limits using centralized constants
            const minHeight = this.CAMERA_CONSTANTS.MIN_ALTITUDE_METERS;
            const maxVisualScale = this.CAMERA_CONSTANTS.MAX_VIEW_RECTANGLE_DEGREES;
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
            const newPosition = Cartesian3.fromRadians(
                currentPos.longitude,
                currentPos.latitude,
                clampedHeight
            );

            // Ignore the camera change event for this programmatic zoom
            this.ignoreNextCameraUpdate = true;

            camera.setView({
                destination: newPosition
            });
        } catch (error) {
            console.error('Error in 2D zoom:', error);
        }
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
                try {
                    const cartesian = this.viewStateService.viewer.camera.pickEllipsoid(
                        new Cartesian2(point.x, point.y),
                        this.viewStateService.viewer.scene.globe.ellipsoid
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
                } catch (error) {
                    // Skip invalid points
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
                const cameraPos = this.viewStateService.viewer.camera.positionCartographic;
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

    // Store event handler references for proper cleanup
    updateOnCameraChange() {
        // Check if viewer is still valid
        if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
            console.debug('cameraChangedHandler: viewer is destroyed or unavailable');
            return;
        }

        // Check for extreme coordinates that might cause issues
        const cameraPos = this.viewStateService.viewer.camera.positionCartographic;
        const lon = CesiumMath.toDegrees(cameraPos.longitude);
        const lat = CesiumMath.toDegrees(cameraPos.latitude);
        if (!isFinite(lon) || !isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
            console.error('Invalid camera coordinates detected:', {lon, lat});
            return;
        }

        if (!this.ignoreNextCameraUpdate) {
            if (this.viewStateService.is2DMode) {
                this.parameterService.set2DCameraState(this.viewStateService.viewer.camera);
            } else {
                this.parameterService.setCameraState(this.viewStateService.viewer.camera);
            }
        }

        this.ignoreNextCameraUpdate = false;
    };

    cameraMoveStartHandler = () => {
        this.cameraIsMoving = true;
    };

    cameraMoveEndHandler = () => {
        this.cameraIsMoving = false;
    };

    /**
     * Restore camera state from saved state
     */
    restoreCameraState(viewerState: ViewState) {
        if (!viewerState?.cameraState || this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
            console.debug('Cannot restore camera state: missing state, viewer, or camera');
            return;
        }

        try {
            const cameraState = viewerState.cameraState;
            this.ignoreNextCameraUpdate = true;

            if (this.viewStateService.is2DMode) {
                // For 2D mode, use view rectangle if available
                if (cameraState.viewRectangle) {
                    this.viewStateService.viewer.camera.setView({
                        destination: cameraState.viewRectangle
                    });
                } else {
                    // Fallback: Create a rectangle from position with altitude compensation if needed
                    let restoredHeight = cameraState.height;

                    // Apply forward distortion compensation when switching from 3D to 2D
                    if (cameraState.savedFromMode === '3D') {
                        const distortionFactor = this.calculateMercatorDistortionFactor(cameraState.latitude);
                        restoredHeight = cameraState.height * distortionFactor;
                        console.debug('Applied 3D→2D altitude compensation:', {
                            originalHeight: cameraState.height,
                            compensatedHeight: restoredHeight,
                            distortionFactor: distortionFactor,
                            latitude: CesiumMath.toDegrees(cameraState.latitude)
                        });
                    } else if (!cameraState.savedFromMode) {
                        // Backward compatibility: if no savedFromMode flag, use moderate compensation
                        const distortionFactor = this.calculateMercatorDistortionFactor(cameraState.latitude);
                        if (distortionFactor > 1.5) { // Only compensate at higher latitudes
                            restoredHeight = cameraState.height * Math.sqrt(distortionFactor); // Apply partial compensation
                            console.debug('Applied backward-compatible 3D→2D altitude compensation:', {
                                originalHeight: cameraState.height,
                                compensatedHeight: restoredHeight,
                                partialDistortionFactor: Math.sqrt(distortionFactor),
                                latitude: CesiumMath.toDegrees(cameraState.latitude)
                            });
                        }
                    }

                    // Calculate appropriate rectangle size based on compensated altitude
                    const earthRadius = this.viewStateService.viewer.scene.globe.ellipsoid.maximumRadius;
                    const visualScale = this.heightToVisualScale(restoredHeight, cameraState.latitude, earthRadius);
                    const halfSizeDegrees = visualScale / 2;
                    const halfSizeRad = CesiumMath.toRadians(halfSizeDegrees);

                    this.viewStateService.viewer.camera.setView({
                        destination: Rectangle.fromRadians(
                            cameraState.longitude - halfSizeRad,
                            cameraState.latitude - halfSizeRad,
                            cameraState.longitude + halfSizeRad,
                            cameraState.latitude + halfSizeRad
                        )
                    });
                }
            } else {
                // For 3D mode, restore full camera state with altitude compensation if needed
                let restoredHeight = cameraState.height;

                // Apply inverse distortion compensation when switching from 2D to 3D
                if (cameraState.savedFromMode === '2D') {
                    const distortionFactor = this.calculateMercatorDistortionFactor(cameraState.latitude);
                    restoredHeight = cameraState.height / distortionFactor;
                    console.debug('Applied 2D→3D altitude compensation:', {
                        originalHeight: cameraState.height,
                        compensatedHeight: restoredHeight,
                        distortionFactor: distortionFactor,
                        latitude: CesiumMath.toDegrees(cameraState.latitude)
                    });
                } else if (!cameraState.savedFromMode) {
                    // Backward compatibility: if no savedFromMode flag, assume potential 2D→3D transition
                    // Apply moderate compensation to avoid extreme altitude jumps
                    const distortionFactor = this.calculateMercatorDistortionFactor(cameraState.latitude);
                    if (distortionFactor > 1.5) { // Only compensate at higher latitudes where distortion is significant
                        restoredHeight = cameraState.height / Math.sqrt(distortionFactor); // Apply partial compensation
                        console.debug('Applied backward-compatible altitude compensation:', {
                            originalHeight: cameraState.height,
                            compensatedHeight: restoredHeight,
                            partialDistortionFactor: Math.sqrt(distortionFactor),
                            latitude: CesiumMath.toDegrees(cameraState.latitude)
                        });
                    }
                }

                this.viewStateService.viewer.camera.setView({
                    destination: Cartesian3.fromRadians(
                        cameraState.longitude,
                        cameraState.latitude,
                        restoredHeight
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

    /**
     * Get the current camera state for preservation
     */
    getCurrentCameraState() {
        if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
            console.debug('Cannot get camera state: missing or destroyed viewer, or camera');
            return null;
        }

        try {
            const camera = this.viewStateService.viewer.camera;
            const position = camera.positionCartographic;

            return {
                longitude: position.longitude,
                latitude: position.latitude,
                height: position.height,
                heading: camera.heading,
                pitch: camera.pitch,
                roll: camera.roll,
                viewRectangle: camera.computeViewRectangle(),
                savedFromMode: this.viewStateService.is2DMode ? '2D' : '3D' // Track which mode state was saved from
            };
        } catch (e) {
            console.error('Error getting camera state:', e);
            return null;
        }
    }
}