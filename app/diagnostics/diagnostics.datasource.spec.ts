import {describe, expect, it} from "vitest";
import type {SubsetDiagnosticsTile} from "../mapview/view-layer-diagnostics.service";
import {CONVERSION_AGE_UNIT} from "./diagnostics.constants";
import {buildAggregatedPerfStats} from "./diagnostics.perf-aggregation";

function tile(
    tileId: number,
    stats: Array<[string, number[]]>,
    ready = true,
    conversionTimestampMs: number | null = null
): SubsetDiagnosticsTile {
    return {
        viewIndex: 0,
        ownerId: "owner",
        presentationKind: "regular",
        mapName: "Map",
        layerName: "Layer",
        tileId,
        mapTileKey: `Features:Map:Layer:${tileId}`,
        conversionTimestampMs,
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
                average: 4.5,
                min: 4.5
            }),
            expect.objectContaining({
                key: "Rendering/Filter/Subset-Size",
                path: ["Rendering", "Filter", "Subset-Size"],
                unit: "B",
                peak: 1536,
                average: 1536,
                min: 1536
            }),
            expect.objectContaining({
                key: "Rendering/WASM/Vertices",
                path: ["Rendering", "WASM", "Vertices"],
                unit: "count",
                peak: 12,
                average: 12,
                min: 12
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
                min: 2,
                peakTileIds: ["7", "3"]
            })
        ]);
    });

    it("aggregates conversion age as one metric with peak, average, and min", () => {
        const nowMs = 10_000;
        const stats = buildAggregatedPerfStats([
            tile(101, [], true, nowMs - 1_000),
            tile(102, [], true, nowMs - 3_000),
            tile(103, [], true, nowMs - 2_000)
        ], 5, nowMs);

        expect(stats.find(stat => stat.key === "Load+Convert/Age"))
            .toMatchObject({
                unit: CONVERSION_AGE_UNIT,
                peak: 3_000,
                average: 2_000,
                min: 1_000,
                peakTileIds: ["102"]
            });
        expect(stats.find(stat => stat.key === "Load+Convert/Freshness"))
            .toBeUndefined();
    });

    it("ignores pending tiles and tiles without conversion metadata", () => {
        const stats = buildAggregatedPerfStats([
            tile(101, [], true, 8_000),
            tile(102, [], true, null),
            tile(103, [], false, 9_000)
        ], 5, 10_000);
        const age = stats.find(stat => stat.key === "Load+Convert/Age");

        expect(age).toMatchObject({peak: 2_000, average: 2_000, min: 2_000});
        expect(stats).toHaveLength(1);
    });

    it("caps tied peak tile ids at the requested limit", () => {
        const stats = buildAggregatedPerfStats([
            tile(101, [], true, 8_000),
            tile(102, [], true, 8_000),
            tile(103, [], true, 8_000)
        ], 2, 10_000);

        expect(stats.find(stat => stat.key === "Load+Convert/Age")
            ?.peakTileIds).toEqual(["101", "102"]);
    });
});
