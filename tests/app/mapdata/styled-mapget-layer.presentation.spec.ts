import {spatialPolicyHarness} from "../../support/spatial-policy";
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
    it("publishes one removal event for a complete coverage delta", () => {
        const layer = Object.create(StyledMapgetLayer.prototype) as any;
        const first = new FilterTileState(
            "map", "layer", tilePartition(41), "map/layer/41", 1
        );
        const second = new FilterTileState(
            "map", "layer", tilePartition(42), "map/layer/42", 1
        );
        layer.disposed = false;
        layer.mapInfo = spatialPolicyHarness();
        layer.identity = {viewIndex: 0};
        layer.requestContext = spatialPolicyHarness().spatialRequestContext();
        layer.mapgetLayer = {mapId: "map", layerId: "layer"};
        layer.coverage = {
            partitions: [tilePartition(41), tilePartition(42)]
        };
        layer.coverageVersionValue = 0;
        layer.tileStates = new Map([
            [partitionKey(first.partition), first],
            [partitionKey(second.partition), second]
        ]);
        layer.retiredTileStates = new Map();
        layer.obsoleteTileStates = new Set();
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
        layer.obsoleteTileStates = new Set();
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

    it("never restores an old-policy subset even while its presentation still pins it", () => {
        const context = spatialPolicyHarness().spatialRequestContext();
        const old = new FilterTileState("map", "layer", tilePartition(131073), "Features:map:layer:131073", 1);
        old.subsetBlob = new Uint8Array([1]);
        const layer = Object.assign(Object.create(StyledMapgetLayer.prototype), {
            disposed: false, explicitRequestContext: true, requestContext: context,
            mapInfo: spatialPolicyHarness(), mapgetLayer: {mapId: "map", layerId: "layer"},
            filterPlan: {channels: []}, options: {}, events: new Subject(),
            coverage: {partitions: [tilePartition(131073)]}, coverageVersionValue: 0,
            tileStates: new Map([[old.partitionKey, old]]), retiredTileStates: new Map(),
            obsoleteTileStates: new Set(), tileStatePresentationRefs: new Map(),
            filterRef: {generation: 2, replace: vi.fn(), setCoverage: vi.fn(), isPending: () => true}
        }) as StyledMapgetLayer;
        layer.retainTileState(old);
        layer.setSpatialRequestContext({...context, revision: "changed"});
        layer.setPartitionCoverage([tilePartition(131073)]);
        expect(layer.tileStates.get(old.partitionKey)).not.toBe(old);
        expect(layer.tileStates.get(old.partitionKey)?.subsetBlob).toBeNull();
        expect(old.subsetBlob).not.toBeNull();
        layer.releaseTileState(old);
        expect(old.subsetBlob).toBeNull();
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
