import "@angular/compiler";
import {HttpHeaders, HttpResponse} from "@angular/common/http";
import {runInInjectionContext} from "@angular/core";
import {getState} from "@ngrx/signals";
import {BehaviorSubject, of} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {AppStore, AppStoreValues} from "../shared/app.store";
import {AppStateService} from "../shared/appstate.service";
import {observeStore} from "../shared/persisted-state";
import type {ErdblickStyle, StyleService} from "../styledata/style.service";
import type {MapPresetService} from "../styledata/map-preset.service";
import {MapInfoService} from "./map-info.service";
import type {MapInfoItem} from "./map.tree.model";

function source(mapId: string, configIndex: number, layers: string[], status = "ready"): MapInfoItem {
    return {mapId, sourceId: mapId, stringPoolId: mapId, configIndex, status,
        extraJsonAttachment: {}, maxParallelJobs: 1, addOn: false,
        layers: Object.fromEntries(layers.map(layerId => [layerId, {layerId, type: "Features",
            canRead: true, canWrite: false, coverage: [], featureTypes: [], zoomLevels: [13],
            version: {major: 1, minor: 0, patch: 0}}]))};
}

/** Real store, persistence, native parser and catalog replacement with an explicit HTTP boundary. */
function fixture(defaults: Record<string, unknown>, hash: string) {
    const injector = ownerTestInjector();
    const store = injector.get(AppStore);
    const persistence = injector.get(AppStateService);
    expect(persistence.seedConfigDefaultState(defaults, hash)).toEqual([]);
    persistence.initializePersistence();
    const makeStyle = (id: string, shortId: string): ErdblickStyle => ({
        id, shortId, visible: true, presets: [],
        options: [{id: "detail", label: "Detail", description: "Detail", type: "Bool", defaultValue: false, internal: false}],
        featureLayerStyle: {hasLayerAffinity: () => true}
    }) as unknown as ErdblickStyle;
    const styles = new Map([["MapStyle", makeStyle("MapStyle", "map-style")], ["RetiredStyle", makeStyle("RetiredStyle", "retired-style")]]);
    const get = vi.fn();
    const maps = runInInjectionContext(injector, () => new MapInfoService(
        {get} as never, persistence,
        {styles, styleGroups: new BehaviorSubject([])} as unknown as StyleService,
        {presets: [], presets$: new BehaviorSubject([]), presetsForLayer: () => [], isAvailable: () => true} as unknown as MapPresetService,
        {clearBackendConnectionError() {}, showBackendConnectionError() {}} as never
    ));
    let revision = 0;
    return {store, persistence, maps, styles,
        async reload(entries: MapInfoItem[]) {
            get.mockReturnValueOnce(of(new HttpResponse({body: JSON.parse(JSON.stringify(entries)),
                headers: new HttpHeaders({"X-Mapget-Sources-Revision": String(++revision)})})));
            expect(await maps.reloadDataSources()).toBe(true);
        },
        dispose() {
            maps.maps.destroy();
            maps.tileLayerParser.delete();
        }
    };
}

const defaults = {layerNames: ["Map/Road", "Map/Other"], visibility: [[true, false]],
    zoomLevel: [[10, 12]], autoZoomLevel: [[false, true]],
    styleVisiblity: {MapStyle: true, RetiredStyle: false}, marker: true};

async function flushPersistence(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

afterEach(() => localStorage.clear());

describe("complete catalog state and persisted ownership", () => {
    it("preserves a manually opened empty dock until catalog pruning actually removes its last panel", async () => {
        const test = fixture({}, "empty-dock");
        const {store} = test;
        const publications: AppStoreValues[] = [];
        const observer = observeStore(store, state => state).subscribe(state => publications.push(state));
        try {
            store.setDockOpen(true);
            store.setDockWidth(480);
            await test.reload([source("Map", 0, ["Road", "Other"])]);
            expect(store.layout.dockOpen()).toBe(true);
            expect(store.layout.dockWidth()).toBe(480);

            store.setSelection([{featureId: "Road.1", mapTileKey: "Features:Map:Road:545379780"}]);
            publications.length = 0;
            await test.reload([source("Map", 0, ["Other"])]);
            expect(publications).toHaveLength(1);
            expect(publications[0].inspection.selection).toEqual([]);
            expect(publications[0].layout.dockOpen).toBe(false);
            expect(publications[0].layout.dockWidth).toBe(480);
        } finally {
            observer.unsubscribe();
            test.dispose();
        }
    });

    it.each([
        {name: "packed hexadecimal tile IDs", mapId: "Very-Large-Map", layers: ["Road"], status: "ready",
            features: [{featureId: "Intersection.545554858.3348", mapTileKey: "Features:Very-Large-Map:Road:22100770000d"}]},
        {name: "saved selections while datasource layers initialize", mapId: "Very-Large-Map", layers: [], status: "initializing",
            features: [{featureId: "Intersection.545554858.3348", mapTileKey: "Features:Very-Large-Map:Road:545554858"}]},
        {name: "focused panel metadata when one selected layer disappears", mapId: "Very-Large-Map", layers: ["Road"], status: "ready",
            features: [{featureId: "Road.1", mapTileKey: "Features:Very-Large-Map:Road:545554858"},
                {featureId: "Lane.1", mapTileKey: "Features:Very-Large-Map:Lane:545554858"}]},
        {name: "encoded slashes in a map ID", mapId: "Provider/Sample Munich", layers: ["Landmark"], status: "ready",
            features: [{featureId: "Landmark.545666604.12", mapTileKey: "Features:Provider%2FSample Munich:Landmark:545666604"}]}
    ])("retains $name through the real catalog owner", async ({mapId, layers, status, features}) => {
        const test = fixture({}, "selection-catalog");
        const panel = {id: 0, features, locked: true, focused: true, size: [30, 20] as [number, number], color: "#fff314", undocked: false};
        test.store.setSelectionValue([panel]);
        const lifetime = test.store.captureInspectionPanel(0)!;
        try {
            await test.reload([source(mapId, 0, layers, status)]);
            expect(test.store.inspection.selection()).toEqual([{...panel, features: [features[0]]}]);
            expect(test.store.isCurrentInspectionPanel(lifetime)).toBe(true);
        } finally { test.dispose(); }
    });

    it("retains pending-source state, prunes one complete candidate, and accepts new config defaults after restart", async () => {
        const test = fixture(defaults, "config-one");
        const {store} = test;
        const road = {mapTileKey: "Features:Map:Road:545554858", featureId: "Road.1"};
        const other = {mapTileKey: "Features:Map:Other:545554858", featureId: "Other.1"};
        const removedId = store.setSelection([road], undefined, true)!;
        store.setInspectionPanelLockedState(removedId, true);
        store.setInspectionPanelUndockedState(removedId, true);
        store.ensureInspectionDialogLayout(removedId, 0, () => ({position: {left: 10, top: 20}, size: {width: 480, height: 640}, open: true}));
        const removedLifetime = store.captureInspectionPanel(removedId)!;
        const retainedId = store.setSelection([other], undefined, true)!;
        store.setInspectionTreeExpansionState(removedId, {expandedNodes: new Map([["road", true]]), fullExpansionActive: false, fullCollapseActive: false});
        store.setInspectionComparison({base: {panelId: removedId, mapId: "Map", label: "Road", featureIds: [road]},
            others: [{panelId: retainedId, mapId: "Map", label: "Other", featureIds: [other]}]});
        store.setMarkerControl({enabled: false, position: null});
        const publications: AppStoreValues[] = [];
        const runtimeCatalogs: string[][] = [];
        const observer = observeStore(store, value => value).subscribe(value => {
            publications.push(value);
            runtimeCatalogs.push([...test.maps.maps.maps].flatMap(([mapId, map]) =>
                map.children.map(layer => `${mapId}/${layer.id}`)));
        });
        try {
            await test.reload([source("Map", 0, ["Road", "Other"]), source("Waiting", 1, [], "initializing")]);
            const retainedLayer = test.maps.mapgetLayer("Map", "Other");
            const baseline = getState(store);
            publications.length = 0;
            await test.reload([source("Map", 0, ["Road", "Other"]), source("Waiting", 1, [], "failed")]);
            expect(test.maps.canPruneStateForCurrentCatalog()).toBe(false);
            expect(store.inspection.selection()).toEqual(baseline.inspection.selection);
            expect(store.layers.layerNames()).toEqual(["Map/Road", "Map/Other"]);
            expect(store.styles.styleVisibility()).toEqual(defaults.styleVisiblity);
            expect(test.maps.mapgetLayer("Map", "Other")).toBe(retainedLayer);
            expect(publications).toEqual([]);

            await test.reload([source("Map", 0, ["Road", "Other"]), source("Waiting", 1, [])]);
            expect(test.maps.canPruneStateForCurrentCatalog()).toBe(true);
            expect(store.inspection.selection().map(panel => panel.id)).toEqual([removedId, retainedId]);
            publications.length = 0;
            runtimeCatalogs.length = 0;
            test.styles.delete("RetiredStyle");
            await test.reload([source("Map", 0, ["Other"]), source("Waiting", 1, [])]);

            expect(publications).toHaveLength(1);
            expect(runtimeCatalogs).toEqual([["Map/Other"]]);
            const published = publications[0];
            expect(published.layers.layerNames).toEqual(["Map/Other"]);
            expect(published.layers.layerVisibility[store.idAt(0)!]).toEqual([false]);
            expect([...published.layers.options.keys()]).toEqual(["Map/Other/map-style/detail"]);
            expect(published.styles.styleVisibility).toEqual({MapStyle: true});
            expect(published.inspection.selection.map(panel => panel.id)).toEqual([retainedId]);
            expect(published.inspection.inspectionComparison?.base.panelId).toBe(retainedId);
            expect(published.inspection.treeExpansion.has(removedId)).toBe(false);
            expect(published.layout.dialogLayouts).not.toHaveProperty(`inspection:${removedId}`);
            expect(store.isCurrentInspectionPanel(removedLifetime)).toBe(false);
            expect(store.focusedInspectionPanelId()).toBe(retainedId);
            expect(published.layout.dockOpen).toBe(true);
            await flushPersistence();
            const metadata = JSON.parse(localStorage.getItem("erdblickConfigDefaultStateMeta")!).entries;
            for (const key of ["layerNames", "visibility", "zoomLevel", "autoZoomLevel", "styleVisiblity"]) {
                expect(metadata[key]?.owner, key).toBe("config");
            }
            expect(metadata.marker.owner).toBe("user");
        } finally {
            observer.unsubscribe();
            test.dispose();
        }

        const restarted = fixture({...defaults, visibility: [[false, true]],
            styleVisiblity: {MapStyle: false, RetiredStyle: true}}, "config-two");
        try {
            expect(restarted.store.layers.layerNames()).toEqual(["Map/Road", "Map/Other"]);
            expect(restarted.store.layers.layerVisibility()[restarted.store.idAt(0)!]).toEqual([false, true]);
            expect(restarted.store.styles.styleVisibility()).toEqual({MapStyle: false, RetiredStyle: true});
            expect(restarted.store.views.marker()).toBe(false);
        } finally { restarted.dispose(); }
    });
});
