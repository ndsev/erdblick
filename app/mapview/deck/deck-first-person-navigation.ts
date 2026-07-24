import type {Viewport} from "../../../build/libs/core/erdblick-core";

export const FIRST_PERSON_EYE_HEIGHT_METERS = 1.7;
export const FIRST_PERSON_FOV_DEGREES = 60;
export const FIRST_PERSON_NEAR_METERS = 0.1;
export const FIRST_PERSON_FAR_METERS = 1000;
export const FIRST_PERSON_FOCAL_DISTANCE = 1;

const EARTH_RADIUS_METERS = 6378137;
const COVERAGE_PADDING = 1.05;
const MAX_WEB_MERCATOR_LATITUDE = 85.05113;

/** Complete controlled state for one fixed-location first-person camera. */
export interface FixedFirstPersonCameraState {
    longitude: number;
    latitude: number;
    position: [number, number, number];
    bearing: number;
    pitch: number;
    minPitch: number;
    maxPitch: number;
}

/** Builds a horizontal eye-level camera at an exact picked feature position. */
export function createFixedFirstPersonCameraState(
    target: readonly [number, number, number],
    bearing: number
): FixedFirstPersonCameraState {
    return {
        longitude: target[0],
        latitude: target[1],
        position: [0, 0, target[2] + FIRST_PERSON_EYE_HEIGHT_METERS],
        bearing,
        pitch: 0,
        minPitch: -89,
        maxPitch: 89
    };
}

/** Accepts look direction changes while pinning the first-person camera to its entry location. */
export function updateFixedFirstPersonLook(
    current: FixedFirstPersonCameraState,
    next: Pick<FixedFirstPersonCameraState, "bearing" | "pitch">
): FixedFirstPersonCameraState {
    const bearing = Number.isFinite(next.bearing)
        ? (next.bearing % 360 + 360) % 360
        : current.bearing;
    const pitch = Number.isFinite(next.pitch)
        ? Math.max(current.minPitch, Math.min(current.maxPitch, next.pitch))
        : current.pitch;
    return {
        ...current,
        bearing,
        pitch
    };
}

/** Builds the stable all-directions tile footprint retained for a first-person session. */
export function createFirstPersonCoverageViewport(
    target: readonly [number, number, number],
    bearing: number
): Viewport {
    const radiusMeters = FIRST_PERSON_FAR_METERS * COVERAGE_PADDING;
    const latitudeDelta = radiusMeters / EARTH_RADIUS_METERS * 180 / Math.PI;
    const longitudeDelta = latitudeDelta / Math.max(
        0.01,
        Math.cos(target[1] * Math.PI / 180)
    );
    const south = Math.max(-MAX_WEB_MERCATOR_LATITUDE, target[1] - latitudeDelta);
    const north = Math.min(MAX_WEB_MERCATOR_LATITUDE, target[1] + latitudeDelta);
    return {
        west: target[0] - longitudeDelta,
        south,
        width: longitudeDelta * 2,
        height: north - south,
        camPosLon: target[0],
        camPosLat: target[1],
        orientation: -bearing * Math.PI / 180 + Math.PI * 0.5
    };
}
