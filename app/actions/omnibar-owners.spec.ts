import "@angular/compiler";
import {Subject} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createStateOwners, StateOwners} from "../shared/state-test-owners";

const systems: StateOwners[] = [];
function fixture() {
    const owners = createStateOwners({events: new Subject(), navigate: async () => true,
        routerState: {snapshot: {root: {queryParams: {}}}}, getCurrentNavigation: () => undefined} as never,
        {showError() {}, showSuccess() {}} as never);
    systems.push(owners);
    return owners;
}
afterEach(() => systems.splice(0).forEach(owners => owners.destroy()));

describe("owner omnibar workflows", () => {
    it("keeps an inspection suggestion valid across presentation edits and retires it when an ID is reused", async () => {
        const owners = fixture();
        const feature = {featureId: "Road.1", mapTileKey: "Features:Map:Road:1"};
        const id = owners.inspections.setSelection([feature])!;
        const candidate = owners.actions.omnibarTargets("close Road")[0];
        expect(candidate.name).toContain("Road.1");
        owners.inspections.setInspectionPanelLockedState(id, true);
        expect(candidate.validate("close Road")).toBe(true);
        owners.inspections.unsetPanel(id);
        expect(owners.inspections.setSelection([feature])).toBe(id);
        await expect(candidate.execute!("close Road")).rejects.toMatchObject({detail: {code: "not_available"}});
        expect(owners.inspections.selection).toHaveLength(1);
        await owners.actions.omnibarTargets("close Road")[0].execute!("close Road");
        expect(owners.inspections.selection).toEqual([]);
    });

    it("replays search history against logical views after reorder and rejects removed targets", () => {
        const owners = fixture();
        owners.views.viewIdsState.next(["left", "right"]);
        const payload = owners.searches.actionPayloadForHistory({selectedViewIndices: [1],
            selectedMapLayers: [{mapId: "Map", layerId: "Road"}]});
        expect(payload.selectedViewIds).toEqual(["right"]);
        const run = vi.spyOn(owners.searches, "run").mockReturnValue({id: "test"} as never);
        owners.views.reorderViews(["right", "left"]);
        owners.searches.runFromActionPayload("Road", payload);
        expect(run).toHaveBeenCalledWith("Road", expect.objectContaining({selectedViewIndices: [0]}));
        owners.views.retainViews([1], new Map());
        expect(() => owners.searches.runFromActionPayload("Road", payload)).toThrow();
        expect(run).toHaveBeenCalledOnce();
    });
});
