import {describe, expect, it} from "vitest";
import {
    AUTO_TILE_SUBSET_RENDER_WORKER_COUNT,
    clampTileSubsetRenderWorkerCount,
    MAX_TILE_SUBSET_RENDER_WORKER_COUNT
} from "./tile-render-policy";

describe("tile render policy", () => {
    it("preserves zero as automatic worker sizing and clamps explicit counts", () => {
        expect(clampTileSubsetRenderWorkerCount(0)).toBe(
            AUTO_TILE_SUBSET_RENDER_WORKER_COUNT
        );
        expect(clampTileSubsetRenderWorkerCount(7.9)).toBe(7);
        expect(clampTileSubsetRenderWorkerCount(-10)).toBe(0);
        expect(clampTileSubsetRenderWorkerCount(1000)).toBe(
            MAX_TILE_SUBSET_RENDER_WORKER_COUNT
        );
    });

});
