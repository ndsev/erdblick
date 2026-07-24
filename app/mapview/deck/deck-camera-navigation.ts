import {WebMercatorViewport} from "@deck.gl/core";

/** Vertical field of view shared by map rendering and camera-state conversion. */
export const DECK_MAP_FOV_DEGREES = 60;

/** Near-plane scale chosen to support close inspection without sacrificing excessive depth precision. */
export const DECK_MAP_NEAR_Z_MULTIPLIER = 0.01;

/** deck.gl's horizon-aware far-plane scale. */
export const DECK_MAP_FAR_Z_MULTIPLIER = 1.01;

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const FULL_LONGITUDE_SPAN = 360;

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
