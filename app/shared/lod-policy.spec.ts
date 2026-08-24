import {describe, expect, it} from "vitest";
import {
    clampLod3TileThreshold,
    clampStyleLod,
    DEFAULT_LOD3_TILE_THRESHOLD,
    MAX_LOD3_TILE_THRESHOLD,
    MAX_STYLE_LOD,
    MIN_LOD3_TILE_THRESHOLD,
    MIN_STYLE_LOD
} from "./lod-policy";

describe("style LOD policy", () => {
    it("clamps the configurable LOD 3 density boundary", () => {
        expect(clampLod3TileThreshold("invalid")).toBe(
            DEFAULT_LOD3_TILE_THRESHOLD
        );
        expect(clampLod3TileThreshold(1)).toBe(MIN_LOD3_TILE_THRESHOLD);
        expect(clampLod3TileThreshold(123.9)).toBe(123);
        expect(clampLod3TileThreshold(99999)).toBe(MAX_LOD3_TILE_THRESHOLD);
    });

    it("clamps dynamic style LOD values to the integer ladder", () => {
        expect(clampStyleLod(-1)).toBe(MIN_STYLE_LOD);
        expect(clampStyleLod(4.9)).toBe(4);
        expect(clampStyleLod(99)).toBe(MAX_STYLE_LOD);
    });
});
