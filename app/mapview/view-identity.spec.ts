import "@angular/compiler";
import {afterEach, describe, expect, it, vi} from "vitest";
import {computed, Injector, runInInjectionContext} from "@angular/core";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import {InspectionStateService} from "../inspection/inspection-state.service";
import {FeatureWrapper} from "../mapdata/feature-inspection.model";
import {Subject} from "rxjs";
import {createStateTestSystem, StateTestSystem} from "../shared/state-test-system";
import {MapViewStateService} from "./map-view-state.service";
import {FeatureSearchService} from "../search/feature.search.service";

const systems: StateTestSystem[] = [];
function fixture(params: Record<string, string> = {}) {
    const router = {events: new Subject(), routerState: {snapshot: {root: {queryParams: params}}},
        navigate: vi.fn().mockResolvedValue(true), getCurrentNavigation: vi.fn()};
    const messages = {showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn()};
    const state = createStateTestSystem(router as never, messages as never);
    systems.push(state);
    return {state, views: state.owner(MapViewStateService), router, messages};
}
afterEach(() => { systems.splice(0).forEach(system => system.ngOnDestroy()); localStorage.clear(); });

describe("logical view ownership", () => {
    it("retains cameras, options, search targets and native readers across a reorder", () => {
        const {state, views} = fixture();
        views.numViews = 2;
        const [left, right] = views.viewIds();
        const target = views.captureView(1)!;
        state.layerNames = ["Map/Layer"];
        state.setStyleOptionValues("Map", "Layer", "Style", "opacity", [0.2, 0.8]);
        state.cameraViewDataState.next(1, {destination: {lon: 10, lat: 20, alt: 30},
            orientation: {heading: 0, pitch: -1, roll: 0}, position: [0, 0, 0]});
        state.addFeatureSearch({query: "Road", selectedViewIndices: [1]});
        const camera = views.cameraViewDataState.signal(right);
        const saved = camera();
        views.focusedView = 1;
        views.reorderViews([right, left]);
        expect(views.isCurrent(target)).toBe(true);
        expect(views.focusedViewId()).toBe(right);
        expect(views.cameraViewDataState.getValue(0)).toBe(saved);
        expect(camera()).toBe(saved);
        expect(state.styles.get("Map/Layer/Style/opacity")).toEqual([0.8, 0.2]);
        expect(state.owner(FeatureSearchService).featureSearches[0].selectedViewIds).toEqual([right]);
        expect(state.featureSearches[0].selectedViewIndices).toEqual([0]);
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
        state.retainViews([0], new Map());
        expect(views.isCurrent(oldTarget)).toBe(false);
        views.viewIdsState.next(ids);
        expect(views.captureView(1)!.id).toBe(oldTarget.id);
        expect(views.captureView(1)!.generation).not.toBe(oldTarget.generation);
        expect(views.isCurrent(oldTarget)).toBe(false);
    });

    it("rejects duplicate explicit URL IDs before navigation or any state mutation", async () => {
        const {state, views, router} = fixture();
        state.initializePersistence();
        const before = state.exportSnapshot();
        const identity = views.captureView(0)!;
        await expect(state.replaceUrlState({n: "2", vid: "same,same", m: "1"})).rejects.toThrow();
        expect(router.navigate).not.toHaveBeenCalled();
        expect(state.exportSnapshot()).toEqual(before);
        expect(views.isCurrent(identity)).toBe(true);
    });

    it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("rejects reserved view ID %s atomically", async id => {
        const {state, views, router} = fixture();
        state.initializePersistence();
        const previous = views.viewIds();
        expect(() => views.viewIdsState.next([id])).toThrow("Reserved view ID");
        await expect(state.replaceUrlState({vid: id, m: "1"})).rejects.toThrow("Reserved view ID");
        expect(views.viewIds()).toBe(previous);
        expect(views.marker).toBe(false);
        expect(router.navigate).not.toHaveBeenCalled();
    });

    it("continues startup on invalid IDs and reports the rejected link", () => {
        const {state, views, messages} = fixture({n: "2", vid: "bad", m: "1"});
        state.initializePersistence();
        expect(state.ready.getValue()).toBe(true);
        expect(views.numViews).toBe(1);
        expect(views.marker).toBe(false);
        expect(messages.showError).toHaveBeenCalledOnce();
    });

    it("shares one fallback ID mapping across stored arrays and partial legacy camera fields", () => {
        localStorage.setItem("numberOfViews", "2");
        localStorage.setItem("cameraView", JSON.stringify([
            {lon: 11, lat: 22, alt: 33}, {lon: 44, lat: 55, alt: 66}
        ]));
        localStorage.setItem("layerNames", JSON.stringify(["Map/Layer"]));
        localStorage.setItem("Style~0~opacity", "0.2:0.8");
        const {state, views} = fixture({lon: "99,88", m: "1"});
        state.initializePersistence();
        expect(views.viewIds()).toHaveLength(2);
        expect(new Set(views.viewIds()).size).toBe(2);
        expect(views.cameraViewDataState.getValue(0).destination).toEqual({lon: 99, lat: 22, alt: 33});
        expect(views.cameraViewDataState.getValue(1).destination).toEqual({lon: 88, lat: 55, alt: 66});
        expect(state.styles.get("Map/Layer/Style/opacity")).toEqual(["0.2", "0.8"]);
        expect(new URL(state.shareableUrl()).searchParams.get("vid")).toBe(views.viewIds().join(","));
    });
});


describe("view membership preparations", () => {
    it("inherits source search selection for added views and prunes removed targets", () => {
        const {state, views} = fixture();
        const search = state.owner(FeatureSearchService);
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
        state.layerNames = ["Map/Layer"];
        state.setStyleOptionValues("Map", "Layer", "Style", "opacity", [0.5]);
        const options = state.store.layers.options();
        const iteration = vi.spyOn(options, Symbol.iterator);
        const entries = vi.spyOn(options, "entries");
        const keys = vi.spyOn(Object, "keys");
        const layerRecords = state.store.layers.layerVisibility();
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
    const injector = Injector.create({providers: [
        {provide: MapViewStateService, useValue: views},
        {provide: InspectionStateService, useValue: state.owner(InspectionStateService)}
    ]});
    const selection = runInInjectionContext(injector, () => new InspectionSelectionService(
        state as never, tiles as never, runtime as never, {registerShortcut: vi.fn()} as never,
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
