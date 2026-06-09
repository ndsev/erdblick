import {describe, expect, it} from "vitest";
import {isValidSurfaceRingTopology, triangulateSurfaceIndices} from "./surface-triangulation";

describe("surface triangulation", () => {
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
