import {Injectable} from "@angular/core";
import {Cartesian2, Cartographic, CesiumMath, Rectangle} from "./cesium";
import {MapService} from "./map.service";
import {ParametersService} from "./parameters.service";
import {CameraService} from "./camera.service";
import {ViewStateService} from "./view.state.service";

@Injectable({providedIn: 'root'})
export class ViewService {
    // TODO - refactoring:
    //   1. ViewService should be able to handle more than one viewer: Viewer within their ViewerWrapper
    //      based on their unique viewerIds.
    constructor(private mapService: MapService,
                private parameterService: ParametersService,
                private viewStateService: ViewStateService,
                private cameraService: CameraService) {
    }

    toggleSceneMode() {
        // Don't allow toggling if already changing modes
        if (this.viewStateService.isChangingMode) {
            console.debug('Mode change already in progress, ignoring toggle request');
            return;
        }
        this.parameterService.setCameraMode(!this.viewStateService.is2DMode);
    }

    setup2DModeConstraints() {
        // Enable 2D map interactions
        const scene = this.viewStateService.viewer.scene;

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

    setup3DModeConstraints() {
        // Re-enable full 3D camera controls
        const scene = this.viewStateService.viewer.scene;

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
     * Update the visible viewport, and communicate it to the model.
     */
    updateViewport() {
        try {
            // Check if the viewer is destroyed
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot update viewport: viewer is destroyed or unavailable');
                return;
            }

            let canvas = this.viewStateService.viewer.scene.canvas;
            if (!canvas) {
                console.debug('Cannot update viewport: canvas not available');
                return;
            }

            let center = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
            let centerCartesian = this.viewStateService.viewer.camera.pickEllipsoid(center);
            let centerLon, centerLat;

            if (centerCartesian !== undefined) {
                let centerCartographic = Cartographic.fromCartesian(centerCartesian);
                centerLon = CesiumMath.toDegrees(centerCartographic.longitude);
                centerLat = CesiumMath.toDegrees(centerCartographic.latitude);
            } else {
                let cameraCartographic = Cartographic.fromCartesian(this.viewStateService.viewer.camera.positionWC);
                centerLon = CesiumMath.toDegrees(cameraCartographic.longitude);
                centerLat = CesiumMath.toDegrees(cameraCartographic.latitude);
            }

            // First try: Pass ellipsoid explicitly (workaround for Cesium issue)
            let rectangle = this.viewStateService.viewer.camera.computeViewRectangle(
                this.viewStateService.viewer.scene.globe.ellipsoid
            );

            if (!rectangle) {
                // Workaround: Robust rectangle calculation with multiple sample points
                rectangle = this.cameraService.computeRobustViewRectangle(canvas);
            }

            if (!rectangle) {
                // Final fallback: Calculate viewport from camera position and height
                const cameraCartographic = this.viewStateService.viewer.camera.positionCartographic;
                const cameraLon = CesiumMath.toDegrees(cameraCartographic.longitude);
                const cameraLat = CesiumMath.toDegrees(cameraCartographic.latitude);
                const cameraHeight = cameraCartographic.height;

                // Calculate viewport size based on camera height with distortion compensation
                const earthRadius = this.viewStateService.viewer.scene.globe.ellipsoid.maximumRadius;
                const visualScale = this.cameraService.heightToVisualScale(
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
            const maxLatRad = this.cameraService.getWebMercatorMaxLatitudeRad();
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
            if (this.viewStateService.is2DMode) {
                // Calculate dimensions that represent the visual scale for accurate zoom level detection
                // In WebMercator at high latitudes, geographic bounds are larger than the visual area
                const cameraHeight = this.viewStateService.viewer.camera.positionCartographic.height;
                const earthRadius = this.viewStateService.viewer.scene.globe.ellipsoid.maximumRadius;

                // Validate camera height is reasonable
                if (!isFinite(cameraHeight) || cameraHeight <= 0) {
                    console.error('Invalid camera height:', cameraHeight);
                    return;
                }

                try {
                    // Get camera position for distortion compensation
                    const cameraCartographic = this.viewStateService.viewer.camera.positionCartographic;

                    // Use camera service's distortion-compensated visual scale calculation
                    const visualScale = this.cameraService.heightToVisualScale(
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
                    const bounds = this.cameraService.getSizeBounds();
                    sizeLon = Math.max(bounds.minLon, Math.min(bounds.maxLon, sizeLon));
                    sizeLat = Math.max(bounds.minLat, Math.min(bounds.maxLat, sizeLat));

                } catch (error) {
                    console.error('Error in visual scale calculation:', error);
                    // Use geographic bounds as fallback
                    sizeLon = east - west;
                    sizeLat = north - south;
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
                orientation: -this.viewStateService.viewer.camera.heading + Math.PI * .5,
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

    updateOnCameraChangedHandler = () => {
        try {
            this.cameraService.updateOnCameraChange();
            this.updateViewport();
        } catch (error) {
            console.error('Error on camera change update:', error);
        }
    }
}