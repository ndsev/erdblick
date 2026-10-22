import "@angular/compiler";
import {HttpClient} from "@angular/common/http";
import {getState} from "@ngrx/signals";
import {BehaviorSubject} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {AppConfigService} from "../shared/app-config.service";
import {AppStore} from "../shared/app.store";
import {AppStateService} from "../shared/appstate.service";
import {observeStore} from "../shared/persisted-state";
import {MapPresetService} from "../styledata/map-preset.service";
import {StyleService} from "../styledata/style.service";
import {MapInfoService} from "./map-info.service";
import {layerPresetInferenceKey, layerStyleOptions, MapInfoItem, MapLayerTree} from "./map.tree.model";

const trees: MapLayerTree[] = [];
afterEach(() => {
    trees.splice(0).forEach(tree => tree.destroy());
    localStorage.clear();
});

/** Use the real preset resolver, resource tree and native state publication. */
function fixture(conflictingComposition = false) {
    const ref = {styleId: "Style", presetId: "preset"};
    const presets = [{id: "preset", name: "Preset", values: [{optionId: "enabled", value: true}]}];
    if (conflictingComposition) {
        presets.push({id: "off", name: "Off", values: [{optionId: "enabled", value: false}]});
    }
    const style = {
        id: "Style", shortId: "Style", visible: true, presets,
        options: [{id: "enabled", label: "Enabled", description: "Enabled", type: "Bool",
            defaultValue: false, internal: false}],
        featureLayerStyle: {hasLayerAffinity: () => true}
    };
    const composition = {
        id: "map-preset", name: "Map preset", enabled: true,
        layerPresets: [{layerId: "Layer", ...ref}]
    };
    if (conflictingComposition) {
        composition.layerPresets.push({layerId: "Other", styleId: "Style", presetId: "off"});
    }
    const injector = ownerTestInjector([
        MapInfoService, MapPresetService,
        {provide: HttpClient, useValue: {}},
        {provide: StyleService, useValue: {styles: new Map([[style.id, style]]), styleGroups: new BehaviorSubject([])}},
        {provide: AppConfigService, useValue: {snapshot: {
            mapPresets: [composition], mapPresetConfig: {configured: true, issues: []}
        }}}
    ]);
    const store = injector.get(AppStore);
    const persistence = injector.get(AppStateService);
    const mapPresets = injector.get(MapPresetService);
    mapPresets.initialize();
    persistence.ready.next(true);
    const service = injector.get(MapInfoService);
    const layerIds = conflictingComposition ? ["Layer", "Other"] : ["Layer"];
    const source: MapInfoItem = {
        mapId: "Map", sourceId: "Map", stringPoolId: "Map", extraJsonAttachment: {},
        maxParallelJobs: 1, addOn: false,
        layers: Object.fromEntries(layerIds.map(layerId => [layerId, {
            layerId, type: "Features", canRead: true, canWrite: false, coverage: [], featureTypes: [],
            zoomLevels: [13], version: {major: 1, minor: 0, patch: 0}
        }]))
    };
    Reflect.get(service, "publishSourceCatalogTree").call(service, [source]);
    const tree = service.maps;
    trees.push(tree);
    const option = layerStyleOptions(tree.getFeatureLayer("Map", "Layer")!)[0];
    return {service, store, tree, option, ref};
}

describe("MapInfoService preset reconciliation policy", () => {
    it("shares explicit layer and map preset application with non-component callers", () => {
        const {service, store, option, ref} = fixture();
        expect(service.applyLayerPreset(0, "Map", "Layer", ref)).toBe(true);
        expect(option.value).toEqual([true]);
        expect(store.getLayerPresetSelection(0, "Map", "Layer")).toEqual(ref);

        option.value[0] = false;
        service.applyStyleOptionChange(option, 0);
        expect(store.getLayerPresetSelection(0, "Map", "Layer")).toBeNull();
        expect(service.applyMapPreset(0, "Map", "map-preset")).toBe(true);
        expect(option.value).toEqual([true]);
        expect(store.getMapPresetSelection(0, "Map")).toBe("map-preset");
    });

    it("rejects missing presets and conflicting synchronized compositions before any option changes", () => {
        const {service, store, option, ref} = fixture(true);
        store.setLayerSyncOption(0, true);
        const before = getState(store);
        const options = [...option.value];
        expect(service.applyMapPreset(0, "Map", "map-preset")).toBe(false);
        expect(service.applyLayerPreset(0, "Map", "Layer", {...ref, presetId: "missing"})).toBe(false);
        expect(getState(store)).toEqual(before);
        expect(option.value).toEqual(options);
    });

    it("infers presets only for the identities changed by a manual option edit", () => {
        const {service, store, tree, option, ref} = fixture();
        const reconcile = vi.spyOn(tree, "reconcilePresetSelections");
        option.value[0] = true;
        service.applyStyleOptionChange(option, 0);
        expect([...reconcile.mock.calls[0][0]!]).toEqual([layerPresetInferenceKey(0, "Map", "Layer")]);
        expect(store.getLayerPresetSelection(0, "Map", "Layer")).toEqual(ref);
    });

    it("validates without inferring a new association during an explicit preset operation", () => {
        const {service, store, tree, option} = fixture();
        const reconcile = vi.spyOn(tree, "reconcilePresetSelections");
        option.value[0] = true;
        service.applyPresetChanges([option], 0, [{mapId: "Map", layerId: "Layer"}]);
        expect(reconcile.mock.calls[0][0]!.size).toBe(0);
        expect(store.getLayerPresetSelection(0, "Map", "Layer")).toBeNull();
    });

    it("publishes the selected preset and its option values together", () => {
        const {service, store, ref} = fixture();
        const observed: Array<{preset: unknown; value: unknown}> = [];
        const subscription = observeStore(store, state => state.layers).subscribe(() => {
            observed.push({
                preset: store.getLayerPresetSelection(0, "Map", "Layer"),
                value: store.styleOptionValues("Map", "Layer", "Style", "enabled", "Bool", false)[0]
            });
        });
        expect(service.applyLayerPreset(0, "Map", "Layer", ref)).toBe(true);
        expect(observed).toEqual([{preset: null, value: false}, {preset: ref, value: true}]);
        subscription.unsubscribe();
    });
});
