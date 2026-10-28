/**
 * Fit a view to a location area and prepare its outline polygons.
 * Navigation and overlays use the same geographic bounds while the current
 * view remains responsible for transitions and layer lifetime.
 */
import {clipPolygon, cutPolygonByMercatorBounds} from "@math.gl/polygon";
import type {LocationArea, LocationPolygon, RenderRectangle} from "../render-view.model";
import {
    createDeckMapViewport,
    type DeckMapCameraState
} from "./navigation/web-mercator-feature-navigation.adapter";

/** A full 512px world fits even a 1px pane with half its space reserved for padding. */
export const LOCATION_MIN_MAP_ZOOM = -10;
export const LOCATION_MERCATOR_LATITUDE = 85.0511287798066;

/** Splits dateline geometry and clips fill and outlines to the same Mercator domain once per jump. */
export function locationOverlayPolygons(area: LocationArea): LocationPolygon[] {
    const result: LocationPolygon[] = [];
    if (!area.polygons) {
        const {west, east, south, north} = area.rectangle;
        const bottom = Math.max(-LOCATION_MERCATOR_LATITUDE, Math.min(LOCATION_MERCATOR_LATITUDE, south));
        const top = Math.max(-LOCATION_MERCATOR_LATITUDE, Math.min(LOCATION_MERCATOR_LATITUDE, north));
        for (let left = west; left < east;) {
            const world = Math.floor((left + 180) / 360);
            const right = Math.min(east, left + 180, 180 + world * 360);
            result.push([[[left - world * 360, bottom], [right - world * 360, bottom],
                [right - world * 360, top], [left - world * 360, top], [left - world * 360, bottom]]]);
            left = right;
        }
        return result;
    }
    for (const polygon of area.polygons) {
        const positions: number[] = [], holes: number[] = [];
        for (const ring of polygon) {
            if (positions.length) holes.push(positions.length);
            for (let index = 0; index < ring.length; index++) {
                const [lon, lat] = ring[index];
                const previous = ring[index - 1];
                // Explicit full-world edges must survive shortest-path dateline splitting.
                if (previous && Math.abs(lon - previous[0]) >= 360 - 1e-8) {
                    for (let part = 1; part < 4; part++) positions.push(
                        previous[0] + (lon - previous[0]) * part / 4,
                        previous[1] + (lat - previous[1]) * part / 4);
                }
                positions.push(lon, lat);
            }
        }
        for (const part of cutPolygonByMercatorBounds(positions, holes, {size: 2, maxLatitude: LOCATION_MERCATOR_LATITUDE})) {
            const offsets = [0, ...(part.holeIndices ?? []), part.positions.length];
            const rings: LocationPolygon = [];
            for (let ringIndex = 0; ringIndex < offsets.length - 1; ringIndex++) {
                const clipped = clipPolygon(part.positions, [-180, -LOCATION_MERCATOR_LATITUDE, 180, LOCATION_MERCATOR_LATITUDE],
                    {size: 2, startIndex: offsets[ringIndex], endIndex: offsets[ringIndex + 1]});
                if (clipped.length < 6) {
                    if (ringIndex === 0) break;
                    continue; // A hole completely outside the projection has no visible contribution.
                }
                const ring: [number, number][] = [];
                for (let index = 0; index < clipped.length; index += 2) ring.push([clipped[index], clipped[index + 1]]);
                const first = ring[0], last = ring[ring.length - 1];
                if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
                rings.push(ring);
            }
            if (rings.length) result.push(rings);
        }
    }
    return result;
}

/** Fits a ground envelope in the actual projection, preserving orientation when possible. */
export function fitLocationArea(
    bounds: RenderRectangle, current: DeckMapCameraState, width: number, height: number, orthographic: boolean
): DeckMapCameraState | undefined {
    if (![width, height].every(Number.isFinite) || width < 1 || height < 1) return undefined;
    const south = Math.max(-LOCATION_MERCATOR_LATITUDE, Math.min(LOCATION_MERCATOR_LATITUDE, bounds.south));
    const north = Math.max(-LOCATION_MERCATOR_LATITUDE, Math.min(LOCATION_MERCATOR_LATITUDE, bounds.north));
    const padding = Math.min(24, width / 4, height / 4);
    const seed = createDeckMapViewport(current, width, height, true).fitBounds(
        [[bounds.west, south], [bounds.east, north]], {padding, maxZoom: 22, minExtent: 0.000001}
    );
    const base: DeckMapCameraState = {
        longitude: seed.longitude, latitude: seed.latitude, zoom: seed.zoom,
        pitch: orthographic ? 0 : current.pitch, bearing: orthographic ? 0 : current.bearing,
        position: [0, 0, 0]
    };
    const corners = [[bounds.west, south, 0], [bounds.west, north, 0], [bounds.east, north, 0], [bounds.east, south, 0]];
    const fits = (state: DeckMapCameraState): boolean => {
        const viewport = createDeckMapViewport(state, width, height, orthographic);
        return corners.every(corner => {
            const [x, y, z] = viewport.project(corner);
            return [x, y, z].every(Number.isFinite) && z >= -1 && z <= 1
                && x >= padding - 1e-6 && x <= width - padding + 1e-6
                && y >= padding - 1e-6 && y <= height - padding + 1e-6;
        });
    };
    // Ground projection is projective: keeping all envelope corners inside also contains its edges/interior.
    for (const orientation of [base, {...base, pitch: 0, bearing: 0}]) {
        let low = LOCATION_MIN_MAP_ZOOM, high = 22;
        if (!fits({...orientation, zoom: low})) continue;
        for (let iteration = 0; iteration < 40; iteration++) {
            const zoom = (low + high) / 2;
            if (fits({...orientation, zoom})) low = zoom; else high = zoom;
        }
        return {...orientation, zoom: low};
    }
    return undefined;
}
