import {describe, expect, it} from "vitest";
import type {TileSubsetDelivery} from "./filter-subscription.model";
import {FilterTileState} from "./filter-tile-state.model";

function delivery(
    overrides: Partial<TileSubsetDelivery> = {}
): TileSubsetDelivery {
    return {
        blob: new Uint8Array([1, 2, 3]),
        filterId: "styled",
        generation: 2,
        mapId: "Map",
        layerId: "Layer",
        tileId: 42,
        mapTileKey: "Features:Map:Layer:42",
        stringPoolId: "source",
        conversionTimestampMs: 1_725_000_123_456,
        ttlMs: 60_000,
        dependencies: [{
            sourceTileKey: "Features:Map:Layer:42",
            mapId: "Map",
            layerId: "Layer",
            tileId: 42,
            sourceFeatureCount: 11
        }],
        issues: [],
        info: {
            "Filter/Entries/Total#count": 7,
            "Filter/Geometry/Vertices#count": 12_345
        },
        numEntries: 7,
        geometryVertexCount: 12_345,
        glbAttachmentName: "",
        receivedAt: 100,
        ...overrides
    };
}

function state() {
    return new FilterTileState(
        "Map",
        "Layer",
        42,
        "Features:Map:Layer:42",
        2
    );
}

describe("FilterTileState", () => {
    it("retains immutable subset metadata and uses installation as acceptance", () => {
        const tile = state();

        expect(tile.install(delivery())).toBe(true);

        expect(tile.status).toBe("ready");
        expect(tile.backendPending).toBe(false);
        expect(tile.valueVersion).toBe(1);
        expect(tile.geometryVertexCount).toBe(12_345);
        expect(tile.renderedEntryCount).toBe(7);
        expect(tile.sourceFeatureCount).toBe(11);
        expect(tile.conversionTimestampMs).toBe(1_725_000_123_456);
        expect(tile.ttlMs).toBe(60_000);

        tile.dispose();
        expect(tile.geometryVertexCount).toBe(0);
        expect(tile.conversionTimestampMs).toBeNull();
        expect(tile.ttlMs).toBeNull();
    });

    it("keeps a retained blob presentation-ready while replacement work is pending", () => {
        const tile = state();
        const retained = delivery();
        tile.install(retained);

        tile.markPending(2);

        expect(tile.status).toBe("ready");
        expect(tile.backendPending).toBe(true);
        expect(tile.subsetBlob).toBe(retained.blob);
    });

    it("orders same-generation refreshes by absolute expiry in both arrival orders", () => {
        const installOrder = (deadlines: number[]) => {
            const tile = state();
            tile.install(delivery({
                conversionTimestampMs: 0,
                ttlMs: 100
            }));
            tile.markPending(2);
            const installed = deadlines.map(deadline => tile.install(delivery({
                blob: new Uint8Array([deadline / 100]),
                conversionTimestampMs: 0,
                ttlMs: deadline
            })));
            return {tile, installed};
        };

        const freshestFirst = installOrder([300, 200]);
        expect(freshestFirst.installed).toEqual([true, false]);
        expect(freshestFirst.tile.expiresAtMs).toBe(300);
        expect(freshestFirst.tile.valueVersion).toBe(2);

        const freshestLast = installOrder([200, 300]);
        expect(freshestLast.installed).toEqual([true, true]);
        expect(freshestLast.tile.expiresAtMs).toBe(300);
        expect(freshestLast.tile.valueVersion).toBe(3);
    });

    it("rejects equal-lifetime duplicates without advancing the local value version", () => {
        const tile = state();
        tile.install(delivery());

        expect(tile.install(delivery({blob: new Uint8Array([9])}))).toBe(false);
        expect(tile.valueVersion).toBe(1);
        expect(tile.subsetBlob).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("throws before mutation when full tile identity does not match", () => {
        const tile = state();

        expect(() => tile.install(delivery({
            mapTileKey: "Features:Map:Other:42"
        }))).toThrow("Subset identity mismatch");
        expect(tile.subsetBlob).toBeNull();
        expect(tile.valueVersion).toBe(0);
    });
});
