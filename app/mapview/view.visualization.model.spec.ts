import {describe, expect, it, vi} from "vitest";

import {coreLib} from "../integrations/wasm";
import {
    ViewVisualizationState
} from "./view.visualization.model";

describe("ViewVisualizationState", () => {
    it("applies the low-fi LOD0..LOD7 threshold policy from canonical per-level tile counts", () => {
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

        const tileIdsForLevel = new Map<number, bigint[]>();
        tileIdsForLevel.set(0, [1000n]);
        tileIdsForLevel.set(1, [2000n]);
        tileIdsForLevel.set(2, [3000n]);
        tileIdsForLevel.set(3, [4000n]);
        tileIdsForLevel.set(4, [5000n]);
        tileIdsForLevel.set(5, [6000n]);
        tileIdsForLevel.set(6, [7000n]);
        tileIdsForLevel.set(7, [8000n]);
        tileIdsForLevel.set(8, [9000n]);
        const canonicalTileCountsByLevel = new Map<number, number>([
            [0, 4096],
            [1, 1024],
            [2, 512],
            [3, 256],
            [4, 128],
            [5, 64],
            [6, 32],
            [7, 16],
            [8, 15]
        ]);

        const getTileIdsSpy = vi.spyOn(coreLib as any, "getTileIds")
            .mockImplementation((_viewport: any, level: number, _limit: number) => {
                return tileIdsForLevel.get(level) ?? [];
            });
        const getNumTileIdsForCanonicalCameraSpy = vi.spyOn(coreLib as any, "getNumTileIdsForCanonicalCamera")
            .mockImplementation((altitudeMeters: number, level: number) => {
                expect(altitudeMeters).toBe(1234);
                return canonicalTileCountsByLevel.get(level) ?? 0;
            });

        try {
            state.recalculateTileIds(999, [0, 1, 2, 3, 4, 5, 6, 7, 8], 1234);
        } finally {
            getTileIdsSpy.mockRestore();
            getNumTileIdsForCanonicalCameraSpy.mockRestore();
        }

        const level0Policy = state.getTileRenderPolicy(tileIdsForLevel.get(0)![0]);
        expect(level0Policy).toEqual({
            targetFidelity: "low",
            maxLowFiLod: 0
        });

        expect(state.getTileRenderPolicy(tileIdsForLevel.get(1)![0])).toEqual({
            targetFidelity: "low",
            maxLowFiLod: 1
        });

        expect(state.getTileRenderPolicy(tileIdsForLevel.get(2)![0])).toEqual({
            targetFidelity: "low",
            maxLowFiLod: 2
        });

        expect(state.getTileRenderPolicy(tileIdsForLevel.get(3)![0])).toEqual({
            targetFidelity: "low",
            maxLowFiLod: 3
        });

        expect(state.getTileRenderPolicy(tileIdsForLevel.get(4)![0])).toEqual({
            targetFidelity: "low",
            maxLowFiLod: 4
        });

        expect(state.getTileRenderPolicy(tileIdsForLevel.get(5)![0])).toEqual({
            targetFidelity: "low",
            maxLowFiLod: 5
        });

        expect(state.getTileRenderPolicy(tileIdsForLevel.get(6)![0])).toEqual({
            targetFidelity: "low",
            maxLowFiLod: 6
        });

        expect(state.getTileRenderPolicy(tileIdsForLevel.get(7)![0])).toEqual({
            targetFidelity: "low",
            maxLowFiLod: 7
        });

        const level8Policy = state.getTileRenderPolicy(tileIdsForLevel.get(8)![0]);
        expect(level8Policy).toEqual({
            targetFidelity: "high",
            maxLowFiLod: null
        });
    });
});
