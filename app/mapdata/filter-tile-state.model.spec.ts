import {describe, expect, it} from "vitest";
import type {TileSubsetDelivery} from "./filter-subscription.model";
import {FilterTileState} from "./filter-tile-state.model";

function delivery(): TileSubsetDelivery {
    return {
        blob: new Uint8Array([1, 2, 3]),
        filterId: "styled",
        generation: 2,
        mapId: "Map",
        layerId: "Layer",
        tileId: 42,
        mapTileKey: "Features:Map:Layer:42",
        stringPoolId: "source",
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
        receivedAt: 100
    };
}

describe("FilterTileState", () => {
    it("retains pre-render geometry weight with the immutable subset", () => {
        const state = new FilterTileState(
            "Map",
            "Layer",
            42,
            "Features:Map:Layer:42",
            2
        );

        state.install(delivery());

        expect(state.geometryVertexCount).toBe(12_345);
        expect(state.renderedEntryCount).toBe(7);
        expect(state.sourceFeatureCount).toBe(11);

        state.dispose();
        expect(state.geometryVertexCount).toBe(0);
    });
});
