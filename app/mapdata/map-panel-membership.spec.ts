import {TestBed} from "@angular/core/testing";
import {AppStore, AppStoreValues} from "../shared/app.store";
import {observeStore} from "../shared/persisted-state";
import "@angular/compiler";
import {HttpHeaders, HttpResponse} from "@angular/common/http";
import {Injector, runInInjectionContext} from "@angular/core";
import {BehaviorSubject, of} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {MapViewService} from "../mapview/map-view.service";
import {AppConfigService} from "../shared/app-config.service";
import {AppStateService} from "../shared/appstate.service";
import type {ErdblickStyle, StyleService} from "../styledata/style.service";
import type {MapPresetService} from "../styledata/map-preset.service";
import {MapInfoService} from "./map-info.service";
import {MapTileStreamService} from "./map-tile-stream.service";
import {MapPanelComponent} from "./map.panel.component";
import {layerStyleOptions, type MapInfoItem, type MapTreeViewNode} from "./map.tree.model";

/** Real catalog replacement, tree preparation, membership and panel projection without rendering WebGL. */
async function fixture() {
    const config = {config$: new BehaviorSubject({}), getBackgroundLayers: () => [], getDefaultBackgroundLayerId: () => null};
    const injector = ownerTestInjector([
        AppStore, {provide: AppConfigService, useValue: config}, {provide: MapTileStreamService, useValue: {}}
    ], TestBed.inject(Injector));
    const persistence = injector.get(AppStateService);
    const views = injector.get(AppStore);
    const layers = injector.get(AppStore);
    const styles = {
        styles: new Map([["Style", {
            id: "Style", shortId: "style", visible: true, presets: [],
            options: [{id: "details", label: "Details", description: "Details", type: "Bool", defaultValue: false, internal: false}],
            featureLayerStyle: {hasLayerAffinity: () => true}
        } as unknown as ErdblickStyle]]),
        styleGroups: new BehaviorSubject([]), pruneVisibility() {}
    } as unknown as StyleService;
    const presets = {
        presets: [], presets$: new BehaviorSubject([]), presetsForLayer: () => [],
        matchesPresetValues: () => false, isAvailable: () => true
    } as unknown as MapPresetService;
    const http = {get: vi.fn()};
    persistence.ready.next(true);
    const maps = runInInjectionContext(injector, () => new MapInfoService(
        http as never, persistence, styles, presets,
        {clearBackendConnectionError() {}, showBackendConnectionError() {}} as never
    ));
    const renderers = runInInjectionContext(injector, () => new MapViewService(views, maps));
    let revision = 0;
    const reload = async () => {
        const source: MapInfoItem = {
            mapId: "Map", sourceId: "Map", stringPoolId: "Map", extraJsonAttachment: {},
            maxParallelJobs: 1, addOn: false,
            layers: {Road: {layerId: "Road", type: "Features", canRead: true, canWrite: false,
                coverage: [], featureTypes: [], zoomLevels: [13], version: {major: 1, minor: ++revision, patch: 0}}}
        };
        http.get.mockReturnValueOnce(of(new HttpResponse({body: [source],
            headers: new HttpHeaders({"X-Mapget-Sources-Revision": String(revision)})})));
        expect(await maps.reloadDataSources()).toBe(true);
    };
    await reload();
    const panel = runInInjectionContext(injector, () => new MapPanelComponent(
        maps, renderers, {} as never, persistence, {registerShortcut() {}, unregisterShortcut() {}} as never,
        config as never, {} as never, {} as never, {} as never, {} as never, presets, styles
    ));
    let nodesByView: MapTreeViewNode[][] = [];
    const subscription = panel.mapTreeView$.subscribe(value => { nodesByView = value.nodesByView; });
    return {
        views, layers, maps, panel, persistence, reload,
        nodes: () => nodesByView,
        layer: (view: number) => nodesByView[view][0].children!.find(node => node.id === "Road")!,
        dispose() {
            subscription.unsubscribe();
            panel.ngOnDestroy();
            maps.maps.destroy();
            maps.tileLayerParser.delete();
        }
    };
}

afterEach(() => localStorage.clear());

describe("map panel membership projections", () => {
    it("publishes complete new-view controls after replacing an already displayed catalog", async () => {
        const test = await fixture();
        try {
            await test.reload();
            test.views.createView(test.views.viewEntities().map(view => view.id)[0]);
            expect(test.nodes()).toHaveLength(2);
            expect(test.layer(1).viewConfig).toHaveLength(2);
            expect(test.layer(1).viewConfig![1]).toEqual(test.layers.mapLayerConfig("Map", "Road")[1]);
            expect(test.layer(1).children!.find(node => node.id === "details")!.value).toEqual([false, false]);
        } finally {
            test.dispose();
        }
    });

    it("projects reordered layer settings before the next explicit synchronization", async () => {
        const test = await fixture();
        try {
            test.views.createView(test.views.viewEntities().map(view => view.id)[0]);
            test.layers.setMapLayerConfig("Map", "Road", [
                {visible: false, level: 10, autoLevel: false},
                {visible: true, level: 15, autoLevel: true}
            ]);
            test.layers.setStyleOptionValues("Map", "Road", "style", "details", [false, true]);
            test.layers.setLayerSyncOption(0, true);
            await test.reload();
            const [left, right] = test.views.viewEntities().map(view => view.id);
            const publications: AppStoreValues[] = [];
            const observer = observeStore(test.views, state => state).subscribe(state => publications.push(state));
            publications.length = 0;
            try {
                test.views.reorderViews([right, left]);
                expect(publications).toHaveLength(1);
                expect(publications[0].viewIds).toEqual([right, left]);
                expect(publications[0].layers.layerVisibility).toEqual({[left]: [false], [right]: [true]});
                expect(publications[0].layers.layerSyncOptions).toEqual({[left]: true, [right]: false});
            } finally { observer.unsubscribe(); }
            const layer = test.maps.maps.maps.get("Map")!.layers.get("Road")!;
            expect(layerStyleOptions(layer)[0].value).toEqual([true, false]);
            test.maps.applySyncOptionsForView(1);
            expect(layerStyleOptions(layer)[0].value).toEqual([true, false]);
            expect(test.layer(0).viewConfig).toEqual([
                {visible: true, level: 15, autoLevel: true},
                {visible: false, level: 10, autoLevel: false}
            ]);
            expect(test.layer(0).children!.find(node => node.id === "details")!.value).toEqual([true, false]);
            const current = test.nodes();
            test.views.setMarkerState(true);
            expect(test.nodes()).toBe(current);
        } finally {
            test.dispose();
        }
    });

    it("refreshes cloned controls after an external snapshot keeps the same membership", async () => {
        const test = await fixture();
        try {
            test.persistence.initializePersistence();
            const ids = test.views.viewIds();
            const oldLayer = test.layer(0);
            const result = test.persistence.replaceSnapshotState({
                ...test.persistence.exportSnapshot(),
                visibility: [[false]],
                zoomLevel: [[9]],
                autoZoomLevel: [[false]],
                "style~0~details": "1"
            });

            expect(result).toEqual([]);
            expect(test.views.viewIds()).toBe(ids);
            expect(test.layer(0)).not.toBe(oldLayer);
            expect(test.layer(0).viewConfig).toEqual([{visible: false, level: 9, autoLevel: false}]);
            expect(test.layer(0).children!.find(node => node.id === "details")!.value).toEqual([true]);
        } finally {
            test.dispose();
        }
    });
});
