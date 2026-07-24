import {describe, expect, it, vi} from "vitest";
import {coreLib} from "../integrations/wasm";
import {ViewVisualizationState} from "./view.visualization.model";

describe("ViewVisualizationState", () => {
    it("selects stylesheet fidelity from the configured tile threshold", () => {
        const state = new ViewVisualizationState();
        const getTileIds = vi.spyOn(coreLib as any, "getTileIds")
            .mockImplementation((...args: unknown[]) =>
                Number(args[1]) === 4 ? [40] : [50]
            );
        const getCanonicalCount = vi.spyOn(
            coreLib as any,
            "getNumTileIdsForCanonicalCamera"
        ).mockImplementation((...args: unknown[]) =>
            Number(args[1]) === 4 ? 127 : 128
        );
        try {
            state.recalculateTileIds(512, [4, 5], 1234, 128);
        } finally {
            getTileIds.mockRestore();
            getCanonicalCount.mockRestore();
        }
        expect(state.getTileRenderPolicy(40)).toEqual({
            targetFidelity: "high"
        });
        expect(state.getTileRenderPolicy(50)).toEqual({
            targetFidelity: "low"
        });
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

    it("uses conservative low fidelity for unknown tiles", () => {
        expect(new ViewVisualizationState().getTileRenderPolicy(1)).toEqual({
            targetFidelity: "low"
        });
    });

    it("retains an unchanged ordered tile plan instead of rebuilding its caches", () => {
        const state = new ViewVisualizationState();
        state.viewport = {
            south: 0,
            west: 0,
            width: 1,
            height: 1,
            camPosLon: 0,
            camPosLat: 0,
            orientation: 0
        };
        const getTileIdsSpy = vi.spyOn(coreLib, "getTileIds").mockReturnValue([1000, 1001]);
        const getCanonicalCountSpy = vi.spyOn(coreLib, "getNumTileIdsForCanonicalCamera").mockReturnValue(2);

        try {
            expect(state.recalculateTileIds(999, [4], 1234)).toBe(true);
            const firstPlan = state.visibleTileIdsPerLevel;
            expect(state.recalculateTileIds(999, [4], 1234)).toBe(false);
            expect(state.visibleTileIdsPerLevel).toBe(firstPlan);

            getTileIdsSpy.mockReturnValue([1001, 1000]);
            expect(state.recalculateTileIds(999, [4], 1234)).toBe(true);
            expect(state.visibleTileIdsPerLevel).not.toBe(firstPlan);
        } finally {
            getTileIdsSpy.mockRestore();
            getCanonicalCountSpy.mockRestore();
        }
    });
});
