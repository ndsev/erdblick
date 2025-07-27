import {ElementRef, Injectable} from "@angular/core";
import {Cartesian2, Cartesian3, Cartographic, CesiumMath, Rectangle} from "./cesium";
import {ParametersService} from "./parameters.service";
import {ViewState, ViewStateService} from "./view.state.service";

@Injectable({providedIn: 'root'})
export class CameraService {
    ignoreNextCameraUpdate: boolean = false;
    cameraIsMoving: boolean = false;

    constructor(private parameterService: ParametersService,
                private viewStateService: ViewStateService) {
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
                this.zoom2D(0.8); // Zoom in by 20%
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
                this.zoom2D(1.25); // Zoom out by 25%
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
    zoom2D(zoomFactor: number): void {
        try {
            // Check if viewer is destroyed
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot zoom in 2D: viewer is missing or destroyed');
                return;
            }

            const camera = this.viewStateService.viewer.camera;

            // Get current camera height
            const currentHeight = camera.positionCartographic.height;
            const newHeight = currentHeight * zoomFactor;

            // Convert height to equivalent view rectangle height using natural relationship
            const earthRadius = this.viewStateService.viewer.scene.globe.ellipsoid.maximumRadius; // Use viewer's ellipsoid maximum radius
            const newViewRectHeight = 2 * Math.atan(newHeight / (2 * earthRadius));

            // Apply zoom limits based on view rectangle height
            const minViewRectHeight = this.getMinViewRectangleHeight();
            const maxViewRectHeight = this.getMaxViewRectangleHeight();

            let clampedViewRectHeight = newViewRectHeight;
            let wasClampedToLimit = false;

            if (newViewRectHeight < minViewRectHeight) {
                clampedViewRectHeight = minViewRectHeight;
                wasClampedToLimit = true;
            } else if (newViewRectHeight > maxViewRectHeight) {
                clampedViewRectHeight = maxViewRectHeight;
                wasClampedToLimit = true;
            }

            // Convert the clamped view rectangle height back to camera height
            const clampedHeight = (2 * earthRadius) * Math.tan(clampedViewRectHeight / 2);

            if (wasClampedToLimit) {
                console.debug('Zoom clamped to view rectangle limits');
            }

            // Set new camera height directly while preserving position
            const currentPos = camera.positionCartographic;
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
     * Calculate the minimum view rectangle height for 2D mode (1 meter in degrees)
     */
    getMinViewRectangleHeight(): number {
        // The Minimum corresponds to about 100 meters altitude using natural scaling
        // This provides a reasonable minimum zoom level
        const earthRadius = this.viewStateService.viewer.scene.globe.ellipsoid.maximumRadius; // Use viewer's ellipsoid maximum radius
        const minAltitude = 100; // meters
        return 2 * Math.atan(minAltitude / (2 * earthRadius));
    }

    /**
     * Calculate the maximum view rectangle height for 2D mode (45 degrees)
     */
    getMaxViewRectangleHeight(): number {
        // Limit to 45 degrees to prevent excessive zoom out
        // This provides a reasonable world view without black bars
        return CesiumMath.toRadians(45);
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
                    // Fallback to center position
                    this.viewStateService.viewer.camera.setView({
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
                this.viewStateService.viewer.camera.setView({
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
                viewRectangle: camera.computeViewRectangle()
            };
        } catch (e) {
            console.error('Error getting camera state:', e);
            return null;
        }
    }
}