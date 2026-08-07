import {describe, expect, it, vi} from "vitest";
import {FilterTileState} from "./filter-tile-state.model";
import {StyledMapgetLayer} from "./styled-mapget-layer.model";

describe("StyledMapgetLayer presentation refs", () => {
    it("keeps a retired subset until the final presentation ref is released", () => {
        const layer = Object.create(StyledMapgetLayer.prototype) as any;
        layer.disposed = false;
        layer.retiredTileStates = new Map();
        layer.tileStatePresentationRefs = new Map();

        const state = new FilterTileState(
            "map",
            "layer",
            42,
            "map/layer/42",
            1
        );
        state.subsetBlob = new Uint8Array([1, 2, 3]);

        layer.retainTileState(state);
        layer.retainTileState(state);
        layer.retiredTileStates.set(state.tileId, state);
        layer.disposeRetiredTileStates();

        expect(state.subsetBlob).not.toBeNull();
        layer.releaseTileState(state);
        expect(state.subsetBlob).not.toBeNull();
        layer.releaseTileState(state);
        expect(state.subsetBlob).toBeNull();
        expect(layer.retiredTileStates.size).toBe(0);
    });

    it("gives overlapping presentations independently releasable attachment refs", () => {
        const first = {key: "first"};
        const second = {key: "second"};
        const retainTileAttachment = vi.fn()
            .mockReturnValueOnce(first)
            .mockReturnValueOnce(second);
        const layer = Object.create(StyledMapgetLayer.prototype) as any;
        layer.disposed = false;
        layer.mapgetLayer = {
            sourceId: "source",
            mapId: "map",
            layerId: "layer"
        };
        layer.tileStream = {retainTileAttachment};
        const state = new FilterTileState(
            "map",
            "layer",
            42,
            "map/layer/42",
            1
        );

        expect(layer.retainAttachment(state, "mesh.glb")).toBe(first);
        expect(layer.retainAttachment(state, "mesh.glb")).toBe(second);
        expect(retainTileAttachment).toHaveBeenCalledTimes(2);
        expect(retainTileAttachment).toHaveBeenLastCalledWith({
            sourceId: "source",
            mapId: "map",
            layerId: "layer",
            tileId: 42,
            name: "mesh.glb"
        });
    });
});
