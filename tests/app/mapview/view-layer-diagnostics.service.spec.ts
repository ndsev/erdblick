import {describe, expect, it} from "vitest";
import {FilterTileState} from "../../../app/mapdata/filter-tile-state.model";
import {tilePartition} from "../../../app/mapdata/partition.model";
import {ViewLayerDiagnosticsService} from "../../../app/mapview/view-layer-diagnostics.service";

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
        state.info = new Proxy({}, {
            ownKeys: () => {
                throw new Error("Progress must not enumerate detailed tile statistics.");
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

describe("point-cloud tile warnings", () => {
    const warning = "One or more point-cloud objects were downsampled for visualization. Inspection and export retain the original points.";

    /** Register one current cloud tile and capture the ordinary warning events. */
    function setup() {
        const service = new ViewLayerDiagnosticsService();
        const state = new FilterTileState("Map", "PointCloudObject", tilePartition(42), "Features:Map:PointCloudObject:42", 1);
        state.status = "ready";
        state.valueVersion = state.renderedValueVersion = 1;
        const layer = {ownerId: "regular", identity: {presentationKind: "regular"},
            tileStates: new Map([[state.partitionKey, state]]), latestStatus: null} as any;
        service.register(0, () => [layer]);
        const messages: string[] = [];
        service.tileWarning.subscribe(event => messages.push(event.message));
        return {service, state, messages};
    }

    it.each([
        {stage: "backend", source: 201, delivered: 8, workerInput: 8, rendered: 8},
        {stage: "worker", source: 201, delivered: 201, workerInput: 201, rendered: 8},
        {stage: "both", source: 201, delivered: 8, workerInput: 8, rendered: 4}
    ])("reports one nonfatal warning for $stage sampling", ({source, delivered, workerInput, rendered}) => {
        const {service, state, messages} = setup();
        state.info = {"PointCloud/SourceRecords": source, "PointCloud/DeliveredRecords": delivered};
        state.renderStats = {pointCloudDeliveredCount: workerInput, pointCloudRenderedCount: rendered};

        expect(service.currentSummary()).toMatchObject({ready: 1, errors: 0});
        expect(service.currentTiles()[0]).toMatchObject({mapTileKey: state.mapTileKey, warnings: [warning]});
        service.notifyChanged();
        service.currentSummary();
        expect(messages).toEqual([warning]);
        expect(state.warnings).toEqual([]); // Source warnings remain unchanged.
    });

    it.each([0, 8, 14_000_000, 25_127_298])("does not warn for %i unchanged points", count => {
        const {service, state, messages} = setup();
        state.info = {"PointCloud/SourceRecords": count, "PointCloud/DeliveredRecords": count};
        state.renderStats = {pointCloudDeliveredCount: count, pointCloudRenderedCount: count};
        service.currentSummary();
        expect(service.currentTiles()[0].warnings).toEqual([]);
        expect(messages).toEqual([]);
    });

    it("logs a late worker warning without repeating earlier tile warnings", () => {
        const {service, state, messages} = setup();
        state.warnings = ["An existing source warning"];
        service.currentSummary();
        expect(messages).toEqual(state.warnings);

        state.renderStats = {pointCloudDeliveredCount: 201, pointCloudRenderedCount: 8};
        service.notifyChanged();
        service.currentSummary();
        service.notifyChanged();
        service.currentSummary();
        expect(messages).toEqual([...state.warnings, warning]);
        expect(service.currentTiles()[0].warnings).toEqual([...state.warnings, warning]);
    });

    it("clears sampling warnings with an exact replacement and warns again for a later sampled value", () => {
        const {service, state, messages} = setup();
        state.info = {"PointCloud/SourceRecords": 201, "PointCloud/DeliveredRecords": 8};
        state.renderStats = {pointCloudDeliveredCount: 8, pointCloudRenderedCount: 4};
        service.currentSummary();

        state.valueVersion++;
        state.info = {};
        state.renderStats = {};
        service.notifyChanged();
        service.currentSummary();
        expect(service.currentTiles()[0].warnings).toEqual([]);
        expect(messages).toEqual([warning]);

        state.valueVersion++;
        state.info = {"PointCloud/SourceRecords": 201, "PointCloud/DeliveredRecords": 8};
        service.notifyChanged();
        service.currentSummary();
        expect(messages).toEqual([warning, warning]);
        state.dispose();
        service.notifyChanged();
        expect(service.currentTiles()[0].warnings).toEqual([]);
    });
});
