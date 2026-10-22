import { InspectionStore } from "./inspection.store";
import { AppLayoutStore } from "../layout/app-layout.store";
import "@angular/compiler";
import { describe, expect, it } from "vitest";
import { testPersistence } from "../../test/state-owners";
import { AppLayoutService } from "../layout/app-layout.service";
import { InspectionPanelService } from "./inspection-panel.service";

const mapTileKey = "Features:map:layer:42";

function createFixture() {
    const persistence = testPersistence();
    const layout = new AppLayoutService(persistence, new AppLayoutStore(persistence));
    const owner = new InspectionPanelService(persistence, layout, {} as never, new InspectionStore(persistence));
    const first = owner.setSelection([{ mapTileKey, featureId: "Road.1" }], undefined, true, true)!;
    const second = owner.setSelection([{ mapTileKey, featureId: "Road.2" }], undefined, true, true)!;
    return { persistence, layout, owner, first, second };
}

describe("InspectionPanelService completed edits", () => {
    it.each(["one panel", "unlocked panels"])("removes %s together with comparison and layout references", removal => {
        const { persistence, layout, owner, first, second } = createFixture();
        owner.setInspectionPanelLockedState(second, true);
        owner.setInspectionDialogPosition(first, { left: 10, top: 20 });
        owner.setInspectionDialogPosition(second, { left: 30, top: 40 });
        owner.setInspectionTreeHiddenColumns(first, ["schemaType"]);
        const entry = (panelId: number) => ({
            panelId,
            label: "Panel " + panelId,
            mapId: "map",
            featureIds: owner.store.selection.find(panel => panel.id === panelId)!.features
        });
        owner.openInspectionComparison({ base: entry(first), others: [entry(second)] });
        const previousSelection = owner.store.selection;
        const observed: unknown[] = [];
        const subscription = persistence.observe(() => ({
            ids: owner.store.selection.map(panel => panel.id),
            comparedIds: owner.store.inspectionComparison
                ? [owner.store.inspectionComparison.base, ...owner.store.inspectionComparison.others].map(item => item.panelId)
                : [],
            layoutIds: Object.keys(layout.store.dialogLayoutsState.value),
            columnIds: Object.keys(owner.store.inspectionTreeHiddenColumnsState.value)
        })).subscribe(value => observed.push(value));

        if (removal === "one panel") owner.unsetPanel(first);
        else owner.unsetUnlockedSelections();

        expect(observed).toEqual([
            {
                ids: [first, second], comparedIds: [first, second],
                layoutIds: ["inspection:" + first, "inspection:" + second], columnIds: [String(first)]
            },
            { ids: [second], comparedIds: [second], layoutIds: ["inspection:" + second], columnIds: [] }
        ]);
        expect(previousSelection.map(panel => panel.id)).toEqual([first, second]);
        subscription.unsubscribe();
    });

    it("docks and focuses a panel with the final lock and dock tab in one commit", () => {
        const { persistence, layout, owner, first, second } = createFixture();
        layout.store.dockActiveTab = "search";
        const observed: unknown[] = [];
        const subscription = persistence.observe(() => ({
            panels: owner.store.selection.map(panel => ({
                id: panel.id, undocked: panel.undocked, locked: panel.locked, focused: !!panel.focused
            })),
            dockOpen: layout.store.isDockOpen,
            tab: layout.store.dockActiveTab
        })).subscribe(value => observed.push(value));

        owner.setInspectionPanelUndockedState(first, false);

        expect(observed).toEqual([
            {
                panels: [
                    { id: first, undocked: true, locked: false, focused: false },
                    { id: second, undocked: true, locked: false, focused: true }
                ],
                dockOpen: false, tab: "search"
            },
            {
                panels: [
                    { id: first, undocked: false, locked: true, focused: true },
                    { id: second, undocked: true, locked: false, focused: false }
                ],
                dockOpen: true, tab: "inspection"
            }
        ]);
        subscription.unsubscribe();
    });

    it("publishes a validity highlight with its final focus and visible dock", () => {
        const { persistence, layout, owner, first, second } = createFixture();
        owner.setInspectionPanelUndockedState(first, false);
        owner.setFocusedInspectionPanel(second);
        layout.store.isDockOpen = false;
        layout.store.dockActiveTab = "search";
        const previousSelection = owner.store.selection;
        const observed: unknown[] = [];
        const subscription = persistence.observe(() => ({
            features: owner.store.selection.map(panel => panel.features[0].featureId),
            focused: owner.focusedInspectionPanelId,
            dockOpen: layout.store.isDockOpen,
            tab: layout.store.dockActiveTab
        })).subscribe(value => observed.push(value));

        owner.toggleInspectionFeatureHighlight(first, mapTileKey, "Road.1:attribute#0");

        expect(observed).toEqual([
            { features: ["Road.1", "Road.2"], focused: second, dockOpen: false, tab: "search" },
            { features: ["Road.1:attribute#0", "Road.2"], focused: first, dockOpen: true, tab: "inspection" }
        ]);
        expect(previousSelection[0].features[0].featureId).toBe("Road.1");
        subscription.unsubscribe();
    });
});
