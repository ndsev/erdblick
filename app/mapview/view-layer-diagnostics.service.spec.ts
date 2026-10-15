import {describe, expect, it} from "vitest";
import {FilterTileState} from "../mapdata/filter-tile-state.model";
import {tilePartition} from "../mapdata/partition.model";
import {ViewLayerDiagnosticsService} from "./view-layer-diagnostics.service";

describe("ViewLayerDiagnosticsService", () => {
    it("counts a ready subset whose presentation is intentionally suppressed", () => {
        const service = new ViewLayerDiagnosticsService();
        const state = new FilterTileState(
            "TestMap",
            "Road",
            tilePartition(42),
            "Features:TestMap:Road:42",
            1
        );
        state.status = "ready";
        state.valueVersion = 1;
        state.renderedValueVersion = 0;
        const layer = {
            ownerId: "search-density",
            identity: {presentationKind: "search"},
            tileStates: new Map([[state.tileId, state]]),
            latestStatus: null
        } as any;

        service.register(0, () => [layer], () => false);

        expect(service.currentTiles()).toHaveLength(1);
        expect(service.currentTiles()[0].ready).toBe(true);
    });

    it("still waits for rendering when presentation remains demanded", () => {
        const service = new ViewLayerDiagnosticsService();
        const state = new FilterTileState(
            "TestMap",
            "Road",
            tilePartition(42),
            "Features:TestMap:Road:42",
            1
        );
        state.status = "ready";
        state.valueVersion = 1;
        const layer = {
            ownerId: "regular",
            identity: {presentationKind: "regular"},
            tileStates: new Map([[state.tileId, state]]),
            latestStatus: null
        } as any;

        service.register(0, () => [layer], () => true);

        expect(service.currentTiles()[0].ready).toBe(false);
        state.renderedValueVersion = 1;
        service.notifyChanged();
        expect(service.currentTiles()[0].ready).toBe(true);
    });

    it("builds lightweight progress without materializing detailed stats", () => {
        const service = new ViewLayerDiagnosticsService();
        const state = new FilterTileState(
            "TestMap",
            "Road",
            tilePartition(42),
            "Features:TestMap:Road:42",
            1
        );
        state.status = "ready";
        state.valueVersion = 1;
        state.renderedValueVersion = 1;
        state.sourceFeatureCount = 7;
        state.renderStats = {vertexCount: 11};
        Object.defineProperty(state, "info", {
            get: () => {
                throw new Error("Detailed tile info must remain lazy.");
            }
        });
        const layer = {
            ownerId: "regular",
            identity: {presentationKind: "regular"},
            tileStates: new Map([[state.tileId, state]]),
            latestStatus: null
        } as any;

        service.register(0, () => [layer]);

        expect(service.currentSummary()).toEqual({
            expected: 1,
            ready: 1,
            errors: 0,
            sourceFeatures: 7,
            vertices: 11
        });
    });

    it("forwards subset errors without requiring a rich tile scan", () => {
        const service = new ViewLayerDiagnosticsService();
        const state = new FilterTileState(
            "TestMap",
            "Road",
            tilePartition(42),
            "Features:TestMap:Road:42",
            1
        );
        state.fail(1, "broken subset");
        const layer = {
            ownerId: "regular",
            identity: {presentationKind: "regular"},
            tileStates: new Map([[state.tileId, state]]),
            latestStatus: null
        } as any;
        const observed: string[] = [];
        service.tileError.subscribe(error => observed.push(error.message));

        service.notifyLayerErrors(0, layer);

        expect(observed).toEqual(["broken subset"]);
    });

    it("publishes only aggregate camera interaction transitions", () => {
        const service = new ViewLayerDiagnosticsService();
        const observed: boolean[] = [];
        service.cameraInteracting$.subscribe(value => observed.push(value));

        service.setViewInteracting(0, true);
        service.setViewInteracting(1, true);
        service.setViewInteracting(0, false);
        service.setViewInteracting(1, false);

        expect(observed).toEqual([false, true, false]);
        expect(service.cameraInteracting).toBe(false);
    });

    it("clears camera interaction when its registered view is removed", () => {
        const service = new ViewLayerDiagnosticsService();
        const unregister = service.register(3, () => []);
        service.setViewInteracting(3, true);

        unregister();

        expect(service.cameraInteracting).toBe(false);
        expect(service.cameraInteracting$.getValue()).toBe(false);
    });
});


it("keeps warned tiles ready and logs each retained value once", () => {
    const service = new ViewLayerDiagnosticsService();
    const state = new FilterTileState("Map", "Road", tilePartition(42), "Features:Map:Road:42", 1);
    state.status = "ready";
    state.valueVersion = 1;
    state.warnings = ["duplicate Road.7"];
    const layer = {ownerId: "regular", identity: {presentationKind: "regular"},
        tileStates: new Map([[state.partitionKey, state]]), latestStatus: null} as any;
    service.register(0, () => [layer], () => false);
    const messages: string[] = [];
    service.tileWarning.subscribe(warning => messages.push(warning.message));
    expect(service.currentSummary().errors).toBe(0);
    expect(service.currentSummary().ready).toBe(1);
    service.notifyChanged();
    service.currentSummary();
    expect(messages).toEqual(["duplicate Road.7"]);
    expect(service.currentTiles()[0].warnings).toEqual(state.warnings);
    state.valueVersion++;
    state.warnings = [];
    service.notifyChanged();
    expect(service.currentTiles()[0].warnings).toEqual([]);
});
