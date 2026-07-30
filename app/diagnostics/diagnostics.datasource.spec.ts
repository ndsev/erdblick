import {describe, expect, it} from "vitest";
import type {SubsetDiagnosticsTile} from "../mapview/view-layer-diagnostics.service";
import {buildAggregatedPerfStats} from "./diagnostics.perf-aggregation";

function tile(
    tileId: number,
    stats: Array<[string, number[]]>,
    ready = true
): SubsetDiagnosticsTile {
    return {
        viewIndex: 0,
        ownerId: "owner",
        presentationKind: "regular",
        mapName: "Map",
        layerName: "Layer",
        tileId,
        mapTileKey: `Features:Map:Layer:${tileId}`,
        ready,
        error: null,
        sourceFeatureCount: 1,
        renderedEntryCount: 1,
        stats: new Map(stats)
    };
}

describe("performance diagnostics aggregation", () => {
    it("normalizes S4E2 unit suffixes while retaining their display units", () => {
        const result = buildAggregatedPerfStats([
            tile(1, [
                ["Rendering/Filter/Subset-Size#bytes", [1536]],
                ["Rendering/Filter/Process-Entries#ms", [4.5]],
                ["Rendering/WASM/Vertices#count", [12]]
            ])
        ]);

        expect(result).toEqual([
            expect.objectContaining({
                key: "Rendering/Filter/Process-Entries",
                path: ["Rendering", "Filter", "Process-Entries"],
                unit: "ms",
                peak: 4.5,
                average: 4.5
            }),
            expect.objectContaining({
                key: "Rendering/Filter/Subset-Size",
                path: ["Rendering", "Filter", "Subset-Size"],
                unit: "B",
                peak: 1536,
                average: 1536
            }),
            expect.objectContaining({
                key: "Rendering/WASM/Vertices",
                path: ["Rendering", "WASM", "Vertices"],
                unit: "count",
                peak: 12,
                average: 12
            })
        ]);
    });

    it("aggregates ready tiles only and retains deterministic peak tile ids", () => {
        const result = buildAggregatedPerfStats([
            tile(7, [["Rendering/WASM/Total#ms", [2, 6]]]),
            tile(3, [["Rendering/WASM/Total#ms", [6]]]),
            tile(9, [["Rendering/WASM/Total#ms", [100]]], false)
        ]);

        expect(result).toEqual([
            expect.objectContaining({
                key: "Rendering/WASM/Total",
                unit: "ms",
                peak: 6,
                average: 14 / 3,
                peakTileIds: ["7", "3"]
            })
        ]);
    });
});
