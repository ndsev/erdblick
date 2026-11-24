import type {SpatialExtentBounds} from "../mapdata/spatial-extent.model";
import type {RenderRectangle} from "./render-view.model";

/** Fit complete intervals, preserving wide regions and their dateline crossings. */
export function spatialExtentEnvelope(bounds: readonly SpatialExtentBounds[]): RenderRectangle | null {
    if (!bounds.length) return null;
    let south = Infinity, north = -Infinity;
    for (const bound of bounds) { south = Math.min(south, bound[1]); north = Math.max(north, bound[3]); }
    const intervals: Array<[number, number]> = [];
    for (const [west, , rawEast] of bounds) {
        const width = rawEast >= west ? rawEast - west : rawEast + 360 - west;
        if (width >= 360) return {west: -180, east: 180, south, north};
        const start = ((west + 180) % 360 + 360) % 360;
        intervals.push([start, Math.min(360, start + width)]);
        if (start + width > 360) intervals.push([0, start + width - 360]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const interval of intervals) {
        const last = merged.at(-1);
        if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
        else merged.push([...interval]);
    }
    let gap = -1, start = 0;
    for (let index = 0; index < merged.length; ++index) {
        const next = merged[(index + 1) % merged.length][0] + (index + 1 === merged.length ? 360 : 0);
        if (next - merged[index][1] > gap) {gap = next - merged[index][1]; start = next % 360;}
    }
    return {west: start - 180, east: start - 180 + 360 - gap, south, north};
}

/** Union compact tile rectangles without enumerating their potentially millions of cells. */
export function unionSpatialTileRectangles(rectangles: readonly SpatialExtentBounds[]): SpatialExtentBounds[] {
    const events = new Map<number, Array<{rectangle: SpatialExtentBounds; add: boolean}>>();
    for (const rectangle of rectangles) {
        for (const [edge, add] of [[rectangle[1], true], [rectangle[3], false]] as const) {
            const changes = events.get(edge) ?? [];
            changes.push({rectangle, add}); events.set(edge, changes);
        }
    }
    const edges = [...events.keys()].sort((a, b) => a - b);
    const active = new Set<SpatialExtentBounds>();
    const result: SpatialExtentBounds[] = [];
    let previous = new Map<string, SpatialExtentBounds>();
    for (let row = 1; row < edges.length; ++row) {
        const south = edges[row - 1], north = edges[row];
        for (const {rectangle, add} of events.get(south)!) {
            if (add) active.add(rectangle); else active.delete(rectangle);
        }
        const spans = [...active].map(rect => [rect[0], rect[2]]).sort((a, b) => a[0] - b[0]);
        const merged: number[][] = [];
        for (const span of spans) {
            const last = merged.at(-1);
            if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
            else merged.push(span);
        }
        const next = new Map<string, SpatialExtentBounds>();
        for (const [west, east] of merged) {
            const key = `${west}:${east}`;
            const existing = previous.get(key);
            const rectangle: SpatialExtentBounds = existing ?? [west, south, east, north];
            rectangle[3] = north;
            if (!existing) result.push(rectangle);
            next.set(key, rectangle);
        }
        previous = next;
    }
    return result;
}
