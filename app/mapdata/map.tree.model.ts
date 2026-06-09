import {
    AppStateService,
    LayerViewConfig,
    TileGridMode,
    VIEW_SYNC_LAYERS
} from "../shared/appstate.service";
import {filter, take} from "rxjs/operators";
import {skip, Subscription} from "rxjs";
import {ErdblickStyle, FeatureStyleOptionWithStringType, StyleService} from "../styledata/style.service";

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
    stages?: number;
    stageLabels?: string[];
    highFidelityStage?: number;
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
    nodeId: string;
    protocolVersion: { major: number, minor: number, patch: number };
    addOn: boolean;
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

    /** Builds the stable key used by the tree and persisted style option state. */
    constructor(mapId: string, layerId: string, definition: FeatureStyleOptionWithStringType, styleId: string, shortStyleId: string) {
        this.id = definition.id;
        this.shortStyleId = shortStyleId;
        this.styleId = styleId;
        this.type = definition.type as string;
        this.info = definition;
        this.mapId = mapId;
        this.layerId = layerId;
        this.key = `${mapId}/${layerId}/${shortStyleId}/${definition.id}`;
    }
}

/** Tree node that represents one feature layer and the per-view controls attached to it. */
export class LayerTreeNode {
    id: string;
    type: string;
    info: LayerInfoItem;
    mapId: string;
    key: string;
    viewConfig: LayerViewConfig[] = [];  // This is an array, because the values are stored per MapView.
    children: StyleOptionNode[] = [];
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
            return;
        }
        this.visible = Array.from({length: numViews}, () => false);
        for (const child of this.children) {
            child.updateVisibilityFromChildren(numViews);
            this.visible = this.visible.map((v, i) => v || child.visible[i]);
        }
    }
}

export interface SyncViewsResult {
    styleOptionChanges: Array<[StyleOptionNode, number]>;
    viewConfigChanged: boolean;
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

    /** Builds the tree and keeps it synchronized with app state and the loaded style sheets. */
    constructor(
        mapInfo: MapInfoItem[],
        private stateService: AppStateService,
        private styleService: StyleService) {
        this.initializeMapGroups(mapInfo);
        this.stateService.ready.pipe(filter(ready => ready), take(1)).subscribe(_ => {
            this.initializeStyleOptions([...this.styleService.styles.values()]);
            this.configureTreeParameters();
            if (this.mapsForMapIds.size) {
                this.stateService.prune(this.mapsForMapIds, this.styleService.styles);
            }
        });
        this.styleService.styleGroups.subscribe(_ => {
            this.initializeStyleOptions([...this.styleService.styles.values()]);
            this.configureTreeParameters();
        });
        this.stateService.numViewsState.subscribe(_ => {
            this.configureTreeParameters();
        });
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
        const ungrouped: Array<MapTreeNode> = [];

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
                ungrouped.push(mapNode);
            }
        }

        this.nodes = [...groups.values(), ...ungrouped];
    }

    /** Rebuilds the style-option children for every layer from the currently visible style sheets. */
    private initializeStyleOptions(styleSheets: ErdblickStyle[]) {
        for (const map of this.maps.values()) {
            for (const layer of map.allFeatureLayers()) {
                layer.children = [];
                for (const style of styleSheets) {
                    if (style.visible && style.featureLayerStyle?.hasLayerAffinity(layer.id)) {
                        for (const option of style.options) {
                            if (!option.internal) {
                                layer.children.push(new StyleOptionNode(layer.mapId, layer.id, option, style.id, style.shortId));
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Reapplies persisted per-view layer configuration and style option values to the tree.
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
                for (const option of featureLayer.children) {
                    option.value = this.stateService.styleOptionValues(
                        featureLayer.mapId,
                        featureLayer.id,
                        option.shortStyleId,
                        option.id,
                        option.type,
                        option.info.defaultValue
                    );
                }
            }
            mapOrGroupItem.updateVisibilityFromChildren(this.stateService.numViewsState.getValue());
            defaultVisibility = false;
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
            return layer.viewConfig[viewIndex].visible;
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
    }

    /** Returns the configured tile grid coordinate mode for the given view. */
    getViewTileGridMode(viewIndex: number): TileGridMode {
        return this.stateService.viewTileGridModeState.getValue(viewIndex);
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
        if (layer.children.some(option => option.value.length <= viewIndex)) {
            return;
        }
        return Object.fromEntries(
            layer.children.filter(option => option.styleId === styleId).map(option => [option.id, option.value[viewIndex]])
        ) as Record<string, boolean|number|string>;
    }

    /** Iterates all feature layers across groups and maps in tree order. */
    *allFeatureLayers(): IterableIterator<LayerTreeNode> {
        for (const child of this.nodes) {
            yield* child.allFeatureLayers();
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
    syncLayers(viewIndex: number, mapId: string, layerId: string): StyleOptionNode[] {
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

        const sourceOptions = sourceLayer.children.filter(option => option.value.length > viewIndex);
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
            if (candidateLayer.children.length < sourceOptions.length) {
                continue;
            }

            const candidateOptionMap = new Map<string, StyleOptionNode>();
            for (const option of candidateLayer.children) {
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
                this.stateService.setStyleOptionValues(
                    targetOption.mapId,
                    targetOption.layerId,
                    targetOption.shortStyleId,
                    targetOption.id,
                    targetOption.value
                );
                changedOptions.push(targetOption);
            }
        }

        return changedOptions;
    }

    /**
     * Mirrors one view's layer/style state into the other views when view sync is enabled.
     * The return value lets callers update only the visualizations affected by the copied state.
     */
    syncViews(viewIndex: number): SyncViewsResult {
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

            for (const option of layer.children) {
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
                if (optionMutated) {
                    this.stateService.setStyleOptionValues(
                        option.mapId,
                        option.layerId,
                        option.shortStyleId,
                        option.id,
                        option.value
                    );
                }
            }
        }

        const sourceTileBorders = this.getViewTileBorderState(viewIndex);
        const sourceTileGridMode = this.getViewTileGridMode(viewIndex);
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
        }

        if (viewConfigChanged) {
            this.configureTreeParameters();
        }

        return { styleOptionChanges, viewConfigChanged };
    }
}
