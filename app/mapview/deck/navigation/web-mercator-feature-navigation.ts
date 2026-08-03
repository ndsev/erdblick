import {WebMercatorViewport} from "@deck.gl/core";
import type {NavigationAnchor, NavigationScreenPosition} from "./feature-navigation.types";

/** Vertical field of view shared by map rendering and camera-state conversion. */
export const DECK_MAP_FOV_DEGREES = 60;

/** Near-plane scale chosen to support close navigation without sacrificing excessive depth precision. */
export const DECK_MAP_NEAR_Z_MULTIPLIER = 0.01;

/** deck.gl's horizon-aware far-plane scale. */
export const DECK_MAP_FAR_Z_MULTIPLIER = 1.01;

/** Closest physical camera distance allowed while zooming around a rendered feature. */
export const MIN_NAVIGATION_ANCHOR_DISTANCE_METERS = 1;

/** Normalized front-clip margin used to stop just before a feature reaches the camera. */
export const MIN_NAVIGATION_ANCHOR_DEPTH = 0.3;

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
    const nextViewport = createDeckMapViewport(nextState, width, height, orthographic);
    const center = nextViewport.panByPosition3D(
        navigationAnchorInViewportWorld(anchor, nextViewport),
        pixel
    );
    return {
        ...nextState,
        longitude: center.longitude ?? nextState.longitude,
        latitude: center.latitude ?? nextState.latitude
    };
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
        || projected[2] < MIN_NAVIGATION_ANCHOR_DEPTH
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
