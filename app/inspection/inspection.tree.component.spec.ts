import {describe, expect, it} from "vitest";
import type {TreeTableNode} from "primeng/api";
import {inspectionSearchNumberLiteral} from "./inspection-search.util";
import {expandPathToFirstHighlightedRow} from "./inspection-tree-highlight";

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
