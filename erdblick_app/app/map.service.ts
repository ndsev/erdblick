import {Injectable} from "@angular/core";
import {Fetch} from "./fetch.model";
import {FeatureTile, FeatureWrapper} from "./features.model";
import {coreLib, uint8ArrayToWasm} from "./wasm";
import {TileVisualization} from "./visualization.model";
import {BehaviorSubject, Subject} from "rxjs";
import {ErdblickStyle, StyleService} from "./style.service";
import {FeatureLayerStyle, TileLayerParser, Feature} from '../../build/libs/core/erdblick-core';
import {ParametersService} from "./parameters.service";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {InfoMessageService} from "./info.service";
import {MAX_ZOOM_LEVEL} from "./feature.search.service";

export interface CoverageRectItem extends Object {
    min: number,
    max: number
}

export interface LayerInfoItem extends Object {
    canRead: boolean;
    canWrite: boolean;
    coverage: Array<number|CoverageRectItem>;
    featureTypes: Array<{name: string, uniqueIdCompositions: Array<Object>}>;
    layerId: string;
    type: string;
    version: {major: number, minor: number, patch: number};
    zoomLevels: Array<number>;
    level: number;
    visible: boolean;
    tileBorders: boolean;
}

export interface MapInfoItem extends Object {
    extraJsonAttachment: Object;
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
    private currentFetch: any;
    private currentViewport: ViewportProperties;
    private currentVisibleTileIds: Set<bigint>;
    private currentHighDetailTileIds: Set<bigint>;
    private tileStreamParsingQueue: any[];
    private tileVisualizationQueue: [string, TileVisualization][];
    private selectionVisualizations: TileVisualization[];

    tileParser: TileLayerParser|null = null;
    tileVisualizationTopic: Subject<any>;
    tileVisualizationDestructionTopic: Subject<any>;
    moveToWgs84PositionTopic: Subject<{x: number, y: number}>;
    allViewportTileIds: Map<number, number> = new Map<number, number>();
    selectionTopic: BehaviorSubject<FeatureWrapper|null> = new BehaviorSubject<FeatureWrapper|null>(null);
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

    constructor(public styleService: StyleService,
                public parameterService: ParametersService,
                private sidePanelService: SidePanelService,
                private messageService: InfoMessageService) {
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

        // Triggered when a tile layer is freshly rendered and should be added to the frontend.
        this.tileVisualizationTopic = new Subject<any>(); // {FeatureTile}

        // Triggered when a tile layer is being removed.
        this.tileVisualizationDestructionTopic = new Subject<any>(); // {FeatureTile}

        // Triggered when the user requests to zoom to a map layer.
        this.moveToWgs84PositionTopic = new Subject<{x: number, y: number}>();
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
            this.update();
        })

        await this.reloadDataSources();

        this.selectionTopic.subscribe(selectedFeatureWrapper => {
            this.selectionVisualizations.forEach(visu => this.tileVisualizationDestructionTopic.next(visu));
            this.selectionVisualizations = [];

            if (this.sidePanelService.panel != SidePanelState.FEATURESEARCH) {
                this.sidePanelService.panel = SidePanelState.NONE;
            }
            if (!selectedFeatureWrapper)
                return;

            // Apply additional highlight styles.
            for (let [_, styleData] of this.styleService.styles) {
                if (styleData.featureLayerStyle && styleData.params.visible) {
                    let visu = new TileVisualization(
                        selectedFeatureWrapper!.featureTile,
                        (tileKey: string)=>this.getFeatureTile(tileKey),
                        styleData.featureLayerStyle,
                        true,
                        selectedFeatureWrapper.peek((f: Feature) => f.id()));
                    this.tileVisualizationTopic.next(visu);
                    this.selectionVisualizations.push(visu);
                }
            }
        });
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
        await new Promise<void>((resolve, reject) => {
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
        return mapItem.layers.has(layerId) ? mapItem.layers.get(layerId)!.visible : false;
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
        this.update();
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
            this.update();
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
        this.update();
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

    update() {
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
                    ...this.currentVisibleTileIds,
                    ...new Set<bigint>(
                        allViewportTileIds.slice(0, this.parameterService.parameters.getValue().tilesVisualizeLimit))
                ])
            }
        }

        // Evict present non-required tile layers.
        let newTileLayers = new Map();
        let evictTileLayer = (tileLayer: FeatureTile) => {
            return !tileLayer.preventCulling && (!this.currentVisibleTileIds.has(tileLayer.tileId) ||
                !this.getMapLayerVisibility(tileLayer.mapName, tileLayer.layerName) ||
                tileLayer.level() != this.getMapLayerLevel(tileLayer.mapName, tileLayer.layerName))
        }
        for (let tileLayer of this.loadedTileLayers.values()) {
            if (evictTileLayer(tileLayer)) {
                tileLayer.destroy();
            } else {
                newTileLayers.set(tileLayer.id, tileLayer);
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

        // Request non-present required tile layers.
        // TODO: Consider tile TTL.
        let requests = [];
        if (this.selectionTileRequest) {
            requests.push(this.selectionTileRequest.remoteRequest);

            if (this.currentFetch) {
                // Disable the re-fetch filtering logic by setting the old
                // fetches' body to null.
                this.currentFetch.bodyJson = null;
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

        // Abort previous fetch operation, if it is different from the new one.
        let newRequestBody = JSON.stringify({
            requests: requests,
            maxKnownFieldIds: this.tileParser!.getFieldDictOffsets()
        });
        if (this.currentFetch) {
            if (this.currentFetch.bodyJson === newRequestBody)
                return;
            this.currentFetch.abort();
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
                // Schedule the parsing of the newly arrived tile layer,
                // but don't do it synchronously to avoid stalling the ongoing
                // fetch operation.
                this.tileStreamParsingQueue.push([message, messageType]);
            });
        this.currentFetch.go();
    }

    addTileFeatureLayer(tileLayerBlob: any, style: ErdblickStyle | null, styleId: string, preventCulling: any) {
        let tileLayer = new FeatureTile(this.tileParser!, tileLayerBlob, preventCulling);

        // Consider, if this tile is a selection tile request.
        if (this.selectionTileRequest && tileLayer.id == this.selectionTileRequest.tileKey) {
            this.selectionTileRequest.resolve!(tileLayer);
            this.selectionTileRequest = null;
        }

        // Don't add a tile that is not supposed to be visible.
        if (!preventCulling) {
            if (!this.currentVisibleTileIds.has(tileLayer.tileId))
                return;
        }

        // If this one replaces an older tile with the same key,
        // then first remove the older existing one.
        if (this.loadedTileLayers.has(tileLayer.id)) {
            this.removeTileLayer(this.loadedTileLayers.get(tileLayer.id));
        }
        this.loadedTileLayers.set(tileLayer.id, tileLayer);

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

    private removeTileLayer(tileLayer: any) {
        tileLayer.destroy()
        for (const styleId of this.visualizedTileLayers.keys()) {
            const tileVisus = this.visualizedTileLayers.get(styleId)?.filter(tileVisu => {
                if (tileVisu.tile.id === tileLayer.id) {
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
            return tileVisu.tile.id !== tileLayer.id;
        });
        this.loadedTileLayers.delete(tileLayer.id);
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
            (tileKey: string)=>this.getFeatureTile(tileKey),
            wasmStyle,
            tileLayer.preventCulling || this.currentHighDetailTileIds.has(tileLayer.tileId),
            "",
            this.getMapLayerBorderState(mapName, layerName),
            (style as ErdblickStyle).params !== undefined ? (style as ErdblickStyle).params.options : {});
        this.tileVisualizationQueue.push([styleId, visu]);
        if (this.visualizedTileLayers.has(styleId)) {
            this.visualizedTileLayers.get(styleId)?.push(visu);
        } else {
            this.visualizedTileLayers.set(styleId, [visu]);
        }
    }

    setViewport(viewport: any) {
        this.currentViewport = viewport;
        this.setTileLevelForViewport();
        this.update();
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

    async loadTileForSelection(tileKey: string) {
        if (this.loadedTileLayers.has(tileKey)) {
            return this.loadedTileLayers.get(tileKey)!;
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

        this.update();
        return selectionTilePromise;
    }

    async selectFeature(tileKey: string, typeId: string, idParts: Array<string|number>, focus: boolean=false) {
        let tile = await this.loadTileForSelection(tileKey);
        let feature = new FeatureWrapper(
            tile.peek(layer => layer.findFeatureIndex(typeId, idParts)),
            tile);
        if (feature.index < 0) {
            let [mapId, layerId, tileId] = coreLib.parseTileFeatureLayerKey(tileKey);
            this.messageService.showError(
                `The feature ${typeId+idParts.map((val, n)=>((n%2)==1?val:".")).join("")}`+
                `does not exist in the ${layerId} layer of tile ${tileId} of map ${mapId}.`);
            return;
        }
        this.selectionTopic.next(feature);
        if (focus) {
            this.focusOnFeature(feature);
        }
    }

    focusOnFeature(feature: FeatureWrapper) {
        const position = feature.peek((parsedFeature: Feature) => parsedFeature.center());
        this.moveToWgs84PositionTopic.next(position);
    }

    setTileLevelForViewport() {
        for (const level of [...Array(MAX_ZOOM_LEVEL + 1).keys()]) {
            if (coreLib.getNumTileIds(this.currentViewport, level) >= 15) {
                this.zoomLevel.next(level);
                return;
            }
        }
        this.zoomLevel.next(MAX_ZOOM_LEVEL);
    }
}
