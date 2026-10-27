import { describe, expect, it, vi } from "vitest";
import type { TreeTableNode } from "primeng/api";
import { inspectionSearchNumberLiteral } from "../../../app/inspection/inspection-search.util";
import { expandPathToFirstHighlightedRow } from "../../../app/inspection/inspection-tree-highlight";
import { InspectionTreeComponent } from "../../../app/inspection/inspection-tree.component";

describe("inspectionSearchNumberLiteral", () => {
    it("keeps BigInt inspection integers as unquoted Simfil numeric literals", () => {
        expect(inspectionSearchNumberLiteral(50n)).toBe("50");
    });

    it("accepts finite numbers and strict numeric strings", () => {
        expect(inspectionSearchNumberLiteral(42)).toBe("42");
        expect(inspectionSearchNumberLiteral(" 1.25e+2 ")).toBe("1.25e+2");
    });

    it("rejects non-numeric strings instead of creating partial numeric literals", () => {
        expect(inspectionSearchNumberLiteral("50 km/h")).toBeUndefined();
        expect(inspectionSearchNumberLiteral("50n")).toBeUndefined();
    });
});

describe("expandPathToFirstHighlightedRow", () => {
    it("reopens a restored collapsed path and returns the resulting visible index", () => {
        const highlighted: TreeTableNode = {
            data: { key: "target", styleClass: "source-data-field highlight" }
        };
        const branch: TreeTableNode = {
            data: { key: "branch" },
            expanded: false,
            children: [{ data: { key: "before" } }, highlighted]
        };
        const root: TreeTableNode = {
            data: { key: "root" },
            expanded: false,
            children: [branch]
        };
        const nodes: TreeTableNode[] = [{ data: { key: "other" } }, root];

        expect(expandPathToFirstHighlightedRow(nodes)).toBe(4);
        expect(root.expanded).toBe(true);
        expect(branch.expanded).toBe(true);
    });

    it("leaves expansion untouched when no explicit highlight exists", () => {
        const nodes: TreeTableNode[] = [{
            data: { key: "root" },
            expanded: false,
            children: [{ data: { key: "child" } }]
        }];

        expect(expandPathToFirstHighlightedRow(nodes)).toBeUndefined();
        expect(nodes[0].expanded).toBe(false);
    });
});

describe("inspection map-hover ownership", () => {
    it("does not let a delayed leave clear a re-entered target", async () => {
        const component = Object.create(InspectionTreeComponent.prototype) as any;
        component.destroyed = false;
        component.mapHoverEpoch = 0;
        component.cdr = { markForCheck: vi.fn() };
        const transition = vi.fn();

        component.claimMapHover("row:X");
        component.deferMapHoverTransition("row:X", transition);
        component.claimMapHover("row:X");
        await Promise.resolve();

        expect(transition).not.toHaveBeenCalled();
        expect(component.activeMapHoverOwner).toBe("row:X");
    });
});

describe("lazy geometry export", () => {
    it("opens the export menu without serializing geometry, then resolves the current payload on copy", () => {
        const component = Object.create(InspectionTreeComponent.prototype) as any;
        const serialize = vi.fn(() => '{"type":"FeatureCollection","features":[]}');
        component.geoJson = () => serialize;
        component.geoJsonMenu = { toggle: vi.fn() };
        component.copyToClipboard = vi.fn();
        component.showGeoJsonMenu({ stopPropagation: vi.fn() } as unknown as MouseEvent);
        expect(serialize).not.toHaveBeenCalled();
        component.copyGeoJson();
        expect(serialize).toHaveBeenCalledTimes(1);
        expect(component.copyToClipboard).toHaveBeenCalledWith(serialize.mock.results[0].value);
    });

    it("continues to export eager payloads from other inspection panels", () => {
        const component = Object.create(InspectionTreeComponent.prototype) as any;
        component.geoJson = () => '{"type":"FeatureCollection","features":[]}';
        component.copyToClipboard = vi.fn();
        component.copyGeoJson();
        expect(component.copyToClipboard).toHaveBeenCalledWith(component.geoJson());
    });
});

describe("incoming relation actions", () => {
    it("opens a source relation that is outside the selected target panel", () => {
        const component = Object.create(InspectionTreeComponent.prototype) as any;
        component.inspectionMenu = { toggle: vi.fn() };
        component.panelId = () => 'target';
        component.inspectionState = {
            state: { selection: [{ id: 'target', features: [{ mapTileKey: 'surface', featureId: 'Surface.1' }] }] },
            setSelection: vi.fn(), toggleInspectionFeatureHighlight: vi.fn()
        };
        component.shouldShowScalarRowActions = () => false;
        component.onRowActionsClick({ stopPropagation: vi.fn() }, {}, {
            key: 'visible', value: '', mapTileKey: 'lane', hoverId: 'Lane.7:relation#1'
        });
        const action = component.inspectionMenuItems.find((item: any) => item.label === 'Inspect source relation');
        expect(action).toBeDefined();
        action.command();
        expect(component.inspectionState.setSelection).toHaveBeenCalledWith([
            { mapTileKey: 'lane', featureId: 'Lane.7:relation#1' }
        ]);
        expect(component.inspectionState.toggleInspectionFeatureHighlight).not.toHaveBeenCalled();
    });
});
