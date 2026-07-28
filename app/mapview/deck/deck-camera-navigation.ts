import {WebMercatorViewport} from "@deck.gl/core";

/** Vertical field of view shared by map rendering and camera-state conversion. */
export const DECK_MAP_FOV_DEGREES = 60;

/** Near-plane scale chosen to support close inspection without sacrificing excessive depth precision. */
export const DECK_MAP_NEAR_Z_MULTIPLIER = 0.01;

/** deck.gl's horizon-aware far-plane scale. */
export const DECK_MAP_FAR_Z_MULTIPLIER = 1.01;

/** Closest physical camera distance allowed while zooming around a rendered feature. */
export const MIN_FEATURE_PIVOT_DISTANCE_METERS = 1;

/** Normalized front-clip margin used to stop just before a feature reaches the camera. */
export const MIN_FEATURE_PIVOT_DEPTH = 0.3;

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const FULL_LONGITUDE_SPAN = 360;
const SAFE_ZOOM_SEARCH_STEPS = 24;

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
    pitch: number;
    bearing: number;
}

/** Geographic rectangle consumed by the native tile-selection viewport. */
export interface ClippedGeographicBounds {
    west: number;
    south: number;
    width: number;
    height: number;
}

/** Creates a Web Mercator viewport using erdblick's single map-projection contract. */
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

/**
 * Returns a padded ground footprint using deck.gl's far-plane clipping at the horizon.
 * Longitudes stay unwrapped around the supplied center so repeated worlds remain continuous.
 */
export function clippedGeographicBounds(
    viewport: WebMercatorViewport,
    centerLon: number,
    paddingFraction: number
): ClippedGeographicBounds {
    const [rawWest, rawSouth, rawEast, rawNorth] = viewport.getBounds({z: 0});
    const rawWidth = rawEast - rawWest;
    const rawHeight = rawNorth - rawSouth;
    const rawCenter = (rawWest + rawEast) / 2;
    const unwrappedCenter = longitudeInNearestWorld(rawCenter, centerLon);
    const paddedWidth = rawWidth * (1 + 2 * paddingFraction);

    if (paddedWidth >= FULL_LONGITUDE_SPAN) {
        // Once every longitude is visible, a canonical full-world rectangle avoids
        // retaining a projection-dependent width larger than the native tile space.
        return {
            west: centerLon - FULL_LONGITUDE_SPAN / 2,
            south: -WEB_MERCATOR_MAX_LATITUDE,
            width: FULL_LONGITUDE_SPAN,
            height: WEB_MERCATOR_MAX_LATITUDE * 2
        };
    }

    const south = Math.max(
        -WEB_MERCATOR_MAX_LATITUDE,
        rawSouth - rawHeight * paddingFraction
    );
    const north = Math.min(
        WEB_MERCATOR_MAX_LATITUDE,
        rawNorth + rawHeight * paddingFraction
    );
    return {
        west: unwrappedCenter - rawWidth / 2 - rawWidth * paddingFraction,
        south,
        width: paddedWidth,
        height: north - south
    };
}

/**
 * Applies a camera change while retaining an elevated world position at its screen pixel.
 * Extra state fields are preserved so callers can keep controller limits alongside the camera.
 */
export function viewStateKeepingAnchor<StateT extends DeckMapCameraState>(
    nextState: StateT,
    pivot: readonly [number, number, number],
    pixel: readonly [number, number],
    width: number,
    height: number,
    orthographic: boolean
): StateT {
    const nextViewport = createDeckMapViewport(nextState, width, height, orthographic);
    const localPivot: [number, number, number] = [
        longitudeInNearestWorld(pivot[0], nextState.longitude),
        pivot[1],
        pivot[2]
    ];
    const center = nextViewport.panByPosition3D(localPivot, [...pixel]);
    return {
        ...nextState,
        longitude: center.longitude ?? nextState.longitude,
        latitude: center.latitude ?? nextState.latitude
    };
}

/** Resolves a pivot into the repeated-world copy local to a viewport. */
function localFeaturePivot(
    viewport: WebMercatorViewport,
    pivot: readonly [number, number, number]
): [number, number, number] {
    return [
        longitudeInNearestWorld(pivot[0], viewport.longitude),
        pivot[1],
        pivot[2]
    ];
}

/** Returns the physical distance between a viewport camera and a WGS84 feature pivot. */
export function featurePivotDistanceMeters(
    viewport: WebMercatorViewport,
    pivot: readonly [number, number, number]
): number {
    const pivotCommon = viewport.projectPosition(localFeaturePivot(viewport, pivot));
    const metersPerUnit = viewport.distanceScales.metersPerUnit;
    return Math.hypot(
        (pivotCommon[0] - viewport.cameraPosition[0]) * metersPerUnit[0],
        (pivotCommon[1] - viewport.cameraPosition[1]) * metersPerUnit[1],
        (pivotCommon[2] - viewport.cameraPosition[2]) * metersPerUnit[2]
    );
}

/**
 * Returns whether a feature pivot is in front of the camera, inside the clip
 * volume, and far enough from the eye for another anchored camera operation.
 */
export function isFeaturePivotUsable(
    viewport: WebMercatorViewport,
    pivot: readonly [number, number, number],
    requireOnScreen = false
): boolean {
    const localPivot = localFeaturePivot(viewport, pivot);
    const projected = viewport.project(localPivot);
    if (projected.length < 3 || !projected.every(Number.isFinite)) {
        return false;
    }

    const pivotCommon = viewport.projectPosition(localPivot);
    const viewMatrix = viewport.viewMatrix;
    const viewZ =
        viewMatrix[2] * pivotCommon[0]
        + viewMatrix[6] * pivotCommon[1]
        + viewMatrix[10] * pivotCommon[2]
        + viewMatrix[14];
    if (viewZ >= 0
        || projected[2] < MIN_FEATURE_PIVOT_DEPTH
        || projected[2] > 1
        || featurePivotDistanceMeters(viewport, localPivot) < MIN_FEATURE_PIVOT_DISTANCE_METERS) {
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
export function viewStateKeepingSafeFeatureAnchor<StateT extends DeckMapCameraState>(
    currentState: StateT,
    requestedState: StateT,
    pivot: readonly [number, number, number],
    pixel: readonly [number, number],
    width: number,
    height: number,
    orthographic: boolean
): StateT {
    const requested = viewStateKeepingAnchor(
        requestedState,
        pivot,
        pixel,
        width,
        height,
        orthographic
    );
    if (requestedState.zoom <= currentState.zoom) {
        return requested;
    }
    const requestedViewport = createDeckMapViewport(requested, width, height, orthographic);
    if (isFeaturePivotUsable(requestedViewport, pivot)) {
        return requested;
    }

    const current = viewStateKeepingAnchor(
        currentState,
        pivot,
        pixel,
        width,
        height,
        orthographic
    );
    const currentViewport = createDeckMapViewport(current, width, height, orthographic);
    if (!isFeaturePivotUsable(currentViewport, pivot)) {
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
            pivot,
            pixel,
            width,
            height,
            orthographic
        );
        const viewport = createDeckMapViewport(candidate, width, height, orthographic);
        if (isFeaturePivotUsable(viewport, pivot)) {
            safeFraction = fraction;
            safeState = candidate;
        } else {
            unsafeFraction = fraction;
        }
    }
    return safeState;
}
