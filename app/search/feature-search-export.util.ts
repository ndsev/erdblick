import type {FeatureSearchStateEntry} from "../shared/feature-search-state";
import type {FeatureSearchResultEntry} from "./feature.search.service";

export interface FeatureSearchGroupingExportOption {
    id: number;
    name: string;
}

interface FeatureSearchGroupingAccessor {
    name: string;
    label: string;
    get: (result: FeatureSearchResultEntry) => string;
}

interface FeatureSearchResultExport {
    mapId: string;
    layerId: string;
    featureId: string;
    resultIndex: number;
    resultKey: string;
    mapTileKey: string;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: string;
    hoverFeatureId: string;
    attributeIndex?: number;
    validityIndex?: number;
    validityCount?: number;
}

export interface FeatureSearchResultExportNode {
    type: "result";
    key: string;
    label: string;
    result: FeatureSearchResultExport;
}

export interface FeatureSearchGroupExportNode {
    type: "group";
    key: string;
    label: string;
    grouping: {
        id: number;
        name: string;
        label: string;
        value: string;
    };
    count: number;
    children: FeatureSearchExportNode[];
}

export type FeatureSearchExportNode = FeatureSearchGroupExportNode | FeatureSearchResultExportNode;

export interface FeatureSearchResultsExport {
    grouping: FeatureSearchGroupingExportOption[];
    filters: {
        tree: {
            value: string;
            filterBy: "label";
            filterMode: "lenient";
        };
    };
    tree: FeatureSearchExportNode[];
}

type FeatureSearchDefinitionExport = Pick<FeatureSearchStateEntry,
    "id"
    | "query"
    | "scope"
    | "autoUpdate"
    | "bookmarked"
    | "enabled"
    | "paused"
    | "showResultsOnMap"
    | "pinColor"
    | "selectedMapLayers"
    | "searchStyleRules"
    | "renderStrategy">;

const GROUPING_ACCESSORS: Record<number, FeatureSearchGroupingAccessor> = {
    1: {name: "Maps", label: "Map", get: result => result.mapId},
    2: {name: "Layers", label: "Layer", get: result => result.layerId},
    3: {name: "Features", label: "Features", get: result => result.featureId.split(".")[0] ?? ""},
    4: {name: "Tiles", label: "Tiles", get: result => result.sourceTileId.toString()}
};

export function featureSearchDefinitionExport(definition: FeatureSearchStateEntry): FeatureSearchDefinitionExport {
    return {
        id: definition.id,
        query: definition.query,
        scope: definition.scope,
        autoUpdate: definition.autoUpdate,
        bookmarked: definition.bookmarked,
        enabled: definition.enabled,
        paused: definition.paused,
        showResultsOnMap: definition.showResultsOnMap,
        pinColor: definition.pinColor,
        selectedMapLayers: definition.selectedMapLayers.map(ref => ({mapId: ref.mapId, layerId: ref.layerId})),
        searchStyleRules: definition.searchStyleRules,
        renderStrategy: {...definition.renderStrategy}
    };
}

export function featureSearchResultsExport(
    results: FeatureSearchResultEntry[],
    grouping: FeatureSearchGroupingExportOption[],
    filterValue = ""
): FeatureSearchResultsExport {
    const normalizedGrouping = normalizeGrouping(grouping);
    const tree = buildResultTree(
        results.map((result, index) => ({result, index})),
        normalizedGrouping,
        0,
        "root"
    );
    return {
        grouping: normalizedGrouping,
        filters: {
            tree: {
                value: filterValue,
                filterBy: "label",
                filterMode: "lenient"
            }
        },
        tree: filterResultTree(tree, filterValue)
    };
}

export function featureSearchJsonReplacer(_: string, value: unknown): unknown {
    return typeof value === "bigint" ? value.toString() : value;
}

export function safeFeatureSearchExportId(id: string): string {
    return (id || "search").replace(/[^A-Za-z0-9._-]+/g, "_") || "search";
}

function normalizeGrouping(grouping: FeatureSearchGroupingExportOption[]): FeatureSearchGroupingExportOption[] {
    const seen = new Set<number>();
    const result: FeatureSearchGroupingExportOption[] = [];
    for (const option of grouping) {
        const accessor = GROUPING_ACCESSORS[option.id];
        if (!accessor || seen.has(option.id)) {
            continue;
        }
        seen.add(option.id);
        result.push({id: option.id, name: option.name || accessor.name});
    }
    return result;
}

function buildResultTree(
    items: Array<{result: FeatureSearchResultEntry; index: number}>,
    grouping: FeatureSearchGroupingExportOption[],
    depth: number,
    parentKey: string
): FeatureSearchExportNode[] {
    if (depth >= grouping.length) {
        return items.map(item => resultNode(item.result, item.index, parentKey));
    }

    const group = grouping[depth];
    const accessor = GROUPING_ACCESSORS[group.id];
    if (!accessor) {
        return items.map(item => resultNode(item.result, item.index, parentKey));
    }

    const partitions = new Map<string, Array<{result: FeatureSearchResultEntry; index: number}>>();
    for (const item of items) {
        const value = accessor.get(item.result);
        const partition = partitions.get(value) ?? [];
        partition.push(item);
        partitions.set(value, partition);
    }

    return Array.from(partitions.entries()).map(([value, partition]) => {
        const key = `${parentKey}/${accessor.label}:${value}`;
        const children = buildResultTree(partition, grouping, depth + 1, key);
        const count = resultCount(children);
        return groupNode(key, group, accessor, value, count, children);
    });
}

function resultNode(result: FeatureSearchResultEntry, index: number, parentKey: string): FeatureSearchResultExportNode {
    return {
        type: "result",
        key: `${parentKey}/leaf:${index}:${result.resultKey}`,
        label: result.label,
        result: {
            mapId: result.mapId,
            layerId: result.layerId,
            featureId: result.featureId,
            resultIndex: result.resultIndex,
            resultKey: result.resultKey,
            mapTileKey: result.mapTileKey,
            sourceTileKey: result.sourceTileKey,
            sourceMapId: result.sourceMapId,
            sourceLayerId: result.sourceLayerId,
            sourceTileId: result.sourceTileId.toString(),
            hoverFeatureId: result.hoverFeatureId,
            ...(result.attributeIndex !== undefined ? {attributeIndex: result.attributeIndex} : {}),
            ...(result.validityIndex !== undefined ? {validityIndex: result.validityIndex} : {}),
            ...(result.validityCount !== undefined ? {validityCount: result.validityCount} : {})
        }
    };
}

function groupNode(
    key: string,
    group: FeatureSearchGroupingExportOption,
    accessor: FeatureSearchGroupingAccessor,
    value: string,
    count: number,
    children: FeatureSearchExportNode[]
): FeatureSearchGroupExportNode {
    return {
        type: "group",
        key,
        label: `${accessor.label}: ${value} (${count})`,
        grouping: {
            id: group.id,
            name: group.name,
            label: accessor.label,
            value
        },
        count,
        children
    };
}

function filterResultTree(nodes: FeatureSearchExportNode[], filterValue: string): FeatureSearchExportNode[] {
    const normalizedFilter = normalizeFilterText(filterValue);
    if (!normalizedFilter) {
        return nodes;
    }
    return nodes.flatMap(node => {
        const filteredNode = filterResultNode(node, normalizedFilter);
        return filteredNode ? [filteredNode] : [];
    });
}

function filterResultNode(node: FeatureSearchExportNode, normalizedFilter: string): FeatureSearchExportNode | null {
    if (matchesFilter(node.label, normalizedFilter)) {
        return node;
    }
    if (node.type === "result") {
        return null;
    }
    const children = filterResultTree(node.children, normalizedFilter);
    if (children.length === 0) {
        return null;
    }
    const count = resultCount(children);
    return {
        ...node,
        label: `${node.grouping.label}: ${node.grouping.value} (${count})`,
        count,
        children
    };
}

function resultCount(nodes: FeatureSearchExportNode[]): number {
    return nodes.reduce((count, node) => count + (node.type === "result" ? 1 : node.count), 0);
}

function matchesFilter(label: string, normalizedFilter: string): boolean {
    return normalizeFilterText(label).includes(normalizedFilter);
}

function normalizeFilterText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .trim();
}
