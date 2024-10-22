import {Injectable} from "@angular/core";
import {Fetch} from "./fetch.model";
import {FeatureTile, FeatureWrapper} from "./features.model";
import {coreLib, uint8ArrayToWasm} from "./wasm";
import {TileVisualization} from "./visualization.model";
import {BehaviorSubject, distinctUntilChanged, Subject} from "rxjs";
import {ErdblickStyle, StyleService} from "./style.service";
import {FeatureLayerStyle, TileLayerParser, Feature, HighlightMode} from '../../build/libs/core/erdblick-core';
import {ParametersService, TileFeatureId} from "./parameters.service";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {InfoMessageService} from "./info.service";
import {MAX_ZOOM_LEVEL} from "./feature.search.service";
import {PointMergeService} from "./pointmerge.service";
import {KeyboardService} from "./keyboard.service";
import * as uuid from 'uuid';

/** Expected structure of a LayerInfoItem's coverage entry. */
export interface CoverageRectItem extends Record<string, any> {
    min: number,
    max: number
}

/** Expected structure of a list entry in the MapInfoItem's layer entry. */
export interface LayerInfoItem extends Record<string, any> {
    canRead: boolean;
    canWrite: boolean;
    coverage: Array<number|CoverageRectItem>;
    featureTypes: Array<{name: string, uniqueIdCompositions: Array<any>}>;
    layerId: string;
    type: string;
    version: {major: number, minor: number, patch: number};
    zoomLevels: Array<number>;
    level: number;
    visible: boolean;
    tileBorders: boolean;
}

/** Expected structure of a list entry in the /sources endpoint. */
export interface MapInfoItem extends Record<string, any> {
    extraJsonAttachment: any;
    layers: Map<string, LayerInfoItem>;
    mapId: string;
    maxParallelJobs: number;
    nodeId: string;
    protocolVersion: {major: number, minor: number, patch: number};
    addOn: boolean;
    visible: boolean;
}

const infoUrl = "/sources";
const tileUrl = "/tiles";
const abortUrl = "/abort";

/** Redefinition of coreLib.Viewport. TODO: Check if needed. */
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
    public loadedTileLayers: Map<string, FeatureTile>;
    private visualizedTileLayers: Map<string, TileVisualization[]>;
    private currentFetch: Fetch|null = null;
    private currentFetchAbort: Fetch|null = null;
    private currentFetchId: number = 0;
    private currentViewport: ViewportProperties;
    private currentVisibleTileIds: Set<bigint>;
    private currentHighDetailTileIds: Set<bigint>;
    private tileStreamParsingQueue: any[];
    private tileVisualizationQueue: [string, TileVisualization][];
    private selectionVisualizations: TileVisualization[];
    private hoverVisualizations: TileVisualization[];

    tileParser: TileLayerParser|null = null;
    tileVisualizationTopic: Subject<any>;
    tileVisualizationDestructionTopic: Subject<any>;
    moveToWgs84PositionTopic: Subject<{x: number, y: number, z?: number}>;
    selectionTopic: BehaviorSubject<Array<FeatureWrapper>> = new BehaviorSubject<Array<FeatureWrapper>>([]);
    hoverTopic: BehaviorSubject<Array<FeatureWrapper>> = new BehaviorSubject<Array<FeatureWrapper>>([]);
    selectionTileRequest: {
        remoteRequest: {
            mapId: string,
            layerId: string,
            tileIds: Array<number>
        },
        tileKey: string,
        resolve: null|((tile: FeatureTile)=>void),
        reject: null|((why: any)=>void),
    } | null = null;
    zoomLevel: BehaviorSubject<number> = new BehaviorSubject<number>(0);
    statsDialogVisible: boolean = false;
    clientId: string = "";

    constructor(public styleService: StyleService,
                public parameterService: ParametersService,
                private sidePanelService: SidePanelService,
                private messageService: InfoMessageService,
                private pointMergeService: PointMergeService,
                private keyboardService: KeyboardService)
    {
        this.loadedTileLayers = new Map();
        this.visualizedTileLayers = new Map();
        this.currentFetch = null;
        this.currentViewport = {
            south: .0,
            west: .0,
            width: .0,
            height: .0,
            camPosLon: .0,
            camPosLat: .0,
            orientation: .0,
        };
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
        this.moveToWgs84PositionTopic = new Subject<{x: number, y: number}>();

        // Unique client ID which ensures that tile fetch requests from this map-service
        // are de-duplicated on the mapget server.
        this.clientId = uuid.v4();
    }

    public async initialize() {
        // Instantiate the TileLayerParser.
        this.tileParser = new coreLib.TileLayerParser();

        // Initial call to processTileStream, will keep calling itself
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

        this.parameterService.parameters.subscribe(params => {
            if (this.parameterService.initialQueryParamsSet)
                return;
            for (let [mapId, mapInfo] of this.maps.getValue()) {
                for (let [layerId, layer] of mapInfo.layers) {
                    [layer.visible, layer.level] = this.parameterService.mapLayerConfig(mapId, layerId, layer.level);
                }
            }
            this.update().then();
        })

        await this.reloadDataSources();

        this.parameterService.parameters.pipe(distinctUntilChanged()).subscribe(parameters => {
            this.highlightFeatures(parameters.selected).then();
        });

        this.selectionTopic.subscribe(selectedFeatureWrappers => {
            this.visualizeHighlights(coreLib.HighlightMode.SELECTION_HIGHLIGHT, selectedFeatureWrappers);
        });
        this.hoverTopic.subscribe(hoveredFeatureWrappers => {
            this.visualizeHighlights(coreLib.HighlightMode.HOVER_HIGHLIGHT, hoveredFeatureWrappers);
        });

        this.keyboardService.registerShortcuts(["Ctrl+x", "Ctrl+X"], ()=>{this.statsDialogVisible = true;});
    }

    private processTileStream() {
        const startTime = Date.now();
        const timeBudget = 10; // milliseconds

        while (this.tileStreamParsingQueue.length) {
            // Check if the time budget is exceeded.
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            let [message, messageType] = this.tileStreamParsingQueue.shift();
            if (messageType === Fetch.CHUNK_TYPE_FIELDS) {
                uint8ArrayToWasm( (wasmBuffer: any) => {
                    this.tileParser!.readFieldDictUpdate(wasmBuffer);
                }, message);
            } else if (messageType === Fetch.CHUNK_TYPE_FEATURES) {
                const tileLayerBlob = message.slice(Fetch.CHUNK_HEADER_SIZE);
                this.addTileFeatureLayer(tileLayerBlob, null, "", null);
            } else {
                console.error(`Encountered unknown message type ${messageType}!`);
            }
        }

        // Continue processing messages with a delay.
        const delay = this.tileStreamParsingQueue.length ? 0 : 10;
        setTimeout((_: any) => this.processTileStream(), delay);
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
                    let mapLayerLevels = new Array<[string, number, boolean, boolean]>();
                    let maps = new Map<string, MapInfoItem>(result.filter(m => !m.addOn).map(mapInfo => {
                        let layers = new Map<string, LayerInfoItem>();
                        for (let [layerId, layerInfo] of Object.entries(mapInfo.layers)) {
                            [layerInfo.visible, layerInfo.level, layerInfo.tileBorders] = this.parameterService.mapLayerConfig(mapInfo.mapId, layerId, 13);
                            mapLayerLevels.push([
                                mapInfo.mapId + '/' + layerId,
                                layerInfo.level,
                                layerInfo.visible,
                                layerInfo.tileBorders
                            ]);
                            layers.set(layerId, layerInfo);
                        }
                        mapInfo.layers = layers;
                        mapInfo.visible = true;
                        return [mapInfo.mapId, mapInfo];
                    }));
                    this.maps.next(maps);
                    this.parameterService.setInitialMapLayers(mapLayerLevels);

                    jsonCompleted = true;
                    checkCompletion();
                })
                .go();
        });
    }

    getMapLayerVisibility(mapId: string, layerId: string) {
        const mapItem = this.maps.getValue().get(mapId);
        if (!mapItem)
            return false;

        const layer = mapItem.layers.get(layerId);
        if (layer) {
            if (layer.type == "SourceData")
                return false;
            return layer.visible;
        }
        return false;
    }

    toggleMapLayerVisibility(mapId: string, layerId: string) {
        const mapItem = this.maps.getValue().get(mapId);
        if (mapItem === undefined) {
            return;
        }
        if (layerId) {
            const layer = mapItem.layers.get(layerId);
            if (layer !== undefined) {
                this.parameterService.setMapLayerConfig(mapId, layerId, layer.level, layer.visible, layer.tileBorders);
            }
        } else {
            mapItem.layers.forEach(layer => {
                this.parameterService.setMapLayerConfig(mapId, layer.layerId, layer.level, mapItem.visible, layer.tileBorders);
            });
        }
        this.update().then();
    }

    toggleLayerTileBorderVisibility(mapId: string, layerId: string) {
        const mapItem = this.maps.getValue().get(mapId);
        if (!mapItem)
            return;
        if (mapItem.layers.has(layerId)) {
            const layer = mapItem.layers.get(layerId)!;
            const hasTileBorders = !layer.tileBorders;
            mapItem.layers.get(layerId)!.tileBorders = hasTileBorders;
            this.parameterService.setMapLayerConfig(mapId, layerId, layer.level, layer.visible, hasTileBorders);
            this.update().then();
        }
    }

    setMapLayerLevel(mapId: string, layerId: string, level: number) {
        const mapItem = this.maps.getValue().get(mapId);
        if (!mapItem)
            return;
        if (mapItem.layers.has(layerId)) {
            const layer = mapItem.layers.get(layerId)!;
            this.parameterService.setMapLayerConfig(mapId, layerId, level, layer.visible, layer.tileBorders);
        }
        this.update().then();
    }

    *allLevels() {
        for (let [_, map] of this.maps.getValue())
            for (let [_, layer] of map.layers)
                yield layer.level;
    }

    getMapLayerLevel(mapId: string, layerId: string) {
        const mapItem = this.maps.getValue().get(mapId);
        if (!mapItem)
            return 13;
        return mapItem.layers.has(layerId) ? mapItem.layers.get(layerId)!.level : 13;
    }

    getMapLayerBorderState(mapId: string, layerId: string) {
        const mapItem = this.maps.getValue().get(mapId);
        if (!mapItem) {
            return false;
        }
        return mapItem.layers.has(layerId) ? mapItem.layers.get(layerId)!.tileBorders : false;
    }

    async update() {
        // Get the tile IDs for the current viewport.
        this.currentVisibleTileIds = new Set<bigint>();
        this.currentHighDetailTileIds = new Set<bigint>();
        // Map from level to array of tileIds.
        let tileIdPerLevel = new Map<number, Array<bigint>>();
        for (let level of this.allLevels()) {
            if (!tileIdPerLevel.has(level)) {
                const allViewportTileIds = coreLib.getTileIds(
                    this.currentViewport,
                    level,
                    this.parameterService.parameters.getValue().tilesLoadLimit) as bigint[];
                tileIdPerLevel.set(level, allViewportTileIds);
                this.currentVisibleTileIds = new Set([
                    ...this.currentVisibleTileIds,
                    ...new Set<bigint>(allViewportTileIds)
                ]);
                this.currentHighDetailTileIds = new Set([
                    ...this.currentHighDetailTileIds,
                    ...new Set<bigint>(
                        allViewportTileIds.slice(0, this.parameterService.parameters.getValue().tilesVisualizeLimit))
                ])
            }
        }

        // Evict present non-required tile layers.
        let newTileLayers = new Map();
        let evictTileLayer = (tileLayer: FeatureTile) => {
            return !tileLayer.preventCulling && !this.selectionTopic.getValue().some(v => v.featureTile.mapTileKey == tileLayer.mapTileKey) && (!this.currentVisibleTileIds.has(tileLayer.tileId) ||
                !this.getMapLayerVisibility(tileLayer.mapName, tileLayer.layerName) ||
                tileLayer.level() != this.getMapLayerLevel(tileLayer.mapName, tileLayer.layerName))
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
                tileVisu.showTileBorder = this.getMapLayerBorderState(mapName, layerName);
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
            }
            else {
                this.selectionTileRequest.reject!("Map layer is not available.");
            }
        }

        for (const [mapName, map] of this.maps.getValue()) {
            for (const [layerName, _] of map.layers) {
                if (!this.getMapLayerVisibility(mapName, layerName)) {
                    continue;
                }

                // Find tile IDs which are not yet loaded for this map layer combination.
                let requestTilesForMapLayer = []
                let level = this.getMapLayerLevel(mapName, layerName);
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

    addTileFeatureLayer(tileLayerBlob: any, style: ErdblickStyle | null, styleId: string, preventCulling: any) {
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

        // Schedule the visualization of the newly added tile layer,
        // but don't do it synchronously to avoid stalling the main thread.
        setTimeout(() => {
            if (style && styleId) {
                this.renderTileLayer(tileLayer, style, styleId);
            } else {
                this.styleService.styles.forEach((style, styleId) => {
                    this.renderTileLayer(tileLayer, style, styleId);
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
    }

    private renderTileLayer(tileLayer: FeatureTile, style: ErdblickStyle|FeatureLayerStyle, styleId: string = "") {
        let wasmStyle = (style as ErdblickStyle).featureLayerStyle ? (style as ErdblickStyle).featureLayerStyle : style as FeatureLayerStyle;
        if (!wasmStyle)
            return;
        if ((style as ErdblickStyle).params !== undefined && !(style as ErdblickStyle).params.visible) {
            return;
        }
        const mapName = tileLayer.mapName;
        const layerName = tileLayer.layerName;
        let visu = new TileVisualization(
            tileLayer,
            this.pointMergeService,
            (tileKey: string)=>this.getFeatureTile(tileKey),
            wasmStyle,
            tileLayer.preventCulling || this.currentHighDetailTileIds.has(tileLayer.tileId),
            coreLib.HighlightMode.NO_HIGHLIGHT,
            [],
            this.getMapLayerBorderState(mapName, layerName),
            (style as ErdblickStyle).params !== undefined ? (style as ErdblickStyle).params.options : {});
        this.tileVisualizationQueue.push([styleId, visu]);
        if (this.visualizedTileLayers.has(styleId)) {
            this.visualizedTileLayers.get(styleId)?.push(visu);
        } else {
            this.visualizedTileLayers.set(styleId, [visu]);
        }
    }

    setViewport(viewport: ViewportProperties) {
        this.currentViewport = viewport;
        this.setTileLevelForViewport();
        this.update().then();
    }

    getPrioritisedTiles() {
        let tiles  = new Array<[number, FeatureTile]>();
        for (const [_, tile] of this.loadedTileLayers) {
            tiles.push([coreLib.getTilePriorityById(this.currentViewport, tile.tileId), tile]);
        }
        tiles.sort((a, b) => b[0] - a[0]);
        return tiles.map(val => val[1]);
    }

    getFeatureTile(tileKey: string): FeatureTile|null {
        return this.loadedTileLayers.get(tileKey) || null;
    }

    async loadTiles(tileKeys: Set<string|null>): Promise<Map<string, FeatureTile>> {
        let result = new Map<string, FeatureTile>();

        // TODO: Optimize this loop to make just a single update call.
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

            let selectionTilePromise = new Promise<FeatureTile>((resolve, reject)=>{
                this.selectionTileRequest!.resolve = resolve;
                this.selectionTileRequest!.reject = reject;
            })

            this.update().then();
            tile = await selectionTilePromise;
            result.set(tileKey, tile);
        }

        return result;
    }

    async highlightFeatures(tileFeatureIds: (TileFeatureId|null|string)[], focus: boolean=false, mode: HighlightMode=coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
        // Load the tiles for the selection.
        const tiles = await this.loadTiles(
            new Set(tileFeatureIds.filter(s => s && typeof s !== "string").map(s => (s as TileFeatureId).mapTileKey)));

        // Ensure that the feature really exists in the tile.
        let features = new Array<FeatureWrapper>();
        for (let id of tileFeatureIds) {
            if (typeof id == "string") {
                // When clicking on geometry that represents a highlight,
                // this is reflected in the feature id. By processing this
                // info here, a hover highlight can be turned into a selection.
                if (id == "hover-highlight") {
                    features = this.hoverTopic.getValue();
                }
                else if (id == "selection-highlight") {
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
        }
        else if (mode == coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
            if (featureSetsEqual(this.selectionTopic.getValue(), features)) {
                return;
            }
            if (featureSetsEqual(this.hoverTopic.getValue(), features)) {
                this.hoverTopic.next([]);
            }
            this.selectionTopic.next(features);
        }
        else {
            console.error(`Unsupported highlight mode!`);
        }

        // TODO: Focus on bounding box of all features?
        if (focus && features.length) {
            this.focusOnFeature(features[0]);
        }
    }

    focusOnFeature(feature: FeatureWrapper) {
        const position = feature.peek((parsedFeature: Feature) => parsedFeature.center());
        this.moveToWgs84PositionTopic.next({x: position.x, y: position.y});
    }

    setTileLevelForViewport() {
        for (const level of [...Array(MAX_ZOOM_LEVEL + 1).keys()]) {
            if (coreLib.getNumTileIds(this.currentViewport, level) >= 48) {
                this.zoomLevel.next(level);
                return;
            }
        }
        this.zoomLevel.next(MAX_ZOOM_LEVEL);
    }

    private visualizeHighlights(mode: HighlightMode, featureWrappers: Array<FeatureWrapper>) {
        let visualizationCollection = null;
        switch (mode) {
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT:
                if (this.sidePanelService.panel != SidePanelState.FEATURESEARCH) {
                    this.sidePanelService.panel = SidePanelState.NONE;
                }
                visualizationCollection = this.selectionVisualizations;
                break;
            case coreLib.HighlightMode.HOVER_HIGHLIGHT:
                visualizationCollection = this.hoverVisualizations; break;
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
                    (tileKey: string)=>this.getFeatureTile(tileKey),
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
}
