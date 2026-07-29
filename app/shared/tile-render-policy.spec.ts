import {describe, expect, it} from "vitest";
import {
    AUTO_TILE_SUBSET_RENDER_WORKER_COUNT,
    clampRenderBlockVertexLimit,
    clampTileSubsetRenderWorkerCount,
    DEFAULT_RENDER_BLOCK_VERTEX_LIMIT,
    MAX_RENDER_BLOCK_VERTEX_LIMIT,
    MAX_TILE_SUBSET_RENDER_WORKER_COUNT,
    MIN_RENDER_BLOCK_VERTEX_LIMIT
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

    it("clamps aggregate block budgets while retaining a useful default", () => {
        expect(clampRenderBlockVertexLimit(undefined)).toBe(
            DEFAULT_RENDER_BLOCK_VERTEX_LIMIT
        );
        expect(clampRenderBlockVertexLimit(1)).toBe(
            MIN_RENDER_BLOCK_VERTEX_LIMIT
        );
        expect(clampRenderBlockVertexLimit(12345.9)).toBe(12345);
        expect(clampRenderBlockVertexLimit(Number.MAX_SAFE_INTEGER)).toBe(
            MAX_RENDER_BLOCK_VERTEX_LIMIT
        );
    });
});
