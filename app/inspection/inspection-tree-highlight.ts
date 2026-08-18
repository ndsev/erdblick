import type {TreeTableNode} from "primeng/api";

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
            if (isHighlighted) {
                highlightedNode = node;
                parents.forEach(parent => parent.expanded = true);
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
