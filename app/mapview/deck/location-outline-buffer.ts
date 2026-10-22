import {lngLatToWorld} from "@math.gl/web-mercator";
import type {LocationPolygon} from "../render-view";

/** Two adjacent records supply one segment; each closed ring ends with a disabled separator. */
export const LOCATION_OUTLINE_RECORD_FLOATS = 10;

/**
 * Preprojects every supplied ring vertex and prepares camera-independent miter joins.
 * Input is the closed, dateline-split, Mercator-clipped output of locationOverlayPolygons.
 * Records contain xy high/low, unit miter xy, miter size, inner-join limit, turn, edge length.
 * The duplicated closing vertex separates rings, so holes and islands never acquire connectors.
 * No coordinates are simplified or discarded. High/low positions preserve detail when zooming in.
 */
export function buildLocationOutlineBuffer(polygons: readonly LocationPolygon[]): Float32Array {
    let count = 0;
    for (const polygon of polygons) for (const ring of polygon) count += ring.length;
    const buffer = new Float32Array(count * LOCATION_OUTLINE_RECORD_FLOATS);
    let cursor = 0;
    for (const polygon of polygons) for (const ring of polygon) {
        const points = ring.map(point => lngLatToWorld(point));
        const last = points.length - 1;
        const firstRecord = cursor;
        for (let index = 0; index < last; index++) {
            const [x, y] = points[index];
            const previous = points[(index + last - 1) % last], next = points[index + 1];
            const ax = x - previous[0], ay = y - previous[1];
            const bx = next[0] - x, by = next[1] - y;
            const lengthA = Math.hypot(ax, ay), lengthB = Math.hypot(bx, by);
            const dirAX = lengthA ? ax / lengthA : 0, dirAY = lengthA ? ay / lengthA : 0;
            const dirBX = lengthB ? bx / lengthB : 0, dirBY = lengthB ? by / lengthB : 0;
            const tangentLength = Math.hypot(dirAX + dirBX, dirAY + dirBY);
            const tangentX = tangentLength ? (dirAX + dirBX) / tangentLength : -dirAY;
            const tangentY = tangentLength ? (dirAY + dirBY) / tangentLength : dirAX;
            const miterX = -tangentY, miterY = tangentX;
            const sinHalf = Math.abs(-miterX * dirAY + miterY * dirAX);
            const cosHalf = Math.abs(dirAX * miterX + dirAY * miterY);
            buffer[cursor] = x;
            buffer[cursor + 1] = y;
            buffer[cursor + 2] = x - buffer[cursor];
            buffer[cursor + 3] = y - buffer[cursor + 1];
            buffer[cursor + 4] = miterX;
            buffer[cursor + 5] = miterY;
            buffer[cursor + 6] = 1 / Math.max(sinHalf, 0.001);
            buffer[cursor + 7] = Math.max(lengthA, lengthB) / Math.max(cosHalf, 0.001);
            // Repeated coordinates retain PathLayer's flat-cap behavior at zero-length neighbors.
            buffer[cursor + 8] = !lengthA || !lengthB ? 0 : dirAX * dirBY >= dirAY * dirBX ? -1 : 1;
            buffer[cursor + 9] = lengthB;
            cursor += LOCATION_OUTLINE_RECORD_FLOATS;
        }
        buffer.copyWithin(cursor, firstRecord, firstRecord + LOCATION_OUTLINE_RECORD_FLOATS);
        buffer[cursor + 9] = -1;
        cursor += LOCATION_OUTLINE_RECORD_FLOATS;
    }
    return buffer;
}
