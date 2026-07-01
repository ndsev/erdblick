import type {TreeTableNode} from "primeng/api";

/** Formats the child count label shown next to array-container keys. */
export function formatInspectionArrayValueCount(children: TreeTableNode[]): string {
    return String(children.length);
}

/** Creates the compact value-column preview for array containers rendered as child rows. */
export function formatInspectionArrayContainerSummary(children: TreeTableNode[]): string {
    const childSummaries = children.map(child => formatInspectionContainerElementSummary(child));
    return `[${childSummaries.join(", ")}]`;
}

/** Formats one array element, falling back to a shallow object-like summary for nested children. */
function formatInspectionContainerElementSummary(node: TreeTableNode, depth = 0): string {
    const value = node.data?.["value"];
    if (value !== null && value !== undefined && String(value).length > 0) {
        return String(value);
    }
    const key = node.data?.["key"];
    if (!node.children?.length || depth > 0) {
        return key !== null && key !== undefined ? String(key) : "";
    }
    const entries = node.children
        .map(child => {
            const childKey = child.data?.["key"];
            const childValue = formatInspectionContainerElementSummary(child, depth + 1);
            if (childKey !== null && childKey !== undefined && String(childKey).length > 0) {
                return childValue.length > 0 ? `${childKey}: ${childValue}` : String(childKey);
            }
            return childValue;
        })
        .filter(entry => entry.length > 0);
    return entries.length ? `{${entries.join(", ")}}` : String(key ?? "");
}
