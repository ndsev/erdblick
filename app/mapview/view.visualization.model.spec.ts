import {describe, expect, it, vi} from "vitest";
import {coreLib} from "../integrations/wasm";
import {
    lineSimplificationToleranceMeters,
    ViewVisualizationState
} from "./view.visualization.model";

describe("ViewVisualizationState", () => {
    it("retains canonical tile density separately from visible coverage", () => {
        const state = new ViewVisualizationState();
        const getTileIds = vi.spyOn(coreLib as any, "getTileIds")
            .mockReturnValue([40]);
        const getCanonicalCount = vi.spyOn(
            coreLib as any,
            "getNumTileIdsForCanonicalCamera"
        ).mockReturnValueOnce(127).mockReturnValueOnce(128);
        try {
            state.recalculateTileIds(512, [4], 1234);
            const version = state.coverageVersion;
            state.recalculateTileIds(512, [4], 1200);
            expect(state.coverageVersion).toBe(version);
        } finally {
            getTileIds.mockRestore();
            getCanonicalCount.mockRestore();
        }
        expect(state.canonicalVisibleTileCountPerLevel.get(4)).toBe(128);
    });

    it("deduplicates levels and keeps stable request order", () => {
        const state = new ViewVisualizationState();
        const getTileIds = vi.spyOn(coreLib as any, "getTileIds")
            .mockReturnValue([7, 3]);
        const getCanonicalCount = vi.spyOn(
            coreLib as any,
            "getNumTileIdsForCanonicalCamera"
        ).mockReturnValue(1);
        try {
            state.recalculateTileIds(512, [6, 6], 1000);
            expect(getTileIds.mock.calls.length).toBe(1);
        } finally {
            getTileIds.mockRestore();
            getCanonicalCount.mockRestore();
        }
        expect(state.visibleTileIdsPerLevel.get(6)).toEqual([7, 3]);
        expect(state.getTileOrder(7)).toBe(0);
        expect(state.getTileOrder(3)).toBe(1);
    });

    it("retains request order when camera motion only reprioritizes one set", () => {
        const state = new ViewVisualizationState();
        const getTileIds = vi.spyOn(coreLib as any, "getTileIds")
            .mockReturnValueOnce([7, 3])
            .mockReturnValueOnce([3, 7]);
        const getCanonicalCount = vi.spyOn(
            coreLib as any,
            "getNumTileIdsForCanonicalCamera"
        ).mockReturnValue(1);
        try {
            state.recalculateTileIds(512, [6], 1000);
            const version = state.coverageVersion;
            state.recalculateTileIds(512, [6], 1000);
            expect(state.coverageVersion).toBe(version);
        } finally {
            getTileIds.mockRestore();
            getCanonicalCount.mockRestore();
        }
        expect(state.visibleTileIdsPerLevel.get(6)).toEqual([7, 3]);
        expect(state.getTileOrder(7)).toBe(0);
    });

    it("quantizes sub-pixel line simplification without camera-motion churn", () => {
        expect(lineSimplificationToleranceMeters(null)).toBe(0);
        expect(lineSimplificationToleranceMeters(0.1)).toBe(0);
        expect(lineSimplificationToleranceMeters(14)).toBe(4);
        expect(lineSimplificationToleranceMeters(18)).toBe(4);
        expect(lineSimplificationToleranceMeters(24)).toBe(8);

        const state = new ViewVisualizationState();
        const getTileIds = vi.spyOn(coreLib as any, "getTileIds")
            .mockReturnValue([7]);
        const getCanonicalCount = vi.spyOn(
            coreLib as any,
            "getNumTileIdsForCanonicalCamera"
        ).mockReturnValue(1);
        try {
            state.metersPerPixel = 14;
            state.recalculateTileIds(512, [6], 1000);
            const version = state.coverageVersion;
            state.metersPerPixel = 18;
            state.recalculateTileIds(512, [6], 1000);
            expect(state.coverageVersion).toBe(version);
            state.metersPerPixel = 24;
            state.recalculateTileIds(512, [6], 1000);
            expect(state.coverageVersion).toBe(version + 1);
            expect(state.lineSimplificationToleranceMeters).toBe(8);
        } finally {
            getTileIds.mockRestore();
            getCanonicalCount.mockRestore();
        }
    });

});
