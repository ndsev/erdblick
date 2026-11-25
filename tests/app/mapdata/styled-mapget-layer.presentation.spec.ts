import {Subject} from "rxjs";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import {FilterTileState} from "../../../app/mapdata/filter-tile-state.model";
import {StyledMapgetLayer} from "../../../app/mapdata/styled-mapget-layer.presentation";
import {partitionKey, tilePartition} from "../../../app/mapdata/partition.model";

describe("StyledMapgetLayer presentation refs", () => {
    it.each(["", "survey"])("installs point highlights only for the requested source and partition: %j", sourceId => {
        const key = "Features:map:layer:42";
        const state = {mapTileKey: key, install: vi.fn(() => true), valueVersion: 1};
        const layer = Object.assign(Object.create(StyledMapgetLayer.prototype), {
            pointSourceId: sourceId, filterRef: {generation: 1},
            tileStates: new Map([["tile", state]]), events: new Subject()
        });
        const deliver = (sourceTileKey: string, deliveredSource: string) => layer.acceptTile({
            generation: 1, partitionKey: "tile",
            dependencies: [{sourceTileKey, sourceId: deliveredSource}]
        }, false);
        expect(deliver(key, "other")).toEqual({status: "superseded"});
        expect(deliver("Features:map:layer:43", sourceId)).toEqual({status: "superseded"});
        expect(state.install).not.toHaveBeenCalled();
        expect(deliver(key, sourceId)).toEqual({status: "accepted", valueVersion: 1});
        expect(state.install).toHaveBeenCalledOnce();
    });

    it("publishes one removal event for a complete coverage delta", () => {
        const layer = Object.create(StyledMapgetLayer.prototype) as any;
        const first = new FilterTileState(
            "map", "layer", tilePartition(41), "map/layer/41", 1
        );
        const second = new FilterTileState(
            "map", "layer", tilePartition(42), "map/layer/42", 1
        );
        layer.disposed = false;
        layer.coverage = {
            partitions: [tilePartition(41), tilePartition(42)]
        };
        layer.coverageVersionValue = 0;
        layer.tileStates = new Map([
            [partitionKey(first.partition), first],
            [partitionKey(second.partition), second]
        ]);
        layer.retiredTileStates = new Map();
        layer.tileStatePresentationRefs = new Map();
        layer.events = new Subject();
        layer.filterRef = {
            generation: 1,
            suspended: false,
            setCoverage: vi.fn()
        };
        const events: unknown[] = [];
        layer.events.subscribe((event: unknown) => events.push(event));

        layer.setCoverage([]);

        expect(events).toEqual([{
            type: "tiles-removed",
            states: [first, second]
        }]);
        expect(layer.retiredTileStates).toEqual(new Map([
            [partitionKey(first.partition), first],
            [partitionKey(second.partition), second]
        ]));
    });

    it("keeps a retired subset until the final presentation ref is released", () => {
        const layer = Object.create(StyledMapgetLayer.prototype) as any;
        layer.disposed = false;
        layer.retiredTileStates = new Map();
        layer.tileStatePresentationRefs = new Map();

        const state = new FilterTileState(
            "map",
            "layer",
            tilePartition(42),
            "map/layer/42",
            1
        );
        state.subsetBlob = new Uint8Array([1, 2, 3]);

        layer.retainTileState(state);
        layer.retainTileState(state);
        layer.retiredTileStates.set(state.partitionKey, state);
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
            tilePartition(42),
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
            partition: tilePartition(42),
            name: "mesh.glb",
            incarnation: 0
        });
    });
});
