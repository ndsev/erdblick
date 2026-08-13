import {
    type MapInteractionTargetViewStateContext,
    WebMercatorViewport,
    type WebMercatorTargetViewState
} from "@deck.gl/core";
import {altitudeToFovy} from "@math.gl/web-mercator";
import type {NavigationAnchor, NavigationScreenPosition} from "./feature-navigation.types";

/** deck.gl's normalized default map-camera altitude, made explicit for Erdblick's camera contract. */
export const DECK_MAP_DEFAULT_ALTITUDE = 1.5;

/** deck.gl's default vertical map FOV, shared by rendering and camera-state conversion. */
export const DECK_MAP_FOV_DEGREES = altitudeToFovy(DECK_MAP_DEFAULT_ALTITUDE);

/** Near-plane scale retained by Erdblick's rendering contract. */
export const DECK_MAP_NEAR_Z_MULTIPLIER = 0.0005;

/** deck.gl's horizon-aware far-plane scale. */
export const DECK_MAP_FAR_Z_MULTIPLIER = 1.01;

/** Relative margin that prevents a target from reaching or crossing the near plane. */
export const NAVIGATION_TARGET_NEAR_RELATIVE_EPSILON = 1e-6;

const SAFE_ZOOM_SEARCH_STEPS = 24;
const TARGET_ALIGNMENT_STEPS = 3;
const TARGET_PIXEL_TOLERANCE = 0.1;

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
    position?: [number, number, number];
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
        position: state.position,
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
 * Retains a world position at a requested pixel using deck.gl's public 3D pan operation.
 *
 * This is kept downstream for Erdblick's ground-centred UI commands and orthographic map mode.
 * Perspective feature orbit/zoom uses `WebMercatorViewport#getTargetViewState` below.
 */
export function viewStateKeepingAnchor<StateT extends DeckMapCameraState>(
    nextState: StateT,
    anchor: NavigationAnchor,
    pixel: NavigationScreenPosition,
    width: number,
    height: number,
    orthographic: boolean
): StateT {
    let result = {...nextState};
    for (let step = 0; step < TARGET_ALIGNMENT_STEPS; step++) {
        const viewport = createDeckMapViewport(result, width, height, orthographic);
        const localAnchor = navigationAnchorInViewportWorld(anchor, viewport);
        const projected = viewport.project(localAnchor);
        if (projected.length >= 2
            && projected.every(Number.isFinite)
            && Math.hypot(projected[0] - pixel[0], projected[1] - pixel[1]) <= 1e-4) {
            break;
        }
        const center = viewport.panByPosition3D(localAnchor, pixel);
        if (!Number.isFinite(center.longitude) || !Number.isFinite(center.latitude)) {
            return nextState;
        }
        result = {
            ...result,
            longitude: center.longitude,
            latitude: center.latitude
        };
    }
    return result;
}

/**
 * Returns whether an anchor is finite, in front of the camera, within clipping, and optionally
 * on screen. No product-visible metre clearance is imposed.
 */
export function isNavigationAnchorUsable(
    viewport: WebMercatorViewport,
    anchor: NavigationAnchor,
    requireOnScreen = false
): boolean {
    const info = viewport.getTargetInfo(anchor);
    if (!info
        || !info.isValid
        || !Number.isFinite(info.targetDistance)
        || info.targetDistance <= 0
        || info.cameraDepth < info.near * (1 + NAVIGATION_TARGET_NEAR_RELATIVE_EPSILON)
        || info.cameraDepth >= info.far) {
        return false;
    }
    return !requireOnScreen || info.isVisible;
}

/**
 * Applies Erdblick's product-specific maximal-safe zoom policy around a selected feature.
 *
 * Every probe delegates camera reconstruction to deck.gl. Erdblick owns only the scalar search
 * between current and requested zoom, and accepts the furthest state that remains numerically in
 * front of the near plane. Orthographic MapView retains the stock anchored-pan behavior because
 * the first canonical target-navigation phase is perspective-only.
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
    if (orthographic) {
        return viewStateKeepingAnchor(
            requestedState,
            anchor,
            pixel,
            width,
            height,
            true
        );
    }

    const requested = resolveTargetViewState(
        currentState,
        requestedState,
        anchor,
        pixel,
        width,
        height
    );
    if (requestedState.zoom <= currentState.zoom) {
        return requested ?? currentState;
    }
    if (requested && isTargetAlignedAndUsable(
        createDeckMapViewport(requested, width, height, false),
        anchor,
        pixel
    )) {
        return requested;
    }

    const current = resolveTargetViewState(
        currentState,
        {...requestedState, zoom: currentState.zoom},
        anchor,
        pixel,
        width,
        height
    );
    if (!current || !isTargetAlignedAndUsable(
        createDeckMapViewport(current, width, height, false),
        anchor,
        pixel
    )) {
        return currentState;
    }

    let safeFraction = 0;
    let unsafeFraction = 1;
    let safeState = current;
    for (let step = 0; step < SAFE_ZOOM_SEARCH_STEPS; step++) {
        const fraction = (safeFraction + unsafeFraction) / 2;
        const candidate = resolveTargetViewState(
            currentState,
            {
                ...requestedState,
                zoom: currentState.zoom
                    + (requestedState.zoom - currentState.zoom) * fraction
            },
            anchor,
            pixel,
            width,
            height
        );
        if (candidate && isTargetAlignedAndUsable(
            createDeckMapViewport(candidate, width, height, false),
            anchor,
            pixel
        )) {
            safeFraction = fraction;
            safeState = candidate;
        } else {
            unsafeFraction = fraction;
        }
    }
    return safeState;
}

/**
 * Applies Erdblick's selected-feature close-stop policy to a canonical controller candidate.
 *
 * deck.gl supplies the frozen target acquisition viewport and direct-inverse candidate. Erdblick
 * searches only the scalar zoom interval; every camera reconstruction remains delegated to the
 * public viewport inverse, and core subsequently applies its own constraints and validation.
 */
export function constrainErdblickTargetNavigationViewState(
    context: Readonly<MapInteractionTargetViewStateContext>
): WebMercatorTargetViewState | null {
    const requested = copyTargetViewState(context.requestedViewState);
    if (requested.zoom <= context.currentViewState.zoom) {
        return requested;
    }

    const target = context.target.coordinate as NavigationAnchor;
    const pixel = context.target.screenPosition as NavigationScreenPosition;
    if (canonicalTargetViewStateIsUsable(context, requested, target, pixel)) {
        return requested;
    }

    const currentCandidate = context.sourceViewport.getTargetViewState({
        target,
        screenPosition: pixel,
        bearing: requested.bearing,
        pitch: requested.pitch,
        zoom: context.currentViewState.zoom
    });
    if (!currentCandidate
        || !canonicalTargetViewStateIsUsable(
            context,
            currentCandidate,
            target,
            pixel
        )) {
        return null;
    }

    let safeFraction = 0;
    let unsafeFraction = 1;
    let safeState = currentCandidate;
    for (let step = 0; step < SAFE_ZOOM_SEARCH_STEPS; step++) {
        const fraction = (safeFraction + unsafeFraction) / 2;
        const zoom = context.currentViewState.zoom
            + (requested.zoom - context.currentViewState.zoom) * fraction;
        const candidate = context.sourceViewport.getTargetViewState({
            target,
            screenPosition: pixel,
            bearing: requested.bearing,
            pitch: requested.pitch,
            zoom
        });
        if (candidate
            && canonicalTargetViewStateIsUsable(context, candidate, target, pixel)) {
            safeFraction = fraction;
            safeState = candidate;
        } else {
            unsafeFraction = fraction;
        }
    }
    return copyTargetViewState(safeState);
}

/** Combines generic visibility with deck.gl's accepted target-to-pixel tolerance. */
function isTargetAlignedAndUsable(
    viewport: WebMercatorViewport,
    anchor: NavigationAnchor,
    pixel: NavigationScreenPosition
): boolean {
    const info = viewport.getTargetInfo(anchor);
    return isNavigationAnchorUsable(viewport, anchor)
        && Boolean(info)
        && Math.hypot(
            info!.projectedPosition[0] - pixel[0],
            info!.projectedPosition[1] - pixel[1]
        ) <= TARGET_PIXEL_TOLERANCE;
}

/** Validates a canonical candidate against Erdblick's known perspective MapView contract. */
function canonicalTargetViewStateIsUsable(
    context: Readonly<MapInteractionTargetViewStateContext>,
    candidate: Readonly<WebMercatorTargetViewState>,
    target: NavigationAnchor,
    pixel: NavigationScreenPosition
): boolean {
    const viewport = createDeckMapViewport(
        candidate,
        context.sourceViewport.width,
        context.sourceViewport.height,
        false
    );
    return isTargetAlignedAndUsable(viewport, target, pixel);
}

/** Returns an unfrozen numeric result accepted by the public controller hook. */
function copyTargetViewState(
    state: Readonly<WebMercatorTargetViewState>
): WebMercatorTargetViewState {
    return {
        longitude: state.longitude,
        latitude: state.latitude,
        zoom: state.zoom,
        bearing: state.bearing,
        pitch: state.pitch,
        position: [...state.position]
    };
}

/** Resolves one perspective pose via the public viewport inverse, preserving extra app fields. */
function resolveTargetViewState<StateT extends DeckMapCameraState>(
    currentState: StateT,
    requestedState: StateT,
    anchor: NavigationAnchor,
    pixel: NavigationScreenPosition,
    width: number,
    height: number
): StateT | null {
    const alignedState = viewStateKeepingAnchor(
        currentState,
        anchor,
        pixel,
        width,
        height,
        false
    );
    const sourceViewport = createDeckMapViewport(alignedState, width, height, false);
    const targetInfo = sourceViewport.getTargetInfo(anchor);
    if (!targetInfo) {
        return null;
    }
    const result = sourceViewport.getTargetViewState({
        target: targetInfo.target,
        screenPosition: pixel,
        bearing: requestedState.bearing,
        pitch: requestedState.pitch,
        zoom: requestedState.zoom
    });
    return result ? {...requestedState, ...result} : null;
}
