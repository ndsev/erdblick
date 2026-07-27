import {TreeTableNode} from "primeng/api";

const SQL_QUERY_KEY = "query";
const SQL_ROWS_KEY = "rows";
const SQL_RESULT_ROW_STYLE_CLASS = "source-data-sql-result-row";
const ADDRESS_KEY = "address";
const DISPLAY_ADDRESS_KEY = "displayAddress";
const ADDRESS_SCOPE_KEY = "addressScope";

interface BitRangeAddress {
    offset: number;
    size: number;
}

/** Visible tree nodes plus optional SQL context extracted from one SourceData root. */
export interface SourceDataTreePresentation {
    sqlQuery?: string;
    treeData: TreeTableNode[];
}

/** Returns whether one parsed SourceData node contributes visible tree content. */
function hasSourceDataTreeNodeContent(node: TreeTableNode | undefined): boolean {
    return !!node && (node.data !== undefined ||
        (Array.isArray(node.children) && node.children.length > 0));
}

/** Return whether a value is the object representation of a BitRange address. */
function isBitRangeAddress(value: unknown): value is BitRangeAddress {
    return typeof value === "object"
        && value !== null
        && typeof (value as BitRangeAddress).offset === "number"
        && typeof (value as BitRangeAddress).size === "number";
}

/** Return whether a tree contains at least one usable relative-address scope. */
function hasBitRangeAddressScope(node: TreeTableNode): boolean {
    if (node.data?.[ADDRESS_SCOPE_KEY] === true
        && isBitRangeAddress(node.data?.[ADDRESS_KEY])) {
        return true;
    }
    return node.children?.some(hasBitRangeAddressScope) ?? false;
}

/**
 * Add presentation-only addresses without changing canonical lookup addresses.
 *
 * Scoped trees hide structural addresses outside payload scopes. Within a
 * scope, descendants are displayed relative to the scope root's absolute
 * offset. Legacy trees without scope metadata retain absolute presentation.
 */
function withDisplayAddresses(
    node: TreeTableNode,
    scopeOffset: number | undefined,
    useAddressScopes: boolean
): TreeTableNode {
    const data = node.data ? {...node.data} : undefined;
    const address = data?.[ADDRESS_KEY];
    let childScopeOffset = scopeOffset;

    if (data?.[ADDRESS_SCOPE_KEY] === true && isBitRangeAddress(address)) {
        childScopeOffset = address.offset;
    }

    if (data) {
        if (isBitRangeAddress(address) && childScopeOffset !== undefined) {
            data[DISPLAY_ADDRESS_KEY] = {
                offset: address.offset - childScopeOffset,
                size: address.size
            };
        } else if (!useAddressScopes && address !== undefined) {
            data[DISPLAY_ADDRESS_KEY] = address;
        }
    }

    return {
        ...node,
        data,
        children: node.children?.map(child =>
            withDisplayAddresses(child, childScopeOffset, useAddressScopes))
    };
}

/**
 * Converts a parsed SourceData root into its visible presentation.
 *
 * SQL result roots expose their query separately and flatten the otherwise
 * redundant `rows > index` hierarchy into named result-row sections.
 */
export function sourceDataTreePresentation(
    root: TreeTableNode | undefined
): SourceDataTreePresentation {
    if (!root) {
        return {treeData: []};
    }

    const rawChildren = Array.isArray(root.children)
        ? root.children.filter(hasSourceDataTreeNodeContent)
        : [];
    const rawQueryNode = rawChildren.find(node => node.data?.["key"] === SQL_QUERY_KEY);
    const rawRowsNode = rawChildren.find(node => node.data?.["key"] === SQL_ROWS_KEY);
    const rawSqlQuery = rawQueryNode?.data?.["value"];
    const isSqlResult = typeof rawSqlQuery === "string"
        && Array.isArray(rawRowsNode?.children);
    const presentedRoot = withDisplayAddresses(
        root,
        undefined,
        isSqlResult || hasBitRangeAddressScope(root));
    const children = Array.isArray(presentedRoot.children)
        ? presentedRoot.children.filter(hasSourceDataTreeNodeContent)
        : [];
    const queryNode = children.find(node => node.data?.["key"] === SQL_QUERY_KEY);
    const rowsNode = children.find(node => node.data?.["key"] === SQL_ROWS_KEY);
    const sqlQuery = queryNode?.data?.["value"];
    if (typeof sqlQuery === "string" && Array.isArray(rowsNode?.children)) {
        return {
            sqlQuery,
            treeData: rowsNode.children
                .filter(hasSourceDataTreeNodeContent)
                .map((row, index) => ({
                    ...row,
                    data: {
                        ...row.data,
                        key: `Result row ${index + 1}`,
                        styleClass: SQL_RESULT_ROW_STYLE_CLASS
                    }
                }))
        };
    }

    return {
        treeData: children.length
            ? children
            : hasSourceDataTreeNodeContent(presentedRoot) ? [presentedRoot] : []
    };
}
