import "@angular/compiler";
import {BehaviorSubject, Subject} from "rxjs";
import {describe, expect, it, vi} from "vitest";

import {MapInfoService} from "./map-info.service";
import {layerPresetInferenceKey, StyleOptionNode} from "./map.tree.model";

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
        viewSync: [],
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
