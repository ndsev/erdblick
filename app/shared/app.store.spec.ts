import {computed} from "@angular/core";
import {getState, watchState} from "@ngrx/signals";
import {describe, expect, it} from "vitest";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {AppStore} from "./app.store";

function fixture() {
    const injector = ownerTestInjector();
    return {injector, store: injector.get(AppStore)};
}

describe("native AppStore publications", () => {
    it("publishes related rendering and transport preferences once", () => {
        const {store, injector} = fixture();
        const observed: unknown[] = [];
        watchState(store, state => observed.push({
            antialiasing: state.views.deckAntialiasingEnabled,
            compression: state.connection.tilePullCompressionEnabled,
            workers: state.views.tileSubsetRenderWorkerCount
        }), {injector});
        observed.length = 0;
        store.setRenderingPreferences({antialiasing: false, semanticCompositing: false,
            contactShading: true, tilePullCompression: true, tileLimit: 100, renderWorkers: 4});
        expect(observed).toEqual([{antialiasing: false, compression: true, workers: 4}]);
    });

    it("removes a view with its camera, style values and search targets in one publication", () => {
        const {store, injector} = fixture();
        store.setNumViews(2);
        const [left, right] = store.viewIds().map(String);
        store.setLayerNames(["Map/Layer"]);
        store.setStyleOptionValues("Map", "Layer", "Style", "opacity", [0.2, 0.8]);
        store.addFeatureSearch({query: "Road", selectedViewIndices: [1]});
        const observed: unknown[] = [];
        watchState(store, state => observed.push({ids: state.viewIds,
            cameras: Object.keys(state.views.cameraViewData),
            options: Object.keys(state.layers.options.get("Map/Layer/Style/opacity")!),
            selected: state.searches.featureSearch[0].selectedViewIds
        }), {injector});
        observed.length = 0;
        store.retainViews([0], new Map());
        expect(observed).toEqual([{ids: [left], cameras: [left], options: [left], selected: []}]);
        expect(store.viewEntityMap()[right]).toBeUndefined();
    });

    it("closes a selected inspection together with comparison, geometry and dock state", () => {
        const {store, injector} = fixture();
        const id = store.setSelection([{featureId: "Road.1", mapTileKey: "Features:Map:Layer:42"}])!;
        store.setInspectionTreeHiddenColumns(id, ["value"]);
        store.ensureInspectionDialogLayout(id, 0, () => ({position: {left: 1, top: 2}, size: {width: 300, height: 200}}));
        store.openInspectionComparison({base: {panelId: id, mapId: "Map", label: "Road", featureIds: []}, others: []});
        const observed: unknown[] = [];
        watchState(store, state => observed.push({selection: state.inspection.selection,
            comparison: state.inspection.inspectionComparison,
            layouts: state.layout.dialogLayouts, dock: state.layout.dockOpen,
            columns: state.inspection.inspectionTreeHiddenColumns
        }), {injector});
        observed.length = 0;
        store.closeInspection({panelId: id});
        expect(observed).toEqual([{selection: [], comparison: null, layouts: {}, dock: false, columns: {}}]);
    });

    it("rejects a complete invalid layer presentation before any native publication", () => {
        const {store, injector} = fixture();
        const before = getState(store);
        let publications = 0;
        watchState(store, () => ++publications, {injector});
        expect(() => store.applyLayerPresentation({configs: [
            {mapId: "Map", layerId: "first", viewConfigs: [{visible: true, level: 13, autoLevel: true}]},
            {mapId: "Map", layerId: "second", viewConfigs: [{visible: true, level: NaN, autoLevel: true}]}
        ], options: [], layerPresets: [], mapPresets: []})).toThrow("Invalid layer level");
        expect(publications).toBe(1);
        expect(getState(store)).toEqual(before);
        expect(store.layers()).toBe(before.layers);
    });

    it("keeps native identities and readers stable for structural no-ops and unrelated fields", () => {
        const {store, injector} = fixture();
        let reads = 0;
        const info = computed(() => { ++reads; return store.diagnostics.logFilter().info; });
        expect(info()).toBe(true);
        const before = store.diagnostics.logFilter();
        let publications = 0;
        watchState(store, () => ++publications, {injector});
        store.setDiagnosticsLogFilter({...before});
        expect(publications).toBe(1);
        store.setDiagnosticsExportOptions({...store.diagnostics.exportOptions(), includeLogs: false});
        expect(info()).toBe(true);
        expect(reads).toBe(1);
        expect(store.diagnostics.logFilter()).toBe(before);
    });

    it("creates independent native defaults for each injector", () => {
        const first = fixture().store;
        const second = fixture().store;
        first.setLayerNames(["Map/Layer"]);
        first.setStyleOptionValues("Map", "Layer", "Style", "enabled", [true]);
        expect(second.layers.options().size).toBe(0);
        expect(second.layers.layerNames()).toEqual([]);
    });
});
