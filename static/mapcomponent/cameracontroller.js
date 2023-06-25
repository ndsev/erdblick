"use strict";

import {
    EventDispatcher,
    PerspectiveCamera,
    Euler,
    Object3D,
    Raycaster,
    Vector2,
    Frustum,
    Matrix4,
    Vector3
} from "../deps/three.js";
import {degreeToRad, smoothstep, wgs84FromScenePos} from "./utils.js";
import {MapViewerConst} from "./consts.js";
import {SingleShotTimer} from "./timer.js";

/**
 * Controller for a globe inspection camera with the following features:
 * The controller may be used to ...
 *   ... drag-turn the camera around the globe.
 *   ... zoom towards the point on the globe that is under the mouse.
 *   ... turn the camera around the globe point that is under the mouse.
 *
 *      +Y (cameraAzimuthRoot.rotation.y) -> Longitude
 *     A
 *  _ _|_ _
 * /@@@|@@@\ Globe
 * @@@@|@@@@\
 * @@@@|@@@@@|
 *  - - - - -| - - - - - > +X (cameraAzimuthRoot.rotation.x) -> Latitude
 * @@@@@\@@@/
 * \@@@@@@\/ - - - - - - > +X (cameraSurfaceRoot.rotation.x) -> Pitch
 *          \_____
 *          |\___/ Camera
 *          ||\__\
 *          |/\|_|  
 *              \
 *              V +Z (cameraSurfaceRoot.rotation.z) -> Roll, Zoom
 */
export class MapViewerCameraController extends EventDispatcher
{

    constructor(camera, viewport, platform) {
        super();

        this.camera = camera;
        this.viewport = viewport;
        this.platform = platform;

        this.mouse = new Vector2();
        this.canvasWidth = 0;
        this.canvasHeight = 0;

        this.lastZoomEventTimestamp = Date.now();
        this.zoomUpdateTimer = new SingleShotTimer(
            MapViewerConst.zoomRedrawThreshold,
            ()=>this.update(true), true);

        this.dragOrigin = null;  // Globe surface point which was under the mouse when dragging started
        this.dragOriginCamera = new PerspectiveCamera();  // Clone of camera when dragging started
        this.dragOriginCameraPos = new Vector3();
        this.dragStartAzimuth = new Euler();
        this.dragStartSurfaceRotation = new Euler();
        this.dragMouseOrigin = new Vector2();
        this.dragMouseButton = platform.mouse.Left;

        this.cameraAzimuthRoot = new Object3D();
        this.cameraAzimuthRoot.rotation.order = "YXZ";
        this.cameraSurfaceRoot = new Object3D();
        this.cameraSurfaceRoot.rotation.order = "ZXY";
        this.cameraSurfaceRoot.position.z = MapViewerConst.globeRenderRadius;
        this.cameraAzimuthRoot.add(this.cameraSurfaceRoot);
        this.cameraSurfaceRoot.add(this.camera);
        this.camera.position.z = MapViewerConst.maxCameraGlobeDistance;

        this.draggingActive = false;
        this.mouseDown = false;

        this.touchState = {
            startX: 0,
            startY: 0,
            avgX: 0,
            avgY: 0,
            scale: 1,
            lastPinchDistance: 0,
            isPan: false,
            isPinch: false
        };

        // Received by model, forwarded to frontend for compass
        // Received by rendering controller to trigger globe/mapviewer-model updates.
        this.CAM_POS_CHANGED = "camPosChanged"; // {orientation, tilt, level, [zooming], [jumped]}

        let lon = degreeToRad(platform.getStateNumeric("lon", 11.3752));
        let lat = -degreeToRad(platform.getStateNumeric("lat", 48.1933));
        this.setCameraAzimuth(lon, lat, true);

        let alt = platform.getStateNumeric("alt", this.getCameraAltitude());
        this.setCameraAltitude(alt, true);

        let x = platform.getStateNumeric("x", .0);
        let z = platform.getStateNumeric("z", .0);
        this.setCameraOrientation(x, z, true);
    }

    /// Get Y/X axis angle differences as derived from the two given vectors.
    vecToVecYXAngles(from, to) {
        let result = new Euler();
        let fromPhi = Math.atan2(from.x, from.z);
        let fromTheta = Math.asin(from.y/from.length());
        let toPhi = Math.atan2(to.x, to.z);
        let toTheta = Math.asin(to.y/to.length());
        result.y = toPhi - fromPhi;
        result.x = -(toTheta - fromTheta);
        return result
    }

    /// Camera pitch is suppressed when zooming out
    cameraMaxPitchAtCurrentHeight() {
        return MapViewerConst.cameraMaxPitch*(1.-smoothstep(MapViewerConst.globeRenderRadius/32., MapViewerConst.globeRenderRadius/8., this.camera.position.z));
    }

    /// Calculate first intersection point between a perfect sphere and a ray.
    raySphereIntersection(rayStart, rayUnitDirection, sphereCenter, sphereRadius)
    {
        // Calculate ray start's offset from the sphere center
        let sphereCenterToRayStart = rayStart.clone().sub(sphereCenter);

        let rSquared = sphereRadius * sphereRadius;
        let dotRayDirectionAndCenterToStart = sphereCenterToRayStart.dot(rayUnitDirection);

        // The sphere is behind or surrounding the start point.
        if(dotRayDirectionAndCenterToStart > 0 || sphereCenterToRayStart.dot(sphereCenterToRayStart) < rSquared)
            return null;

        // Flatten sphereCenterToRayStart into the plane passing through sphereCenter perpendicular to the ray.
        // This gives the closest approach of the ray to the center.
        let closestApproach = sphereCenterToRayStart.clone().sub(
            rayUnitDirection.clone().multiplyScalar(dotRayDirectionAndCenterToStart)
        );
        let closestApproachSquared = closestApproach.dot(closestApproach);

        // Closest approach is outside the sphere.
        if(closestApproachSquared > rSquared)
          return null;

        // Calculate distance from plane where ray enters/exits the sphere.
        let intersectionElevationFromPerpendicularPlane = Math.sqrt(rSquared - closestApproachSquared);

        // Calculate intersection point relative to sphere center.
        let intersectionDirection = closestApproach.clone().sub(rayUnitDirection.clone().multiplyScalar(intersectionElevationFromPerpendicularPlane));

        return sphereCenter.clone().add(intersectionDirection);
    }

    scenePosOnGlobeAtScreenCoords(screenX, screenY, cameraToUse, earthRadius) {
        let rayCaster = new Raycaster();
        let currentMouseCoords = new Vector2(
            (screenX/this.canvasWidth) * 2 - 1,
            - (screenY/this.canvasHeight) * 2 + 1);
        cameraToUse = cameraToUse || this.camera;
        earthRadius = earthRadius || MapViewerConst.globeRenderRadius;
        rayCaster.setFromCamera(currentMouseCoords, cameraToUse);
        return this.raySphereIntersection(rayCaster.ray.origin, rayCaster.ray.direction, new Vector3(0, 0, 0), earthRadius)
    };

    update(forceChangedSignals, cameraJump)
    {
        // Recursively updates world matrices of surfaceRoot and camera too
        this.cameraAzimuthRoot.updateMatrixWorld();
        let cameraWorldPosition = this.cameraWorldPosition();
        this.camera.far = cameraWorldPosition.length() * 1.025;
        this.camera.updateProjectionMatrix();

        // Limit flickering viewport while zooming is in progress.
        let zooming = (Date.now() - this.lastZoomEventTimestamp) < MapViewerConst.zoomRedrawThreshold;
        if (zooming && !forceChangedSignals)
        {
            // Still, notify subscribers about camera state change
            this.dispatchEvent(
            {
                type: this.CAM_POS_CHANGED,
                orientation: this.cameraSurfaceRoot.rotation.z,
                tilt: this.cameraSurfaceRoot.rotation.x,
                level: this.viewport.gridAutoLevel(),
                zooming: true,
                jumped: cameraJump === true
            });

            this.zoomUpdateTimer.restart();
            return;
        }

        // Angular camera position (at camera, incl. tilt)
        let rootPos = this.surfaceRootWorldPosition();
        let cameraPos = this.cameraWorldPosition();

        // (Rough) Estimate of angular globe coverage, scaled with aspect ratio and latitude
        let latAngle = Math.min(this.innerAngleForFov() * Math.max(this.camera.aspect, 1./this.camera.aspect), Math.PI);
        let lonAngle = Math.min(latAngle/Math.cos(this.cameraAzimuthRoot.rotation.x), Math.PI);

        // Calculate camera frustum for viewport-subtile culling
        let frustum = new Frustum();
        frustum.setFromProjectionMatrix(new Matrix4().multiplyMatrices(
            this.camera.projectionMatrix,
            this.camera.matrixWorldInverse));

        // Update viewport
        this.viewport.update(
            Math.atan2(rootPos.x, rootPos.z),
            Math.acos(rootPos.y/rootPos.length()),
            lonAngle, latAngle, frustum);

        // Update viewport subtile-rendertile distribution
        this.viewport.updateSubTiles(cameraPos, frustum);

        // Notify subscribers about camera state change
        this.processCameraChange(cameraJump);

        let wgs = this.getCameraWgs84Coords();
        this.platform.setState("lon", wgs.x);
        this.platform.setState("lat", wgs.y);
        this.platform.setState("alt", this.getCameraAltitude());
        this.platform.setState("x", this.cameraSurfaceRoot.rotation.x);
        this.platform.setState("z", this.cameraSurfaceRoot.rotation.z);
    }

    resetCameraOrientation() {
        this.cameraSurfaceRoot.rotation.z = 0;
        this.cameraSurfaceRoot.rotation.x = 0;
        this.update()
    }

    pointerPosition() {
        return this.mouse
    }

    surfaceRoot() {
        return this.cameraSurfaceRoot
    }

    azimuthRoot() {
        return this.cameraAzimuthRoot
    }

    surfaceRootWorldPosition() {
        let result = new Vector3();
        this.cameraSurfaceRoot.getWorldPosition(result);
        return result;
    }

    cameraWorldPosition() {
        let result = new Vector3();
        this.camera.getWorldPosition(result);
        return result;
    };

    ///////////////////////////////////////////////////////////////////////////
    //                                  UTILITY                              //
    ///////////////////////////////////////////////////////////////////////////

    forceUpdate() {
        this.update(true)
    }

    screenCoordsToWgs84(screenX, screenY)
    {
        let scenePos = this.scenePosOnGlobeAtScreenCoords(screenX, screenY);
        if (scenePos)
            return wgs84FromScenePos(scenePos, MapViewerConst.globeRenderRadius);
        return null
    }

    innerAngleForFov() {
        const d = MapViewerConst.globeRenderRadius + this.camera.position.z;
        const r = MapViewerConst.globeRenderRadius;
        const alpha = Math.tan(degreeToRad(this.camera.fov) * .5);
        let sqrt = 4*d*d + 4 * (alpha*alpha + 1) * (r*r - d*d);

        if (sqrt >= 0) {
            sqrt = Math.sqrt(sqrt);
            const div = 1/(2 * (alpha*alpha + 1));
            const h = (2*d - sqrt)*div;
            const innerDist = d - h;
            const beta = Math.acos(innerDist/r);
            return 2*beta;
        }
        else {
            return Math.PI;
        }
    };

    updateCanvasSize(w, h) {
        this.canvasWidth = w;
        this.canvasHeight = h;
        this.camera.aspect = this.canvasWidth / this.canvasHeight;
        this.camera.updateProjectionMatrix();
        this.update()
    }

    setCameraAzimuth(phi, theta, skipVpUpdate, isCameraJump) {
        this.cameraAzimuthRoot.rotation.y = phi;
        const maxTheta = Math.PI/2. * MapViewerConst.latClampFactor;
        this.cameraAzimuthRoot.rotation.x = Math.min(maxTheta, Math.max(-maxTheta, theta));
        if (!skipVpUpdate)
            this.update(false, isCameraJump)
        else if (isCameraJump)
            this.processCameraChange(true)
    };

    getCameraWgs84Coords() {
        return wgs84FromScenePos(this.surfaceRootWorldPosition(), MapViewerConst.globeRenderRadius);
    }

    setCameraAltitudeGlobeExtent(angularExtentInDegrees) {
        let alt = (
            degreeToRad(angularExtentInDegrees) *
            MapViewerConst.globeRenderRadius /
            Math.tan(degreeToRad(MapViewerConst.cameraFov) * .5)
        );
        this.setCameraAltitude(alt, false, true);
    }

    setCameraAltitude(height, skipVpUpdate, isCameraJump)
    {
        this.camera.position.z = Math.min(
            MapViewerConst.maxCameraGlobeDistance,
            Math.max(
                MapViewerConst.minCameraGlobeDistance,
                height)
        );

        if (this.cameraSurfaceRoot.rotation.x > this.cameraMaxPitchAtCurrentHeight())
            this.cameraSurfaceRoot.rotation.x = this.cameraMaxPitchAtCurrentHeight();

        if (!skipVpUpdate)
            this.update(false, isCameraJump)
        else if (isCameraJump)
            this.processCameraChange(true)
    };

    setCameraOrientation(pitch, yaw, skipVpUpdate, isCameraJump) {
        if (pitch > this.cameraMaxPitchAtCurrentHeight())
            pitch = this.cameraMaxPitchAtCurrentHeight();

        this.cameraSurfaceRoot.rotation.x = pitch;
        this.cameraSurfaceRoot.rotation.z = yaw;

        if (!skipVpUpdate)
            this.update(isCameraJump)
    };

    getCameraAltitude() {
        return this.camera.position.z;
    }

    setCameraPosition(pos, isCameraJump) {
        console.assert(pos.isVector3);
        let r = pos.length();
        console.assert(r >= MapViewerConst.minCameraGlobeDistance);
        let phi = Math.atan2(pos.x, pos.z);
        let theta = -Math.asin(pos.y/r);
        this.setCameraAzimuth(phi, theta, true);
        this.setCameraAltitude(r - MapViewerConst.globeRenderRadius,isCameraJump)
    }

    moveToCoords(lon, lat, skipVpUpdate = false, isJump = true) {
        this.setCameraAzimuth(degreeToRad(lon), degreeToRad(-lat), skipVpUpdate, isJump);
    };
    
    zoomToGridLevel(level) {
        let height =  1.0 / (2.0 ** level) * 180.0;
        this.setCameraAltitudeGlobeExtent(height);
    }

    turnCameraAroundGlobe(deltaPhi, deltaTheta, skipVpUpdate) {
        this.setCameraAzimuth(
            this.cameraAzimuthRoot.rotation.y - deltaPhi,
            this.cameraAzimuthRoot.rotation.x - deltaTheta,
            skipVpUpdate
        )
    }

    processCameraChange(isCameraJump) {
        this.dispatchEvent(
        {
            type: this.CAM_POS_CHANGED,
            orientation: this.cameraSurfaceRoot.rotation.z,
            tilt: this.cameraSurfaceRoot.rotation.x,
            level: this.viewport.gridAutoLevel(),
            jumped: isCameraJump
        });
    }

    turnCameraAroundGlobeRelative(deltaPhiRel, deltaThetaRel) {
        // TODO: Since this is called by the arrow keys, the impl. is
        // a bit awkward when the camera is turned around its local
        // Z axis, since then the root phi/theta rotation axes will not match the
        // Y/X camera axes. Instead what needs to be done here is
        // moving a target point B from cam.pos.worldPosition() on the camera Y/X axes,
        // then move camera by vec2vec(cam.pos.worldPosition(), B).
        let t = this.scenePosOnGlobeAtScreenCoords(this.canvasWidth/2., 0);
        let b = this.scenePosOnGlobeAtScreenCoords(this.canvasWidth/2., this.canvasHeight);
        let currentVisibleArc = Math.PI;
        if (t && b)
            currentVisibleArc = t.angleTo(b);
        this.turnCameraAroundGlobe(
            currentVisibleArc * deltaPhiRel,
            currentVisibleArc * deltaThetaRel
        )
    }

    fastZoomIn(adjustAzimuth) {
        this.notifyWheel(
            -MapViewerConst.zoomSpeedPerKeyStroke,
            true, // skipDeltaNormalization
            !adjustAzimuth // skipAzimuthAdjustment
        )
    }

    fastZoomOut(adjustAzimuth) {
        this.notifyWheel(
            MapViewerConst.zoomSpeedPerKeyStroke,
            true, // skipDeltaNormalization
            !adjustAzimuth // skipAzimuthAdjustment
        )
    }

    ///////////////////////////////////////////////////////////////////////////
    //                            MOUSE INTERACTIONS                         //
    ///////////////////////////////////////////////////////////////////////////

    notifyMouseMoved(x, y) {
        this.mouse.x = x;
        this.mouse.y = y;
        
        if (this.mouseDown)
        {
            this.draggingActive = this.draggingActive || (Math.max(
                Math.abs(this.dragMouseOrigin.x - this.mouse.x),
                Math.abs(this.dragMouseOrigin.y - this.mouse.y)
            ) > MapViewerConst.minPointerMoveBeforeDrag)
        }

        if (this.draggingActive)
        {
            if (this.dragOrigin)
            {
                switch (this.dragMouseButton)
                {
                // Move camera around globe
                case this.platform.mouse.Left:
                    let currentGlobeMouseVector = this.scenePosOnGlobeAtScreenCoords(this.mouse.x, this.mouse.y, this.dragOriginCamera);
                    if (currentGlobeMouseVector) {
                        let angles = this.vecToVecYXAngles(this.dragOrigin, currentGlobeMouseVector);
                        this.setCameraAzimuth(
                            this.dragStartAzimuth.y - angles.y,
                            this.dragStartAzimuth.x - angles.x, false)
                    }
                    break;

                // Move camera around dragOrigin
                case this.platform.mouse.Right:
                    let camAngleDiffX =
                        MapViewerConst.cameraPitchInterval *
                        (this.dragMouseOrigin.y - this.mouse.y)/(this.canvasHeight/2.);
                    let camAngleDiffZ =
                        2*Math.PI *
                        (this.dragMouseOrigin.x - this.mouse.x)/(this.canvasWidth/2.);

                    // Clamp and apply camera X rotation
                    let newCamAngleX = this.dragStartSurfaceRotation.x + camAngleDiffX;
                    if (newCamAngleX < MapViewerConst.cameraMinPitch)
                        camAngleDiffX += MapViewerConst.cameraMinPitch - newCamAngleX;
                    else if (newCamAngleX > this.cameraMaxPitchAtCurrentHeight())
                        camAngleDiffX += this.cameraMaxPitchAtCurrentHeight() - newCamAngleX;
                    this.cameraSurfaceRoot.rotation.x = this.dragStartSurfaceRotation.x + camAngleDiffX;

                    // Apply Z rotation
                    this.cameraSurfaceRoot.rotation.z = this.dragStartSurfaceRotation.z + camAngleDiffZ;
                    this.update();
                }
            }
        }
    }

    notifyMouseDown (button) {
        this.mouseDown = true;
        this.dragOrigin = this.scenePosOnGlobeAtScreenCoords(this.mouse.x, this.mouse.y);
        this.dragOriginCamera.copy(this.camera);
        this.dragOriginCameraPos.setFromMatrixPosition(this.dragOriginCamera.matrixWorld);
        this.dragStartAzimuth.copy(this.cameraAzimuthRoot.rotation);
        this.dragStartSurfaceRotation.copy(this.cameraSurfaceRoot.rotation);
        this.dragMouseOrigin.copy(this.mouse);
        this.dragMouseButton = button
    }

    notifyMouseReleased() {
        this.draggingActive = false;
        this.mouseDown = false
    };

    notifyWheel(delta, skipDeltaNormalization, skipAzimuthAdjustment) {
        // Normalize delta. Platforms put values of wildly different magnitudes here.
        if (!skipDeltaNormalization)
            delta = Math.sign(delta);

        // Limit flickering redraws of outer rendertiles while zooming is in progress.
        this.lastZoomEventTimestamp = Date.now();

        // Move the camera on Z
        this.setCameraAltitude(
            // Apply subtle root curve to speed up zooming at high zoom levels,
            // and keep zooming virtually uneffected at low zoom levels.
            Math.pow(this.camera.position.z/MapViewerConst.maxCameraGlobeDistance, 0.998) *
            MapViewerConst.maxCameraGlobeDistance *
            Math.pow(MapViewerConst.zoomSpeedPerWheelTurn, delta),
            true);

        if (!skipAzimuthAdjustment)
        {
            let oldIntersection = this.scenePosOnGlobeAtScreenCoords(this.mouse.x, this.mouse.y);
            this.cameraAzimuthRoot.updateMatrixWorld();
            let newIntersection = this.scenePosOnGlobeAtScreenCoords(this.mouse.x, this.mouse.y);
            if (oldIntersection && newIntersection) {
                let angles = this.vecToVecYXAngles(oldIntersection, newIntersection);
                this.turnCameraAroundGlobe(angles.y, angles.x, true);
            } else
                console.log("Raycast failed!");
        }

        // Explicitly call update()
        this.update();
    };

    ///////////////////////////////////////////////////////////////////////////
    //                              TOUCH SUPPORT                            //
    ///////////////////////////////////////////////////////////////////////////

    processTouches(touches, reset) {
        this.touchState.avgX = 0;
        this.touchState.avgY = 0;
        for (let i = 0; i < touches.length; ++i)
        {
            this.touchState.avgX += touches[i].clientX;
            this.touchState.avgY += touches[i].clientY
        }
        this.touchState.avgX /= touches.length;
        this.touchState.avgY /= touches.length;

        if (reset) {
            this.touchState.startX = this.touchState.avgX;
            this.touchState.startY = this.touchState.avgY;
            this.touchState.isPan = false;
            this.touchState.isPinch = false
        }

        if (touches.length >= 2)
        {
            if (!this.touchState.isPan)
            {
                let dist = Math.hypot(
                    touches[0].clientX - touches[1].clientX,
                    touches[0].clientY - touches[1].clientY);

                let pinchScaleThreshold = this.touchState.isPinch ? .02 : .1;

                if (reset) {
                    this.touchState.scale = 1.;
                    this.touchState.lastPinchDistance = dist
                }
                else
                {
                    let scale = dist/this.touchState.lastPinchDistance;

                    if (Math.abs(scale-1.) > pinchScaleThreshold)
                    {
                        this.touchState.scale = scale;
                        this.touchState.lastPinchDistance = dist;

                        this.touchState.isPinch = true;
                        this.draggingActive = true
                    }
                    else
                        this.touchState.scale = 1.
                }
            }

            if (!this.touchState.isPinch)
            {
                this.touchState.isPan = this.touchState.isPan || (
                    Math.hypot(
                        this.touchState.avgX - this.touchState.startX,
                        this.touchState.avgY - this.touchState.startY) > 20.
                )
            }
        }
    }

    notifyTouchStart(touches) {
        if (!touches.length)
            return;

        this.processTouches(touches, true);

        this.notifyMouseReleased();
        this.notifyMouseMoved(this.touchState.avgX, this.touchState.avgY);

        if (touches.length === 1)
            this.notifyMouseDown(this.platform.mouse.Left);
        else
            this.notifyMouseDown(this.platform.mouse.Right)
    }

    notifyTouchMove(touches) {
        if (!touches.length)
            return;

        this.processTouches(touches, false);
        if (touches.length === 1 || this.touchState.isPan)
            this.notifyMouseMoved(this.touchState.avgX, this.touchState.avgY);
        else if(this.touchState.isPinch && this.touchState.scale !== 1.)
            this.notifyWheel(-Math.log(this.touchState.scale)*18., true)
    };

    notifyTouchEnd(_) {
        this.notifyMouseReleased()
    }
}
