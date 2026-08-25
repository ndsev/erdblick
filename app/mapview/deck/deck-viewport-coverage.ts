import type {WebMercatorViewport} from "@deck.gl/core";
import {longitudeInNearestWorld} from "./navigation/web-mercator-feature-navigation";

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const FULL_LONGITUDE_SPAN = 360;

/** Geographic rectangle consumed by the native tile-selection viewport. */
export interface ClippedGeographicBounds {
    west: number;
    south: number;
    width: number;
    height: number;
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
