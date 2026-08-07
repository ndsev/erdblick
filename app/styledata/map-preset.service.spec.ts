import {BehaviorSubject} from "rxjs";
import {beforeEach, describe, expect, it} from "vitest";
import type {MapPresetDefinition} from "./map-preset.model";
import {MapPresetService} from "./map-preset.service";

class StateStub {
    readonly mapPresetsState: BehaviorSubject<MapPresetDefinition[]>;

    constructor(initial: MapPresetDefinition[]) {
        this.mapPresetsState = new BehaviorSubject(initial);
    }

    get mapPresets() {
        return this.mapPresetsState.getValue();
    }

    set mapPresets(value: MapPresetDefinition[]) {
        this.mapPresetsState.next(structuredClone(value));
    }
}

const configured = [{
    id: "network",
    name: "Network",
    layerPresets: [{layerId: "Lane", styleId: "Lanes", presetId: "topology"}]
}];

function createService() {
    const state = new StateStub(configured.map(preset => ({...preset, enabled: true})));
    const config: {snapshot: {state: {mapPresets: unknown[]}}} = {
        snapshot: {state: {mapPresets: configured}}
    };
    const styles = new Map<string, any>([["Lanes", {
        id: "Lanes",
        visible: true,
        featureLayerStyle: {hasLayerAffinity: (layerId: string) => layerId === "Lane"},
        presets: [{
            id: "topology",
            name: "Topology",
            values: [{optionId: "show", value: true}]
        }]
    }]]);
    const service = new MapPresetService(config as any, state as any, {styles} as any);
    return {service, state, config};
}

describe("MapPresetService", () => {
    beforeEach(() => localStorage.clear());

    it("loads inline definitions and resolves embedded presets for an affine layer", () => {
        const {service} = createService();
        service.initialize();

        expect(service.presets.map(preset => preset.id)).toEqual(["network"]);
        const resolved = service.presetsForLayer("Lane", [{styleId: "Lanes", id: "show"}]);
        expect(resolved).toHaveLength(1);
        expect(resolved[0].ref).toEqual({styleId: "Lanes", presetId: "topology"});
        expect(service.presetsForLayer("Road", [{styleId: "Lanes", id: "show"}])).toEqual([]);
    });

    it("operates definitions and availability through one map-presets AppState", () => {
        const {service, state, config} = createService();
        const emissions: MapPresetDefinition[][] = [];
        const issues: unknown[][] = [];
        service.presets$.subscribe(presets => emissions.push(presets));
        service.issues$.subscribe(current => issues.push(current));
        config.snapshot.state.mapPresets = [{id: "invalid"}, ...configured];
        service.initialize();
        expect(issues.at(-1)).not.toEqual([]);
        service.setAvailable("network", false);
        expect(service.isAvailable(service.presets[0])).toBe(false);
        expect(state.mapPresets[0].enabled).toBe(false);
        expect(issues.at(-1)).toEqual([]);

        expect(service.addPreset({
            id: "geometry",
            name: "Geometry",
            enabled: true,
            layerPresets: [{layerId: "Road", styleId: "Roads", presetId: "geometry"}]
        })).toBe(true);
        expect(state.mapPresets).toHaveLength(2);
        expect(emissions.at(-1)?.map(preset => preset.id)).toEqual(["network", "geometry"]);
        expect(service.hasLocalOverride).toBe(true);

        service.resetToConfigured();
        expect(state.mapPresets).toEqual([{...configured[0], enabled: true}]);
        expect(service.hasLocalOverride).toBe(false);
    });

    it("rejects an invalid raw edit transactionally", () => {
        const {service} = createService();
        service.initialize();
        expect(service.applyOverrideSource("- id: invalid")).toBe(false);
        expect(service.presets.map(preset => preset.id)).toEqual(["network"]);
    });
});
