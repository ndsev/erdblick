import {describe, expect, it, vi} from "vitest";

import {coreLib} from "../integrations/wasm";
import {
    ViewVisualizationState
} from "./view.visualization.model";

describe("ViewVisualizationState", () => {
    it("applies the low-fi LOD0..LOD7 threshold policy per zoom level", () => {
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
        tileIdsForLevel.set(0, Array.from({length: 130}, (_, i) => BigInt(1000 + i)));
        tileIdsForLevel.set(1, Array.from({length: 100}, (_, i) => BigInt(2000 + i)));
        tileIdsForLevel.set(2, Array.from({length: 82}, (_, i) => BigInt(3000 + i)));
        tileIdsForLevel.set(3, Array.from({length: 65}, (_, i) => BigInt(4000 + i)));
        tileIdsForLevel.set(4, Array.from({length: 58}, (_, i) => BigInt(5000 + i)));
        tileIdsForLevel.set(5, Array.from({length: 49}, (_, i) => BigInt(6000 + i)));
        tileIdsForLevel.set(6, Array.from({length: 41}, (_, i) => BigInt(7000 + i)));
        tileIdsForLevel.set(7, Array.from({length: 35}, (_, i) => BigInt(8000 + i)));
        tileIdsForLevel.set(8, Array.from({length: 20}, (_, i) => BigInt(9000 + i)));

        const getTileIdsSpy = vi.spyOn(coreLib as any, "getTileIds")
            .mockImplementation((_viewport: any, level: number, _limit: number) => {
                return tileIdsForLevel.get(level) ?? [];
            });

        try {
            state.recalculateTileIds(999, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
        } finally {
            getTileIdsSpy.mockRestore();
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
