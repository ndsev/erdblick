import {WebMercatorViewport} from "@deck.gl/core";
import {altitudeToFovy} from "@math.gl/web-mercator";
import type {NavigationAnchor, NavigationScreenPosition} from "./feature-navigation.types";

/** deck.gl's normalized default map-camera altitude, made explicit for Erdblick's camera contract. */
export const DECK_MAP_DEFAULT_ALTITUDE = 1.5;

/** deck.gl's default vertical map FOV, shared by rendering and camera-state conversion. */
export const DECK_MAP_FOV_DEGREES = altitudeToFovy(DECK_MAP_DEFAULT_ALTITUDE);

/** Near-plane scale kept inside the one-metre physical feature-navigation stop. */
export const DECK_MAP_NEAR_Z_MULTIPLIER = 0.0005;

/** deck.gl's horizon-aware far-plane scale. */
export const DECK_MAP_FAR_Z_MULTIPLIER = 1.01;

/** Closest physical camera distance allowed while zooming around a rendered feature. */
export const MIN_NAVIGATION_ANCHOR_DISTANCE_METERS = 1;

const SAFE_ZOOM_SEARCH_STEPS = 24;
const ANCHOR_SCREEN_CORRECTION_STEPS = 3;
const CAMERA_CENTER_PROBE_DEGREES = 1e-7;
const CAMERA_ZOOM_PROBE = 1e-5;
const ORBIT_POSE_CORRECTION_STEPS = 6;

/** Returns a longitude in the world copy nearest to the supplied reference. */
export function longitudeInNearestWorld(longitude: number, reference: number): number {
    const delta = ((longitude - reference + 180) % 360 + 360) % 360 - 180;
    return reference + delta;
}

/** Camera fields required to construct a deck.gl map viewport. */
export interface DeckMapCameraState {
    longitude: number;
    latitude: number;
    zoom: number;
    minZoom?: number;
    maxZoom?: number;
    pitch: number;
    bearing: number;
}

/** Creates a Web Mercator viewport using Erdblick's single map-projection contract. */
export function createDeckMapViewport(
    state: DeckMapCameraState,
    width: number,
    height: number,
    orthographic: boolean
): WebMercatorViewport {
    return new WebMercatorViewport({
        width,
        height,
        longitude: state.longitude,
        latitude: state.latitude,
        zoom: state.zoom,
        pitch: state.pitch,
        bearing: state.bearing,
        orthographic,
        fovy: DECK_MAP_FOV_DEGREES,
        nearZMultiplier: DECK_MAP_NEAR_Z_MULTIPLIER,
        farZMultiplier: DECK_MAP_FAR_Z_MULTIPLIER
    });
}

/** Resolves an anchor into the repeated-world copy local to a viewport. */
export function navigationAnchorInViewportWorld(
    anchor: NavigationAnchor,
    viewport: WebMercatorViewport
): NavigationAnchor {
    return [
        longitudeInNearestWorld(anchor[0], viewport.longitude),
        anchor[1],
        anchor[2]
    ];
}

/**
 * Applies a camera change while retaining an elevated world position at its screen pixel.
 * Extra state fields are preserved so callers can keep controller limits alongside the camera.
 */
export function viewStateKeepingAnchor<StateT extends DeckMapCameraState>(
    nextState: StateT,
    anchor: NavigationAnchor,
    pixel: NavigationScreenPosition,
    width: number,
    height: number,
    orthographic: boolean
): StateT {
    const initialViewport = createDeckMapViewport(nextState, width, height, orthographic);
    const initialAnchor = navigationAnchorInViewportWorld(anchor, initialViewport);
    const initialCenter = initialViewport.panByPosition3D(initialAnchor, pixel);
    let result = {
        ...nextState,
        longitude: initialCenter.longitude ?? nextState.longitude,
        latitude: initialCenter.latitude ?? nextState.latitude
    };
    // panByPosition3D intentionally uses a local linear approximation. Refine
    // its residual with the actual deck viewport projection, without creating
    // a parallel camera/projection model.
    for (let step = 0; step < ANCHOR_SCREEN_CORRECTION_STEPS; ++step) {
        const viewport = createDeckMapViewport(result, width, height, orthographic);
        const localAnchor = navigationAnchorInViewportWorld(anchor, viewport);
        const projected = viewport.project(localAnchor);
        const errorX = projected[0] - pixel[0];
        const errorY = projected[1] - pixel[1];
        if (Math.hypot(errorX, errorY) <= 1e-4) {
            break;
        }
        const longitudeProbe = createDeckMapViewport(
            {...result, longitude: result.longitude + CAMERA_CENTER_PROBE_DEGREES},
            width,
            height,
            orthographic
        ).project(localAnchor);
        const latitudeProbe = createDeckMapViewport(
            {...result, latitude: result.latitude + CAMERA_CENTER_PROBE_DEGREES},
            width,
            height,
            orthographic
        ).project(localAnchor);
        const dxLongitude = (longitudeProbe[0] - projected[0]) / CAMERA_CENTER_PROBE_DEGREES;
        const dyLongitude = (longitudeProbe[1] - projected[1]) / CAMERA_CENTER_PROBE_DEGREES;
        const dxLatitude = (latitudeProbe[0] - projected[0]) / CAMERA_CENTER_PROBE_DEGREES;
        const dyLatitude = (latitudeProbe[1] - projected[1]) / CAMERA_CENTER_PROBE_DEGREES;
        const determinant = dxLongitude * dyLatitude - dxLatitude * dyLongitude;
        if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) {
            break;
        }
        result = {
            ...result,
            longitude: result.longitude
                + (-errorX * dyLatitude + dxLatitude * errorY) / determinant,
            latitude: result.latitude
                + (dyLongitude * errorX - dxLongitude * errorY) / determinant
        };
    }
    return result;
}

/**
 * Applies a rotation while retaining both the anchor pixel and the physical
 * camera-to-anchor distance.
 *
 * OrbitState keeps target and zoom as independent state. MapState has no target
 * field, so the equivalent map-view operation adjusts its internal zoom only as
 * needed to preserve the orbit radius after deck's requested bearing/pitch.
 */
export function viewStateOrbitingNavigationAnchor<StateT extends DeckMapCameraState>(
    currentState: StateT,
    requestedState: StateT,
    anchor: NavigationAnchor,
    pixel: NavigationScreenPosition,
    width: number,
    height: number,
    orthographic: boolean
): StateT {
    const currentViewport = createDeckMapViewport(
        currentState,
        width,
        height,
        orthographic
    );
    const currentAnchor = navigationAnchorInViewportWorld(anchor, currentViewport);
    const currentViewZ = navigationAnchorViewZ(currentViewport, currentAnchor);
    const targetDistance = navigationAnchorDistanceMeters(currentViewport, currentAnchor);
    if (!Number.isFinite(currentViewZ) || currentViewZ >= 0
        || !Number.isFinite(targetDistance) || targetDistance <= 0) {
        return viewStateKeepingAnchor(
            requestedState,
            anchor,
            pixel,
            width,
            height,
            orthographic
        );
    }

    const minZoom = requestedState.minZoom ?? Number.NEGATIVE_INFINITY;
    const maxZoom = requestedState.maxZoom ?? Number.POSITIVE_INFINITY;
    let candidate: StateT = {
        ...requestedState,
        longitude: currentState.longitude,
        latitude: currentState.latitude,
        zoom: Math.max(minZoom, Math.min(maxZoom, currentState.zoom))
    };
    // OrbitView retains a target's camera-space pose while changing rotation.
    // MapView has no target state, so solve its longitude, latitude, and zoom
    // against deck's own projection until the same screen ray and orbit radius
    // are restored. This selects the in-front solution and avoids the mirrored
    // behind-camera result that panByPosition3D can produce at high pitch.
    for (let step = 0; step < ORBIT_POSE_CORRECTION_STEPS; ++step) {
        const residual = orbitPoseResidual(
            candidate,
            anchor,
            pixel,
            targetDistance,
            width,
            height,
            orthographic
        );
        if (Math.hypot(residual[0], residual[1]) <= 1e-4
            && Math.abs(residual[2]) <= 1e-10) {
            break;
        }
        const probes: Array<[keyof DeckMapCameraState, number]> = [
            ["longitude", CAMERA_CENTER_PROBE_DEGREES],
            ["latitude", CAMERA_CENTER_PROBE_DEGREES],
            ["zoom", CAMERA_ZOOM_PROBE]
        ];
        const jacobian = probes.map(([field, amount]) => {
            const probe = orbitPoseResidual(
                {...candidate, [field]: candidate[field]! + amount},
                anchor,
                pixel,
                targetDistance,
                width,
                height,
                orthographic
            );
            return probe.map((value, row) => (value - residual[row]) / amount);
        });
        const correction = solveThreeByThree(
            [
                [jacobian[0][0], jacobian[1][0], jacobian[2][0]],
                [jacobian[0][1], jacobian[1][1], jacobian[2][1]],
                [jacobian[0][2], jacobian[1][2], jacobian[2][2]]
            ],
            [-residual[0], -residual[1], -residual[2]]
        );
        if (!correction) {
            break;
        }
        candidate = {
            ...candidate,
            longitude: candidate.longitude + correction[0],
            latitude: candidate.latitude + correction[1],
            zoom: Math.max(minZoom, Math.min(maxZoom, candidate.zoom + correction[2]))
        };
    }
    return candidate;
}

/** Returns screen-position and physical-radius error for one candidate orbit pose. */
function orbitPoseResidual<StateT extends DeckMapCameraState>(
    state: StateT,
    anchor: NavigationAnchor,
    pixel: NavigationScreenPosition,
    targetDistance: number,
    width: number,
    height: number,
    orthographic: boolean
): [number, number, number] {
    const viewport = createDeckMapViewport(state, width, height, orthographic);
    const localAnchor = navigationAnchorInViewportWorld(anchor, viewport);
    const projected = viewport.project(localAnchor);
    return [
        projected[0] - pixel[0],
        projected[1] - pixel[1],
        navigationAnchorDistanceMeters(viewport, localAnchor) - targetDistance
    ];
}

/** Transforms a navigation anchor into deck's forward-facing camera depth. */
function navigationAnchorViewZ(
    viewport: WebMercatorViewport,
    anchor: NavigationAnchor
): number {
    const common = viewport.projectPosition(anchor);
    const matrix = viewport.viewMatrix;
    return matrix[2] * common[0]
        + matrix[6] * common[1]
        + matrix[10] * common[2]
        + matrix[14];
}

/** Solves one small linear system with partial pivoting. */
function solveThreeByThree(
    matrix: [[number, number, number], [number, number, number], [number, number, number]],
    values: [number, number, number]
): [number, number, number] | null {
    const rows = matrix.map((row, index) => [...row, values[index]]);
    for (let column = 0; column < 3; ++column) {
        let pivot = column;
        for (let row = column + 1; row < 3; ++row) {
            if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) {
                pivot = row;
            }
        }
        if (!Number.isFinite(rows[pivot][column]) || Math.abs(rows[pivot][column]) <= 1e-12) {
            return null;
        }
        [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
        const scale = rows[column][column];
        for (let index = column; index < 4; ++index) {
            rows[column][index] /= scale;
        }
        for (let row = 0; row < 3; ++row) {
            if (row === column) {
                continue;
            }
            const factor = rows[row][column];
            for (let index = column; index < 4; ++index) {
                rows[row][index] -= factor * rows[column][index];
            }
        }
    }
    return [rows[0][3], rows[1][3], rows[2][3]];
}

/** Returns the physical distance between a viewport camera and a WGS84 navigation anchor. */
export function navigationAnchorDistanceMeters(
    viewport: WebMercatorViewport,
    anchor: NavigationAnchor
): number {
    const localAnchor = navigationAnchorInViewportWorld(anchor, viewport);
    const anchorCommon = viewport.projectPosition(localAnchor);
    const metersPerUnit = viewport.distanceScales.metersPerUnit;
    return Math.hypot(
        (anchorCommon[0] - viewport.cameraPosition[0]) * metersPerUnit[0],
        (anchorCommon[1] - viewport.cameraPosition[1]) * metersPerUnit[1],
        (anchorCommon[2] - viewport.cameraPosition[2]) * metersPerUnit[2]
    );
}

/**
 * Returns whether an anchor is in front of the camera, inside the clip volume,
 * and far enough from the eye for another anchored camera operation.
 */
export function isNavigationAnchorUsable(
    viewport: WebMercatorViewport,
    anchor: NavigationAnchor,
    requireOnScreen = false
): boolean {
    const localAnchor = navigationAnchorInViewportWorld(anchor, viewport);
    const projected = viewport.project(localAnchor);
    if (projected.length < 3 || !projected.every(Number.isFinite)) {
        return false;
    }

    const anchorCommon = viewport.projectPosition(localAnchor);
    const viewMatrix = viewport.viewMatrix;
    const viewZ =
        viewMatrix[2] * anchorCommon[0]
        + viewMatrix[6] * anchorCommon[1]
        + viewMatrix[10] * anchorCommon[2]
        + viewMatrix[14];
    if (viewZ >= 0
        || projected[2] < 0
        || projected[2] > 1
        || navigationAnchorDistanceMeters(viewport, localAnchor) < MIN_NAVIGATION_ANCHOR_DISTANCE_METERS) {
        return false;
    }

    return !requireOnScreen
        || (projected[0] >= 0
            && projected[0] <= viewport.width
            && projected[1] >= 0
            && projected[1] <= viewport.height);
}

/**
 * Applies a feature-anchored camera change and limits zoom-in at the closest
 * safe state instead of allowing a coarse input step to cross the feature.
 */
export function viewStateKeepingSafeNavigationAnchor<StateT extends DeckMapCameraState>(
    currentState: StateT,
    requestedState: StateT,
    anchor: NavigationAnchor,
    pixel: NavigationScreenPosition,
    width: number,
    height: number,
    orthographic: boolean
): StateT {
    const requested = viewStateKeepingAnchor(
        requestedState,
        anchor,
        pixel,
        width,
        height,
        orthographic
    );
    if (requestedState.zoom <= currentState.zoom) {
        return requested;
    }
    const requestedViewport = createDeckMapViewport(requested, width, height, orthographic);
    if (isNavigationAnchorUsable(requestedViewport, anchor)) {
        return requested;
    }

    const current = viewStateKeepingAnchor(
        currentState,
        anchor,
        pixel,
        width,
        height,
        orthographic
    );
    const currentViewport = createDeckMapViewport(current, width, height, orthographic);
    if (!isNavigationAnchorUsable(currentViewport, anchor)) {
        return currentState;
    }

    let safeFraction = 0;
    let unsafeFraction = 1;
    let safeState = current;
    for (let step = 0; step < SAFE_ZOOM_SEARCH_STEPS; step++) {
        const fraction = (safeFraction + unsafeFraction) / 2;
        const candidate = viewStateKeepingAnchor(
            {
                ...requestedState,
                zoom: currentState.zoom
                    + (requestedState.zoom - currentState.zoom) * fraction
            },
            anchor,
            pixel,
            width,
            height,
            orthographic
        );
        const viewport = createDeckMapViewport(candidate, width, height, orthographic);
        if (isNavigationAnchorUsable(viewport, anchor)) {
            safeFraction = fraction;
            safeState = candidate;
        } else {
            unsafeFraction = fraction;
        }
    }
    return safeState;
}
