/**
 * Convert geolocation provider shapes into the points, extents and polygons
 * used for navigation. Keeping these calculations independent of the provider
 * service lets both result display and navigation consume the same geometry.
 */
import type {LocationPolygon, RenderRectangle} from "../mapview/render-view.model";

/** Matches the server's decoded-vertex ceiling; validation also bounds ring allocation. */
const MAX_BOUNDARY_VERTICES = 1_000_000;

/** Reads a finite WGS84 longitude/latitude pair without coercing nulls into coordinates. */
export function locationPoint(value: unknown): [number, number] | undefined {
    if (!Array.isArray(value) || value.length < 2) return undefined;
    const [lon, lat] = value;
    return typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat)
        && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90 ? [lon, lat] : undefined;
}

/** Converts origin/size metadata to a positive-area rectangle, retaining eastward wrapping. */
export function locationExtent(value: unknown): RenderRectangle | undefined {
    if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1])) return undefined;
    const origin = locationPoint(value[0]);
    const [width, height] = value[1];
    if (!origin || value[1].length !== 2 || typeof width !== "number" || typeof height !== "number"
        || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || width > 360 || height <= 0
        || origin[1] + height > 90) return undefined;
    return {west: origin[0], south: origin[1], east: origin[0] + width, north: origin[1] + height};
}

/** Validates a complete boundary once; malformed holes/components reject the whole geometry. */
export function locationPolygons(value: unknown): LocationPolygon[] | undefined {
    if (!value || typeof value !== "object") return undefined;
    const geometry = value as {type?: unknown; coordinates?: unknown};
    const raw = geometry.type === "Polygon" ? [geometry.coordinates]
        : geometry.type === "MultiPolygon" ? geometry.coordinates : undefined;
    if (!Array.isArray(raw) || !raw.length || raw.length > MAX_BOUNDARY_VERTICES / 4) return undefined;
    const polygons: LocationPolygon[] = [];
    let vertices = 0;
    for (const polygon of raw) {
        if (!Array.isArray(polygon) || !polygon.length || polygon.length > MAX_BOUNDARY_VERTICES / 4) return undefined;
        const rings: LocationPolygon = [];
        for (const ring of polygon) {
            if (!Array.isArray(ring) || ring.length < 4 || (vertices += ring.length) > MAX_BOUNDARY_VERTICES) return undefined;
            const points: [number, number][] = [];
            const distinct: [number, number][] = [];
            for (const coordinate of ring) {
                const point = locationPoint(coordinate);
                if (!point) return undefined;
                points.push(point);
                if (distinct.length < 3 && !distinct.some(p => p[0] === point[0] && p[1] === point[1])) distinct.push(point);
            }
            const first = points[0], last = points[points.length - 1];
            if (distinct.length < 3 || first[0] !== last[0] || first[1] !== last[1]) return undefined;
            let twiceArea = 0;
            for (let index = 1; index < points.length; index++) {
                twiceArea += points[index - 1][0] * points[index][1] - points[index][0] * points[index - 1][1];
            }
            if (twiceArea === 0) return undefined;
            rings.push(points);
        }
        polygons.push(rings);
    }
    return polygons;
}

/** Contains every component; metadata may disambiguate a short dateline-crossing envelope. */
export function locationGeometryExtent(polygons: LocationPolygon[], metadata?: RenderRectangle): RenderRectangle {
    let west = metadata?.west ?? Infinity, east = metadata?.east ?? -Infinity;
    let south = metadata?.south ?? Infinity, north = metadata?.north ?? -Infinity;
    const center = metadata ? (west + east) / 2 : 0;
    let fullWorld = metadata ? east - west >= 360 : false;
    for (const polygon of polygons) for (const ring of polygon) {
        for (let index = 0; index < ring.length; index++) {
            const [rawLon, lat] = ring[index];
            const lon = metadata ? rawLon + 360 * Math.round((center - rawLon) / 360) : rawLon;
            west = Math.min(west, lon); east = Math.max(east, lon);
            south = Math.min(south, lat); north = Math.max(north, lat);
            if (index && Math.abs(rawLon - ring[index - 1][0]) > 180 && (!metadata || metadata.east <= 180)) {
                // Without an explicitly wrapped box, preserve full-world edges and polar interiors.
                fullWorld = true;
            }
        }
    }
    if (fullWorld || east - west > 360) { west = -180; east = 180; }
    return {west, south, east, north};
}
