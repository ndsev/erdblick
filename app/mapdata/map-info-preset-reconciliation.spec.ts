import "@angular/compiler";
import {BehaviorSubject, Subject} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createStateOwners, StateOwners} from "../shared/state-test-owners";

import {MapInfoService} from "./map-info.service";
import {layerPresetInferenceKey, LayerPresetNode, StyleOptionNode} from "./map.tree.model";

function fixture() {
    const reconcilePresetSelections = vi.fn();
    const tree = {
        reconcilePresetSelections,
        syncLayers: vi.fn(() => []),
        syncViews: vi.fn(() => ({viewConfigChanged: false, styleOptionChanges: []}))
    };
    const service = Object.create(MapInfoService.prototype) as any;
    service.maps$ = new BehaviorSubject(tree);
    service.stateService = {
        transaction: (operation: () => unknown) => operation()
    };
    service.viewStateOwner = {viewSync: [], numViews: 1};
    service.layerState = {
        setStyleOptionValuesBatch: vi.fn()
    };
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
    return {service, option, reconcilePresetSelections};
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

const ownersToDestroy: StateOwners[] = [];
afterEach(() => {
    ownersToDestroy.splice(0).forEach(owners => owners.destroy());
    localStorage.clear();
});

it("publishes a preset selection and its option values together for ordinary owner callers", () => {
    const owners = createStateOwners({events: new Subject(), navigate: async () => true,
        routerState: {snapshot: {root: {queryParams: {}}}}, getCurrentNavigation: () => undefined} as never,
    {showError() {}, showSuccess() {}} as never);
    ownersToDestroy.push(owners);
    owners.layers.initializeMapLayerConfig("Map", "Layer");
    owners.layers.initializeStyleOptionValues("Map", "Layer", "Style", "enabled", "Bool", false);
    const {service, option} = fixture();
    service.stateService = owners.persistence;
    service.viewStateOwner = owners.views;
    service.layerState = owners.layers;
    option.value = [false];
    const ref = {styleId: "Style", presetId: "preset"};
    const preset = {id: "preset", styleId: "Style", name: "Preset", key: "key", ref,
        values: [{optionId: "enabled", value: true}]};
    const layer = {id: "Layer", mapId: "Map", children: [new LayerPresetNode("Map", "Layer", [preset]), option]};
    service.maps.getFeatureLayer = () => layer;
    service.maps.setLayerPresetSelection = (index: number, mapId: string, layerId: string, value: typeof ref) =>
        owners.layers.setLayerPresetSelection(index, mapId, layerId, value);
    const observed: Array<{preset: unknown; value: unknown}> = [];
    const subscription = owners.layers.layerPresetSelectionState.subscribe(0, () => {
        observed.push({preset: owners.layers.getLayerPresetSelection(0, "Map", "Layer"),
            value: owners.layers.styles.get("Map/Layer/Style/enabled")?.[0]});
    });
    expect(service.applyLayerPreset(0, "Map", "Layer", ref)).toBe(true);
    expect(observed).toEqual([{preset: null, value: false}, {preset: ref, value: true}]);
    subscription.unsubscribe();
});
