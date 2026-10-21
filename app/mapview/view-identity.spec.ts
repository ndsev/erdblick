import "@angular/compiler";
import {computed, Injector, runInInjectionContext} from "@angular/core";
import {Subject} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {AppActionService} from "../actions/app-action.service";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import {InspectionStateService} from "../inspection/inspection-state.service";
import {Cartographic} from "../integrations/geo";
import {FeatureWrapper} from "../mapdata/feature-inspection.model";
import {MapLayerStateService} from "../mapdata/map-layer-state.service";
import {createStateOwners, StateOwners} from "../shared/state-test-owners";
import {MapViewStateService} from "./map-view-state.service";
import {ViewLayerDiagnosticsService} from "./view-layer-diagnostics.service";

const systems: StateOwners[] = [];
function fixture(params: Record<string, string> = {}) {
    const router = {events: new Subject(), routerState: {snapshot: {root: {queryParams: params}}},
        navigate: vi.fn().mockResolvedValue(true), getCurrentNavigation: vi.fn()};
    const messages = {showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn()};
    const state = createStateOwners(router as never, messages as never);
    systems.push(state);
    return {state, views: state.views, router, messages};
}
afterEach(() => { systems.splice(0).forEach(system => system.destroy()); localStorage.clear(); });

describe("logical view ownership", () => {
    it("retains cameras, options, search targets and native readers across a reorder", () => {
        const {state, views} = fixture();
        views.numViews = 2;
        const [left, right] = views.viewIds();
        const target = views.captureView(1)!;
        state.layers.layerNames = ["Map/Layer"];
        state.layers.setStyleOptionValues("Map", "Layer", "Style", "opacity", [0.2, 0.8]);
        state.views.cameraViewDataState.next(1, {destination: {lon: 10, lat: 20, alt: 30},
            orientation: {heading: 0, pitch: -1, roll: 0}, position: [0, 0, 0]});
        state.searches.addFeatureSearch({query: "Road", selectedViewIndices: [1]});
        const camera = views.cameraViewDataState.signal(right);
        const saved = camera();
        views.focusedView = 1;
        views.reorderViews([right, left]);
        expect(views.isCurrent(target)).toBe(true);
        expect(views.focusedViewId()).toBe(right);
        expect(views.cameraViewDataState.getValue(0)).toBe(saved);
        expect(camera()).toBe(saved);
        expect(state.layers.styles.get("Map/Layer/Style/opacity")).toEqual([0.8, 0.2]);
        expect(state.searches.featureSearches[0].selectedViewIds).toEqual([right]);
        expect(state.searches.featureSearches[0].selectedViewIndices).toEqual([0]);
    });

    it("keeps the established snapshot encodings distinct from runtime view values", () => {
        const {state, views} = fixture();
        views.marker = true;
        views.mode2dState.next(0, true);
        views.markedPosition = [11, 48, 0];
        const snapshot = state.persistence.exportSnapshot();
        expect(snapshot).toMatchObject({marker: 1, markedPosition: [11, 48, 0], mode2d: [true]});
        expect(snapshot['cameraView']).toEqual([expect.objectContaining({lon: expect.any(Number), lat: expect.any(Number)})]);
        expect(snapshot).not.toHaveProperty('featureSearchState');
    });

    it("copies an explicit source across cameras, style options and selected searches", () => {
        const {state, views} = fixture();
        views.numViews = 2;
        const [left, right] = views.viewIds();
        state.layers.layerNames = ["Map/Layer"];
        state.layers.setStyleOptionValues("Map", "Layer", "Style", "opacity", [0.2, 0.8]);
        views.cameraViewDataState.next(0, {...views.cameraViewDataState.getValue(0), destination: {lon: 1, lat: 2, alt: 300}});
        state.searches.addFeatureSearch({query: "Road", selectedViewIndices: [0]});
        const copy = views.createView(left);
        expect(views.cameraViewDataState.getValue(views.indexOf(copy))).toEqual(views.cameraViewDataState.getValue(0));
        expect(state.layers.styles.get("Map/Layer/Style/opacity")).toEqual([0.2, 0.8, 0.2]);
        expect(state.searches.featureSearches[0].selectedViewIds).toEqual([left, copy]);
        const unselectedCopy = views.createView(right);
        expect(state.searches.featureSearches[0].selectedViewIds).not.toContain(unselectedCopy);
    });

    it("applies a fresh config view count after restoring previously generated IDs", async () => {
        const first = fixture();
        expect(first.state.persistence.seedConfigDefaultState({numberOfViews: 1}, "first")).toEqual([]);
        first.state.persistence.initializePersistence();
        await Promise.resolve();
        const retained = first.views.viewIds()[0];
        first.state.destroy();
        systems.splice(systems.indexOf(first.state), 1);
        const second = fixture();
        expect(second.state.persistence.seedConfigDefaultState({numberOfViews: 2}, "second")).toEqual([]);
        second.state.persistence.initializePersistence();
        expect(second.views.numViews).toBe(2);
        expect(second.views.viewIds()[0]).toBe(retained);
    });

    it("does not reevaluate a native per-view reader when another view changes", () => {
        const {views} = fixture();
        views.numViews = 2;
        let reads = 0;
        const camera = views.cameraViewDataState.signal(views.viewIds()[0]);
        const observer = computed(() => { ++reads; return camera().destination.lon; });
        observer();
        const previous = views.cameraViewDataState.getValue(1);
        views.cameraViewDataState.next(1, {...previous, destination: {...previous.destination, lon: 7}});
        observer();
        expect(reads).toBe(1);
    });

    it("rejects the previous lifetime after an ID is removed and restored", () => {
        const {state, views} = fixture();
        views.numViews = 2;
        const ids = views.viewIds();
        const oldTarget = views.captureView(1)!;
        state.views.retainViews([0], new Map());
        expect(views.isCurrent(oldTarget)).toBe(false);
        views.viewIdsState.next(ids);
        expect(views.captureView(1)!.id).toBe(oldTarget.id);
        expect(views.captureView(1)!.generation).not.toBe(oldTarget.generation);
        expect(views.isCurrent(oldTarget)).toBe(false);
    });

    it("rejects duplicate explicit URL IDs before navigation or any state mutation", async () => {
        const {state, views, router} = fixture();
        state.persistence.initializePersistence();
        const before = state.persistence.exportSnapshot();
        const identity = views.captureView(0)!;
        await expect(state.persistence.replaceUrlState({n: "2", vid: "same,same", m: "1"})).rejects.toThrow();
        expect(router.navigate).not.toHaveBeenCalled();
        expect(state.persistence.exportSnapshot()).toEqual(before);
        expect(views.isCurrent(identity)).toBe(true);
    });

    it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("rejects reserved view ID %s atomically", async id => {
        const {state, views, router} = fixture();
        state.persistence.initializePersistence();
        const previous = views.viewIds();
        expect(() => views.viewIdsState.next([id])).toThrow("Reserved view ID");
        await expect(state.persistence.replaceUrlState({vid: id, m: "1"})).rejects.toThrow("Reserved view ID");
        expect(views.viewIds()).toBe(previous);
        expect(views.marker).toBe(false);
        expect(router.navigate).not.toHaveBeenCalled();
    });

    it("continues startup on invalid IDs and reports the rejected link", () => {
        const {state, views, messages} = fixture({n: "2", vid: "bad", m: "1"});
        state.persistence.initializePersistence();
        expect(state.persistence.ready.getValue()).toBe(true);
        expect(views.numViews).toBe(1);
        expect(views.marker).toBe(false);
        expect(messages.showError).toHaveBeenCalledOnce();
    });

    it("derives URL count from explicit IDs during startup and direct replacement", async () => {
        const {state, views} = fixture({vid: "west,east"});
        state.persistence.initializePersistence();
        expect(views.viewIds()).toEqual(["west", "east"]);
        expect(views.numViews).toBe(2);
        await state.persistence.replaceUrlState({vid: "north,south,central"}, true);
        expect(views.viewIds()).toEqual(["north", "south", "central"]);
        expect(views.numViews).toBe(3);
    });

    it("rejects inconsistent snapshot and config identities before changing any owner", () => {
        const {state, views} = fixture();
        state.persistence.initializePersistence();
        const before = state.persistence.exportSnapshot();
        const lifetime = views.captureView(0)!;
        const conflicting = {marker: true, viewIds: ["explicit"], numberOfViews: 2};
        expect(state.persistence.validateSnapshot(conflicting)).toHaveLength(1);
        expect(state.persistence.importSnapshot(conflicting)).toHaveLength(1);
        expect(state.persistence.replaceSnapshotState(conflicting)).toHaveLength(1);
        expect(state.persistence.seedConfigDefaultState(conflicting, "invalid")).toHaveLength(1);
        expect(state.persistence.exportSnapshot()).toEqual(before);
        expect(views.isCurrent(lifetime)).toBe(true);
    });

    it("derives a missing snapshot count from explicit IDs and applies positional values once", () => {
        const {state, views} = fixture();
        state.persistence.initializePersistence();
        expect(state.persistence.replaceSnapshotState({
            cameraView: [{lon: 10, lat: 20, alt: 30}, {lon: 40, lat: 50, alt: 60}],
            viewIds: ["west", "east"]
        })).toEqual([]);
        expect(views.viewIds()).toEqual(["west", "east"]);
        expect(views.numViews).toBe(2);
        expect(views.cameraViewDataState.getValue(1).destination).toEqual({lon: 40, lat: 50, alt: 60});
    });

    it("creates fresh lifetimes for each full snapshot replacement without IDs", () => {
        const {state, views} = fixture();
        state.persistence.initializePersistence();
        const original = views.captureView(0)!;
        expect(state.persistence.replaceSnapshotState({numberOfViews: 2})).toEqual([]);
        const first = views.viewIds();
        expect(first).toHaveLength(2);
        expect(views.isCurrent(original)).toBe(false);
        expect(state.persistence.replaceSnapshotState({numberOfViews: 2})).toEqual([]);
        expect(views.viewIds().some(id => first.includes(id))).toBe(false);
    });

    it("keeps legacy partial snapshot IDs and omitted camera positions", () => {
        const {state, views} = fixture();
        views.numViews = 2;
        const ids = views.viewIds();
        const camera = {...views.cameraViewDataState.getValue(1), destination: {lon: 4, lat: 5, alt: 6}};
        views.cameraViewDataState.next(1, camera);
        expect(state.persistence.importSnapshot({marker: true})).toEqual([]);
        expect(views.viewIds()).toBe(ids);
        expect(views.cameraViewDataState.getValue(1)).toBe(camera);
        expect(state.persistence.importSnapshot({viewIds: ["first", "second"]})).toEqual([]);
        expect(views.cameraViewDataState.getValue(1)).toEqual(camera);
    });

    it("seeds config identities before positional values regardless of object key order", () => {
        const {state, views} = fixture();
        expect(state.persistence.seedConfigDefaultState({
            cameraView: [{lon: 10, lat: 20, alt: 30}, {lon: 40, lat: 50, alt: 60}],
            viewIds: ["west", "east"]
        }, "config")).toEqual([]);
        expect(views.viewIds()).toEqual(["west", "east"]);
        expect(views.cameraViewDataState.getValue(1).destination).toEqual({lon: 40, lat: 50, alt: 60});
    });

    it("shares one fallback ID mapping across stored arrays and partial legacy camera fields", () => {
        localStorage.setItem("numberOfViews", "2");
        localStorage.setItem("cameraView", JSON.stringify([
            {lon: 11, lat: 22, alt: 33}, {lon: 44, lat: 55, alt: 66}
        ]));
        localStorage.setItem("layerNames", JSON.stringify(["Map/Layer"]));
        localStorage.setItem("Style~0~opacity", "0.2:0.8");
        const {state, views} = fixture({lon: "99,88", m: "1"});
        state.persistence.initializePersistence();
        expect(views.viewIds()).toHaveLength(2);
        expect(new Set(views.viewIds()).size).toBe(2);
        expect(views.cameraViewDataState.getValue(0).destination).toEqual({lon: 99, lat: 22, alt: 33});
        expect(views.cameraViewDataState.getValue(1).destination).toEqual({lon: 88, lat: 55, alt: 66});
        expect(state.layers.styles.get("Map/Layer/Style/opacity")).toEqual(["0.2", "0.8"]);
        expect(new URL(state.url.shareableUrl()).searchParams.get("vid")).toBe(views.viewIds().join(","));
    });
});


describe("view membership preparations", () => {
    it.each(["URL", "snapshot"])("keeps live search targets by ID during a partial %s import", async format => {
        const {state, views} = fixture();
        state.persistence.initializePersistence();
        views.viewIdsState.next(["a", "b"]);
        state.searches.addFeatureSearch({query: "Road", selectedViewIndices: [1]});
        const importIds = async (ids: string[]) => {
            if (format === "URL") await state.persistence.replaceUrlState({vid: ids.join(",")});
            else expect(state.persistence.importSnapshot({viewIds: ids})).toEqual([]);
        };
        await importIds(["b", "c"]);
        expect(state.searches.featureSearches[0].selectedViewIds).toEqual(["b"]);
        await importIds(["a", "c"]);
        expect(state.searches.featureSearches[0].selectedViewIds).toEqual([]);
        await importIds(["b", "c"]);
        expect(state.searches.featureSearches[0].selectedViewIds).toEqual([]);
    });

    it("publishes synchronized camera and projection changes atomically through ordinary owner methods", () => {
        const {views} = fixture();
        views.numViews = 2;
        views.viewSync = ["pos", "proj"];
        const cameras: number[][] = [];
        const modes: boolean[][] = [];
        views.cameraViewDataState.appState.subscribe(() => cameras.push([0, 1].map(index =>
            views.cameraViewDataState.getValue(index).destination.lon)));
        views.mode2dState.appState.subscribe(() => modes.push([0, 1].map(index => views.mode2dState.getValue(index))));
        cameras.length = 0;
        modes.length = 0;
        views.setView(0, Cartographic.fromDegrees(12, 48, 1000));
        views.setProjectionMode(0, true);
        expect(cameras).toEqual([[12, 12]]);
        expect(modes).toEqual([[true, true]]);
    });

    it("inherits source search selection for added views and prunes removed targets", () => {
        const {state, views} = fixture();
        const search = state.searches;
        search.addFeatureSearch({query: "Road", selectedViewIndices: [0]});
        views.numViews = 2;
        const [first, removed] = views.viewIds();
        expect(search.featureSearches[0].selectedViewIds).toEqual([first, removed]);
        views.retainViews([0], new Map());
        expect(search.featureSearches[0].selectedViewIds).toEqual([first]);
        views.numViews = 2;
        const added = views.viewIds()[1];
        expect(added).not.toBe(removed);
        expect(search.featureSearches[0].selectedViewIds).toEqual([first, added]);
        search.patchFeatureSearch(search.featureSearches[0].id, {selectedViewIndices: [0]});
        views.numViews = 3;
        expect(search.featureSearches[0].selectedViewIds).toEqual([first]);
    });

    it("does not enumerate style options or layer records for unrelated preferences", () => {
        const {state, views} = fixture();
        state.layers.layerNames = ["Map/Layer"];
        state.layers.setStyleOptionValues("Map", "Layer", "Style", "opacity", [0.5]);
        const options = state.persistence.store.layers.options();
        const iteration = vi.spyOn(options, Symbol.iterator);
        const entries = vi.spyOn(options, "entries");
        const keys = vi.spyOn(Object, "keys");
        const layerRecords = state.persistence.store.layers.layerVisibility();
        views.marker = true;
        expect(iteration).not.toHaveBeenCalled();
        expect(entries).not.toHaveBeenCalled();
        expect(keys.mock.calls.some(([value]) => value === layerRecords)).toBe(false);
        iteration.mockRestore(); entries.mockRestore(); keys.mockRestore();
    });
});

function pendingFocus() {
    const {state, views} = fixture();
    views.numViews = 2;
    let finish!: (value: FeatureWrapper[]) => void;
    const tiles = {loadFeatures: vi.fn(() => new Promise<FeatureWrapper[]>(resolve => { finish = resolve; }))};
    const move = vi.fn();
    const runtime = {navigationStarted: new Subject(), moveToWgs84PositionTopic: {next: move},
        showsFeatureSearchTileInView: vi.fn(() => true)};
    const injector = Injector.create({providers: [AppActionService,
        {provide: ViewLayerDiagnosticsService, useValue: {}},
        {provide: MapLayerStateService, useValue: state.layers},
        {provide: MapViewStateService, useValue: views},
        {provide: InspectionStateService, useValue: state.inspections}
    ]});
    const selection = runInInjectionContext(injector, () => new InspectionSelectionService(
        state.persistence as never, tiles as never, runtime as never, {registerShortcut: vi.fn()} as never,
        {showError: vi.fn()} as never, {run: (callback: () => void) => callback()} as never));
    const loaded = {featureTile: {tileId: 1n, mapName: "Map", layerName: "Layer"},
        peek: (callback: (value: unknown) => unknown) => callback({
            center: () => ({x: 10, y: 20, z: 0}), boundingRadiusEndPoint: () => ({x: 10, y: 20, z: 0})
        })} as unknown as FeatureWrapper;
    return {views, selection, move, finish: () => finish([loaded])};
}

describe("feature focus through asynchronous loading", () => {
    it("keeps the undefined target's multi-view zoom behavior", async () => {
        const {selection, move, finish} = pendingFocus();
        const pending = selection.focusOnFeature(undefined, {mapTileKey: "Map/Layer/1", featureId: "Road.1"});
        finish(); await pending;
        expect(move.mock.calls.map(([target]) => target.targetView)).toEqual([0, 1]);
    });

    it("follows the logical target through reorder while its feature is loading", async () => {
        const {views, selection, move, finish} = pendingFocus();
        const pending = selection.focusOnFeature(1, {mapTileKey: "Map/Layer/1", featureId: "Road.1"});
        views.reorderViews([...views.viewIds()].reverse());
        finish(); await pending;
        expect(move.mock.calls.map(([target]) => target.targetView)).toEqual([0]);
    });

    it("does not move a restored ID from a previous lifetime", async () => {
        const {views, selection, move, finish} = pendingFocus();
        const ids = views.viewIds();
        const pending = selection.focusOnFeature(1, {mapTileKey: "Map/Layer/1", featureId: "Road.1"});
        views.retainViews([0], new Map());
        views.viewIdsState.next(ids);
        finish(); await pending;
        expect(move).not.toHaveBeenCalled();
    });
});
