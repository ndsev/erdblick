"use strict";

import {Fetch} from "./fetch.component";
import {FeatureTile} from "./features.component";
import {uint8ArrayToWasm} from "./wasm";
import {TileVisualization} from "./visualization.component";
import {BehaviorSubject, Subject} from "rxjs";
import {ErdblickStyle, ErdblickStyleData, StyleService} from "./style.service";
import {MapInfoItem, MapItemLayer} from "./map.service";
import {ParametersService} from "./parameters.service";

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
 * Erdblick view-model class. This class is responsible for keeping track
 * of the following objects:
 *  (1) available maps
 *  (2) currently loaded tiles
 *  (3) available style sheets.
 *
 * As the viewport changes, it requests new tiles from the mapget server
 * and triggers their conversion to Cesium tiles according to the active
 * style sheets.
 */
export class ErdblickModel {
    static MAX_NUM_TILES_TO_LOAD = 2048;
    static MAX_NUM_TILES_TO_VISUALIZE = 512;
    private coreLib: any;
    private styles: Map<string, ErdblickStyleData> | null;
    private importedStyles: Map<string, ErdblickStyleData> | null;
    private maps: Map<string, MapInfoItem> | null;
    private loadedTileLayers: Map<string, FeatureTile>;
    private visualizedTileLayers: Map<string, TileVisualization[]>;
    private currentFetch: any;
    private currentViewport: ViewportProperties;
    private currentVisibleTileIds: Set<bigint>;
    private currentHighDetailTileIds: Set<bigint>;
    private tileStreamParsingQueue: any[];
    private tileVisualizationQueue: [string, TileVisualization][];
    maxLoadTiles: number;
    maxVisuTiles: number;
    private tileParser: any;
    tileVisualizationTopic: Subject<any>;
    tileVisualizationDestructionTopic: Subject<any>;
    zoomToWgs84PositionTopic: Subject<any>;
    mapInfoTopic: Subject<any>;
    allViewportTileIds: Map<number, number> = new Map<number, number>();
    layerIdToLevel: Map<string, number> = new Map<string, number>();
    availableMapItems: BehaviorSubject<Map<string, MapInfoItem>> = new BehaviorSubject<Map<string, MapInfoItem>>(new Map<string, MapInfoItem>());

    private textEncoder: TextEncoder = new TextEncoder();

    constructor(coreLibrary: any,
                public styleService: StyleService,
                public parametersService: ParametersService) {
        this.coreLib = coreLibrary;
        this.styles = null;
        this.importedStyles = null;
        this.maps = null;
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
        this.maxLoadTiles = ErdblickModel.MAX_NUM_TILES_TO_LOAD;
        this.maxVisuTiles = ErdblickModel.MAX_NUM_TILES_TO_VISUALIZE;

        // Instantiate the TileLayerParser, and set its callback
        // for when a new tile is received.
        this.tileParser = new this.coreLib.TileLayerParser();

        ///////////////////////////////////////////////////////////////////////////
        //                               MODEL EVENTS                            //
        ///////////////////////////////////////////////////////////////////////////

        /// Triggered when a tile layer is freshly rendered and should be added to the frontend.
        this.tileVisualizationTopic = new Subject<any>(); // {FeatureTile}

        /// Triggered when a tile layer is being removed.
        this.tileVisualizationDestructionTopic = new Subject<any>(); // {FeatureTile}

        /// Triggered when the user requests to zoom to a map layer.
        this.zoomToWgs84PositionTopic = new Subject<any>(); // {.x,.y}

        /// Triggered when the map info is updated.
        this.mapInfoTopic = new Subject<any>(); // {<mapId>: <mapInfo>}

        ///////////////////////////////////////////////////////////////////////////
        //                                 BOOTSTRAP                             //
        ///////////////////////////////////////////////////////////////////////////

        this.loadStyles();
        this.reloadDataSources();

        // Initial call to processTileStream, will keep calling itself
        this.processTileStream();
        this.processVisualizationTasks();
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
                uint8ArrayToWasm(this.coreLib, (wasmBuffer: any) => {
                    this.tileParser.readFieldDictUpdate(wasmBuffer);
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

    loadStyles() {
        if (this.styles) {
            this.styles.forEach((style: ErdblickStyleData, _) => {
                if (style) style.featureLayerStyle.delete();
            });
        }
        if (this.importedStyles) {
            this.importedStyles.forEach((style: ErdblickStyleData, _) => {
                if (style) style.featureLayerStyle.delete();
            });
        }
        this.styles = new Map<string, ErdblickStyleData>();
        this.importedStyles = new Map<string, ErdblickStyleData>();

        const parameters = this.parametersService.parameters.getValue();
        if (parameters) {
            [...this.styleService.activatedStyles.keys()].forEach(styleId =>
                this.styleService.activatedStyles.set(styleId, parameters.styles.includes(styleId)));
        }

        this.styleService.styleData.forEach((styleString: string, styleId: string) => {
            const erdblickStyleData = this.loadErdblickStyleData(styleId, styleString);
            if (erdblickStyleData !== undefined && erdblickStyleData) {
                this.styles!.set(styleId, erdblickStyleData);
            }
        });

        this.styleService.importedStyleData.forEach((styleString: string, styleId: string) => {
            const erdblickStyleData = this.loadErdblickStyleData(styleId, styleString, true);
            if (erdblickStyleData !== undefined && erdblickStyleData) {
                this.importedStyles!.set(styleId, erdblickStyleData);
            }
        });

        console.log("Loaded styles.");
    }

    private loadErdblickStyleData(styleId: string, styleString: string, imported: boolean = false): ErdblickStyleData | undefined {
        const isAvailable = imported ? this.styleService.activatedImportedStyles.has(styleId) : this.styleService.activatedStyles.has(styleId);
        if (isAvailable) {
            const styleUint8Array = this.textEncoder.encode(styleString);
            // Parse the style description into a WASM style object.
            return uint8ArrayToWasm(this.coreLib,
                (wasmBuffer: any) => {
                    return {
                        enabled: imported ? this.styleService.activatedImportedStyles.get(styleId)! : this.styleService.activatedStyles.get(styleId)!,
                        featureLayerStyle: new this.coreLib.FeatureLayerStyle(wasmBuffer)
                    }
                },
                styleUint8Array);
        }
        return undefined;
    }

    reloadStyle(styleId: string) {
        if (this.styles) {
            if (this.styles.has(styleId) && this.styleService.styleData.has(styleId)) {
                this.styleService.syncStyle(styleId).then(_ => {
                    const styleString = this.styleService.styleData.get(styleId);
                    if (styleString !== undefined) {
                        this.styles!.get(styleId)?.featureLayerStyle?.delete();
                        const erdblickStyleData= this.loadErdblickStyleData(styleId, styleString);
                        if (erdblickStyleData !== undefined && erdblickStyleData) {
                            this.styles!.set(styleId, erdblickStyleData);
                        }
                        this.tileVisualizationQueue = [];
                        this.visualizedTileLayers.get(styleId)?.forEach(tileVisu =>
                            this.tileVisualizationDestructionTopic.next(tileVisu)
                        );
                        this.visualizedTileLayers.set(styleId, []);
                        for (let [_, tileLayer] of this.loadedTileLayers.entries()) {
                            this.renderTileLayer(tileLayer, this.styles!.get(styleId), styleId);
                        }
                    }
                });
            }
        }
        console.log(`Reloaded style: ${styleId}.`);
    }

    cycleImportedStyle(styleId: string, remove= false) {
        if (this.importedStyles) {
            if (remove && !this.styleService.importedStyleData.has(styleId)) {
                console.log(`No style data for: ${styleId}.`);
                return;
            }
            const styleString = this.styleService.importedStyleData.get(styleId);
            if (styleString === undefined) {
                console.log(`Could not retrieve style data for: ${styleId}.`);
                return;
            }
            if (remove) {
                this.importedStyles!.get(styleId)?.featureLayerStyle?.delete();
                this.importedStyles!.delete(styleId);
                this.tileVisualizationQueue = [];
                this.visualizedTileLayers.get(styleId)?.forEach(tileVisu =>
                    this.tileVisualizationDestructionTopic.next(tileVisu)
                );
                this.visualizedTileLayers.delete(styleId);
            } else {
                const erdblickStyleData= this.loadErdblickStyleData(styleId, styleString, true);
                if (erdblickStyleData !== undefined && erdblickStyleData) {
                    this.importedStyles!.set(styleId, erdblickStyleData);
                }
                this.visualizedTileLayers.set(styleId, []);
                for (let [_, tileLayer] of this.loadedTileLayers.entries()) {
                    this.renderTileLayer(tileLayer, this.importedStyles!.get(styleId), styleId);
                }
            }
        }
        console.log(`Cycled imported style: ${styleId}.`);
    }

    private reapplyStyle(styleId: string, imported: boolean = false) {
        const styleMap = imported ? this.importedStyles : this.styles;
        if (!styleMap || !styleMap.has(styleId)) {
            return;
        }
        const isActivated = imported ? this.styleService.activatedImportedStyles.get(styleId) : this.styleService.activatedStyles.get(styleId);
        if (isActivated === undefined) {
            return;
        }
        const style = styleMap!.get(styleId);
        if (style === undefined) {
            return;
        }
        style.enabled = isActivated;
        this.visualizedTileLayers.get(styleId)?.forEach(tileVisu =>
            this.tileVisualizationDestructionTopic.next(tileVisu)
        );
        if (isActivated) {
            this.visualizedTileLayers.set(styleId, []);
            for (let [_, tileLayer] of this.loadedTileLayers.entries()) {
                this.renderTileLayer(tileLayer, style, styleId);
            }
        } else {
            this.visualizedTileLayers.set(styleId, []);
        }
        console.log(`${isActivated ? 'Activated' : 'Deactivated'} style: ${styleId}.`);
    }

    reapplyStyles(styleIds: Array<string>, imported: boolean = false) {
        this.tileVisualizationQueue = [];
        styleIds.forEach(styleId => this.reapplyStyle(styleId, imported));
    }

    reapplyAllStyles() {
        if (this.styles) {
            this.reapplyStyles([...this.styles.keys()]);
        }
    }

    private reloadDataSources() {
        new Fetch(infoUrl)
        .withBufferCallback((infoBuffer: any) => {
            uint8ArrayToWasm(this.coreLib, (wasmBuffer: any) => {
                this.tileParser.setDataSourceInfo(wasmBuffer);
            }, infoBuffer)
            console.log("Loaded data source info.");
        })
        .withJsonCallback((result: Array<MapInfoItem>) => {
            const availableMapItems = this.availableMapItems.getValue();
            this.maps = new Map<string, MapInfoItem>(result.map(mapInfo => {
                let layers = new Map<string, MapItemLayer>();
                let defCoverage = [0n];
                Object.entries(mapInfo.layers).forEach(([layerName, layer]) => {
                    let erdblickLayer = layer as MapItemLayer;
                    if (erdblickLayer.coverage.length == 0) {
                        erdblickLayer.coverage = defCoverage;
                    }
                    erdblickLayer.level = 13;
                    erdblickLayer.visible = true;
                    layers.set(layerName, erdblickLayer);
                    this.layerIdToLevel.set(mapInfo.mapId + '/' + layerName, 13);
                });
                mapInfo.layers = layers;
                if (availableMapItems.has(mapInfo.mapId)) {
                    const availableMapItem = this.availableMapItems.getValue().get(mapInfo.mapId)!;
                    mapInfo.visible = availableMapItem.visible;
                    mapInfo.level = availableMapItem.level;
                    for (const [layerName, mapLayer] of layers) {
                        if (availableMapItem.layers.has(layerName)) {
                            mapLayer.visible = availableMapItem.layers.get(layerName)!.visible;
                            mapLayer.level = availableMapItem.layers.get(layerName)!.level;
                        }
                    }
                } else {
                    mapInfo.visible = true;
                    mapInfo.level = 13;
                }
                return [mapInfo.mapId, mapInfo]
            }));
            this.mapInfoTopic.next(this.maps);
        })
        .go();
    }

    ///////////////////////////////////////////////////////////////////////////
    //                          MAP UPDATE CONTROLS                          //
    ///////////////////////////////////////////////////////////////////////////

    checkMapLayerVisibility(mapName: string, layerName: string) {
        const mapItem = this.availableMapItems.getValue().get(mapName);
        if (mapItem == undefined) {
            return false;
        }
        return mapItem.layers.has(layerName) && mapItem.layers.get(layerName)!.visible;
    }

    update() {
        // Get the tile IDs for the current viewport.
        this.currentVisibleTileIds = new Set<bigint>();
        this.currentHighDetailTileIds = new Set<bigint>();
        // Level: array of tileIds
        let tileIdPerLevel = new Map<number, Array<bigint>>();
        for (let [_, level] of this.layerIdToLevel) {
            if (!tileIdPerLevel.has(level)) {
                const allViewportTileIds = this.coreLib.getTileIds(this.currentViewport, level, this.maxLoadTiles) as bigint[];
                tileIdPerLevel.set(level, allViewportTileIds);
                this.currentVisibleTileIds = new Set([
                    ...this.currentVisibleTileIds,
                    ...new Set<bigint>(allViewportTileIds)
                ]);
                this.currentHighDetailTileIds = new Set([
                    ...this.currentVisibleTileIds,
                    ...new Set<bigint>(allViewportTileIds.slice(0, this.maxVisuTiles))
                ])
            }
        }

        // Abort previous fetch operation.
        if (this.currentFetch) {
            this.currentFetch.abort();
            // Clear any unparsed messages from the previous stream.
            this.tileStreamParsingQueue = [];
        }

        // Make sure that there are no unparsed bytes lingering from the previous response stream.
        this.tileParser.reset();

        // Evict present non-required tile layers.
        let newTileLayers = new Map();
        for (let tileLayer of this.loadedTileLayers.values()) {
            if (!tileLayer.preventCulling && (!this.currentVisibleTileIds.has(tileLayer.tileId) ||
                !this.checkMapLayerVisibility(tileLayer.mapName, tileLayer.layerName))) {
                tileLayer.destroy();
            } else {
                newTileLayers.set(tileLayer.id, tileLayer);
            }
        }
        this.loadedTileLayers = newTileLayers;

        // Request non-present required tile layers.
        // TODO: Consider tile TTL.
        let requests = [];
        if (this.maps) {
            for (const [mapName, map] of this.maps) {
                for (const [layerName, _] of map.layers) {
                    // Find tile IDs which are not yet loaded for this map layer combination.
                    let requestTilesForMapLayer = []
                    let level = this.layerIdToLevel.get(mapName + '/' + layerName);
                    if (level == undefined) {
                        continue;
                    }
                    let tileIds = tileIdPerLevel.get(level!);
                    if (tileIds == undefined) {
                        continue;
                    }
                    for (let tileId of tileIds!) {
                        const tileMapLayerKey = this.coreLib.getTileFeatureLayerKey(mapName, layerName, tileId);
                        if (this.checkMapLayerVisibility(mapName, layerName)) {
                            if (!this.loadedTileLayers.has(tileMapLayerKey)) {
                                requestTilesForMapLayer.push(Number(tileId));
                            }
                        } else {
                            if (this.loadedTileLayers.has(tileMapLayerKey)) {
                                this.removeTileLayer(this.loadedTileLayers.get(tileMapLayerKey));
                                this.loadedTileLayers.delete(tileMapLayerKey);
                            }
                        }
                    }
                    // Only add a request if there are tiles to be loaded.
                    if (requestTilesForMapLayer) {
                        requests.push({
                            mapId: mapName,
                            layerId: layerName,
                            tileIds: requestTilesForMapLayer
                        });
                    }
                }
            }
        }

        // Update visualizations and visualization queue
        for (const styleId of this.visualizedTileLayers.keys()) {
            const tileVisus = this.visualizedTileLayers.get(styleId)?.filter(tileVisu => {
                if (!this.currentVisibleTileIds.has(tileVisu.tile.tileId) && !tileVisu.tile.preventCulling) {
                    this.tileVisualizationDestructionTopic.next(tileVisu);
                    return false;
                }
                let styleEnabled = false;
                if (this.styles?.has(styleId)) {
                    styleEnabled = this.styles?.get(styleId)?.enabled!;
                } else if (this.importedStyles?.has(styleId)) {
                    styleEnabled = this.importedStyles?.get(styleId)?.enabled!;
                }
                if (styleId != "_builtin" && !styleEnabled) {
                    this.tileVisualizationDestructionTopic.next(tileVisu);
                    return false;
                }
                tileVisu.isHighDetail = this.currentHighDetailTileIds.has(tileVisu.tile.tileId) || tileVisu.tile.preventCulling;
                return true;
            });
            if (tileVisus !== undefined && tileVisus.length) {
                this.visualizedTileLayers.set(styleId, tileVisus);
            } else {
                this.visualizedTileLayers.delete(styleId);
            }
        }
        for (const [styleId, tileVisus] of this.visualizedTileLayers) {
            tileVisus.forEach(tileVisu => {
                if (tileVisu.isDirty()) {
                    this.tileVisualizationQueue.push([styleId, tileVisu]);
                }
            });
        }

        // Launch the new fetch operation
        this.currentFetch = new Fetch(tileUrl)
        .withChunkProcessing()
        .withMethod("POST")
        .withBody({
            requests: requests,
            maxKnownFieldIds: this.tileParser.getFieldDictOffsets()
        })
        .withBufferCallback((message: any, messageType: any) => {
            // Schedule the parsing of the newly arrived tile layer,
            // but don't do it synchronously to avoid stalling the ongoing
            // fetch operation.
            this.tileStreamParsingQueue.push([message, messageType]);
        });
        this.currentFetch.go();
    }

    private addTileFeatureLayer(tileLayerBlob: any, style: ErdblickStyleData | null, styleId: string, preventCulling: any) {
        let tileLayer = new FeatureTile(this.coreLib, this.tileParser, tileLayerBlob, preventCulling);

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
                this.styles?.forEach((style, styleId) => {
                    this.renderTileLayer(tileLayer, style, styleId);
                });
                this.importedStyles?.forEach((style, styleId) => {
                    this.renderTileLayer(tileLayer, style, styleId);
                });
            }
        })
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

    private renderTileLayer(tileLayer: FeatureTile, style: any, styleId: string = "_builtin") {
        if (style) {
            if (styleId != "_builtin" && !style.enabled) {
                return;
            }
            let visu = new TileVisualization(
                tileLayer,
                styleId == "_builtin" ? style : style.featureLayerStyle,
                tileLayer.preventCulling || this.currentHighDetailTileIds.has(tileLayer.tileId));
            this.tileVisualizationQueue.push([styleId, visu]);
            if (this.visualizedTileLayers.has(styleId)) {
                this.visualizedTileLayers.get(styleId)?.push(visu);
            } else {
                this.visualizedTileLayers.set(styleId, [visu]);
            }
        }
    }

    // public:
    setViewport(viewport: any) {
        this.currentViewport = viewport;
        this.update();
    }
}
