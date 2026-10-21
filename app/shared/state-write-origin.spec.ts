import {Subject} from "rxjs";
import {afterEach, describe, expect, it} from "vitest";
import releasedStateKeys from "../../test/persisted-state-keys.json";
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
    it("registers every released key exactly once through the complete actual-owner fixture", () => {
        const owners = fixture();
        const names = owners.persistence.registeredStateNames;
        expect(releasedStateKeys).toHaveLength(70);
        expect(new Set(names).size).toBe(names.length);
        expect([...names].sort()).toEqual([...releasedStateKeys, "viewIds"].sort());
    });

    it("keeps discovery reads pure and catalog materialization system-owned", async () => {
        const owners = fixture();
        const before = owners.persistence.exportSnapshot();
        expect(owners.layers.mapLayerConfig("Map", "Layer")).toEqual([{visible: true, level: 13, autoLevel: true}]);
        expect(owners.layers.styleOptionValues("Map", "Layer", "Style", "enabled", "Bool", true)).toEqual([true]);
        expect(owners.persistence.exportSnapshot()).toEqual(before);
        owners.layers.initializeMapLayerConfig("Map", "Layer");
        owners.layers.initializeStyleOptionValues("Map", "Layer", "Style", "enabled", "Bool", true);
        const entries = await metadata(owners);
        for (const key of ["layerNames", "visibility", "zoomLevel", "autoZoomLevel", "Style~0~enabled"]) {
            expect(entries[key]?.owner, key).not.toBe("user");
        }
        expect(owners.layers.styles.get("Map/Layer/Style/enabled")).toEqual([true]);
    });

    it("retains a system write's origin after an observer queues another commit", async () => {
        const owners = fixture();
        const subscription = owners.views.markerState.subscribe(marker => {
            if (marker) owners.persistence.withSystemStateMutation(() => {
                owners.diagnostics.diagnosticsLogFilter = {info: false, warn: true, error: true};
            });
        });
        owners.views.marker = true;
        const entries = await metadata(owners);
        expect(entries["marker"]?.owner).toBe("user");
        expect(entries["diagnosticsLogFilter"]?.owner).not.toBe("user");
        expect(owners.diagnostics.diagnosticsLogFilter.info).toBe(false);
        subscription.unsubscribe();
    });

    it("keeps per-slot origins inside a mixed transaction and forgets reverted edits", async () => {
        const owners = fixture();
        owners.persistence.transaction(() => {
            owners.views.marker = true;
            owners.persistence.withSystemStateMutation(() => {
                owners.diagnostics.diagnosticsLogFilter = {info: false, warn: true, error: true};
            });
            const original = owners.diagnostics.diagnosticsExportOptions;
            owners.diagnostics.diagnosticsExportOptions = {...original, includeLogs: false};
            owners.diagnostics.diagnosticsExportOptions = original;
        });
        const entries = await metadata(owners);
        expect(entries["marker"]?.owner).toBe("user");
        expect(entries["diagnosticsLogFilter"]?.owner).not.toBe("user");
        expect(entries["diagnosticsExportOptions"]?.owner).not.toBe("user");
    });

    it("propagates system membership origin to count, focus and per-view preparation", async () => {
        const owners = fixture();
        owners.views.markerState.subscribe(marker => {
            if (marker) owners.persistence.withSystemStateMutation(() => { owners.views.numViews = 2; });
        });
        owners.views.marker = true;
        const entries = await metadata(owners);
        for (const name of [owners.views.viewIdsState.name, owners.views.numViewsState.name,
            owners.views.focusedViewState.name, owners.views.cameraViewDataState.appState.name,
            owners.layers.layerVisibilityState.appState.name, owners.layers.stylesState.name]) {
            expect(entries[name]?.owner, name).not.toBe("user");
        }
        expect(owners.views.numViews).toBe(2);
    });
});
