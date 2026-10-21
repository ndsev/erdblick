import "@angular/compiler";
import {BehaviorSubject, Subject} from "rxjs";
import {describe, expect, it, vi} from "vitest";

import {StateOwners, testPersistence} from "../../test/state-owners";
import {MapInfoService} from "./map-info.service";
import {LayerPresetNode, layerPresetInferenceKey, StyleOptionNode} from "./map.tree.model";

function fixture() {
    const registry = testPersistence();
    const owners = new StateOwners(registry);
    owners.layerState.materializeLayerDefaults("Map", "Layer");
    owners.layerState.materializeStyleOptionDefaults("Map", "Layer", "Style", "enabled", "Bool", false);
    const reconcilePresetSelections = vi.fn();
    const tree = {
        reconcilePresetSelections,
        syncLayers: vi.fn(() => []),
        syncViews: vi.fn(() => ({viewConfigChanged: false, styleOptionChanges: []}))
    };
    const service = Object.create(MapInfoService.prototype) as any;
    service.maps$ = new BehaviorSubject(tree);
    service.stateService = registry;
    service.layerState = owners.layerState;
    service.viewSettings = owners.viewSettings;
    service.styleOptionsChanged = new Subject();
    service.layerStateChanged = new Subject();
    service.isSyncOptionsForViewEnabled = vi.fn(() => false);
    const option = new StyleOptionNode(
        "Map",
        "Layer",
        {
            id: "enabled",
            label: "Enabled",
            description: "Enabled",
            type: "Bool",
            defaultValue: false,
            internal: false
        },
        "Style",
        "Style",
        true
    );
    option.value = [true];
    return {service, option, reconcilePresetSelections, registry, layers: owners.layerState};
}

describe("MapInfoService preset reconciliation policy", () => {
    it("shares explicit layer/map preset application with non-component callers", () => {
        const {service, option} = fixture();
        option.value = [false];
        const ref = {styleId: "Style", presetId: "preset"};
        const preset = {id: "preset", styleId: "Style", name: "Preset", key: "key", ref, values: [{optionId: "enabled", value: true}]};
        const layer = {id: "Layer", mapId: "Map", children: [new LayerPresetNode("Map", "Layer", [preset]), option]};
        const mapPreset = {id: "map-preset", name: "Map preset"};
        const map = {id: "Map", layers: new Map([["Layer", layer]]), mapPresets: [mapPreset]};
        service.stateService.numViews = 1;
        service.maps.maps = new Map([["Map", map]]);
        service.maps.getFeatureLayer = vi.fn(() => layer);
        service.maps.setLayerPresetSelection = vi.fn();
        service.maps.setMapPresetSelection = vi.fn();
        service.maps.resolveMapPresetComponents = vi.fn(() => [{layer, preset}]);
        service.maps.mapPresetHasSyncConflict = vi.fn(() => false);
        const apply = vi.spyOn(service, "applyPresetChanges");
        expect(service.applyLayerPreset(0, "Map", "Layer", ref)).toBe(true);
        expect(option.value).toEqual([true]);
        expect(service.maps.setLayerPresetSelection).toHaveBeenCalledWith(0, "Map", "Layer", ref);
        expect(apply).toHaveBeenCalledOnce();
        apply.mockClear(); option.value[0] = false;
        expect(service.applyMapPreset(0, "Map", "map-preset")).toBe(true);
        expect(option.value).toEqual([true]);
        expect(service.maps.setMapPresetSelection).toHaveBeenCalledWith(0, "Map", "map-preset");
        expect(apply).toHaveBeenCalledOnce();
        apply.mockClear(); option.value[0] = false;
        service.isSyncOptionsForViewEnabled.mockReturnValue(true);
        service.maps.mapPresetHasSyncConflict.mockReturnValue(true);
        expect(service.applyMapPreset(0, "Map", "map-preset")).toBe(false);
        expect(option.value).toEqual([false]);
        expect(apply).not.toHaveBeenCalled();
        expect(service.applyLayerPreset(0, "Map", "Layer", {...ref, presetId: "missing"})).toBe(false);
        expect(option.value).toEqual([false]);
    });

    it.each(["layer", "map"])("publishes one complete ordinary %s preset edit and restores cache on failure", kind => {
        const {service, option, registry, layers} = fixture();
        option.value = [false];
        const ref = {styleId: "Style", presetId: "preset"};
        const preset = {id: "preset", styleId: "Style", name: "Preset", key: "key", ref, values: [{optionId: "enabled", value: true}]};
        const layer = {id: "Layer", mapId: "Map", children: [new LayerPresetNode("Map", "Layer", [preset]), option]};
        service.maps.maps = new Map([["Map", {id: "Map", mapPresets: [{id: "whole"}]}]]);
        service.maps.getFeatureLayer = () => layer;
        service.maps.setLayerPresetSelection = (view: number, map: string, layer: string, value: typeof ref | null) => layers.setLayerPresetSelection(view, map, layer, value);
        service.maps.setMapPresetSelection = (view: number, map: string, value: string | null) => layers.setMapPresetSelection(view, map, value);
        service.maps.resolveMapPresetComponents = () => [{layer, preset}];
        service.maps.mapPresetHasSyncConflict = () => false;
        service.maps.configureTreeParameters = () => { option.value = layers.styleOptionValues("Map", "Layer", "Style", "enabled", "Bool", false); };
        const state = () => ({preset: layers.getLayerPresetSelection(0, "Map", "Layer"),
            mapPreset: layers.getMapPresetSelection(0, "Map"), values: layers.styleOptionValues("Map", "Layer", "Style", "enabled", "Bool", false)});
        const observed: unknown[] = [], render: unknown[] = [];
        registry.observe(state).subscribe(value => observed.push(value));
        service.styleOptionsChanged.subscribe(() => render.push(state()));
        const apply = () => kind === "map" ? service.applyMapPreset(0, "Map", "whole") : service.applyLayerPreset(0, "Map", "Layer", ref);
        const write = vi.spyOn(layers, "setStyleOptionValuesBatch").mockImplementationOnce(() => { throw new Error("prepared write failed"); });
        expect(apply).toThrow("prepared write failed");
        expect(observed).toHaveLength(1);
        expect(render).toEqual([]);
        expect(option.value).toEqual([false]);
        write.mockRestore();
        expect(apply()).toBe(true);
        expect(observed).toHaveLength(2);
        expect(observed[1]).toEqual({preset: ref, mapPreset: kind === "map" ? "whole" : null, values: [true]});
        expect(render).toEqual([observed[1]]);
        registry.ngOnDestroy();
    });

    it("infers only after a manual option transaction", () => {
        const {service, option, reconcilePresetSelections} = fixture();

        service.applyStyleOptionChange(option, 0);

        const targets = reconcilePresetSelections.mock.calls[0][0] as Set<string>;
        expect([...targets]).toEqual([layerPresetInferenceKey(0, "Map", "Layer")]);
    });

    it("validates without inference while explicitly applying a preset", () => {
        const {service, option, reconcilePresetSelections} = fixture();

        service.applyPresetChanges([option], 0, [{mapId: "Map", layerId: "Layer"}]);

        const targets = reconcilePresetSelections.mock.calls[0][0] as Set<string>;
        expect(targets.size).toBe(0);
    });
});
