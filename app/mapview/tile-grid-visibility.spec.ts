import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import type {Viewport} from "../../build/libs/core/erdblick-core";
import {coreLib} from "../integrations/wasm";
import {
    autoTileGridLevel,
    coarsenedTileLevel,
    tileGridExtentForLevel,
    tileGridVisibleCellCount
} from "./tile-grid-visibility";

const VIEWPORT: Viewport = {
    south: 35,
    west: -25,
    width: 70,
    height: 35,
    camPosLon: 0,
    camPosLat: 0,
    orientation: 0
};

describe("tile-grid visibility helpers", () => {
    it("coarsens levels from true viewport grid cells instead of a tile-load-limited list", () => {
        const targetCellCount = 64;
        const sourceLevel = 12;
        const sourceCount = tileGridVisibleCellCount(sourceLevel, VIEWPORT, "nds");

        expect(sourceCount).toBeGreaterThan(targetCellCount);

        const effectiveLevel = coarsenedTileLevel(sourceLevel, VIEWPORT, targetCellCount, "nds");

        expect(effectiveLevel).toBeLessThan(sourceLevel);
        expect(tileGridVisibleCellCount(effectiveLevel, VIEWPORT, "nds")).toBeLessThanOrEqual(targetCellCount);
        expect(tileGridVisibleCellCount(effectiveLevel + 1, VIEWPORT, "nds")).toBeGreaterThan(targetCellCount);
    });

    it("keeps the NDS grid twice as wide as the equivalent XYZ row count", () => {
        const ndsExtent = tileGridExtentForLevel(8, VIEWPORT, "nds");
        const xyzExtent = tileGridExtentForLevel(8, VIEWPORT, "xyz");

        expect(ndsExtent?.colCount).toBe((ndsExtent?.rowCount ?? 0) * 2);
        expect(xyzExtent?.colCount).toBe(xyzExtent?.rowCount);
    });

    it.each(["nds", "xyz"] as const)("automatically selects %s level from canonical-camera density", mode => {
        const canonicalCount = vi.spyOn(
            coreLib as any,
            "getNumTileIdsForCanonicalCamera"
        ).mockImplementation((...args: unknown[]) => {
            const level = args[1] as number;
            return level > 9 ? 65 : 64;
        });
        try {
            expect(autoTileGridLevel(12_345, mode)).toBe(9);
            expect(canonicalCount).toHaveBeenCalledWith(12_345, 9);
        } finally {
            canonicalCount.mockRestore();
        }
    });
});
