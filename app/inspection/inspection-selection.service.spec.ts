import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";

import type {
    AppStateService,
    InspectionPanelModel,
    TileFeatureId
} from "../shared/appstate.service";
import type {InfoMessageService} from "../shared/info.service";
import {InspectionSelectionService} from "./inspection-selection.service";

const feature = (featureId: string, mapTileKey: string): TileFeatureId => ({featureId, mapTileKey});

function createHarness(limit: number, initialPanels: InspectionPanelModel<TileFeatureId>[] = []) {
    let panels = [...initialPanels];
    let nextPanelId = 1 + Math.max(-1, ...panels.map(panel => panel.id));
    const stateService = {
        inspectionsLimit: limit,
        get selection() {
            return panels;
        },
        setSelection: vi.fn((features: TileFeatureId[], _id?: number, forceNewPanel = false) => {
            if (!forceNewPanel) {
                const duplicate = panels.find(panel =>
                    panel.sourceData === undefined &&
                    panel.features.some(existing =>
                        existing.mapTileKey === features[0].mapTileKey &&
                        existing.featureId === features[0].featureId
                    )
                );
                if (duplicate) {
                    return undefined;
                }
                const reusable = [...panels].reverse().find(panel =>
                    panel.sourceData === undefined && !panel.locked
                );
                if (reusable) {
                    reusable.features = [...features];
                    return reusable.id;
                }
            }
            if (panels.length >= limit) {
                return undefined;
            }
            const id = nextPanelId++;
            panels.push({
                id,
                features: [...features],
                locked: false,
                focused: true,
                size: [30, 20],
                color: "#fff",
                undocked: false
            });
            return id;
        }),
        unsetUnlockedSelections: vi.fn(() => {
            panels = panels.filter(panel => panel.locked || panel.sourceData !== undefined);
        }),
        setInspectionPanelLockedState: vi.fn((panelId: number, locked: boolean) => {
            const panel = panels.find(candidate => candidate.id === panelId);
            if (panel) {
                panel.locked = locked;
            }
        })
    } as unknown as AppStateService;
    const infoMessageService = {showWarning: vi.fn()} as unknown as InfoMessageService;
    const service = new InspectionSelectionService(
        stateService,
        {} as never,
        {} as never,
        {registerShortcut: vi.fn()} as never,
        infoMessageService,
        {run: (callback: () => unknown) => callback()} as never
    );
    return {service, stateService, infoMessageService, panels: () => panels};
}

describe("InspectionSelectionService multi-inspection", () => {
    it("deduplicates exact identities and warns once when logical hits exceed capacity", () => {
        const {service, panels, infoMessageService} = createHarness(2);
        const result = service.inspectFeatureIds([
            feature("same-id", "map-a/tile"),
            feature("same-id", "map-a/tile"),
            feature("same-id", "map-b/tile"),
            feature("third", "map-c/tile")
        ]);

        expect(result).toEqual({foundFeatureCount: 3, inspectedFeatureCount: 2});
        expect(panels().map(panel => panel.features[0])).toEqual([
            feature("same-id", "map-a/tile"),
            feature("same-id", "map-b/tile")
        ]);
        expect(infoMessageService.showWarning).toHaveBeenCalledOnce();
        expect(infoMessageService.showWarning).toHaveBeenCalledWith(
            "Inspecting 2 features out of 3 found features. " +
            "Decrease the selection or increase your max inspections limit to see more."
        );
    });

    it("does not invoke the generic panel-limit path for a single hit when no panel can be reused", () => {
        const lockedPanel: InspectionPanelModel<TileFeatureId> = {
            id: 0,
            features: [feature("locked", "map/tile")],
            locked: true,
            focused: true,
            size: [30, 20],
            color: "#fff",
            undocked: false
        };
        const {service, stateService, infoMessageService} = createHarness(1, [lockedPanel]);

        const result = service.inspectFeatureIds([feature("new", "map/tile")]);

        expect(result).toEqual({foundFeatureCount: 1, inspectedFeatureCount: 0});
        expect(stateService.setSelection).not.toHaveBeenCalled();
        expect(infoMessageService.showWarning).toHaveBeenCalledWith(
            "Inspecting 0 features out of 1 found features. " +
            "Decrease the selection or increase your max inspections limit to see more."
        );
    });

    it("uses remaining capacity for hits not already represented by pinned panels", () => {
        const existing = feature("existing", "map/tile");
        const lockedPanel: InspectionPanelModel<TileFeatureId> = {
            id: 0,
            features: [existing],
            locked: true,
            focused: true,
            size: [30, 20],
            color: "#fff",
            undocked: false
        };
        const {service, panels, infoMessageService} = createHarness(2, [lockedPanel]);
        const missing = feature("missing", "map/tile");

        const result = service.inspectFeatureIds([existing, missing]);

        expect(result).toEqual({foundFeatureCount: 2, inspectedFeatureCount: 2});
        expect(panels().map(panel => panel.features[0])).toEqual([existing, missing]);
        expect(infoMessageService.showWarning).not.toHaveBeenCalled();
    });

    it("locks every panel newly opened by a Ctrl drill inspection", () => {
        const {service, panels, stateService} = createHarness(3);

        const result = service.inspectFeatureIds([
            feature("first", "map/tile"),
            feature("second", "map/tile")
        ], true);

        expect(result).toEqual({foundFeatureCount: 2, inspectedFeatureCount: 2});
        expect(panels().map(panel => panel.locked)).toEqual([true, true]);
        expect(stateService.setInspectionPanelLockedState).toHaveBeenCalledTimes(2);
    });
});
