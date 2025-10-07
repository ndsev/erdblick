import {Injectable} from "@angular/core";
import {Fetch} from "./fetch";
import {FeatureTile, FeatureWrapper} from "./features.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {TileVisualization} from "../mapview/visualization.model";
import {BehaviorSubject, combineLatest, filter, Subject} from "rxjs";
import {ErdblickStyle, StyleService} from "../styledata/style.service";
import {Feature, HighlightMode, TileLayerParser} from '../../build/libs/core/erdblick-core';
import {AppStateService, LayerViewConfig, TileFeatureId} from "../shared/appstate.service";
import {SidePanelService, SidePanelState} from "../shared/sidepanel.service";
import {InfoMessageService} from "../shared/info.service";
import {MAX_ZOOM_LEVEL} from "../search/feature.search.service";
import {PointMergeService} from "../mapview/pointmerge.service";
import {KeyboardService} from "../shared/keyboard.service";
import * as uuid from 'uuid';

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
    key?: string;
    canRead: boolean;
    canWrite: boolean;
    coverage: Array<number | CoverageRectItem>;
    featureTypes: Array<{ name: string, uniqueIdCompositions: Array<any> }>;
    mapId?: string;
    layerId: string;
    type: string;
    version: { major: number, minor: number, patch: number };
    zoomLevels: Array<number>;

    // This is an array, because the values are stored per MapView.
    viewConfig: LayerViewConfig[];
}

/** Expected structure of a list entry in the /sources endpoint. */
export interface MapInfoItem extends Record<string, any> {
    key?: string;
    extraJsonAttachment: any;
    layers: Map<string, LayerInfoItem>;
    mapId: string;
    maxParallelJobs: number;
    nodeId: string;
    protocolVersion: { major: number, minor: number, patch: number };
    addOn: boolean;
    type: string;
    children?: Array<LayerInfoItem>;
    expanded?: boolean;
    visible: boolean[]; // This is an array, because the values are stored per MapView.
}

export interface GroupInfoItem extends Record<string, any> {
    key: string;
    id: string;
    type: string;
    children: Array<GroupInfoItem | MapInfoItem>;
    expanded: boolean;
    visible: boolean[]; // This is an array, because the values are stored per MapView.
}

const infoUrl = "sources";
const tileUrl = "tiles";
const abortUrl = "abort";

/** Redefinition of coreLib.Viewport. TODO: Check if needed. */
// NOTE: This type duplicates the Viewport interface from coreLib. Investigation needed
// to determine if this redefinition is actually necessary or if coreLib.Viewport can be used directly.
type ViewportProperties = {
    orientation: number;
    camPosLon: number;
    south: number;
    west: number;
    width: number;
    height: number;
    camPosLat: number
};

/**
 * Determine if two lists of feature wrappers have the same features.
 */
function featureSetsEqual(rhs: FeatureWrapper[], lhs: FeatureWrapper[]) {
    return rhs.length === lhs.length && rhs.every(rf => lhs.some(lf => rf.equals(lf)));
}

const DEFAULT_VIEWPORT = {
    south: .0,
    west: .0,
    width: .0,
    height: .0,
    camPosLon: .0,
    camPosLat: .0,
    orientation: .0
}

/**
 * Erdblick map service class. This class is responsible for keeping track
 * of the following objects:
 *  (1) available maps
 *  (2) currently loaded tiles
 *  (3) available style sheets.
 *
 * As the viewport changes, it requests new tiles from the mapget server
 * and triggers their conversion to Cesium tiles according to the active
 * style sheets.
 */
@Injectable({providedIn: 'root'})
export class MapService {

    public maps: BehaviorSubject<Map<string, MapInfoItem>> = new BehaviorSubject<Map<string, MapInfoItem>>(new Map<string, MapInfoItem>());
    public mapGroups: BehaviorSubject<(GroupInfoItem | MapInfoItem)[]> = new BehaviorSubject<(GroupInfoItem | MapInfoItem)[]>([]);
    // TODO - refactoring:
    //   1. mapIdsPerViewer: Map<string, Set<string>> should store sets of mapIds associated
    //      with the particular ViewerWrapper.viewerId.
    public mapIdsPerViewer: Map<string, Set<string>> = new Map<string, Set<string>>();
    public loadedTileLayers: Map<string, FeatureTile>;
    public legalInformationPerMap = new Map<string, Set<string>>();
    public legalInformationUpdated = new Subject<boolean>();
    private visualizedTileLayers: Map<string, TileVisualization[]>;
    private currentFetch: Fetch | null = null;
    private currentFetchAbort: Fetch | null = null;
    private currentFetchId: number = 0;
    private currentViewport: ViewportProperties[];
    private currentVisibleTileIds: Set<bigint>;
    private currentHighDetailTileIds: Set<bigint>;
    private tileStreamParsingQueue: any[];
    private tileVisualizationQueue: [string, TileVisualization][];
    private selectionVisualizations: TileVisualization[];
    private hoverVisualizations: TileVisualization[];

    tileParser: TileLayerParser | null = null;
    tileVisualizationTopic: Subject<any>;
    tileVisualizationDestructionTopic: Subject<any>;
    moveToWgs84PositionTopic: Subject<{ targetView: number, x: number, y: number, z?: number }>;
    selectionTopic: BehaviorSubject<Array<FeatureWrapper>> = new BehaviorSubject<Array<FeatureWrapper>>([]);
    hoverTopic: BehaviorSubject<Array<FeatureWrapper>> = new BehaviorSubject<Array<FeatureWrapper>>([]);

    /**
     * When true, clearing the selection does not reset the side panel state.
     * This is used when removing selections due to layer deactivation.
     */
    private preserveSidePanel: boolean = false;

    /**
     * Remove selected features that belong to the given map/layer combination.
     * @param mapId Map identifier.
     * @param layerId Layer identifier within the map.
     */
    private clearSelectionForLayer(viewIndex: number, mapId: string, layerId: string) {
        const current = this.selectionTopic.getValue();
        const remaining = current.filter(
            fw => !(fw.featureTile.mapName === mapId && fw.featureTile.layerName === layerId)
        );
        if (remaining.length !== current.length) {
            this.preserveSidePanel = true;
            this.selectionTopic.next(remaining);
            this.preserveSidePanel = false;
        }
    }

    selectionTileRequest: {
        remoteRequest: {
            mapId: string,
            layerId: string,
            tileIds: Array<number>
        },
        tileKey: string,
        resolve: null | ((tile: FeatureTile) => void),
        reject: null | ((why: any) => void),
    } | null = null;
    zoomLevel: BehaviorSubject<number> = new BehaviorSubject<number>(0);
    statsDialogVisible: boolean = false;
    statsDialogNeedsUpdate: Subject<void> = new Subject<void>();
    clientId: string = "";

    constructor(public styleService: StyleService,
                public stateService: AppStateService,
                private sidePanelService: SidePanelService,
                private messageService: InfoMessageService,
                private pointMergeService: PointMergeService,
                private keyboardService: KeyboardService) {
        this.loadedTileLayers = new Map();
        this.visualizedTileLayers = new Map();
        this.currentFetch = null;
        this.currentViewport = [DEFAULT_VIEWPORT];
        this.currentVisibleTileIds = new Set();
        this.currentHighDetailTileIds = new Set();
        this.tileStreamParsingQueue = [];
        this.tileVisualizationQueue = [];
        this.selectionVisualizations = [];
        this.hoverVisualizations = [];

        // Triggered when a tile layer is freshly rendered and should be added to the frontend.
        this.tileVisualizationTopic = new Subject<any>(); // {FeatureTile}

        // Triggered when a tile layer is being removed.
        this.tileVisualizationDestructionTopic = new Subject<any>(); // {FeatureTile}

        // Triggered when the user requests to zoom to a map layer.
        this.moveToWgs84PositionTopic = new Subject<{ targetView: number, x: number, y: number }>();

        // Unique client ID which ensures that tile fetch requests from this map-service
        // are de-duplicated on the mapget server.
        this.clientId = uuid.v4();
    }

    public async initialize() {
        // Instantiate the TileLayerParser.
        this.tileParser = new coreLib.TileLayerParser();

        // Use combineLatest to coordinate maps loading with parameter initialization
        combineLatest([this.maps, this.stateService.ready]).pipe(
            filter(([_, ready]) => ready)
        ).subscribe(_ => {
            this.processMapsUpdate();
        });

        // Initial call to processTileStream: will keep calling itself
        this.processTileStream();
        this.processVisualizationTasks();

        this.styleService.styleRemovedForId.subscribe(styleId => {
            this.tileVisualizationQueue = [];
            this.visualizedTileLayers.get(styleId)?.forEach(tileVisu =>
                this.tileVisualizationDestructionTopic.next(tileVisu)
            );
            this.visualizedTileLayers.delete(styleId);
        });
        this.styleService.styleAddedForId.subscribe(styleId => {
            this.visualizedTileLayers.set(styleId, []);
            for (let [_, tileLayer] of this.loadedTileLayers) {
                this.renderTileLayer(tileLayer, this.styleService.styles.get(styleId)!, styleId);
            }
        });

        // Apply initial parameter configuration once maps are loaded and parameters are ready
        combineLatest([this.maps, this.stateService.ready]).pipe(
            filter(([maps, ready]) => ready && maps.size > 0),
        ).subscribe(([maps, _]) => {
            for (let [mapId, mapInfo] of maps) {
                let isAnyLayerVisible = false;
                for (let [layerId, layer] of mapInfo.layers) {
                    for (let viewIndex = 0; viewIndex < this.stateService.layerNames.getValue().length; ++i) {
                        viewConfig = this.stateService.mapLayerConfig(viewIndex, mapId, layerId, layer.viewConfig.level);
                        if (!isAnyLayerVisible && layer.type !== "SourceData" && layer.visible) {
                            isAnyLayerVisible = true;
                        }
                    }
                }
                mapInfo.visible = isAnyLayerVisible;
            }
            this.update().then();
        });

        await this.reloadDataSources();

        this.stateService.selectedFeaturesState.subscribe(selected => {
            this.highlightFeatures(selected).then();
        });
        this.selectionTopic.subscribe(selectedFeatureWrappers => {
            this.visualizeHighlights(coreLib.HighlightMode.SELECTION_HIGHLIGHT, selectedFeatureWrappers);
        });
        this.hoverTopic.subscribe(hoveredFeatureWrappers => {
            this.visualizeHighlights(coreLib.HighlightMode.HOVER_HIGHLIGHT, hoveredFeatureWrappers);
        });

        this.keyboardService.registerShortcut("Ctrl+x", () => {
            this.statsDialogVisible = true;
            this.statsDialogNeedsUpdate.next();
        }, true);
    }

    private activateMapsByDefault(groups: Map<string, GroupInfoItem>, ungrouped: Array<MapInfoItem>, first: string) {
        // No parameter layers - activate the first group or the first ungrouped map as default
        if (first && groups.has(first)) {
            for (const mapItem of groups.get(first)!.children) {
                mapItem.visible = true;
                this.toggleMapLayerVisibility(mapItem.mapId);
            }
        } else if (ungrouped.length > 0) {
            ungrouped[0].visible = true;
            this.toggleMapLayerVisibility(ungrouped[0].mapId);
        }
    };

    private activateMapsIfNew(groups: Map<string, GroupInfoItem>, ungrouped: Array<MapInfoItem>) {
        // Check for new groups and activate them
        for (const [groupId, groupItems] of groups) {
            if (!this.mapGroups.getValue().has(groupId)) {
                // New group - activate all maps in it
                for (const mapItem of groupItems.children) {
                    mapItem.visible = true;
                    this.toggleMapLayerVisibility(mapItem.mapId);
                }
            } else {
                // Existing group - check for new maps within it
                const prevGroup = this.mapGroups.getValue().get(groupId)!;
                for (const mapItem of groupItems.children) {
                    if (!prevGroup.children.find(prev => prev.mapId === mapItem.mapId)) {
                        // New map in existing group - activate it
                        mapItem.visible = true;
                        this.toggleMapLayerVisibility(mapItem.mapId);
                    }
                }
            }
        }

        // Handle new ungrouped maps
        if (ungrouped.length > 0 && this.mapGroups.getValue().has("ungrouped")) {
            const prevUngrouped = this.mapGroups.getValue().get("ungrouped")!;
            for (const mapItem of ungrouped) {
                if (!prevUngrouped.children.find(prev => prev.mapId === mapItem.mapId)) {
                    // New ungrouped map - activate it
                    mapItem.visible = true;
                    this.toggleMapLayerVisibility(mapItem.mapId);
                }
            }
        }
    };

    private setMapsLayersIdChildren(mapItem: MapInfoItem, key: string) {
        mapItem.key = mapItem.mapId;
        mapItem.children = [];
        mapItem.expanded = true;
        mapItem.type = "Map";
        for (let layer of mapItem.layers.values()) {
            if (layer.type !== "SourceData") {
                layer.key = `${mapItem.mapId}/${layer.layerId}`;
                layer.mapId = mapItem.mapId;
                mapItem.children.push(layer);
            }
        }
        return mapItem;
    }

    // Pure function that computes new map groups
    private computeMapGroups(): (GroupInfoItem | MapInfoItem)[] {
        const isInitLoad = this.mapGroups.getValue().length === 0;
        const hasExistingLayers = this.stateService.layerNames.getValue().length > 0;

        const groups = new Map<string, GroupInfoItem>();
        const ungrouped: Array<MapInfoItem> = [];

        let keyCounter = 0;
        const nextKey = () => (keyCounter++).toString();

        const getOrCreateGroupByPath = (path: string): GroupInfoItem => {
            const segments = path.split('/');
            const top = segments[0];
            let current: GroupInfoItem;
            if (groups.has(top)) {
                current = groups.get(top)!;
            } else {
                current = {
                    key: nextKey(),
                    id: top,
                    type: "Group",
                    children: [],
                    visible: Array.from({ length: this.stateService.numViews }, (_) => false),
                    expanded: true
                };
                groups.set(top, current);
            }
            let acc = top;
            for (let i = 1; i < segments.length; ++i) {
                acc = `${acc}/${segments[i]}`;
                let found: GroupInfoItem | null = null;
                for (const child of current.children) {
                    if ((child as any).type === "Group" && (child as GroupInfoItem).id === acc) {
                        found = child as GroupInfoItem;
                        break;
                    }
                }
                if (!found) {
                    found = {
                        key: nextKey(),
                        id: acc,
                        type: "Group",
                        children: [],
                        visible: Array.from({ length: this.stateService.numViews }, (_) => false),
                        expanded: true
                    };
                    current.children.push(found);
                }
                current = found;
            }
            return current;
        };

        // Build nested groups
        for (const [mapId, mapItem] of this.maps.getValue()) {
            if (mapId.includes('/')) {
                const parentPath = mapId.split('/').slice(0, -1).join('/');
                const currentGroup = getOrCreateGroupByPath(parentPath);
                const mapNode = this.setMapsLayersIdChildren(mapItem, nextKey());
                currentGroup.children.push(mapNode);
            } else {
                ungrouped.push(this.setMapsLayersIdChildren(mapItem, nextKey()));
            }
        }

        // If no parameter layers exist yet, activate defaults
        if (!isInitLoad && (groups.size > 0 || ungrouped.length > 0)) {
            this.activateMapsIfNew(groups, ungrouped);
        } else if (!hasExistingLayers) {
            // choose the first available top-level group if any, else first ungrouped
            const firstTop = groups.keys().next().value as string | undefined;
            this.activateMapsByDefault(groups, ungrouped, firstTop || "");
        }

        // compute derived visibility for all groups (any descendant map visible)
        const computeGroupVisibility = (group: GroupInfoItem): boolean[] => {
            let anyVisible: boolean[] = group.visible;
            for (const child of group.children) {
                if ((child as any).type === "Group") {
                    anyVisible = computeGroupVisibility(child as GroupInfoItem) || anyVisible;
                } else {
                    const mapChild = child as MapInfoItem;
                    anyVisible = anyVisible.map((v, i) => v || mapChild.visible[i]);
                }
            }
            group.visible = anyVisible;
            return anyVisible;
        };

        for (const [_, topGroup] of groups) {
            computeGroupVisibility(topGroup);
        }

        return [...groups.values(), ...ungrouped];
    }

    public processMapsUpdate() {
        const newGroups = this.computeMapGroups();
        const currentGroups = this.mapGroups.getValue();
        if (!this.mapGroupsEqual(currentGroups, newGroups)) {
            this.mapGroups.next(newGroups);
        }
    }

    // Helper to compare map groups for equality
    private mapGroupsEqual(a: (GroupInfoItem | MapInfoItem)[], b: (GroupInfoItem | MapInfoItem)[]): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < b.length; i++) {
            if (!this.groupsDeepEqual(a[i] as GroupInfoItem, b[i] as GroupInfoItem)) {
                return false;
            }
        }
        return true;
    }

    private groupsDeepEqual(a: GroupInfoItem, b: GroupInfoItem): boolean {
        if (a.id !== b.id) return false;
        if (a.children.length !== b.children.length) return false;
        for (let i = 0; i < a.children.length; i++) {
            const ac = a.children[i] as any;
            const bc = b.children[i] as any;
            if (ac.type !== bc.type) return false;
            if (ac.type === 'Group') {
                if (!this.groupsDeepEqual(ac as GroupInfoItem, bc as GroupInfoItem)) return false;
            } else {
                return ((ac as MapInfoItem).mapId === (bc as MapInfoItem).mapId) &&
                (ac as MapInfoItem).visible.every((v, i) => v === (bc as MapInfoItem).visible[i]);
            }
        }
        // Optional: group visible flag derives from children; ignore minor differences
        return true;
    }

    private processTileStream(viewIndex: number) {
        const startTime = Date.now();
        const timeBudget = 10; // milliseconds

        while (this.tileStreamParsingQueue.length) {
            // Check if the time budget is exceeded.
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            let [message, messageType] = this.tileStreamParsingQueue.shift();
            if (messageType === Fetch.CHUNK_TYPE_FIELDS) {
                uint8ArrayToWasm((wasmBuffer: any) => {
                    this.tileParser!.readFieldDictUpdate(wasmBuffer);
                }, message);
            } else if (messageType === Fetch.CHUNK_TYPE_FEATURES) {
                const tileLayerBlob = message.slice(Fetch.CHUNK_HEADER_SIZE);
                this.addTileFeatureLayer(viewIndex, tileLayerBlob, null, "", null);
            } else {
                console.error(`Encountered unknown message type ${messageType}!`);
            }
        }

        // Continue processing messages with a delay.
        const delay = this.tileStreamParsingQueue.length ? 0 : 10;
        setTimeout((_: any) => this.processTileStream(viewIndex), delay);
    }

    private processVisualizationTasks() {
        const startTime = Date.now();
        const timeBudget = 20; // milliseconds

        while (this.tileVisualizationQueue.length) {
            // Check if the time budget is exceeded.
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            const entry = this.tileVisualizationQueue.shift();
            if (entry !== undefined) {
                const tileVisu = entry[1];
                this.tileVisualizationTopic.next(tileVisu);
            }
        }

        // Continue visualizing tiles with a delay.
        const delay = this.tileVisualizationQueue.length ? 0 : 10;
        setTimeout((_: any) => this.processVisualizationTasks(), delay);
    }

    public async reloadDataSources() {
        return new Promise<void>((resolve, reject) => {
            let bufferCompleted = false;
            let jsonCompleted = false;

            const checkCompletion = () => {
                if (bufferCompleted && jsonCompleted) {
                    resolve();
                }
            };

            new Fetch(infoUrl)
                .withBufferCallback((infoBuffer: any) => {
                    uint8ArrayToWasm((wasmBuffer: any) => {
                        this.tileParser!.setDataSourceInfo(wasmBuffer);
                        console.log("Loaded data source info.");
                        bufferCompleted = true;
                        checkCompletion();
                    }, infoBuffer);
                })
                .withJsonCallback((result: Array<MapInfoItem>) => {
                    let mapLayerLevels = new Array<[string, string, LayerViewConfig[]]>();
                    let maps = new Map<string, MapInfoItem>(result.filter(m => !m.addOn).map(mapInfo => {
                        let layers = new Map<string, LayerInfoItem>();
                        let isAnyLayerVisible: boolean[] = [];
                        for (let [layerId, layerInfo] of Object.entries(mapInfo.layers)) {
                            mapLayerLevels.push([
                                mapInfo.mapId,
                                layerId,
                                this.stateService.mapLayerConfig(mapInfo.mapId, layerId)
                            ]);
                            while (isAnyLayerVisible.length <= layerInfo.viewConfig.length) {
                                isAnyLayerVisible.push(false);
                            }
                            for (let i = 0; i < layerInfo.viewConfig.length; i++) {
                                isAnyLayerVisible[i] = layerInfo.type !== "SourceData" && layerInfo.viewConfig[i].visible;
                            }
                            layers.set(layerId, layerInfo);
                        }
                        mapInfo.type = "Map";
                        mapInfo.layers = layers;
                        mapInfo.visible = isAnyLayerVisible;
                        return [mapInfo.mapId, mapInfo];
                    }));
                    this.maps.next(maps);
                    // TODO: This is stupid
                    this.stateService.setInitialMapLayers(mapLayerLevels);

                    jsonCompleted = true;
                    checkCompletion();
                })
                .go();
        });
    }

    getMapLayerVisibility(viewIndex: number, mapId: string, layerId: string) {
        const mapItem = this.maps.getValue().get(mapId);
        if (!mapItem) {
            return false;
        }

        const layer = mapItem.layers.get(layerId);
        if (layer) {
            if (layer.type == "SourceData") {
                return false;
            }
            return layer.viewConfig[viewIndex];
        }
        return false;
    }

    toggleMapLayerVisibility(viewIndex: number, mapId: string, layerId: string = "", state: boolean | undefined = undefined, deferUpdate: boolean = false) {
        const mapItem = this.maps.getValue().get(mapId);
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
                this.clearSelectionForLayer(viewIndex, mapId, layerId);
            }
            // Recalculate map visibility based on non-SourceData layers
            mapItem.visible[viewIndex] = mapItem.layers.values().map(layer => {
                return [layer.type, layer.viewConfig[viewIndex].visible];
            }).some(result => result[0] !== "SourceData" && result[1]);
        } else {
            if (viewIndex >= mapItem.visible.length) {
                return;
            }
            if (state !== undefined) {
                mapItem.visible[viewIndex] = state;
            }
            const params: {
                mapId: string,
                layerId: string,
                viewConfig: LayerViewConfig
            }[] = []
            for (const [_, layer] of mapItem.layers) {
                if (layer.type !== "SourceData") {
                    layer.viewConfig[viewIndex].visible = mapItem.visible[viewIndex];
                    params.push({
                        mapId: mapItem.mapId,
                        layerId: layer.layerId,
                        viewConfig: layer.viewConfig[viewIndex]
                    });
                    if (!layer.viewConfig[viewIndex].visible) {
                        this.clearSelectionForLayer(viewIndex, mapId, layer.layerId);
                    }
                }
            }
            this.stateService.setMapConfigForIndex(viewIndex, params);
        }
        if (!deferUpdate) {
            this.processMapsUpdate();
            this.update(viewIndex).then();
        }
    }

    toggleLayerTileBorderVisibility(viewIndex: number, mapId: string, layerId: string) {
        const mapItem = this.maps.getValue().get(mapId);
        if (!mapItem || !mapItem.layers.has(layerId)) {
            return;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.viewConfig.length <= viewIndex) {
            return;
        }
        layer.viewConfig[viewIndex].tileBorders = !layer.viewConfig[viewIndex].tileBorders;
        this.stateService.setMapLayerConfig(mapId, layerId, layer.viewConfig);
        this.update(viewIndex).then();
    }

    setMapLayerLevel(viewIndex: number, mapId: string, layerId: string, level: number) {
        const mapItem = this.maps.getValue().get(mapId);
        if (!mapItem || !mapItem.layers.has(layerId)) {
            return;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.viewConfig.length <= viewIndex) {
            return;
        }
        layer.viewConfig[viewIndex].level = level;
        this.stateService.setMapLayerConfig(mapId, layerId, layer.viewConfig);
        this.update(viewIndex).then();
    }

    * allLevels(viewIndex: number) {
        for (let [_, map] of this.maps.getValue())
            for (let [_, layer] of map.layers)
                yield layer.viewConfig[viewIndex].level;
    }

    getMapLayerLevel(viewIndex: number, mapId: string, layerId: string) {
        const mapItem = this.maps.getValue().get(mapId);
        if (!mapItem || !mapItem.layers.has(layerId)) {
            return 13;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.viewConfig.length <= viewIndex) {
            return 13;
        }
        return layer.viewConfig[viewIndex].level;
    }

    getMapLayerBorderState(viewIndex: number, mapId: string, layerId: string) {
        const mapItem = this.maps.getValue().get(mapId);
        if (!mapItem || !mapItem.layers.has(layerId)) {
            return false;
        }
        const layer = mapItem.layers.get(layerId)!;
        if (layer.viewConfig.length <= viewIndex) {
            return false;
        }
        return layer.viewConfig[viewIndex].tileBorders;
    }

    async update(viewIndex: number) {
        // Get the tile IDs for the current viewport.
        this.currentVisibleTileIds = new Set<bigint>();
        this.currentHighDetailTileIds = new Set<bigint>();
        // Map from level to array of tileIds.
        let tileIdPerLevel = new Map<number, Array<bigint>>();

        const loadLimit = this.stateService.tilesLoadLimitState.getValue();
        const visualizeLimit = this.stateService.tilesVisualizeLimitState.getValue();

        for (let level of this.allLevels(viewIndex)) {
            if (!tileIdPerLevel.has(level)) {
                const allViewportTileIds = coreLib.getTileIds(
                    this.currentViewport[viewIndex],
                    level,
                    loadLimit) as bigint[];

                tileIdPerLevel.set(level, allViewportTileIds);
                this.currentVisibleTileIds = new Set([
                    ...this.currentVisibleTileIds,
                    ...new Set<bigint>(allViewportTileIds)
                ]);
                this.currentHighDetailTileIds = new Set([
                    ...this.currentHighDetailTileIds,
                    ...new Set<bigint>(
                        allViewportTileIds.slice(0, visualizeLimit))
                ]);
            }
        }

        // Evict present non-required tile layers.
        let newTileLayers = new Map();
        let evictTileLayer = (tileLayer: FeatureTile) => {
            return !tileLayer.preventCulling && !this.selectionTopic.getValue().some(v =>
                v.featureTile.mapTileKey == tileLayer.mapTileKey) &&
                (!this.currentVisibleTileIds.has(tileLayer.tileId) ||
                !this.getMapLayerVisibility(viewIndex, tileLayer.mapName, tileLayer.layerName) ||
                tileLayer.level() != this.getMapLayerLevel(viewIndex, tileLayer.mapName, tileLayer.layerName))
        }
        for (let tileLayer of this.loadedTileLayers.values()) {
            if (evictTileLayer(tileLayer)) {
                tileLayer.destroy();
            } else {
                newTileLayers.set(tileLayer.mapTileKey, tileLayer);
            }
        }
        this.loadedTileLayers = newTileLayers;

        // Update visualizations.
        for (const styleId of this.visualizedTileLayers.keys()) {
            const tileVisus = this.visualizedTileLayers.get(styleId)?.filter(tileVisu => {
                const mapName = tileVisu.tile.mapName;
                const layerName = tileVisu.tile.layerName;
                if (tileVisu.tile.disposed) {
                    this.tileVisualizationDestructionTopic.next(tileVisu);
                    return false;
                }
                let styleEnabled = false;
                if (this.styleService.styles.has(styleId)) {
                    styleEnabled = this.styleService.styles.get(styleId)?.params.visible!;
                }
                if (styleId != "_builtin" && !styleEnabled) {
                    this.tileVisualizationDestructionTopic.next(tileVisu);
                    return false;
                }
                tileVisu.showTileBorder = this.getMapLayerBorderState(viewIndex, mapName, layerName);
                tileVisu.isHighDetail = this.currentHighDetailTileIds.has(tileVisu.tile.tileId) || tileVisu.tile.preventCulling;
                return true;
            });
            if (tileVisus && tileVisus.length) {
                this.visualizedTileLayers.set(styleId, tileVisus);
            } else {
                this.visualizedTileLayers.delete(styleId);
            }
        }

        // Update Tile Visualization Queue.
        this.tileVisualizationQueue = [];
        for (const [styleId, tileVisus] of this.visualizedTileLayers) {
            tileVisus.forEach(tileVisu => {
                if (tileVisu.isDirty()) {
                    this.tileVisualizationQueue.push([styleId, tileVisu]);
                }
            });
        }

        // Rest of this function: Request non-present required tile layers.
        // Only do this, if there is no ongoing effort to do so.
        //  Reason: This is an async function, so multiple "instances" of it
        //  may be running simultaneously. But we only ever want one function to
        //  execute the /abort-and-/tiles fetch combo.
        let myFetchId = ++this.currentFetchId;
        let abortAwaited = false;
        if (this.currentFetchAbort) {
            await this.currentFetchAbort.done;
            abortAwaited = true;
            if (myFetchId != this.currentFetchId) {
                return;
            }
        }

        let requests = [];
        if (this.selectionTileRequest) {
            // Do not go forward with the selection tile request, if it
            // pertains to a map layer that is not available anymore.
            const mapLayerItem = this.maps.getValue()
                .get(this.selectionTileRequest.remoteRequest.mapId)?.layers
                .get(this.selectionTileRequest.remoteRequest.layerId);
            if (mapLayerItem) {
                requests.push(this.selectionTileRequest.remoteRequest);
                if (this.currentFetch) {
                    // Disable the re-fetch filtering logic by setting the old
                    // fetches' body to null.
                    this.currentFetch.bodyJson = null;
                }
            } else {
                this.selectionTileRequest.reject!("Map layer is not available.");
            }
        }

        for (const [mapName, map] of this.maps.getValue()) {
            for (const [layerName, _] of map.layers) {
                if (!this.getMapLayerVisibility(viewIndex, mapName, layerName)) {
                    continue;
                }

                // Find tile IDs which are not yet loaded for this map layer combination.
                let requestTilesForMapLayer = []
                let level = this.getMapLayerLevel(viewIndex, mapName, layerName);
                let tileIds = tileIdPerLevel.get(level);
                if (tileIds === undefined) {
                    continue;
                }
                for (let tileId of tileIds!) {
                    const tileMapLayerKey = coreLib.getTileFeatureLayerKey(mapName, layerName, tileId);
                    if (!this.loadedTileLayers.has(tileMapLayerKey)) {
                        requestTilesForMapLayer.push(Number(tileId));
                    }
                }
                // Only add a request if there are tiles to be loaded.
                if (requestTilesForMapLayer.length > 0) {
                    requests.push({
                        mapId: mapName,
                        layerId: layerName,
                        tileIds: requestTilesForMapLayer
                    });
                }
            }
        }

        let newRequestBody = JSON.stringify({
            requests: requests,
            stringPoolOffsets: this.tileParser!.getFieldDictOffsets(),
            clientId: this.clientId
        });
        if (this.currentFetch) {
            // Ensure that the new fetch operation is different from the previous one.
            if (this.currentFetch.bodyJson === newRequestBody) {
                return;
            }
            // Abort any ongoing requests for this clientId.
            if (!abortAwaited) {
                this.currentFetch.abort();
                this.currentFetchAbort = new Fetch(abortUrl)
                    .withMethod("POST")
                    .withBody(JSON.stringify({clientId: this.clientId}));
                await this.currentFetchAbort.go();
                this.currentFetchAbort = null;
            }
            // Wait for the current Fetch operation to end.
            await this.currentFetch.done;
            // Do not proceed with this update, if a newer one was started.
            if (myFetchId != this.currentFetchId) {
                return;
            }
            this.currentFetch = null;
            // Clear any unparsed messages from the previous stream.
            this.tileStreamParsingQueue = [];
        }

        // Nothing to do if all requests are empty.
        if (requests.length === 0) {
            return;
        }

        // Make sure that there are no unparsed bytes lingering from the previous response stream.
        this.tileParser!.reset();

        // Launch the new fetch operation
        this.currentFetch = new Fetch(tileUrl)
            .withChunkProcessing()
            .withMethod("POST")
            .withBody(newRequestBody)
            .withBufferCallback((message: any, messageType: any) => {
                // Schedule the parsing of the newly arrived tile layer.
                this.tileStreamParsingQueue.push([message, messageType]);
            });
        await this.currentFetch.go();
    }

    addTileFeatureLayer(viewIndex: number, tileLayerBlob: any, style: ErdblickStyle | null, styleId: string, preventCulling: any) {
        let tileLayer = new FeatureTile(this.tileParser!, tileLayerBlob, preventCulling);

        // Consider, if this tile is a selection tile request.
        if (this.selectionTileRequest && tileLayer.mapTileKey == this.selectionTileRequest.tileKey) {
            this.selectionTileRequest.resolve!(tileLayer);
            this.selectionTileRequest = null;
        }
        // Don't add a tile that is not supposed to be visible.
        else if (!preventCulling) {
            if (!this.currentVisibleTileIds.has(tileLayer.tileId))
                return;
        }

        // If this one replaces an older tile with the same key,
        // then first remove the older existing one.
        if (this.loadedTileLayers.has(tileLayer.mapTileKey)) {
            this.removeTileLayer(this.loadedTileLayers.get(tileLayer.mapTileKey)!);
        }
        this.loadedTileLayers.set(tileLayer.mapTileKey, tileLayer);
        this.statsDialogNeedsUpdate.next();

        // Update legal information if any.
        if (tileLayer.legalInfo) {
            this.setLegalInfo(tileLayer.mapName, tileLayer.legalInfo);
        }

        // Schedule the visualization of the newly added tile layer,
        // but don't do it synchronously to avoid stalling the main thread.
        setTimeout(() => {
            if (style && styleId) {
                this.renderTileLayer(viewIndex, tileLayer, style, styleId);
            } else {
                this.styleService.styles.forEach((style, styleId) => {
                    this.renderTileLayer(viewIndex, tileLayer, style, styleId);
                });
            }
        });
    }

    private removeTileLayer(tileLayer: FeatureTile) {
        tileLayer.destroy();
        for (const styleId of this.visualizedTileLayers.keys()) {
            const tileVisus = this.visualizedTileLayers.get(styleId)?.filter(tileVisu => {
                if (tileVisu.tile.mapTileKey === tileLayer.mapTileKey) {
                    this.tileVisualizationDestructionTopic.next(tileVisu);
                    return false;
                }
                return true;
            });
            if (tileVisus !== undefined && tileVisus.length) {
                this.visualizedTileLayers.set(styleId, tileVisus);
            } else {
                this.visualizedTileLayers.delete(styleId);
            }
        }
        this.tileVisualizationQueue = this.tileVisualizationQueue.filter(([_, tileVisu]) => {
            return tileVisu.tile.mapTileKey !== tileLayer.mapTileKey;
        });
        this.loadedTileLayers.delete(tileLayer.mapTileKey);
        this.statsDialogNeedsUpdate.next();
    }

    private renderTileLayer(viewIndex: number, tileLayer: FeatureTile, style: ErdblickStyle, styleId: string = "") {
        const wasmStyle = style.featureLayerStyle;
        if (!wasmStyle) {
            return;
        }
        if (style.params !== undefined && !style.params.visible) {
            return;
        }

        const mapName = tileLayer.mapName;
        const layerName = tileLayer.layerName;
        let visu = new TileVisualization(
            tileLayer,
            this.pointMergeService,
            (tileKey: string) => this.getFeatureTile(tileKey),
            wasmStyle,
            tileLayer.preventCulling || this.currentHighDetailTileIds.has(tileLayer.tileId),
            coreLib.HighlightMode.NO_HIGHLIGHT,
            [],
            this.getMapLayerBorderState(viewIndex, mapName, layerName),
            style.params !== undefined ? style.params.options : {});
        this.tileVisualizationQueue.push([styleId, visu]);
        if (this.visualizedTileLayers.has(styleId)) {
            this.visualizedTileLayers.get(styleId)?.push(visu);
        } else {
            this.visualizedTileLayers.set(styleId, [visu]);
        }
    }

    setViewport(viewIndex: number, viewport: ViewportProperties) {
        while (this.currentViewport.length <= viewIndex) {
            this.currentViewport.push(DEFAULT_VIEWPORT);
        }
        this.currentViewport[viewIndex] = viewport;
        this.setTileLevelForViewport(viewIndex);
        this.update(viewIndex).then();
    }

    getPrioritisedTiles(viewIndex: number) {
        let tiles = new Array<[number, FeatureTile]>();
        for (const [_, tile] of this.loadedTileLayers) {
            tiles.push([coreLib.getTilePriorityById(this.currentViewport[viewIndex], tile.tileId), tile]);
        }
        tiles.sort((a, b) => b[0] - a[0]);
        return tiles.map(val => val[1]);
    }

    getFeatureTile(tileKey: string): FeatureTile | null {
        return this.loadedTileLayers.get(tileKey) || null;
    }

    async loadTiles(viewIndex: number, tileKeys: Set<string | null>): Promise<Map<string, FeatureTile>> {
        let result = new Map<string, FeatureTile>();

        // TODO: Optimize this loop to make just a single update call.
        // NOTE: Currently each missing tile triggers a separate update() call, which is inefficient.
        // Should batch all missing tiles and make a single update call for better performance.
        for (let tileKey of tileKeys) {
            if (!tileKey) {
                continue;
            }

            let tile = this.loadedTileLayers.get(tileKey);
            if (tile) {
                result.set(tileKey, tile);
                continue;
            }

            let [mapId, layerId, tileId] = coreLib.parseTileFeatureLayerKey(tileKey);
            this.selectionTileRequest = {
                remoteRequest: {
                    mapId: mapId,
                    layerId: layerId,
                    tileIds: [Number(tileId)],
                },
                tileKey: tileKey,
                resolve: null,
                reject: null,
            }

            let selectionTilePromise = new Promise<FeatureTile>((resolve, reject) => {
                this.selectionTileRequest!.resolve = resolve;
                this.selectionTileRequest!.reject = reject;
            })

            this.update(viewIndex).then();
            tile = await selectionTilePromise;
            result.set(tileKey, tile);
        }

        return result;
    }

    async highlightFeatures(viewIndex: number, tileFeatureIds: (TileFeatureId | null | string)[],
                            focus: boolean = false, mode: HighlightMode = coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
        // Load the tiles for the selection.
        const tiles = await this.loadTiles(viewIndex, new Set(tileFeatureIds.filter(s =>
            s && typeof s !== "string"
            ).map(s =>
                (s as TileFeatureId).mapTileKey
            )
        ));

        // Ensure that the feature really exists in the tile.
        let features = new Array<FeatureWrapper>();
        for (let id of tileFeatureIds) {
            if (typeof id == "string") {
                // When clicking on geometry that represents a highlight,
                // this is reflected in the feature id. By processing this
                // info here, a hover highlight can be turned into a selection.
                if (id == "hover-highlight") {
                    features = this.hoverTopic.getValue();
                } else if (id == "selection-highlight") {
                    features = this.selectionTopic.getValue();
                }
                continue;
            }

            if (!id?.featureId) {
                continue;
            }

            const tile = tiles.get(id?.mapTileKey || "");
            if (!tile) {
                console.error(`Could not load tile ${id?.mapTileKey} for highlighting!`);
                continue;
            }
            if (!tile.has(id?.featureId || "")) {
                const [mapId, layerId, tileId] = coreLib.parseTileFeatureLayerKey(id?.mapTileKey || "");
                this.messageService.showError(
                    `The feature ${id?.featureId} does not exist in the ${layerId} layer of tile ${tileId} of map ${mapId}.`);
                continue;
            }

            features.push(new FeatureWrapper(id!.featureId, tile));
        }

        if (mode == coreLib.HighlightMode.HOVER_HIGHLIGHT) {
            if (features.length) {
                if (featureSetsEqual(this.selectionTopic.getValue(), features)) {
                    return;
                }
            }
            if (featureSetsEqual(this.hoverTopic.getValue(), features)) {
                return;
            }
            this.hoverTopic.next(features);
        } else if (mode == coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
            if (featureSetsEqual(this.selectionTopic.getValue(), features)) {
                return;
            }
            if (featureSetsEqual(this.hoverTopic.getValue(), features)) {
                this.hoverTopic.next([]);
            }
            this.selectionTopic.next(features);
        } else {
            console.error(`Unsupported highlight mode!`);
        }

        // TODO: Focus on bounding box of all features?
        // NOTE: Currently only focuses on the first feature. Should calculate bounding box
        // of all selected features and focus on that area for better UX when multiple features are selected.
        if (focus && features.length) {
            this.focusOnFeature(viewIndex, features[0]);
        }
    }

    focusOnFeature(viewIndex: number, feature: FeatureWrapper) {
        const position = feature.peek((parsedFeature: Feature) => parsedFeature.center());
        this.moveToWgs84PositionTopic.next({targetView: viewIndex, x: position.x, y: position.y});
    }

    setTileLevelForViewport(viewIndex: number) {
        // Validate viewport data
        if (!this.currentViewport || this.currentViewport.length <= viewIndex ||
            !isFinite(this.currentViewport[viewIndex].south) || !isFinite(this.currentViewport[viewIndex].west) ||
            !isFinite(this.currentViewport[viewIndex].width) || !isFinite(this.currentViewport[viewIndex].height) ||
            !isFinite(this.currentViewport[viewIndex].camPosLon) || !isFinite(this.currentViewport[viewIndex].camPosLat)) {
            console.error('Invalid viewport data in setTileLevelForViewport:', this.currentViewport);
            return;
        }

        try {
            for (const level of [...Array(MAX_ZOOM_LEVEL + 1).keys()]) {
                const numTileIds = coreLib.getNumTileIds(this.currentViewport[viewIndex], level);

                if (!isFinite(numTileIds) || numTileIds < 0) {
                    console.warn(`Invalid numTileIds for level ${level}: ${numTileIds}`);
                    continue;
                }

                if (numTileIds >= 48) {
                    this.zoomLevel.next(level);
                    return;
                }
            }
            this.zoomLevel.next(MAX_ZOOM_LEVEL);
        } catch (error) {
            console.error('Error in setTileLevelForViewport:', error);
            // Fallback to a safe zoom level
            this.zoomLevel.next(10);
        }
    }

    * tileLayersForTileId(tileId: bigint): Generator<FeatureTile> {
        for (const tile of this.loadedTileLayers.values()) {
            if (tile.tileId == tileId) {
                yield tile;
            }
        }
    }

    private visualizeHighlights(mode: HighlightMode, featureWrappers: Array<FeatureWrapper>) {
        let visualizationCollection = null;
        switch (mode) {
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT:
                if (!this.preserveSidePanel && this.sidePanelService.panel != SidePanelState.FEATURESEARCH) {
                    this.sidePanelService.panel = SidePanelState.NONE;
                }
                visualizationCollection = this.selectionVisualizations;
                break;
            case coreLib.HighlightMode.HOVER_HIGHLIGHT:
                visualizationCollection = this.hoverVisualizations;
                break;
            default:
                console.error(`Bad visualization mode ${mode}!`);
                return;
        }

        while (visualizationCollection.length) {
            this.tileVisualizationDestructionTopic.next(visualizationCollection.pop());
        }
        if (!featureWrappers.length) {
            return;
        }

        // Apply highlight styles.
        const featureTile = featureWrappers[0].featureTile;
        const featureIds = featureWrappers.map(fw => fw.featureId);
        for (let [_, style] of this.styleService.styles) {
            if (style.featureLayerStyle && style.params.visible) {
                let visu = new TileVisualization(
                    featureTile,
                    this.pointMergeService,
                    (tileKey: string) => this.getFeatureTile(tileKey),
                    style.featureLayerStyle,
                    true,
                    mode,
                    featureIds,
                    false,
                    style.params.options);
                this.tileVisualizationTopic.next(visu);
                visualizationCollection.push(visu);
            }
        }
    }

    private setLegalInfo(mapName: string, legalInfo: string): void {
        if (this.legalInformationPerMap.has(mapName)) {
            this.legalInformationPerMap.get(mapName)!.add(legalInfo);
        } else {
            this.legalInformationPerMap.set(mapName, new Set<string>().add(legalInfo));
        }
        this.legalInformationUpdated.next(true);
    }

    private removeLegalInfo(mapName: string): void {
        if (this.legalInformationPerMap.has(mapName)) {
            this.legalInformationPerMap.delete(mapName);
            this.legalInformationUpdated.next(true);
        }
    }

    private clearAllLegalInfo(): void {
        this.legalInformationPerMap.clear();
        this.legalInformationUpdated.next(true);
    }

    /**
     * Clean up all tile visualizations - used during viewer recreation
     */
    clearAllTileVisualizations(viewer: any): void {
        for (const [styleId, tileVisualizations] of this.visualizedTileLayers) {
            tileVisualizations.forEach(tileVisu => {
                try {
                    tileVisu.destroy(viewer);
                } catch (error) {
                    console.warn('Error destroying tile visualization:', error);
                }
            });
        }
        this.visualizedTileLayers.clear();
        this.tileVisualizationQueue = [];
    }

    /**
     * Force clear all loaded tiles - used during viewer recreation
     * This ensures tiles bound to old viewer context are evicted and refetched
     */
    clearAllLoadedTiles(): void {
        // Destroy all loaded tiles since they're bound to old viewer context
        for (const tileLayer of this.loadedTileLayers.values()) {
            try {
                tileLayer.destroy();
            } catch (error) {
                console.warn('Error destroying loaded tile:', error);
            }
        }
        this.loadedTileLayers.clear();

        // Abort any ongoing fetch to prevent race conditions
        if (this.currentFetch) {
            this.currentFetch.abort();
            this.currentFetch = null;
        }

        // Clear tile parsing queue to prevent rendering stale tiles
        this.tileStreamParsingQueue = [];
    }
}
