import {
    AppStateService,
    clampTileGridLevel,
    clampTileGridOpacity,
    LayerViewConfig,
    normalizeTileGridColor,
    TileGridMode,
    VIEW_SYNC_LAYERS
} from "../shared/appstate.service";
import {filter, take} from "rxjs/operators";
import {Subscription} from "rxjs";
import {ErdblickStyle, FeatureStyleOptionWithStringType, StyleService} from "../styledata/style.service";
import {
    MapPresetService,
    NO_PRESET_ID,
    ResolvedLayerPreset
} from "../styledata/map-preset.service";
import {LayerPresetRef} from "../styledata/layer-preset.model";
import {MapPresetDefinition, MapPresetLayer} from "../styledata/map-preset.model";

export type DataSourceCatalogStatus = "initializing" | "ready" | "failed";

/** Removes the synthetic group prefix from nested map ids for tree display. */
export function removeGroupPrefix(id: string) {
    if (id.includes('/')) {
        const pureId = id.split('/').at(-1);
        return pureId ? pureId : id;
    }
    return id;
}

/** Expected structure of a LayerInfoItem's coverage entry. */
export interface CoverageRectItem extends Record<string, any> {
    min: number,
    max: number
}

/** Expected structure of a list entry in the MapInfoItem's layer entry. */
export interface LayerInfoItem extends Record<string, any> {
    canRead: boolean;
    canWrite: boolean;
    coverage: Array<number | CoverageRectItem>;
    featureTypes: Array<{ name: string, uniqueIdCompositions: Array<any> }>;
    layerId: string;
    type: string;
    version: { major: number, minor: number, patch: number };
    zoomLevels: Array<number>;
}

/** Expected structure of a list entry in the /sources endpoint. */
export interface MapInfoItem extends Record<string, any> {
    extraJsonAttachment: any;
    layers: Record<string, LayerInfoItem>;
    mapId: string;
    maxParallelJobs: number;
    sourceId: string;
    stringPoolId: string;
    protocolVersion?: { major: number, minor: number, patch: number };
    addOn: boolean;
    status?: DataSourceCatalogStatus | string;
    statusMessage?: string;
    progress?: number | null;
    configIndex?: number;
    type?: string;
}

/** Normalizes legacy and catalog-aware `/sources` entries into a known datasource state. */
export function dataSourceCatalogStatus(item: Pick<MapInfoItem, "status">): DataSourceCatalogStatus {
    return item.status === "initializing" || item.status === "failed"
        ? item.status
        : "ready";
}

/** Returns true when a `/sources` catalog entry can be used for tile and search requests. */
export function isDataSourceCatalogEntryReady(item: Pick<MapInfoItem, "status">): boolean {
    return dataSourceCatalogStatus(item) === "ready";
}

/** Normalizes optional datasource startup progress to a display percentage. */
export function dataSourceProgressPercent(item: Pick<MapInfoItem, "progress">): number | null {
    if (typeof item.progress !== "number" || !Number.isFinite(item.progress)) {
        return null;
    }
    const percent = item.progress <= 1
        ? item.progress * 100
        : item.progress;
    return Math.max(0, Math.min(100, Math.round(percent)));
}

/** Sorts catalog snapshots in config order while keeping legacy entries stable at the end. */
export function sortDataSourceCatalogEntries(entries: MapInfoItem[]): MapInfoItem[] {
    return entries
        .map((entry, index) => ({entry, index}))
        .sort((lhs, rhs) => {
            const lhsIndex = Number.isFinite(lhs.entry.configIndex)
                ? Number(lhs.entry.configIndex)
                : Number.MAX_SAFE_INTEGER;
            const rhsIndex = Number.isFinite(rhs.entry.configIndex)
                ? Number(rhs.entry.configIndex)
                : Number.MAX_SAFE_INTEGER;
            return lhsIndex - rhsIndex || lhs.index - rhs.index;
        })
        .map(({entry}) => entry);
}

/** Tree node that mirrors one style option entry for a concrete map/layer pairing. */
export class StyleOptionNode {
    id: string;
    type: string;
    key: string;
    info: FeatureStyleOptionWithStringType;
    mapId: string;
    layerId: string;
    value: (boolean|number|string)[] = [];
    shortStyleId: string;
    styleId: string;
    styleOptionGroupId: string;
    firstInStyleGroup: boolean;

    /** Builds the stable key used by the tree and persisted style option state. */
    constructor(
        mapId: string,
        layerId: string,
        definition: FeatureStyleOptionWithStringType,
        styleId: string,
        shortStyleId: string,
        firstInStyleGroup: boolean
    ) {
        this.id = definition.id;
        this.shortStyleId = shortStyleId;
        this.styleId = styleId;
        this.styleOptionGroupId = styleId;
        this.firstInStyleGroup = firstInStyleGroup;
        this.type = definition.type as string;
        this.info = definition;
        this.mapId = mapId;
        this.layerId = layerId;
        this.key = `${mapId}/${layerId}/${shortStyleId}/${definition.id}`;
    }
}

/** Tree row that selects and expands eligible presets for one concrete feature layer. */
export class LayerPresetNode {
    readonly id = "layer-preset";
    readonly type = "Preset";
    readonly key: string;
    readonly mapId: string;
    readonly layerId: string;
    readonly presets: ResolvedLayerPreset[];
    readonly selectOptions: Array<{label: string; value: string}>;
    selectedPresetKeys: string[] = [];
    expandedPresetOptions: boolean[] = [];

    /** Creates the stable leading control row for one map/layer option list. */
    constructor(
        mapId: string,
        layerId: string,
        presets: ResolvedLayerPreset[]
    ) {
        this.mapId = mapId;
        this.layerId = layerId;
        this.key = `${mapId}/${layerId}/layer-preset`;
        this.presets = presets;
        this.selectOptions = [
            {label: "Custom options", value: NO_PRESET_ID},
            ...presets.map(preset => ({label: `${preset.styleId} — ${preset.name}`, value: preset.key}))
        ];
    }
}

/** Controls how a reconciled preset association changes the compact option projection. */
export type LayerPresetPresentation = "collapse" | "expand" | "preserve";

/** Identifies one concrete layer in one view for post-transaction preset inference. */
export function layerPresetInferenceKey(viewIndex: number, mapId: string, layerId: string): string {
    return `${viewIndex}\u0000${mapId}\u0000${layerId}`;
}

/**
 * Selects the unique most-specific preset matching the current option state.
 * A current preset wins only an equal-specificity tie; catalog order never breaks ambiguity.
 */
export function bestMatchingLayerPreset(
    presets: readonly ResolvedLayerPreset[],
    options: readonly StyleOptionNode[],
    viewIndex: number,
    currentKey: string
): ResolvedLayerPreset | undefined {
    const matches = presets.filter(preset => preset.values.every(value => {
        const option = options.find(candidate =>
            candidate.styleId === preset.styleId && candidate.id === value.optionId);
        return option?.value[viewIndex] === value.value;
    }));
    if (!matches.length) {
        return undefined;
    }
    const mostSpecificCount = Math.max(...matches.map(preset => preset.values.length));
    const mostSpecific = matches.filter(preset => preset.values.length === mostSpecificCount);
    if (mostSpecific.length === 1) {
        return mostSpecific[0];
    }
    return mostSpecific.find(preset => preset.key === currentKey);
}

export type LayerTreeChildNode = LayerPresetNode | StyleOptionNode;

/** Narrows a layer child to an actual style option rather than its preset control row. */
export function isStyleOptionNode(node: LayerTreeChildNode): node is StyleOptionNode {
    return node instanceof StyleOptionNode;
}

/** Narrows a layer child to its preset control row. */
export function isLayerPresetNode(node: LayerTreeChildNode): node is LayerPresetNode {
    return node instanceof LayerPresetNode;
}

/** Returns only renderable style-option children from one feature-layer node. */
export function layerStyleOptions(layer: LayerTreeNode): StyleOptionNode[] {
    return layer.children.filter(isStyleOptionNode);
}

/** Returns the leading preset row from one feature-layer node, if options are present. */
export function layerPresetNode(layer: LayerTreeNode): LayerPresetNode | undefined {
    return layer.children.find(isLayerPresetNode);
}

/** Tree node that represents one feature layer and the per-view controls attached to it. */
export class LayerTreeNode {
    id: string;
    type: string;
    info: LayerInfoItem;
    mapId: string;
    key: string;
    viewConfig: LayerViewConfig[] = [];  // This is an array, because the values are stored per MapView.
    children: LayerTreeChildNode[] = [];
    expanded: boolean = true;

    /** Wraps raw layer metadata into the structure consumed by the map tree. */
    constructor(layerInfo: LayerInfoItem, mapId: string) {
        this.info = layerInfo;
        this.mapId = mapId;
        this.id = layerInfo.layerId;
        this.key = `${mapId}/${layerInfo.layerId}`;
        this.type = layerInfo.type;
    }
}

/** Tree node for one map entry, including its feature layers and per-view visibility state. */
export class MapTreeNode {
    id: string;
    type: string = "Map";
    info: MapInfoItem;
    key: string;
    onlyFeatureLayers: LayerTreeNode[];
    layers: Map<string, LayerTreeNode> = new Map();
    expanded: boolean = true;
    visible: boolean[] = [];  // This is an array, because the values are stored per MapView.
    mapPresets: MapPresetDefinition[] = [];
    mapPresetOptions: Array<{label: string; value: string}> = [{label: "Custom options", value: NO_PRESET_ID}];
    selectedMapPresetIds: string[] = [];

    /** Materializes layer child nodes once so the tree can be reconfigured without rebuilding metadata. */
    constructor(mapInfo: MapInfoItem) {
        this.info = mapInfo;
        this.key = mapInfo.mapId;
        this.id = mapInfo.mapId;
        this.layers =  new Map(Object.entries(mapInfo.layers).map(([_, layerInfo]) =>
            [layerInfo.layerId, new LayerTreeNode(layerInfo, mapInfo.mapId)])
        );
        this.onlyFeatureLayers = Array.from(this.layers.values().filter(layer => layer.type !== "SourceData"));
    }

    /** Returns the feature-layer children that PrimeNG renders beneath this map node. */
    get children() {
        return this.onlyFeatureLayers;
    }

    /**
     * Recomputes per-view map visibility from the child layer switches.
     * The tree uses this aggregate state for parent checkboxes and auto-collapse.
     */
    updateVisibilityFromChildren(numViews: number) {
        // Set the visibility state for this map node for each view,
        // based on the view config state of the layers. We must assume
        // that all layers have the same number of view config entries.
        if (!this.children.length) {
            this.visible = Array.from({length: numViews}, () => false);
            return;
        }
        this.visible = Array.from({length: numViews}, () => false);
        for (const child of this.children) {
            if (child.type === "SourceData") {
                continue;
            }
            console.assert(child.viewConfig.length === numViews);
            this.visible = this.visible.map((v, i) => v || child.viewConfig[i].visible);
        }
        // Collapse the node automatically if it does not contain active children
        if (this.expanded) {
            this.expanded = this.visible.some(v => v);
        }
    }

    /** Iterates every feature layer below this map node. */
    *allFeatureLayers() {
        for (const child of this.children) {
            yield child;
        }
    }
}

/** Tree node for synthetic folder/group entries derived from slash-separated map ids. */
export class GroupTreeNode {
    id: string;
    key: string;
    type: string = "Group";
    children: Array<GroupTreeNode | MapTreeNode> = [];
    expanded: boolean = true;
    visible: boolean[] = [];  // This is an array, because the values are stored per MapView.

    /** Preserves the full group path as both key and id so nested lookup stays unambiguous. */
    constructor(key: string) {
        this.key = key;
        this.id = key;  // FIXME removeGroupPrefix(key); ???
    }

    /** Iterates every feature layer nested anywhere below this group. */
    *allFeatureLayers(): IterableIterator<LayerTreeNode> {
        for (const child of this.children) {
            yield* child.allFeatureLayers();
        }
    }

    /** Recomputes aggregate visibility from the group's descendant maps and child groups. */
    updateVisibilityFromChildren(numViews: number) {
        // Set the visibility state for this group node for each view,
        // based on the view config state of the maps. We must assume
        // that all maps have the same number of view config entries.
        if (!this.children.length) {
            this.visible = Array.from({length: numViews}, () => false);
            return;
        }
        this.visible = Array.from({length: numViews}, () => false);
        for (const child of this.children) {
            child.updateVisibilityFromChildren(numViews);
            this.visible = this.visible.map((v, i) => v || child.visible[i]);
        }
    }
}

type MapTreeSourceNode = GroupTreeNode | MapTreeNode | LayerTreeNode | LayerPresetNode | StyleOptionNode;

/**
 * Presentation-only tree node consumed by the map panel while a filter is active.
 * Mutable map, layer, and style-option state remains shared with the canonical source node.
 */
export interface MapTreeViewNode {
    id: string;
    key: string;
    type: string;
    expanded?: boolean;
    children?: MapTreeViewNode[];
    visible?: boolean[];
    viewConfig?: LayerViewConfig[];
    value?: Array<boolean | number | string>;
}

/** Returns the source children of a branch node without manufacturing children for leaves. */
function mapTreeNodeChildren(
    node: MapTreeSourceNode,
    viewIndex: number,
    query: string
): MapTreeSourceNode[] | undefined {
    if (node instanceof LayerTreeNode) {
        const presetNode = layerPresetNode(node);
        const options = layerStyleOptions(node);
        if (!presetNode || presetNode.presets.length === 0) {
            return options;
        }
        const selectedPreset = presetNode.presets.find(
            preset => preset.key === presetNode.selectedPresetKeys[viewIndex]);
        if (!selectedPreset || presetNode.expandedPresetOptions[viewIndex]) {
            return [presetNode, ...options];
        }
        return [
            presetNode,
            ...options.filter(option =>
                !selectedPreset.values.some(value =>
                    selectedPreset.styleId === option.styleId && value.optionId === option.id)
                || (!!query && mapTreeNodeMatches(option, query)))
        ];
    }
    if (node instanceof MapTreeNode) {
        return [...node.children];
    }
    if (node instanceof GroupTreeNode) {
        return [...node.children];
    }
    return undefined;
}

/** Matches the identifiers rendered by the map tree and the human label of style options. */
function mapTreeNodeMatches(node: MapTreeSourceNode, query: string): boolean {
    if (node instanceof StyleOptionNode) {
        return node.id.toLocaleLowerCase().includes(query)
            || node.info.label.toLocaleLowerCase().includes(query);
    }
    if (node instanceof LayerPresetNode) {
        return node.presets.some(preset =>
            preset.id.toLocaleLowerCase().includes(query)
            || preset.name.toLocaleLowerCase().includes(query)
            || preset.styleId.toLocaleLowerCase().includes(query));
    }
    if (node instanceof MapTreeNode && node.mapPresets.some(preset =>
        preset.id.toLocaleLowerCase().includes(query)
        || preset.name.toLocaleLowerCase().includes(query))) {
        return true;
    }
    return node.id.toLocaleLowerCase().includes(query);
}

/** Clones a complete display subtree while retaining references to its underlying control state. */
function cloneMapTreeSubtree(
    node: MapTreeSourceNode,
    viewIndex: number,
    query: string
): MapTreeViewNode {
    const children = mapTreeNodeChildren(node, viewIndex, query);
    if (children === undefined) {
        return {...node};
    }
    return {
        ...node,
        children: children.map(child => cloneMapTreeSubtree(child, viewIndex, query))
    };
}

/**
 * Filters one branch recursively.
 * Ancestors of descendant matches are expanded only in the cloned presentation tree.
 */
function filterMapTreeNode(
    node: MapTreeSourceNode,
    query: string,
    viewIndex: number
): MapTreeViewNode | null {
    // Lenient matching keeps a directly matched map or branch complete, just like PrimeNG's tree filter.
    if (mapTreeNodeMatches(node, query)) {
        return cloneMapTreeSubtree(node, viewIndex, query);
    }

    const children = mapTreeNodeChildren(node, viewIndex, query);
    if (!children?.length) {
        return null;
    }

    const filteredChildren: MapTreeViewNode[] = [];
    for (const child of children) {
        const filteredChild = filterMapTreeNode(child, query, viewIndex);
        if (filteredChild !== null) {
            filteredChildren.push(filteredChild);
        }
    }
    if (!filteredChildren.length) {
        return null;
    }

    return {
        ...node,
        children: filteredChildren,
        expanded: true
    };
}

/**
 * Builds the map panel's filtered view without changing datasource or per-view map state.
 * An empty query returns the canonical root nodes so their normal expansion state is restored.
 */
export function filterMapTreeNodes(
    nodes: Array<GroupTreeNode | MapTreeNode>,
    filterText: string,
    viewIndex = 0
): MapTreeViewNode[] {
    const query = filterText.trim().toLocaleLowerCase();
    if (!query) {
        return nodes.map(node => cloneMapTreeSubtree(node, viewIndex, query));
    }

    const filteredNodes: MapTreeViewNode[] = [];
    for (const node of nodes) {
        const filteredNode = filterMapTreeNode(node, query, viewIndex);
        if (filteredNode !== null) {
            filteredNodes.push(filteredNode);
        }
    }
    return filteredNodes;
}

export interface SyncViewsResult {
    styleOptionChanges: Array<[StyleOptionNode, number]>;
    viewConfigChanged: boolean;
}

/** One map-preset component resolved against a concrete map and active style catalog. */
export interface ResolvedMapPresetComponent {
    definition: MapPresetLayer;
    layer: LayerTreeNode;
    preset: ResolvedLayerPreset;
}

/**
 * Holds the map/layer/style tree shown in the maps panel.
 * The tree owns UI-only grouping and visibility state, while `AppStateService`
 * remains the source of truth for persisted per-view settings.
 */
export class MapLayerTree {
    nodes: (GroupTreeNode | MapTreeNode)[] = [];
    private mapsForMapIds: Map<string, MapTreeNode> = new Map();
    private sizeOfTree: number = 0;
    private readonly subscriptions = new Subscription();

    /** Builds the tree and keeps it synchronized with app state and the loaded style sheets. */
    constructor(
        mapInfo: MapInfoItem[],
        private stateService: AppStateService,
        private styleService: StyleService,
        private mapPresetService: MapPresetService,
        private readonly pruneUnavailableState = true) {
        this.initializeMapGroups(mapInfo);
        this.subscriptions.add(
            this.stateService.ready.pipe(filter(ready => ready), take(1)).subscribe(_ => {
                this.initializeStyleOptions([...this.styleService.styles.values()]);
                this.configureTreeParameters();
                if (this.mapsForMapIds.size && this.pruneUnavailableState) {
                    this.stateService.prune(this.mapsForMapIds, this.styleService.styles);
                }
            })
        );
        this.subscriptions.add(this.styleService.styleGroups.subscribe(_ => {
            this.initializeStyleOptions([...this.styleService.styles.values()]);
            this.configureTreeParameters();
        }));
        this.subscriptions.add(this.mapPresetService.presets$.subscribe(_ => {
            this.initializeStyleOptions([...this.styleService.styles.values()]);
            this.configureTreeParameters();
        }));
        this.subscriptions.add(this.stateService.numViewsState.subscribe(_ => {
            this.configureTreeParameters();
        }));
    }

    /** Releases state and style subscriptions when the datasource catalog replaces this tree. */
    destroy(): void {
        this.subscriptions.unsubscribe();
    }

    /** Exposes the flat map lookup used by callers that already know the map id. */
    get maps() {
        return this.mapsForMapIds;
    }

    /** Returns the approximate node count for diagnostics and tree heuristics. */
    get size() {
        return this.sizeOfTree;
    }

    /**
     * Builds the nested group/map structure from the backend `/sources` response.
     * Group nodes are synthetic and derived solely from slash-separated map ids.
     */
    private initializeMapGroups(mapInfo: MapInfoItem[]) {
        const groups = new Map<string, GroupTreeNode>();
        const rootNodes: Array<GroupTreeNode | MapTreeNode> = [];

        const getOrCreateGroupByPath = (path: string): GroupTreeNode => {
            const segments = path.split('/');
            let currentPath = segments[0];
            let currentGroup: GroupTreeNode;
            if (groups.has(currentPath)) {
                currentGroup = groups.get(currentPath)!;
            } else {
                currentGroup = new GroupTreeNode(currentPath);
                this.sizeOfTree++;
                groups.set(currentPath, currentGroup);
                rootNodes.push(currentGroup);
            }
            for (let i = 1; i < segments.length; ++i) {
                currentPath = `${currentPath}/${segments[i]}`;
                let found: GroupTreeNode | null = null;
                for (const child of currentGroup.children) {
                    if ((child as any).type === "Group" && (child as GroupTreeNode).id === currentPath) {
                        found = child as GroupTreeNode;
                        break;
                    }
                }
                if (!found) {
                    found = new GroupTreeNode(currentPath);
                    this.sizeOfTree++;
                    currentGroup.children.push(found);
                }
                currentGroup = found;
            }
            return currentGroup;
        };

        // Build nested groups
        for (const mapItem of mapInfo) {
            if (mapItem.mapId.includes('/')) {
                const parentPath = mapItem.mapId.split('/').slice(0, -1).join('/');
                const currentGroup = getOrCreateGroupByPath(parentPath);
                const mapNode = new MapTreeNode(mapItem);
                this.sizeOfTree += 1 + mapNode.layers.size;
                this.maps.set(mapItem.mapId, mapNode);
                currentGroup.children.push(mapNode);
            } else {
                const mapNode = new MapTreeNode(mapItem);
                this.sizeOfTree += 1 + mapNode.layers.size;
                this.maps.set(mapItem.mapId, mapNode);
                rootNodes.push(mapNode);
            }
        }

        this.nodes = rootNodes;
    }

    /** Rebuilds the style-option children for every layer from the currently visible style sheets. */
    private initializeStyleOptions(styleSheets: ErdblickStyle[]) {
        for (const map of this.maps.values()) {
            for (const layer of map.allFeatureLayers()) {
                const previousPresetNode = layerPresetNode(layer);
                const options: StyleOptionNode[] = [];
                for (const style of styleSheets) {
                    if (style.visible && style.featureLayerStyle?.hasLayerAffinity(layer.id)) {
                        const visibleOptions = style.options.filter(option => !option.internal);
                        for (const [index, option] of visibleOptions.entries()) {
                            options.push(new StyleOptionNode(
                                layer.mapId,
                                layer.id,
                                option,
                                style.id,
                                style.shortId,
                                index === 0));
                        }
                    }
                }
                if (!options.length) {
                    layer.children = [];
                    continue;
                }
                const presetNode = new LayerPresetNode(
                    layer.mapId,
                    layer.id,
                    this.mapPresetService.presetsForLayer(layer.id, options));
                presetNode.expandedPresetOptions = previousPresetNode
                    ? [...previousPresetNode.expandedPresetOptions]
                    : [];
                layer.children = [presetNode, ...options];
            }
            // Partial compositions can become equivalent on maps that omit one of their layers.
            const resolvedSignatures = new Set<string>();
            map.mapPresets = this.mapPresetService.presets.filter(preset => {
                if (!this.mapPresetService.isAvailable(preset)) {
                    return false;
                }
                const components = this.resolveMapPresetComponents(map, preset);
                if (!components) {
                    return false;
                }
                const signature = components.map(component =>
                    `${component.layer.id}\u0000${component.preset.key}`).sort().join("\u0001");
                if (resolvedSignatures.has(signature)) {
                    return false;
                }
                resolvedSignatures.add(signature);
                return true;
            });
            map.mapPresetOptions = [
                {label: "Custom options", value: NO_PRESET_ID},
                ...map.mapPresets.map(preset => ({label: preset.name, value: preset.id}))
            ];
        }
    }

    /** Resolves components present on a map and rejects broken references on existing layers. */
    resolveMapPresetComponents(
        map: MapTreeNode,
        preset: MapPresetDefinition
    ): ResolvedMapPresetComponent[] | undefined {
        if (!isDataSourceCatalogEntryReady(map.info)) {
            return undefined;
        }
        const result: ResolvedMapPresetComponent[] = [];
        for (const definition of preset.layerPresets) {
            const layer = map.onlyFeatureLayers.find(candidate => candidate.id === definition.layerId);
            if (!layer) {
                continue;
            }
            const resolvedPreset = this.mapPresetService.resolveLayerPreset(
                layer.id,
                {styleId: definition.styleId, presetId: definition.presetId},
                layerStyleOptions(layer));
            if (!resolvedPreset) {
                return undefined;
            }
            result.push({definition, layer, preset: resolvedPreset});
        }
        return result.length ? result : undefined;
    }

    /** Returns whether layer synchronization would force two component assignments to disagree. */
    mapPresetHasSyncConflict(map: MapTreeNode, preset: MapPresetDefinition): boolean {
        const components = this.resolveMapPresetComponents(map, preset);
        if (!components) {
            return true;
        }
        const assignments = new Map<string, boolean>();
        for (const component of components) {
            for (const value of component.preset.values) {
                const key = `${component.preset.styleId}\u0000${value.optionId}`;
                const previous = assignments.get(key);
                if (previous !== undefined && previous !== value.value) {
                    return true;
                }
                assignments.set(key, value.value);
            }
        }
        return false;
    }

    /**
     * Reapplies persisted per-view state and infers unambiguous presets from hydrated option values.
     * This is called after map/style changes and when the number of views changes.
     */
    configureTreeParameters() {
        let defaultVisibility = true;
        for (const mapOrGroupItem of this.nodes) {
            for (const featureLayer of mapOrGroupItem.allFeatureLayers()) {
                const defaultLevel = featureLayer.info.zoomLevels.length
                    ? featureLayer.info.zoomLevels[0]
                    : undefined;
                featureLayer.viewConfig = this.stateService.mapLayerConfig(
                    featureLayer.mapId,
                    featureLayer.info.layerId,
                    defaultVisibility,
                    defaultLevel);
                const options = layerStyleOptions(featureLayer);
                for (const option of options) {
                    option.value = this.stateService.styleOptionValues(
                        featureLayer.mapId,
                        featureLayer.id,
                        option.shortStyleId,
                        option.id,
                        option.type,
                        option.info.defaultValue
                    );
                }
                const presetNode = layerPresetNode(featureLayer);
                if (presetNode) {
                    const viewCount = this.stateService.numViewsState.getValue();
                    presetNode.selectedPresetKeys = Array.from({length: viewCount}, (_, viewIndex) => {
                        const selectedRef = this.stateService.getLayerPresetSelection(
                            viewIndex,
                            featureLayer.mapId,
                            featureLayer.id);
                        const matchingPresets = selectedRef?.styleId
                            ? presetNode.presets.filter(preset =>
                                preset.styleId === selectedRef.styleId && preset.id === selectedRef.presetId)
                            : presetNode.presets.filter(preset => preset.id === selectedRef?.presetId);
                        const selectedPreset = matchingPresets.length === 1 ? matchingPresets[0] : undefined;
                        if (selectedPreset
                            && this.mapPresetService.matchesPresetValues(
                                selectedPreset,
                                options,
                                viewIndex)) {
                            if (selectedRef?.styleId !== selectedPreset.styleId) {
                                this.stateService.setLayerPresetSelection(
                                    viewIndex,
                                    featureLayer.mapId,
                                    featureLayer.id,
                                    selectedPreset.ref);
                            }
                            return selectedPreset.key;
                        }
                        const inferredPreset = bestMatchingLayerPreset(
                            presetNode.presets,
                            options,
                            viewIndex,
                            selectedPreset?.key ?? NO_PRESET_ID);
                        if (inferredPreset) {
                            this.stateService.setLayerPresetSelection(
                                viewIndex,
                                featureLayer.mapId,
                                featureLayer.id,
                                inferredPreset.ref);
                            return inferredPreset.key;
                        }
                        if (selectedRef) {
                            this.stateService.setLayerPresetSelection(
                                viewIndex,
                                featureLayer.mapId,
                                featureLayer.id,
                                null);
                        }
                        return NO_PRESET_ID;
                    });
                    presetNode.expandedPresetOptions = Array.from(
                        {length: viewCount},
                        (_, viewIndex) => presetNode.expandedPresetOptions[viewIndex] ?? false);
                }
            }
            mapOrGroupItem.updateVisibilityFromChildren(this.stateService.numViewsState.getValue());
            defaultVisibility = false;
        }

        const viewCount = this.stateService.numViewsState.getValue();
        for (const map of this.maps.values()) {
            map.selectedMapPresetIds = Array.from({length: viewCount}, (_, viewIndex) => {
                const matchingPresets = map.mapPresets.filter(preset => {
                    const components = this.resolveMapPresetComponents(map, preset);
                    return components?.every(component =>
                        this.mapPresetService.matchesPresetValues(
                            component.preset,
                            layerStyleOptions(component.layer),
                            viewIndex)) === true;
                });
                const selectedId = this.stateService.getMapPresetSelection(viewIndex, map.id);
                const selectedPreset = matchingPresets.find(preset => preset.id === selectedId);
                if (selectedPreset) {
                    return selectedPreset.id;
                }
                if (matchingPresets.length === 1) {
                    this.stateService.setMapPresetSelection(
                        viewIndex,
                        map.id,
                        matchingPresets[0].id);
                    return matchingPresets[0].id;
                }
                if (selectedId) {
                    this.stateService.setMapPresetSelection(viewIndex, map.id, null);
                }
                return NO_PRESET_ID;
            });
        }
    }

    /** Returns the current visible flag for a concrete map layer in a specific view. */
    getMapLayerVisibility(viewIndex: number, mapId: string, layerId: string) {
        const mapItem = this.maps.get(mapId);
        if (!mapItem || !mapItem.children.some(layer => layer.id === layerId)) {
            return false;
        }

        const layer = mapItem.layers.get(layerId);
        if (layer) {
            if (layer.type == "SourceData") {
                return false;
            }
            return layer.viewConfig[viewIndex]?.visible ?? false;
        }
        return false;
    }

    /** Updates one layer, one map, or one group subtree and persists the visibility change. */
    setMapLayerVisibility(viewIndex: number, mapOrGroupId: string, layerId: string = "", state: boolean) {
        const mapOrGroupItem = this.findChildById(mapOrGroupId);
        if (mapOrGroupItem === undefined) {
            return;
        }
        for (const layer of mapOrGroupItem.allFeatureLayers()) {
            if (viewIndex >= layer.viewConfig.length) {
                continue;
            }
            if (!layerId || layer.id === layerId) {
                layer.viewConfig[viewIndex].visible = state;
                this.stateService.setMapLayerConfig(layer.mapId, layer.id, layer.viewConfig);
            }
        }
        // Set visibility of map/group items from their children.
        this.configureTreeParameters();
    }

    /** Persists whether tile borders are shown for the given view. */
    setViewTileBorderState(viewIndex: number, enabled: boolean) {
        this.stateService.viewTileBordersState.next(viewIndex, enabled);
    }

    /** Returns whether tile borders are enabled for the given view. */
    getViewTileBorderState(viewIndex: number) {
        return this.stateService.viewTileBordersState.getValue(viewIndex);
    }

    /** Persists the tile grid coordinate mode shown in the given view. */
    setViewTileGridMode(viewIndex: number, mode: TileGridMode) {
        this.stateService.viewTileGridModeState.next(viewIndex, mode);
        this.setViewTileGridLevel(viewIndex, this.getViewTileGridLevel(viewIndex));
    }

    /** Returns the configured tile grid coordinate mode for the given view. */
    getViewTileGridMode(viewIndex: number): TileGridMode {
        return this.stateService.viewTileGridModeState.getValue(viewIndex);
    }

    /** Persists the independent line-grid level for the given view. */
    setViewTileGridLevel(viewIndex: number, level: number): void {
        this.stateService.viewTileGridLevelState.next(
            viewIndex,
            clampTileGridLevel(level, this.getViewTileGridMode(viewIndex)));
    }

    /** Returns the selected line-grid level for the given view. */
    getViewTileGridLevel(viewIndex: number): number {
        return clampTileGridLevel(
            this.stateService.viewTileGridLevelState.getValue(viewIndex),
            this.getViewTileGridMode(viewIndex));
    }

    /** Persists whether the line grid follows the viewport-based auto-level heuristic. */
    setViewTileGridAutoLevel(viewIndex: number, autoLevel: boolean): void {
        this.stateService.viewTileGridAutoLevelState.next(viewIndex, autoLevel);
    }

    /** Returns whether the line grid follows the viewport-based auto-level heuristic. */
    getViewTileGridAutoLevel(viewIndex: number): boolean {
        return this.stateService.viewTileGridAutoLevelState.getValue(viewIndex);
    }

    /** Persists the line-grid RGB colour for the given view. */
    setViewTileGridColor(viewIndex: number, color: string): void {
        this.stateService.viewTileGridColorState.next(viewIndex, normalizeTileGridColor(color));
    }

    /** Returns the normalized line-grid RGB colour for the given view. */
    getViewTileGridColor(viewIndex: number): string {
        return normalizeTileGridColor(this.stateService.viewTileGridColorState.getValue(viewIndex));
    }

    /** Persists the line-grid opacity percentage for the given view. */
    setViewTileGridOpacity(viewIndex: number, opacity: number): void {
        this.stateService.viewTileGridOpacityState.next(viewIndex, clampTileGridOpacity(opacity));
    }

    /** Returns the normalized line-grid opacity percentage for the given view. */
    getViewTileGridOpacity(viewIndex: number): number {
        return clampTileGridOpacity(this.stateService.viewTileGridOpacityState.getValue(viewIndex));
    }

    /** Persists the explicit layer level for a single view. */
    setMapLayerLevel(viewIndex: number, mapId: string, layerId: string, level: number) {
        const mapItem = this.maps.get(mapId);
        if (!mapItem || !mapItem.children.some(layer => layer.id === layerId)) {
            return;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.viewConfig.length <= viewIndex) {
            return;
        }
        layer.viewConfig[viewIndex].level = level;
        this.stateService.setMapLayerConfig(mapId, layerId, layer.viewConfig);
    }

    /** Persists whether a layer follows the auto-level heuristic in a given view. */
    setMapLayerAutoLevel(viewIndex: number, mapId: string, layerId: string, autoLevel: boolean) {
        const mapItem = this.maps.get(mapId);
        if (!mapItem || !mapItem.children.some(layer => layer.id === layerId)) {
            return;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.viewConfig.length <= viewIndex) {
            return;
        }
        layer.viewConfig[viewIndex].autoLevel = autoLevel;
        this.stateService.setMapLayerConfig(mapId, layerId, layer.viewConfig);
    }

    /** Iterates the configured layer levels for one view across every known feature layer. */
    *allLevels(viewIndex: number) {
        for (let [_, map] of this.maps) {
            for (let layer of map.children) {
                if (layer.viewConfig.length <= viewIndex) {
                    console.error(`Attempt to read viewConfig at bad index ${viewIndex}`);
                    continue;
                }
                yield layer.viewConfig[viewIndex].level;
            }
        }
    }

    /** Returns the persisted layer level, falling back to the historical default level 13. */
    getMapLayerLevel(viewIndex: number, mapId: string, layerId: string) {
        const mapItem = this.maps.get(mapId);
        if (!mapItem || !mapItem.children.some(layer => layer.id === layerId)) {
            return 13;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.viewConfig.length <= viewIndex) {
            return 13;
        }
        return layer.viewConfig[viewIndex].level;
    }

    /** Returns whether auto-level is enabled, defaulting to true for missing config. */
    getMapLayerAutoLevel(viewIndex: number, mapId: string, layerId: string) {
        const mapItem = this.maps.get(mapId);
        if (!mapItem || !mapItem.children.some(layer => layer.id === layerId)) {
            return true;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.viewConfig.length <= viewIndex) {
            return true;
        }
        return layer.viewConfig[viewIndex].autoLevel;
    }

    /** Returns the persisted style option values for one layer/style combination in one view. */
    getLayerStyleOptions(viewIndex: number, mapId: string, layerId: string, styleId: string): Record<string, boolean|number|string> | undefined {
        const mapItem = this.maps.get(mapId);
        if (!mapItem || !mapItem.children.some(layer => layer.id === layerId)) {
            return;
        }
        const layer = mapItem.layers.get(layerId)!;
        const options = layerStyleOptions(layer);
        if (options.some(option => option.value.length <= viewIndex)) {
            return;
        }
        return Object.fromEntries(
            options.filter(option => option.styleId === styleId).map(option => [option.id, option.value[viewIndex]])
        ) as Record<string, boolean|number|string>;
    }

    /** Iterates all feature layers across groups and maps in tree order. */
    *allFeatureLayers(): IterableIterator<LayerTreeNode> {
        for (const child of this.nodes) {
            yield* child.allFeatureLayers();
        }
    }

    /** Returns one concrete feature layer by its map and layer identity. */
    getFeatureLayer(mapId: string, layerId: string): LayerTreeNode | undefined {
        return this.maps.get(mapId)?.layers.get(layerId);
    }

    /** Stores expansion changes from an unfiltered presentation clone on its canonical branch. */
    setNodeExpanded(key: string, expanded: boolean): void {
        const stack: Array<GroupTreeNode | MapTreeNode | LayerTreeNode> = [...this.nodes];
        while (stack.length) {
            const node = stack.pop()!;
            if (node.key === key) {
                node.expanded = expanded;
                return;
            }
            if (node instanceof GroupTreeNode || node instanceof MapTreeNode) {
                stack.push(...node.children);
            }
        }
    }

    /** Updates one qualified layer-preset association and its collapsed expansion state. */
    setLayerPresetSelection(
        viewIndex: number,
        mapId: string,
        layerId: string,
        ref: LayerPresetRef | null,
        presentation: LayerPresetPresentation = "collapse"
    ): void {
        const layer = this.getFeatureLayer(mapId, layerId);
        const presetNode = layer ? layerPresetNode(layer) : undefined;
        if (!presetNode || viewIndex >= this.stateService.numViewsState.getValue()) {
            return;
        }
        const selectedPreset = ref ? presetNode.presets.find(preset =>
            preset.styleId === ref.styleId && preset.id === ref.presetId) : undefined;
        const normalizedKey = selectedPreset?.key ?? NO_PRESET_ID;
        if (presetNode.selectedPresetKeys[viewIndex] !== normalizedKey) {
            if (presentation === "collapse") {
                presetNode.expandedPresetOptions[viewIndex] = false;
            } else if (presentation === "expand") {
                presetNode.expandedPresetOptions[viewIndex] = true;
            }
        }
        presetNode.selectedPresetKeys[viewIndex] = normalizedKey;
        this.stateService.setLayerPresetSelection(
            viewIndex,
            mapId,
            layerId,
            selectedPreset?.ref ?? null);
    }

    /** Toggles whether options owned by the selected preset are projected into one view's tree. */
    setLayerPresetExpanded(
        viewIndex: number,
        mapId: string,
        layerId: string,
        expanded: boolean
    ): void {
        const layer = this.getFeatureLayer(mapId, layerId);
        const presetNode = layer ? layerPresetNode(layer) : undefined;
        if (presetNode) {
            presetNode.expandedPresetOptions[viewIndex] = expanded;
        }
    }

    /** Stores or clears one map-preset association after its component values are applied. */
    setMapPresetSelection(viewIndex: number, mapId: string, presetId: string | null): void {
        const map = this.maps.get(mapId);
        if (!map || viewIndex >= this.stateService.numViewsState.getValue()) {
            return;
        }
        const selected = presetId ? map.mapPresets.find(preset => preset.id === presetId) : undefined;
        map.selectedMapPresetIds[viewIndex] = selected?.id ?? NO_PRESET_ID;
        this.stateService.setMapPresetSelection(viewIndex, mapId, selected?.id ?? null);
    }

    /**
     * Validates every stored association and infers layer presets only for explicitly affected
     * layer/view identities after their complete option transaction has settled.
     */
    reconcilePresetSelections(inferenceTargets: ReadonlySet<string> = new Set()): void {
        const viewCount = this.stateService.numViewsState.getValue();
        for (const layer of this.allFeatureLayers()) {
            const presetNode = layerPresetNode(layer);
            if (!presetNode) {
                continue;
            }
            const options = layerStyleOptions(layer);
            for (let viewIndex = 0; viewIndex < viewCount; viewIndex++) {
                const storedRef = this.stateService.getLayerPresetSelection(viewIndex, layer.mapId, layer.id);
                const selectedPreset = presetNode.presets.find(preset =>
                    preset.key === presetNode.selectedPresetKeys[viewIndex]
                    || (preset.styleId === storedRef?.styleId && preset.id === storedRef?.presetId));
                const shouldInfer = inferenceTargets.has(
                    layerPresetInferenceKey(viewIndex, layer.mapId, layer.id));
                if (shouldInfer) {
                    const matched = bestMatchingLayerPreset(
                        presetNode.presets,
                        options,
                        viewIndex,
                        selectedPreset?.key ?? NO_PRESET_ID);
                    if (matched) {
                        this.setLayerPresetSelection(
                            viewIndex,
                            layer.mapId,
                            layer.id,
                            matched.ref,
                            "expand");
                    } else {
                        this.setLayerPresetSelection(
                            viewIndex,
                            layer.mapId,
                            layer.id,
                            null,
                            "preserve");
                    }
                    continue;
                }
                if (selectedPreset && this.mapPresetService.matchesPresetValues(
                    selectedPreset,
                    options,
                    viewIndex)) {
                    presetNode.selectedPresetKeys[viewIndex] = selectedPreset.key;
                    continue;
                }
                if (storedRef || presetNode.selectedPresetKeys[viewIndex]) {
                    this.setLayerPresetSelection(viewIndex, layer.mapId, layer.id, null);
                }
            }
        }

        for (const map of this.maps.values()) {
            for (let viewIndex = 0; viewIndex < viewCount; viewIndex++) {
                const selectedId = map.selectedMapPresetIds[viewIndex]
                    || this.stateService.getMapPresetSelection(viewIndex, map.id);
                const selected = map.mapPresets.find(preset => preset.id === selectedId);
                const components = selected ? this.resolveMapPresetComponents(map, selected) : undefined;
                const matches = components?.every(component =>
                    layerPresetNode(component.layer)?.selectedPresetKeys[viewIndex] === component.preset.key
                    && this.mapPresetService.matchesPresetValues(
                        component.preset,
                        layerStyleOptions(component.layer),
                        viewIndex)) === true;
                if (selected && components && matches) {
                    map.selectedMapPresetIds[viewIndex] = selected.id;
                } else if (selectedId) {
                    this.setMapPresetSelection(viewIndex, map.id, null);
                }
            }
        }
    }

    /** Runtime type guard for synthetic group nodes. */
    private checkIsMapGroup (e: any): e is GroupTreeNode {
        return e.type === "Group";
    }

    /** Recursively resolves a tree node by id across group and map children. */
    private findChildById(id: string, elements: (GroupTreeNode | MapTreeNode)[]|undefined = undefined): GroupTreeNode | MapTreeNode | undefined {
        if (!elements) {
            elements = this.nodes;
        }
        for (const elem of elements) {
            if (elem.id === id) {
                return elem;
            }
            if (this.checkIsMapGroup(elem)) {
                const found = this.findChildById(id, elem.children);
                if (found) return found;
            }
        }
        return undefined;
    }

    /**
     * Copies style option values from one layer to every other compatible layer in the tree.
     * Compatibility means matching style id and option ids, not matching map/layer ids.
     */
    syncLayers(
        viewIndex: number,
        mapId: string,
        layerId: string,
        persistChanges = true
    ): StyleOptionNode[] {
        const sourceMap = this.maps.get(mapId);
        if (!sourceMap) {
            return [];
        }
        const sourceLayer = sourceMap.layers.get(layerId);
        if (!sourceLayer) {
            return [];
        }
        if (viewIndex >= sourceLayer.viewConfig.length) {
            return [];
        }

        const sourceOptions = layerStyleOptions(sourceLayer).filter(option => option.value.length > viewIndex);
        if (!sourceOptions.length) {
            return [];
        }

        const sourceOptionKeys = new Map<string, StyleOptionNode>();
        for (const option of sourceOptions) {
            sourceOptionKeys.set(`${option.styleId}:${option.id}`, option);
        }

        const changedOptions: StyleOptionNode[] = [];

        for (const candidateLayer of this.allFeatureLayers()) {
            if (candidateLayer === sourceLayer) {
                continue;
            }
            const candidateOptions = layerStyleOptions(candidateLayer);
            if (candidateOptions.length < sourceOptions.length) {
                continue;
            }

            const candidateOptionMap = new Map<string, StyleOptionNode>();
            for (const option of candidateOptions) {
                candidateOptionMap.set(`${option.styleId}:${option.id}`, option);
            }

            let optionsMatch = true;
            for (const key of sourceOptionKeys.keys()) {
                const targetOption = candidateOptionMap.get(key);
                if (!targetOption || targetOption.value.length <= viewIndex) {
                    optionsMatch = false;
                    break;
                }
            }

            if (!optionsMatch) {
                continue;
            }

            for (const [key, sourceOption] of sourceOptionKeys.entries()) {
                const targetOption = candidateOptionMap.get(key)!;
                const sourceValue = sourceOption.value[viewIndex];
                if (targetOption.value[viewIndex] === sourceValue) {
                    continue;
                }
                targetOption.value[viewIndex] = sourceValue;
                changedOptions.push(targetOption);
            }
            this.copyLayerPresetSelection(viewIndex, sourceLayer, candidateLayer);
        }

        if (persistChanges && changedOptions.length) {
            this.stateService.setStyleOptionValuesBatch(changedOptions.map(option => ({
                mapId: option.mapId,
                layerId: option.layerId,
                shortStyleId: option.shortStyleId,
                optionId: option.id,
                values: option.value
            })));
        }
        return changedOptions;
    }

    /**
     * Mirrors one view's layer/style state into the other views when view sync is enabled.
     * The return value lets callers update only the visualizations affected by the copied state.
     */
    syncViews(viewIndex: number, persistStyleChanges = true): SyncViewsResult {
        const numViews = this.stateService.numViewsState.getValue();
        if (numViews < 2) {
            return { styleOptionChanges: [], viewConfigChanged: false };
        }

        const styleOptionChanges: Array<[StyleOptionNode, number]> = [];
        let viewConfigChanged = false;

        for (const layer of this.allFeatureLayers()) {
            if (layer.viewConfig.length <= viewIndex) {
                continue;
            }
            const sourceConfig = layer.viewConfig[viewIndex];
            let layerConfigMutated = false;

            for (let targetIndex = 0; targetIndex < layer.viewConfig.length; targetIndex++) {
                if (targetIndex === viewIndex || layer.viewConfig.length <= targetIndex) {
                    continue;
                }
                const targetConfig = layer.viewConfig[targetIndex];
                if (!targetConfig) {
                    continue;
                }

                if (targetConfig.visible !== sourceConfig.visible ||
                    targetConfig.level !== sourceConfig.level ||
                    targetConfig.autoLevel !== sourceConfig.autoLevel) {
                    layer.viewConfig[targetIndex] = {
                        autoLevel: sourceConfig.autoLevel,
                        visible: sourceConfig.visible,
                        level: sourceConfig.level
                    };
                    layerConfigMutated = true;
                }
            }

            if (layerConfigMutated) {
                viewConfigChanged = true;
                this.stateService.setMapLayerConfig(layer.mapId, layer.id, layer.viewConfig);
            }

            for (const option of layerStyleOptions(layer)) {
                if (option.value.length <= viewIndex) {
                    continue;
                }
                const sourceValue = option.value[viewIndex];
                let optionMutated = false;
                for (let targetIndex = 0; targetIndex < option.value.length; targetIndex++) {
                    if (targetIndex === viewIndex) {
                        continue;
                    }
                    if (option.value[targetIndex] !== sourceValue) {
                        option.value[targetIndex] = sourceValue;
                        optionMutated = true;
                        styleOptionChanges.push([option, targetIndex]);
                    }
                }
            }
            const presetNode = layerPresetNode(layer);
            const selectedPreset = presetNode?.presets.find(preset =>
                preset.key === presetNode.selectedPresetKeys[viewIndex]);
            const selectedRef = selectedPreset?.ref
                ?? this.stateService.getLayerPresetSelection(viewIndex, layer.mapId, layer.id);
            for (let targetIndex = 0; targetIndex < numViews; targetIndex++) {
                if (targetIndex !== viewIndex) {
                    this.applyEligiblePresetSelection(
                        targetIndex,
                        layer,
                        selectedRef);
                }
            }
        }

        for (const map of this.maps.values()) {
            const selectedMapPresetId = map.selectedMapPresetIds[viewIndex]
                || this.stateService.getMapPresetSelection(viewIndex, map.id);
            for (let targetIndex = 0; targetIndex < numViews; targetIndex++) {
                if (targetIndex !== viewIndex) {
                    this.setMapPresetSelection(targetIndex, map.id, selectedMapPresetId || null);
                }
            }
        }

        const sourceTileBorders = this.getViewTileBorderState(viewIndex);
        const sourceTileGridMode = this.getViewTileGridMode(viewIndex);
        const sourceTileGridLevel = this.getViewTileGridLevel(viewIndex);
        const sourceTileGridAutoLevel = this.getViewTileGridAutoLevel(viewIndex);
        const sourceTileGridColor = this.getViewTileGridColor(viewIndex);
        const sourceTileGridOpacity = this.getViewTileGridOpacity(viewIndex);
        for (let targetIndex = 0; targetIndex < numViews; targetIndex++) {
            if (targetIndex === viewIndex) {
                continue;
            }
            if (this.getViewTileBorderState(targetIndex) !== sourceTileBorders) {
                this.setViewTileBorderState(targetIndex, sourceTileBorders);
                viewConfigChanged = true;
            }
            if (this.getViewTileGridMode(targetIndex) !== sourceTileGridMode) {
                this.setViewTileGridMode(targetIndex, sourceTileGridMode);
                viewConfigChanged = true;
            }
            if (this.getViewTileGridLevel(targetIndex) !== sourceTileGridLevel) {
                this.setViewTileGridLevel(targetIndex, sourceTileGridLevel);
                viewConfigChanged = true;
            }
            if (this.getViewTileGridAutoLevel(targetIndex) !== sourceTileGridAutoLevel) {
                this.setViewTileGridAutoLevel(targetIndex, sourceTileGridAutoLevel);
                viewConfigChanged = true;
            }
            if (this.getViewTileGridColor(targetIndex) !== sourceTileGridColor) {
                this.setViewTileGridColor(targetIndex, sourceTileGridColor);
                viewConfigChanged = true;
            }
            if (this.getViewTileGridOpacity(targetIndex) !== sourceTileGridOpacity) {
                this.setViewTileGridOpacity(targetIndex, sourceTileGridOpacity);
                viewConfigChanged = true;
            }
        }

        if (persistStyleChanges && styleOptionChanges.length) {
            const changedOptions = new Map<string, StyleOptionNode>();
            for (const [option] of styleOptionChanges) {
                changedOptions.set(option.key, option);
            }
            this.stateService.setStyleOptionValuesBatch([...changedOptions.values()].map(option => ({
                mapId: option.mapId,
                layerId: option.layerId,
                shortStyleId: option.shortStyleId,
                optionId: option.id,
                values: option.value
            })));
        }
        if (viewConfigChanged) {
            for (const root of this.nodes) {
                root.updateVisibilityFromChildren(this.stateService.numViewsState.getValue());
            }
        }

        return { styleOptionChanges, viewConfigChanged };
    }

    /** Copies one layer's preset association when the target owns the same matching definition. */
    private copyLayerPresetSelection(
        viewIndex: number,
        sourceLayer: LayerTreeNode,
        targetLayer: LayerTreeNode
    ): void {
        const sourcePresetNode = layerPresetNode(sourceLayer);
        const selectedPreset = sourcePresetNode?.presets.find(preset =>
            preset.key === sourcePresetNode.selectedPresetKeys[viewIndex]);
        const selectedRef = selectedPreset?.ref
            ?? this.stateService.getLayerPresetSelection(viewIndex, sourceLayer.mapId, sourceLayer.id);
        this.applyEligiblePresetSelection(
            viewIndex,
            targetLayer,
            selectedRef);
    }

    /** Applies an association only when the target preset exists and all owned values match. */
    private applyEligiblePresetSelection(
        viewIndex: number,
        layer: LayerTreeNode,
        ref: LayerPresetRef | null
    ): void {
        if (!ref) {
            this.setLayerPresetSelection(viewIndex, layer.mapId, layer.id, null);
            return;
        }
        const presetNode = layerPresetNode(layer);
        const preset = presetNode?.presets.find(candidate =>
            candidate.styleId === ref.styleId && candidate.id === ref.presetId);
        if (preset
            && this.mapPresetService.matchesPresetValues(
                preset,
                layerStyleOptions(layer),
                viewIndex)) {
            this.setLayerPresetSelection(viewIndex, layer.mapId, layer.id, preset.ref);
            return;
        }
        this.setLayerPresetSelection(viewIndex, layer.mapId, layer.id, null);
    }
}
