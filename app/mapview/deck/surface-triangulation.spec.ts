import {describe, expect, it} from "vitest";
import {
    isValidSurfaceRingTopology,
    surfaceRingNormal,
    triangulateSurfaceIndices
} from "./surface-triangulation";

describe("surface triangulation", () => {
    it("computes stable normals for sloped and vertical surface rings", () => {
        const sloped = surfaceRingNormal(new Float32Array([
            0, 0, 0,
            10, 0, 10,
            10, 10, 10,
            0, 10, 0
        ]), 0, 4);
        const vertical = surfaceRingNormal(new Float32Array([
            0, 0, 0,
            0, 10, 0,
            0, 10, 10,
            0, 0, 10
        ]), 0, 4);

        expect(Math.abs(sloped[0])).toBeCloseTo(Math.SQRT1_2, 6);
        expect(sloped[1]).toBeCloseTo(0, 6);
        expect(Math.abs(sloped[2])).toBeCloseTo(Math.SQRT1_2, 6);
        expect(Math.abs(vertical[0])).toBeCloseTo(1, 6);
        expect(vertical[1]).toBeCloseTo(0, 6);
        expect(vertical[2]).toBeCloseTo(0, 6);
    });

    it("triangulates vertical surfaces by projecting to the dominant plane", () => {
        const indices = triangulateSurfaceIndices({
            positions: new Float32Array([
                0, 0, 0,
                0, 0, 1,
                0, 1, 0
            ]),
            startIndices: new Uint32Array([0, 3])
        });

        expect(indices).toHaveLength(3);
    });

    it("validates per-surface polygon hole metadata", () => {
        const valid = {
            positions: new Float32Array(8 * 3),
            startIndices: new Uint32Array([0, 8]),
            holeIndices: new Uint32Array([4]),
            holeIndexStarts: new Uint32Array([0, 1])
        };

        expect(isValidSurfaceRingTopology(valid, 8)).toBe(true);
        expect(isValidSurfaceRingTopology({
            ...valid,
            holeIndices: new Uint32Array([0])
        }, 8)).toBe(false);
        expect(isValidSurfaceRingTopology({
            ...valid,
            holeIndexStarts: new Uint32Array([1, 1])
        }, 8)).toBe(false);
    });
});
