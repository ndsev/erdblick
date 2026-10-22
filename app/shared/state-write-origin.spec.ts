import {getState, WritableStateSource} from "@ngrx/signals";
import {Subject} from "rxjs";
import {afterEach, describe, expect, it} from "vitest";
import releasedStateKeys from "../../test/persisted-state-keys.json";
import {prepareViewMembership} from "../mapview/map-view.store-feature";
import type {AppStoreValues} from "./app.store";
import {patchAppState, persistenceDescriptors} from "./persisted-state";
import {createStateOwners, StateOwners} from "./state-test-owners";

const fixtures: StateOwners[] = [];
function fixture() {
    const owners = createStateOwners({events: new Subject(), navigate: async () => true,
        routerState: {snapshot: {root: {queryParams: {}}}}, getCurrentNavigation: () => undefined} as never,
    {showError() {}, showSuccess() {}} as never);
    owners.persistence.initializePersistence();
    fixtures.push(owners);
    return owners;
}

afterEach(() => {
    fixtures.splice(0).forEach(owners => owners.destroy());
    localStorage.clear();
});

async function metadata(owners: StateOwners) {
    await Promise.resolve();
    await Promise.resolve();
    return Reflect.get(owners.persistence, "configDefaultStateMeta").entries as Record<string, {owner: string}>;
}

describe("persistence write ownership", () => {
    it("discovers every released key exactly once from the actual composed store", () => {
        const owners = fixture();
        const names = owners.persistence.persistedStateNames;
        expect(releasedStateKeys).toHaveLength(70);
        expect(new Set(names).size).toBe(names.length);
        expect([...names].sort()).toEqual([...releasedStateKeys, "viewIds"].sort());
    });

    it("keeps discovery reads pure and catalog materialization system-owned", async () => {
        const owners = fixture();
        const store = owners.store;
        const before = owners.persistence.exportSnapshot();
        expect(store.mapLayerConfig("Map", "Layer")).toEqual([{visible: true, level: 13, autoLevel: true}]);
        expect(store.styleOptionValues("Map", "Layer", "Style", "enabled", "Bool", true)).toEqual([true]);
        expect(owners.persistence.exportSnapshot()).toEqual(before);
        store.applyLayerPresentation({
            configs: [{mapId: "Map", layerId: "Layer", viewConfigs: [{visible: true, level: 13, autoLevel: true}]}],
            options: [{mapId: "Map", layerId: "Layer", shortStyleId: "Style", optionId: "enabled", values: [true]}],
            layerPresets: [], mapPresets: []
        }, {origin: "system"});
        const entries = await metadata(owners);
        for (const key of ["layerNames", "visibility", "zoomLevel", "autoZoomLevel", "Style~0~enabled"]) {
            expect(entries[key]?.owner, key).not.toBe("user");
        }
        expect(store.layers.options().get("Map/Layer/Style/enabled")).toEqual({[store.idAt(0)!]: true});
    });

    it("keeps per-field origins for one prepared mixed publication", async () => {
        const owners = fixture();
        const current = getState(owners.store);
        // Exercise the same publication primitive used inside native features;
        // protected application consumers cannot call patchState directly.
        patchAppState(owners.store as unknown as WritableStateSource<AppStoreValues>, {
            views: {...current.views, marker: true},
            diagnostics: {...current.diagnostics, logFilter: {info: false, warn: true, error: true}}
        }, {marker: "user", diagnosticsLogFilter: "system"});
        const entries = await metadata(owners);
        expect(entries["marker"]?.owner).toBe("user");
        expect(entries["diagnosticsLogFilter"]?.owner).not.toBe("user");
        expect(entries["diagnosticsExportOptions"]?.owner).not.toBe("user");
        // Origin belongs only to that synchronous publication.
        owners.store.setDiagnosticsLogFilter({info: true, warn: false, error: true});
        expect((await metadata(owners))["diagnosticsLogFilter"]?.owner).toBe("user");
    });

    it("propagates system membership origin to count, focus and keyed preparation", async () => {
        const owners = fixture();
        const next = prepareViewMembership(getState(owners.store), [owners.store.idAt(0)!, "new"], persistenceDescriptors(owners.store));
        owners.store.restorePersistedState(next, "system");
        const entries = await metadata(owners);
        for (const name of ["viewIds", "numberOfViews", "focus", "cameraView", "visibility", "styleOptions"]) {
            expect(entries[name]?.owner, name).not.toBe("user");
        }
        expect(owners.store.numViews()).toBe(2);
    });
});
