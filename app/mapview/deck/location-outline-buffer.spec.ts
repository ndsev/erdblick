import {describe, expect, it} from "vitest";
import {lngLatToWorld} from "@math.gl/web-mercator";
import {buildLocationOutlineBuffer, LOCATION_OUTLINE_RECORD_FLOATS as STRIDE} from "./location-outline-buffer";
import type {LocationPolygon} from "../render-view";

describe("location outline buffer", () => {
    it("preserves every supplied vertex, including tiny islands, holes and repeated points, without connecting rings", () => {
        const polygons: LocationPolygon[] = [
            [[[10, 50], [11, 50], [11, 51], [10, 50]],
                [[10.1, 50.1], [10.1, 50.2], [10.2, 50.1], [10.1, 50.1]]],
            [[[179.999999, 80], [179.9999991, 80], [179.9999991, 80], [179.9999991, 80.0000001], [179.999999, 80]]]
        ];
        const buffer = buildLocationOutlineBuffer(polygons);
        expect(buffer.length / STRIDE).toBe(polygons.flat().reduce((sum, ring) => sum + ring.length, 0));
        expect(buffer.every(Number.isFinite)).toBe(true);
        let record = 0;
        for (const polygon of polygons) for (const ring of polygon) {
            for (const point of ring) {
                const projected = lngLatToWorld(point);
                expect(buffer[record] + buffer[record + 2]).toBeCloseTo(projected[0], 11);
                expect(buffer[record + 1] + buffer[record + 3]).toBeCloseTo(projected[1], 11);
                record += STRIDE;
            }
            expect(buffer[record - 1]).toBe(-1);
        }
        const tinyIsland = (polygons[0][0].length + polygons[0][1].length) * STRIDE;
        // The first two x high parts coincide, but the low parts and positive edge length retain the island.
        expect(buffer[tinyIsland]).toBe(buffer[tinyIsland + STRIDE]);
        expect(buffer[tinyIsland + 2]).not.toBe(buffer[tinyIsland + STRIDE + 2]);
        expect(buffer[tinyIsland + 9]).toBeGreaterThan(0);
        expect(buffer[tinyIsland + STRIDE + 9]).toBe(0);
    });

    it("accepts an empty overlay without allocating vertices", () => {
        expect(buildLocationOutlineBuffer([]).length).toBe(0);
    });
});
