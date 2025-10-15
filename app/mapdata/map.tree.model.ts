import {AppStateService, LayerViewConfig} from "../shared/appstate.service";
import {filter, take} from "rxjs/operators";
import {BehaviorSubject, skip, Subscription} from "rxjs";
import {FeatureWrapper} from "./features.model";
import {ErdblickStyle, FeatureStyleOptionWithStringType, StyleService} from "../styledata/style.service";

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
    nodeId: string;
    protocolVersion: { major: number, minor: number, patch: number };
    addOn: boolean;
}

export class StyleOptionNode {
    id: string;
    type: string;
    key: string;
    info: FeatureStyleOptionWithStringType;
    mapId: string;
    layerId: string;
    value: (boolean|number|string)[] = [];
    shortStyleId: string;

    constructor(mapId: string, layerId: string, definition: FeatureStyleOptionWithStringType, shortStyleId: string) {
        this.id = definition.id;
        this.shortStyleId = shortStyleId;
        this.type = definition.type as string;
        this.info = definition;
        this.mapId = mapId;
        this.layerId = layerId;
        this.key = `${mapId}/${layerId}/${shortStyleId}/${definition.id}`;
    }
}

export class LayerTreeNode {
    id: string;
    type: string;
    info: LayerInfoItem;
    mapId: string;
    key: string;
    viewConfig: LayerViewConfig[] = [];  // This is an array, because the values are stored per MapView.
    children: StyleOptionNode[] = [];
    expanded: boolean = true;

    constructor(layerInfo: LayerInfoItem, mapId: string) {
        this.info = layerInfo;
        this.mapId = mapId;
        this.id = layerInfo.layerId;
        this.key = `${mapId}/${layerInfo.layerId}`;
        this.type = layerInfo.type;
    }
}

export class MapTreeNode {
    id: string;
    type: string = "Map";
    info: MapInfoItem;
    key: string;
    layers: Map<string, LayerTreeNode> = new Map();
    expanded: boolean = true;
    visible: boolean[] = [];  // This is an array, because the values are stored per MapView.

    constructor(mapInfo: MapInfoItem) {
        this.info = mapInfo;
        this.key = mapInfo.mapId;
        this.id = mapInfo.mapId;
        this.layers =  new Map(Object.entries(mapInfo.layers).map(([_, layerInfo]) =>
            [layerInfo.layerId, new LayerTreeNode(layerInfo, mapInfo.mapId)])
        );
    }

    get children() {
        return Array.from(this.layers.values().filter(layer => layer.type !== "SourceData"));
    }

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
    }

    *allFeatureLayers() {
        for (const child of this.children) {
            yield child;
        }
    }
}

export class GroupTreeNode {
    id: string;
    key: string;
    type: string = "Group";
    children: Array<GroupTreeNode | MapTreeNode> = [];
    expanded: boolean = true;
    visible: boolean[] = [];  // This is an array, because the values are stored per MapView.

    constructor(key: string) {
        this.key = key;
        this.id = key;  // FIXME removeGroupPrefix(key); ???
    }

    *allFeatureLayers(): IterableIterator<LayerTreeNode> {
        for (const child of this.children) {
            yield* child.allFeatureLayers();
        }
    }

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

export class MapLayerTree {
    nodes: (GroupTreeNode | MapTreeNode)[] = [];
    private mapsForMapIds: Map<string, MapTreeNode> = new Map();
    private sizeOfTree: number = 0;

    constructor(
        mapInfo: MapInfoItem[],
        private selectionTopic: BehaviorSubject<Array<FeatureWrapper>>,
        private stateService: AppStateService,
        private styleService: StyleService) {
        this.initializeMapGroups(mapInfo);
        this.stateService.ready.pipe(filter(ready => ready), take(1)).subscribe(_ => {
            this.initializeStyleOptions([...this.styleService.styles.values()]);
            this.configureTreeParameters();
        });
        this.styleService.styleGroups.subscribe(_ => {
            this.initializeStyleOptions([...this.styleService.styles.values()]);
            this.configureTreeParameters();
        });
        this.stateService.numViewsState.subscribe(_ => {
            this.configureTreeParameters();
        });
    }

    get maps() {
        return this.mapsForMapIds;
    }

    get size() {
        return this.sizeOfTree;
    }

    // Pure function that computes new map groups
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

    private initializeStyleOptions(styleSheets: ErdblickStyle[]) {
        for (const map of this.maps.values()) {
            for (const layer of map.allFeatureLayers()) {
                layer.children = [];
                for (const style of styleSheets) {
                    if (style.featureLayerStyle?.hasLayerAffinity(layer.id)) {
                        for (const option of style.options) {
                            layer.children.push(new StyleOptionNode(layer.mapId, layer.id, option, style.shortId));
                        }
                    }
                }
            }
        }
    }

    configureTreeParameters() {
        let defaultVisibility = true;
        for (const child of this.nodes) {
            for (const featureLayer of child.allFeatureLayers()) {
                featureLayer.viewConfig = this.stateService.mapLayerConfig(
                    featureLayer.mapId,
                    featureLayer.info.layerId,
                    defaultVisibility);
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
            child.updateVisibilityFromChildren(this.stateService.numViewsState.getValue());
            defaultVisibility = false;
        }
    }

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

    /**
     * Remove selected features that belong to the given map/layer combination.
     * @param mapId Map identifier.
     * @param layerId Layer identifier within the map.
     */
    private clearSelectionForLayer(mapId: string, layerId: string) {
        const current = this.selectionTopic.getValue();
        const remaining = current.filter(
            fw => !(fw.featureTile.mapName === mapId && fw.featureTile.layerName === layerId)
        );
        if (remaining.length !== current.length) {
            this.selectionTopic.next(remaining);
        }
    }

    toggleMapLayerVisibility(viewIndex: number, mapId: string, layerId: string = "", state: boolean | undefined = undefined, deferUpdate: boolean = false) {
        const mapItem = this.maps.get(mapId);
        if (mapItem === undefined) {
            return;
        }
        if (layerId) {
            const layer = mapItem.layers.get(layerId);
            if (layer === undefined || layer.type == "SourceData" ||
                viewIndex >= layer.viewConfig.length || viewIndex >= mapItem.visible.length) {
                return;
            }
            if (state !== undefined) {
                layer.viewConfig[viewIndex].visible = state;
            }
            this.stateService.setMapLayerConfig(mapId, layerId, layer.viewConfig);
            if (!layer.viewConfig[viewIndex].visible) {
                this.clearSelectionForLayer(mapId, layerId);
            }
            // Recalculate map visibility based on non-SourceData layers
            mapItem.visible[viewIndex] = mapItem.children.map(layer => {
                return [layer.type, layer.viewConfig[viewIndex].visible];
            }).some(result => result[1]);
        } else {
            if (viewIndex >= mapItem.visible.length) {
                return;
            }
            if (state !== undefined) {
                mapItem.visible[viewIndex] = state;
            }
            for (const [_, layer] of mapItem.layers) {
                if (layer.type !== "SourceData") {
                    layer.viewConfig[viewIndex].visible = mapItem.visible[viewIndex];
                    if (!layer.viewConfig[viewIndex].visible) {
                        this.clearSelectionForLayer(mapId, layer.id);
                    }
                }
                this.stateService.setMapLayerConfig(mapItem.id, layer.id, layer.viewConfig);
            }
        }
        if (!deferUpdate) {
            this.configureTreeParameters();
        }
    }

    toggleLayerTileBorderVisibility(viewIndex: number, mapId: string, layerId: string) {
        const mapItem = this.maps.get(mapId);
        if (!mapItem || !mapItem.children.some(layer => layer.id === layerId)) {
            return;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.viewConfig.length <= viewIndex) {
            return;
        }
        layer.viewConfig[viewIndex].tileBorders = !layer.viewConfig[viewIndex].tileBorders;
        this.stateService.setMapLayerConfig(mapId, layerId, layer.viewConfig);
    }

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

    getMapLayerBorderState(viewIndex: number, mapId: string, layerId: string) {
        const mapItem = this.maps.get(mapId);
        if (!mapItem || !mapItem.children.some(layer => layer.id === layerId)) {
            return false;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.viewConfig.length <= viewIndex) {
            return false;
        }
        return layer.viewConfig[viewIndex].tileBorders;
    }

    getLayerStyleOptions(viewIndex: number, mapId: string, layerId: string): Record<string, boolean|number|string> | undefined {
        const mapItem = this.maps.get(mapId);
        if (!mapItem || !mapItem.children.some(layer => layer.id === layerId)) {
            return;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.children.some(option => option.value.length <= viewIndex)) {
            return;
        }
        return Object.fromEntries(
            layer.children.map(option => [option.id, option.value[viewIndex]])
        ) as Record<string, boolean|number|string>;
    }
}