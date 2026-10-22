import "@angular/compiler";
import {computed, Injector, runInInjectionContext} from "@angular/core";
import {AppStore} from "../shared/app.store";
import {observeStore} from "../shared/persisted-state";
import {setTestViewIds} from "../../test/owner-test-injector";
import {Subject} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import {Cartographic} from "../integrations/geo";
import {FeatureWrapper} from "../mapdata/feature-inspection.model";
import {createStateOwners, StateOwners} from "../shared/state-test-owners";
import {ViewLayerDiagnosticsService} from "./view-layer-diagnostics.service";

const systems: StateOwners[] = [];
function fixture(params: Record<string, string> = {}) {
    const router = {events: new Subject(), routerState: {snapshot: {root: {queryParams: params}}},
        navigate: vi.fn().mockResolvedValue(true), getCurrentNavigation: vi.fn()};
    const messages = {showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn()};
    const state = createStateOwners(router as never, messages as never);
    systems.push(state);
    return {state, views: state.store, router, messages};
}
afterEach(() => { systems.splice(0).forEach(system => system.destroy()); localStorage.clear(); });

describe("logical view ownership", () => {
    it("retains cameras, options, search targets and native readers across a reorder", () => {
        const {state, views} = fixture();
        views.setNumViews(2);
        const [left, right] = views.viewIds().map(String);
        const target = views.captureView(1)!;
        state.store.setLayerNames(["Map/Layer"]);
        state.store.setStyleOptionValues("Map", "Layer", "Style", "opacity", [0.2, 0.8]);
        state.store.setCameraViewData(1, {destination: {lon: 10, lat: 20, alt: 30},
            orientation: {heading: 0, pitch: -1, roll: 0}, position: [0, 0, 0]});
        state.store.addFeatureSearch({query: "Road", selectedViewIndices: [1]});
        const camera = computed(() => views.views.cameraViewData()[String(right)]);
        const saved = camera();
        views.setFocusedView(1);
        views.reorderViews([right, left]);
        expect(views.isCurrent(target)).toBe(true);
        expect(views.focusedViewId()).toBe(right);
        expect(views.views.cameraViewData()[views.idAt(0)!]).toBe(saved);
        expect(camera()).toBe(saved);
        expect(state.persistence.stylesPersistence.read(state.persistence.currentValues).get("Map/Layer/Style/opacity")).toEqual([0.8, 0.2]);
        expect(state.store.featureSearchEntries()[0].selectedViewIds).toEqual([right]);
        expect(state.store.featureSearchEntries()[0].selectedViewIndices).toEqual([0]);
    });

    it("keeps the established snapshot encodings distinct from runtime view values", () => {
        const {state, views} = fixture();
        views.setMarkerState(true);
        views.setProjectionMode(0, true);
        views.setMarkerPosition(Cartographic.fromDegrees(11, 48, 0));
        const snapshot = state.persistence.exportSnapshot();
        expect(snapshot).toMatchObject({marker: 1, markedPosition: [11, 48, 0], mode2d: [true]});
        expect(snapshot['cameraView']).toEqual([expect.objectContaining({lon: expect.any(Number), lat: expect.any(Number)})]);
        expect(snapshot).not.toHaveProperty('featureSearchState');
    });

    it("copies an explicit source across cameras, style options and selected searches", () => {
        const {state, views} = fixture();
        views.setNumViews(2);
        const [left, right] = views.viewIds().map(String);
        state.store.setLayerNames(["Map/Layer"]);
        state.store.setStyleOptionValues("Map", "Layer", "Style", "opacity", [0.2, 0.8]);
        views.setCameraViewData(0, {...views.views.cameraViewData()[views.idAt(0)!], destination: {lon: 1, lat: 2, alt: 300}});
        state.store.addFeatureSearch({query: "Road", selectedViewIndices: [0]});
        const copy = views.createView(left);
        expect(views.views.cameraViewData()[copy]).toEqual(views.views.cameraViewData()[views.idAt(0)!]);
        expect(state.persistence.stylesPersistence.read(state.persistence.currentValues).get("Map/Layer/Style/opacity")).toEqual([0.2, 0.8, 0.2]);
        expect(state.store.featureSearchEntries()[0].selectedViewIds).toEqual([left, copy]);
        const unselectedCopy = views.createView(right);
        expect(state.store.featureSearchEntries()[0].selectedViewIds).not.toContain(unselectedCopy);
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
        expect(second.views.numViews()).toBe(2);
        expect(second.views.viewIds()[0]).toBe(retained);
    });

    it("keeps feature selection as a browser-history step", () => {
        const {state} = fixture();
        expect(state.persistence.replaceUrl).toBe(true);
        state.store.setSelection([{featureId: "Road.1", mapTileKey: "Features:Map:Layer:42"}]);
        expect(state.persistence.replaceUrl).toBe(false);
        expect(state.persistence.replaceUrl).toBe(true);
        state.store.applyInspectionFeatures([{featureId: "Road.2", mapTileKey: "Features:Map:Layer:42"}]);
        expect(state.persistence.replaceUrl).toBe(false);
    });

    it("does not reevaluate a native per-view reader when another view changes", () => {
        const {views} = fixture();
        views.setNumViews(2);
        let reads = 0;
        const firstId = views.idAt(0)!;
        const camera = computed(() => views.views.cameraViewData()[firstId]);
        const observer = computed(() => { ++reads; return camera().destination.lon; });
        observer();
        const previous = views.views.cameraViewData()[views.idAt(1)!];
        views.setCameraViewData(1, {...previous, destination: {...previous.destination, lon: 7}});
        observer();
        expect(reads).toBe(1);
    });

    it("rejects the previous lifetime after an ID is removed and restored", () => {
        const {state, views} = fixture();
        views.setNumViews(2);
        const ids = views.viewIds();
        const oldTarget = views.captureView(1)!;
        state.store.retainViews([0], new Map());
        expect(views.isCurrent(oldTarget)).toBe(false);
        setTestViewIds(views, ids.map(String));
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
        expect(() => setTestViewIds(views, [id])).toThrow("Reserved view ID");
        await expect(state.persistence.replaceUrlState({vid: id, m: "1"})).rejects.toThrow("Reserved view ID");
        expect(views.viewIds()).toBe(previous);
        expect(views.views.marker()).toBe(false);
        expect(router.navigate).not.toHaveBeenCalled();
    });

    it("continues startup on invalid IDs and reports the rejected link", () => {
        const {state, views, messages} = fixture({n: "2", vid: "bad", m: "1"});
        state.persistence.initializePersistence();
        expect(state.persistence.ready.getValue()).toBe(true);
        expect(views.numViews()).toBe(1);
        expect(views.views.marker()).toBe(false);
        expect(messages.showError).toHaveBeenCalledOnce();
    });

    it.each(["URL", "storage"])("ignores retired legacy osm positions during one-view %s startup", format => {
        const params: Record<string, string> = format === "URL" ? {
            osm: "0~6,0~6", lon: "42.5", lat: "11.615", alt: "500", h: "0.02", p: "-0.75", r: "0"
        } : {};
        if (format === "storage") localStorage.setItem("osm", JSON.stringify(["0~6", "0~6"]));
        const {state, views, messages} = fixture(params);
        const ids = views.viewIds();

        state.persistence.initializePersistence();

        expect(state.persistence.ready.getValue()).toBe(true);
        expect(views.viewIds()).toEqual(ids);
        expect(views.numViews()).toBe(1);
        expect(state.persistence.descriptor("background").read(state.persistence.currentValues)).toEqual([{layerId: null, opacity: 6}]);
        expect(messages.showError).not.toHaveBeenCalled();
        if (format === "URL") {
            expect(views.views.cameraViewData()[views.idAt(0)!].destination).toEqual({lon: 42.5, lat: 11.615, alt: 500});
        }
        // Ignoring retired positions is an import rule, not permission to write an absent live pane.
        expect(() => state.store.setBackgroundState(1, "osm", 40)).toThrow("unavailable");
        expect(state.persistence.descriptor("background").read(state.persistence.currentValues)).toEqual([{layerId: null, opacity: 6}]);
    });

    it("rejects invalid explicit IDs before applying legacy osm or camera fields", () => {
        const {state, views, messages} = fixture({n: "1", vid: "left,right", osm: "0~6,0~6", lon: "42.5"});
        const ids = views.viewIds();
        const camera = views.views.cameraViewData()[views.idAt(0)!];
        const background = state.store.getBackgroundState(0);

        state.persistence.initializePersistence();

        expect(state.persistence.ready.getValue()).toBe(true);
        expect(messages.showError).toHaveBeenCalledOnce();
        expect(views.viewIds()).toEqual(ids);
        expect(views.views.cameraViewData()[views.idAt(0)!]).toEqual(camera);
        expect(state.store.getBackgroundState(0)).toEqual(background);
    });

    it("migrates saved legacy backgrounds while rejecting every field from an invalid URL", () => {
        localStorage.setItem("viewIds", JSON.stringify(["saved"]));
        localStorage.setItem("osm", JSON.stringify(["0~6", "0~6"]));
        const {state, views, messages} = fixture({n: "1", vid: "left,right", osm: "1~80", lon: "42.5"});
        const camera = views.views.cameraViewData()[views.idAt(0)!];

        state.persistence.initializePersistence();

        expect(state.persistence.ready.getValue()).toBe(true);
        expect(messages.showError).toHaveBeenCalledOnce();
        expect(views.viewIds()).toEqual(["saved"]);
        expect(views.views.cameraViewData()[views.idAt(0)!]).toEqual(camera);
        expect(state.persistence.descriptor("background").read(state.persistence.currentValues)).toEqual([{layerId: null, opacity: 6}]);
    });

    it("derives URL count from explicit IDs during startup and direct replacement", async () => {
        const {state, views} = fixture({vid: "west,east"});
        state.persistence.initializePersistence();
        expect(views.viewIds()).toEqual(["west", "east"]);
        expect(views.numViews()).toBe(2);
        await state.persistence.replaceUrlState({vid: "north,south,central"}, true);
        expect(views.viewIds()).toEqual(["north", "south", "central"]);
        expect(views.numViews()).toBe(3);
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
        expect(views.numViews()).toBe(2);
        expect(views.views.cameraViewData()[views.idAt(1)!].destination).toEqual({lon: 40, lat: 50, alt: 60});
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
        views.setNumViews(2);
        const ids = views.viewIds();
        const camera = {...views.views.cameraViewData()[views.idAt(1)!], destination: {lon: 4, lat: 5, alt: 6}};
        views.setCameraViewData(1, camera);
        expect(state.persistence.importSnapshot({marker: true})).toEqual([]);
        expect(views.viewIds()).toBe(ids);
        expect(views.views.cameraViewData()[views.idAt(1)!]).toBe(camera);
        expect(state.persistence.importSnapshot({viewIds: ["first", "second"]})).toEqual([]);
        expect(views.views.cameraViewData()[views.idAt(1)!]).toEqual(camera);
    });

    it("seeds config identities before positional values regardless of object key order", () => {
        const {state, views} = fixture();
        expect(state.persistence.seedConfigDefaultState({
            cameraView: [{lon: 10, lat: 20, alt: 30}, {lon: 40, lat: 50, alt: 60}],
            viewIds: ["west", "east"]
        }, "config")).toEqual([]);
        expect(views.viewIds()).toEqual(["west", "east"]);
        expect(views.views.cameraViewData()[views.idAt(1)!].destination).toEqual({lon: 40, lat: 50, alt: 60});
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
        expect(views.views.cameraViewData()[views.idAt(0)!].destination).toEqual({lon: 99, lat: 22, alt: 33});
        expect(views.views.cameraViewData()[views.idAt(1)!].destination).toEqual({lon: 88, lat: 55, alt: 66});
        expect(state.persistence.stylesPersistence.read(state.persistence.currentValues).get("Map/Layer/Style/opacity")).toEqual(["0.2", "0.8"]);
        expect(new URL(state.url.shareableUrl()).searchParams.get("vid")).toBe(views.viewIds().join(","));
    });
});


describe("view membership preparations", () => {
    it.each(["URL", "snapshot"])("keeps live search targets by ID during a partial %s import", async format => {
        const {state, views} = fixture();
        state.persistence.initializePersistence();
        setTestViewIds(views, ["a", "b"]);
        state.store.addFeatureSearch({query: "Road", selectedViewIndices: [1]});
        const importIds = async (ids: string[]) => {
            if (format === "URL") await state.persistence.replaceUrlState({vid: ids.join(",")});
            else expect(state.persistence.importSnapshot({viewIds: ids})).toEqual([]);
        };
        await importIds(["b", "c"]);
        expect(state.store.featureSearchEntries()[0].selectedViewIds).toEqual(["b"]);
        await importIds(["a", "c"]);
        expect(state.store.featureSearchEntries()[0].selectedViewIds).toEqual([]);
        await importIds(["b", "c"]);
        expect(state.store.featureSearchEntries()[0].selectedViewIds).toEqual([]);
    });

    it("publishes synchronized camera and projection changes atomically through ordinary owner methods", () => {
        const {views} = fixture();
        views.setNumViews(2);
        views.setSynchronization(["pos", "proj"]);
        const cameras: number[][] = [];
        const modes: boolean[][] = [];
        observeStore(views, state => state.views.cameraViewData).subscribe(() => cameras.push([0, 1].map(index =>
            views.views.cameraViewData()[views.idAt(index)!].destination.lon)));
        observeStore(views, state => state.views.mode2d).subscribe(() => modes.push([0, 1].map(index => views.views.mode2d()[views.idAt(index)!])));
        cameras.length = 0;
        modes.length = 0;
        views.setView(0, Cartographic.fromDegrees(12, 48, 1000));
        views.setProjectionMode(0, true);
        expect(cameras).toEqual([[12, 12]]);
        expect(modes).toEqual([[true, true]]);
    });

    it("inherits source search selection for added views and prunes removed targets", () => {
        const {state, views} = fixture();
        const search = state.store;
        search.addFeatureSearch({query: "Road", selectedViewIndices: [0]});
        views.setNumViews(2);
        const [first, removed] = views.viewIds();
        expect(search.featureSearchEntries()[0].selectedViewIds).toEqual([first, removed]);
        views.retainViews([0], new Map());
        expect(search.featureSearchEntries()[0].selectedViewIds).toEqual([first]);
        views.setNumViews(2);
        const added = views.viewIds()[1];
        expect(added).not.toBe(removed);
        expect(search.featureSearchEntries()[0].selectedViewIds).toEqual([first, added]);
        search.patchFeatureSearch(search.featureSearchEntries()[0].id, {selectedViewIndices: [0]});
        views.setNumViews(3);
        expect(search.featureSearchEntries()[0].selectedViewIds).toEqual([first]);
    });

    it("does not enumerate style options or layer records for unrelated preferences", () => {
        const {state, views} = fixture();
        state.store.setLayerNames(["Map/Layer"]);
        state.store.setStyleOptionValues("Map", "Layer", "Style", "opacity", [0.5]);
        const options = state.persistence.store.layers.options();
        const iteration = vi.spyOn(options, Symbol.iterator);
        const entries = vi.spyOn(options, "entries");
        const keys = vi.spyOn(Object, "keys");
        const layerRecords = state.persistence.store.layers.layerVisibility();
        views.setMarkerState(true);
        expect(iteration).not.toHaveBeenCalled();
        expect(entries).not.toHaveBeenCalled();
        expect(keys.mock.calls.some(([value]) => value === layerRecords)).toBe(false);
        iteration.mockRestore(); entries.mockRestore(); keys.mockRestore();
    });
});

function pendingFocus() {
    const {state, views} = fixture();
    views.setNumViews(2);
    let finish!: (value: FeatureWrapper[]) => void;
    const tiles = {loadFeatures: vi.fn(() => new Promise<FeatureWrapper[]>(resolve => { finish = resolve; }))};
    const move = vi.fn();
    const runtime = {navigationStarted: new Subject(), moveToWgs84PositionTopic: {next: move},
        showsFeatureSearchTileInView: vi.fn(() => true)};
    const injector = Injector.create({providers: [
        {provide: AppStore, useValue: state.store},
        {provide: ViewLayerDiagnosticsService, useValue: {}}
    ]});
    const selection = runInInjectionContext(injector, () => new InspectionSelectionService(
        tiles as never, runtime as never, {registerShortcut: vi.fn()} as never,
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
        views.reorderViews([...views.viewIds()].map(String).reverse());
        finish(); await pending;
        expect(move.mock.calls.map(([target]) => target.targetView)).toEqual([0]);
    });

    it("does not move a restored ID from a previous lifetime", async () => {
        const {views, selection, move, finish} = pendingFocus();
        const ids = views.viewIds();
        const pending = selection.focusOnFeature(1, {mapTileKey: "Map/Layer/1", featureId: "Road.1"});
        views.retainViews([0], new Map());
        setTestViewIds(views, ids.map(String));
        finish(); await pending;
        expect(move).not.toHaveBeenCalled();
    });
});
