/**
 * Expand the tree path that reveals the first highlighted inspection row.
 * The caller supplies the current nodes and expansion state; this helper does
 * not own a component, subscription or persisted inspection.
 */
import type {TreeTableNode} from "primeng/api";

/**
 * An original coordinate is a leaf in whole-feature inspection. Selecting
 * it adds Point attributes and its decoded readings to the same tree row.
 * Leave individual candidates and their raw source records for the user to open.
 */
function openPointMeasurements(point: TreeTableNode): void {
    for (const section of point.children ?? []) {
        section.expanded = true;
        const measured: TreeTableNode[] = [];
        const ordinary: TreeTableNode[] = [];
        for (const occurrence of section.children ?? []) {
            const readings = occurrence.children?.find(child => child.data?.["key"] === "Measurements");
            if (readings) {
                occurrence.expanded = true;
                readings.expanded = true;
                measured.push(occurrence);
            } else {
                ordinary.push(occurrence);
            }
        }
        // A road can have dozens of applicable passage restrictions before its
        // curvature record. Keep source order within each group and retain node IDs.
        section.children = [...measured, ...ordinary];
    }
}

/**
 * Reopens the ancestor path for the first explicitly highlighted row and returns
 * its index in the resulting visible tree. Explicit navigation must win over a
 * restored user expansion snapshot, while unrelated branches keep their state.
 */
export function expandPathToFirstHighlightedRow(nodes: TreeTableNode[]): number | undefined {
    let highlightedNode: TreeTableNode | undefined;
    const findHighlighted = (nodeList: TreeTableNode[], parents: TreeTableNode[]): boolean => {
        for (const node of nodeList) {
            const styleClass = node.data?.["styleClass"];
            const isHighlighted = typeof styleClass === "string" &&
                styleClass.split(/\s+/).includes("highlight");
            if (node.data?.["inspectionFocus"] || isHighlighted) {
                highlightedNode = node;
                parents.forEach(parent => parent.expanded = true);
                if (node.data?.["inspectionFocus"]) {
                    node.expanded = true;
                    if (node.data["pointSelected"]) {
                        openPointMeasurements(node);
                    }
                }
                return true;
            }
            if (node.children && findHighlighted(node.children, [...parents, node])) {
                return true;
            }
        }
        return false;
    };
    if (!findHighlighted(nodes, []) || !highlightedNode) {
        return undefined;
    }

    let visibleIndex = 0;
    const findVisibleIndex = (nodeList: TreeTableNode[]): number | undefined => {
        for (const node of nodeList) {
            if (node === highlightedNode) {
                return visibleIndex;
            }
            visibleIndex += 1;
            if (node.expanded && node.children?.length) {
                const childIndex = findVisibleIndex(node.children);
                if (childIndex !== undefined) {
                    return childIndex;
                }
            }
        }
        return undefined;
    };
    return findVisibleIndex(nodes);
}
