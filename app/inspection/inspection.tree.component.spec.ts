import {describe, expect, it, vi} from "vitest";
import type {TreeTableNode} from "primeng/api";
import {inspectionSearchNumberLiteral} from "./inspection-search.util";
import {expandPathToFirstHighlightedRow} from "./inspection-tree-highlight";
import {InspectionTreeComponent} from "./inspection.tree.component";

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
            data: {key: "target", styleClass: "source-data-field highlight"}
        };
        const branch: TreeTableNode = {
            data: {key: "branch"},
            expanded: false,
            children: [{data: {key: "before"}}, highlighted]
        };
        const root: TreeTableNode = {
            data: {key: "root"},
            expanded: false,
            children: [branch]
        };
        const nodes: TreeTableNode[] = [{data: {key: "other"}}, root];

        expect(expandPathToFirstHighlightedRow(nodes)).toBe(4);
        expect(root.expanded).toBe(true);
        expect(branch.expanded).toBe(true);
    });

    it("leaves expansion untouched when no explicit highlight exists", () => {
        const nodes: TreeTableNode[] = [{
            data: {key: "root"},
            expanded: false,
            children: [{data: {key: "child"}}]
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
        component.cdr = {markForCheck: vi.fn()};
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
        component.geoJsonMenu = {toggle: vi.fn()};
        component.copyToClipboard = vi.fn();
        component.showGeoJsonMenu({stopPropagation: vi.fn()} as unknown as MouseEvent);
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
