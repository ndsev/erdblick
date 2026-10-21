import "@angular/compiler";
import {HttpHeaders, HttpResponse} from "@angular/common/http";
import {runInInjectionContext} from "@angular/core";
import {BehaviorSubject, of} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {InspectionStateService} from "../inspection/inspection-state.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapViewService} from "../mapview/map-view.service";
import {AppConfigService} from "../shared/app-config.service";
import {AppLayoutService} from "../shared/app-layout.service";
import {AppStateService} from "../shared/appstate.service";
import type {ErdblickStyle, StyleService} from "../styledata/style.service";
import type {MapPresetService} from "../styledata/map-preset.service";
import {MapInfoService} from "./map-info.service";
import {MapLayerStateService} from "./map-layer-state.service";
import {MapTileStreamService} from "./map-tile-stream.service";
import {MapPanelComponent} from "./map.panel.component";
import {layerStyleOptions, type MapInfoItem, type MapTreeViewNode} from "./map.tree.model";

/** Real catalog replacement, tree preparation, membership and panel projection without rendering WebGL. */
async function fixture() {
    const config = {config$: new BehaviorSubject({}), getBackgroundLayers: () => [], getDefaultBackgroundLayerId: () => null};
    const injector = ownerTestInjector([
        MapViewStateService, MapLayerStateService, AppLayoutService, InspectionStateService,
        {provide: AppConfigService, useValue: config}, {provide: MapTileStreamService, useValue: {}}
    ]);
    const persistence = injector.get(AppStateService);
    // Snapshot tests exercise real persistence; URL projection is outside this fixture.
    persistence.registerUrlCodec({serialize: params => params, hydrate() {}});
    const views = injector.get(MapViewStateService);
    const layers = injector.get(MapLayerStateService);
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
        maps, renderers, {} as never, persistence, {registerShortcut() {}} as never,
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
            panel.subscriptions.forEach(item => item.unsubscribe());
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
            test.views.createView(test.views.viewIds()[0]);
            expect(test.nodes()).toHaveLength(2);
            expect(test.layer(1).viewConfig).toHaveLength(2);
            expect(test.layer(1).viewConfig![1]).toEqual(test.layers.mapLayerConfig("Map", "Road")[1]);
            expect(test.layer(1).children!.find(node => node.id === "details")!.value).toEqual([false, false]);
        } finally {
            test.dispose();
        }
    });

    it("projects reordered layer settings and style values before synchronization reads the tree", async () => {
        const test = await fixture();
        try {
            test.views.createView(test.views.viewIds()[0]);
            test.layers.setMapLayerConfig("Map", "Road", [
                {visible: false, level: 10, autoLevel: false},
                {visible: true, level: 15, autoLevel: true}
            ]);
            test.layers.setStyleOptionValues("Map", "Road", "style", "details", [false, true]);
            test.layers.setLayerSyncOption(0, true);
            await test.reload();
            const [left, right] = test.views.viewIds();
            const observedSync: Array<{view: number; options: unknown[]}> = [];
            const originalSync = test.maps.applySyncOptionsForView.bind(test.maps);
            vi.spyOn(test.maps, "applySyncOptionsForView").mockImplementation(view => {
                const layer = test.maps.maps.maps.get("Map")!.layers.get("Road")!;
                observedSync.push({view, options: [...layerStyleOptions(layer)[0].value]});
                originalSync(view);
            });

            test.views.reorderViews([right, left]);

            expect(observedSync).toEqual([{view: 1, options: [true, false]}]);
            expect(test.layer(0).viewConfig).toEqual([
                {visible: true, level: 15, autoLevel: true},
                {visible: false, level: 10, autoLevel: false}
            ]);
            expect(test.layer(0).children!.find(node => node.id === "details")!.value).toEqual([true, false]);
            const current = test.nodes();
            test.views.marker = true;
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
