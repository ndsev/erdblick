import {Injectable} from "@angular/core";
import {Fetch} from "./fetch";
import {FeatureTile, FeatureWrapper} from "./features.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {TileVisualization} from "../mapview/visualization.model";
import {BehaviorSubject, combineLatest, filter, Subject} from "rxjs";
import {ErdblickStyle, StyleService} from "../styledata/style.service";
import {Feature, HighlightMode, TileLayerParser, Viewport} from '../../build/libs/core/erdblick-core';
import {AppStateService, LayerViewConfig, TileFeatureId} from "../shared/appstate.service";
import {SidePanelService, SidePanelState} from "../shared/sidepanel.service";
import {InfoMessageService} from "../shared/info.service";
import {MAX_ZOOM_LEVEL} from "../search/feature.search.service";
import {PointMergeService} from "../mapview/pointmerge.service";
import {KeyboardService} from "../shared/keyboard.service";
import * as uuid from 'uuid';
import {GroupTreeNode, MapInfoItem, MapLayerTree, MapTreeNode} from "./map.model";

const infoUrl = "sources";
const tileUrl = "tiles";
const abortUrl = "abort";

/**
 * Determine if two lists of feature wrappers have the same features.
 */
function featureSetsEqual(rhs: FeatureWrapper[], lhs: FeatureWrapper[]) {
    return rhs.length === lhs.length && rhs.every(rf => lhs.some(lf => rf.equals(lf)));
}

const DEFAULT_VIEWPORT: Viewport = {
    south: .0,
    west: .0,
    width: .0,
    height: .0,
    camPosLon: .0,
    camPosLat: .0,
    orientation: .0
}

class ViewVisualizationState {
    viewport: Viewport = DEFAULT_VIEWPORT;
    visibleTileIds: Set<bigint> = new Set();
    highDetailTileIds: Set<bigint> = new Set();
    visualizedTileLayers: Map<string, TileVisualization[]> = new Map();
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
export class MapDataService {

    public maps: BehaviorSubject<MapLayerTree> = new BehaviorSubject<MapLayerTree>(new MapLayerTree([], this.stateService));

    public loadedTileLayers: Map<string, FeatureTile>;
    public legalInformationPerMap = new Map<string, Set<string>>();
    public legalInformationUpdated = new Subject<boolean>();
    private currentFetch: Fetch | null = null;
    private currentFetchAbort: Fetch | null = null;
    private currentFetchId: number = 0;
    private tileStreamParsingQueue: any[];
    private tileVisualizationQueue: [string, TileVisualization][];
    private selectionVisualizations: TileVisualization[];
    private hoverVisualizations: TileVisualization[];
    private viewVisualizationState: ViewVisualizationState[] = [];

    tileParser: TileLayerParser | null = null;
    tileVisualizationTopic: Subject<any>;
    tileVisualizationDestructionTopic: Subject<any>;
    moveToWgs84PositionTopic: Subject<{ targetView: number, x: number, y: number, z?: number }>;
    hoverTopic: BehaviorSubject<Array<FeatureWrapper>> = new BehaviorSubject<Array<FeatureWrapper>>([]);

    /**
     * When true, clearing the selection does not reset the side panel state.
     * This is used when removing selections due to layer deactivation.
     */
    private preserveSidePanel: boolean = false;

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
        this.currentFetch = null;
        this.tileStreamParsingQueue = [];
        this.tileVisualizationQueue = [];
        this.selectionVisualizations = [];
        this.hoverVisualizations = [];
        this.viewVisualizationState = [];

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

        // Initial call to processTileStream: will keep calling itself
        this.processTileStream();
        this.processVisualizationTasks();

        this.styleService.styleRemovedForId.subscribe(styleId => {
            this.tileVisualizationQueue = [];
            this.viewVisualizationState.forEach(state => {
                state.visualizedTileLayers.get(styleId)?.forEach(tileVisu =>
                    this.tileVisualizationDestructionTopic.next(tileVisu)
                );
                state.visualizedTileLayers.delete(styleId);
            });
        });
        this.styleService.styleAddedForId.subscribe(styleId => {
            this.viewVisualizationState.forEach((state, viewIndex) => {
                state.visualizedTileLayers.set(styleId, []);
                for (let [_, tileLayer] of this.loadedTileLayers) {
                    this.renderTileLayer(viewIndex, tileLayer, this.styleService.styles.get(styleId)!, styleId);
                }
            });
        });

        await this.reloadDataSources();

        this.stateService.selectedFeaturesState.subscribe(selected => {
            this.highlightFeatures(selected).then();
        });
        this.stateService.selectionTopicState.subscribe(selectedFeatureWrappers => {
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
                uint8ArrayToWasm((wasmBuffer: any) => {
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
        await new Fetch(infoUrl)
            .withBufferCallback((infoBuffer: any) => {
                uint8ArrayToWasm((wasmBuffer: any) => {
                    this.tileParser!.setDataSourceInfo(wasmBuffer);
                    console.log("Loaded data source info.");
                }, infoBuffer);
            })
            .withJsonCallback((result: Array<MapInfoItem>) => {
                let maps = result.filter(m => !m.addOn).map(mapInfo => mapInfo);
                this.maps.next(new MapLayerTree(maps, this.stateService));
            })
            .go();
    }

    async update() {
        let tileIdPerLevel = new Map<number, Array<bigint>>();
        const loadLimit = this.stateService.tilesLoadLimitState.getValue() / this.viewVisualizationState.length;
        const visualizeLimit = this.stateService.tilesVisualizeLimitState.getValue() / this.viewVisualizationState.length;

        // Get the tile IDs for the current viewport.
        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            this.viewVisualizationState[viewIndex].visibleTileIds = new Set<bigint>();
            this.viewVisualizationState[viewIndex].highDetailTileIds = new Set<bigint>();
            for (let level of this.maps.getValue().allLevels(viewIndex)) {
                // Map from level to array of tileIds.
                if (!tileIdPerLevel.has(level)) {
                    const allViewportTileIds = coreLib.getTileIds(
                        this.viewVisualizationState[viewIndex].viewport,
                        level,
                        loadLimit) as bigint[];

                    tileIdPerLevel.set(level, allViewportTileIds);
                    this.viewVisualizationState[viewIndex].visibleTileIds = new Set([
                        ...this.viewVisualizationState[viewIndex].visibleTileIds,
                        ...new Set<bigint>(allViewportTileIds)
                    ]);
                    this.viewVisualizationState[viewIndex].highDetailTileIds = new Set([
                        ...this.viewVisualizationState[viewIndex].highDetailTileIds,
                        ...new Set<bigint>(
                            allViewportTileIds.slice(0, visualizeLimit))
                    ]);
                }
            }
        }

        // Evict present non-required tile layers.
        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            let newTileLayers = new Map();
            let evictTileLayer = (tileLayer: FeatureTile) => {
                return !tileLayer.preventCulling && !this.stateService.selectionTopicState.getValue().some(v =>
                        v.featureTile.mapTileKey == tileLayer.mapTileKey) &&
                    (!this.viewVisualizationState[viewIndex].visibleTileIds.has(tileLayer.tileId) ||
                        !this.maps.getValue().getMapLayerVisibility(viewIndex, tileLayer.mapName, tileLayer.layerName) ||
                        tileLayer.level() != this.maps.getValue().getMapLayerLevel(viewIndex, tileLayer.mapName, tileLayer.layerName))
            }
            for (let tileLayer of this.loadedTileLayers.values()) {
                if (evictTileLayer(tileLayer)) {
                    tileLayer.destroy();
                } else {
                    newTileLayers.set(tileLayer.mapTileKey, tileLayer);
                }
            }
            this.loadedTileLayers = newTileLayers;
        }

        // Update visualizations.
        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            for (const styleId of this.viewVisualizationState[viewIndex].visualizedTileLayers.keys()) {
                const tileVisus = this.viewVisualizationState[viewIndex].visualizedTileLayers
                    .get(styleId)?.filter(tileVisu => {
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
                    tileVisu.showTileBorder = this.maps.getValue().getMapLayerBorderState(viewIndex, mapName, layerName);
                    tileVisu.isHighDetail = this.viewVisualizationState[viewIndex].highDetailTileIds
                        .has(tileVisu.tile.tileId) || tileVisu.tile.preventCulling;
                    return true;
                });
                if (tileVisus && tileVisus.length) {
                    this.viewVisualizationState[viewIndex].visualizedTileLayers.set(styleId, tileVisus);
                } else {
                    this.viewVisualizationState[viewIndex].visualizedTileLayers.delete(styleId);
                }
            }
        }

        // Update Tile Visualization Queue.
        this.tileVisualizationQueue = [];
        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            for (const [styleId, tileVisus] of this.viewVisualizationState[viewIndex].visualizedTileLayers) {
                tileVisus.forEach(tileVisu => {
                    if (tileVisu.isDirty()) {
                        this.tileVisualizationQueue.push([styleId, tileVisu]);
                    }
                });
            }
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
            const mapLayerItem = this.maps.getValue().maps
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

        for (const [mapName, map] of this.maps.getValue().maps) {
            for (const [layerName, _] of map.layers) {
                for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
                    if (!this.maps.getValue().getMapLayerVisibility(viewIndex, mapName, layerName)) {
                        continue;
                    }

                    // Find tile IDs which are not yet loaded for this map layer combination.
                    let requestTilesForMapLayer = []
                    let level = this.maps.getValue().getMapLayerLevel(viewIndex, mapName, layerName);
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
            this.viewVisualizationState.forEach((state) => {
                if (!state.visibleTileIds.has(tileLayer.tileId))
                    return;
            });
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
            for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
                if (style && styleId) {
                    this.renderTileLayer(viewIndex, tileLayer, style, styleId);
                } else {
                    this.styleService.styles.forEach((style, styleId) => {
                        this.renderTileLayer(viewIndex, tileLayer, style, styleId);
                    });
                }
            }
        });
    }

    private removeTileLayer(tileLayer: FeatureTile) {
        tileLayer.destroy();
        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            for (const styleId of this.viewVisualizationState[viewIndex].visualizedTileLayers.keys()) {
                const tileVisus = this.viewVisualizationState[viewIndex].visualizedTileLayers
                    .get(styleId)?.filter(tileVisu => {
                    if (tileVisu.tile.mapTileKey === tileLayer.mapTileKey) {
                        this.tileVisualizationDestructionTopic.next(tileVisu);
                        return false;
                    }
                    return true;
                });
                if (tileVisus !== undefined && tileVisus.length) {
                    this.viewVisualizationState[viewIndex].visualizedTileLayers.set(styleId, tileVisus);
                } else {
                    this.viewVisualizationState[viewIndex].visualizedTileLayers.delete(styleId);
                }
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
            tileLayer.preventCulling ||  this.viewVisualizationState[viewIndex].highDetailTileIds.has(tileLayer.tileId),
            coreLib.HighlightMode.NO_HIGHLIGHT,
            [],
            this.maps.getValue().getMapLayerBorderState(viewIndex, mapName, layerName),
            style.params !== undefined ? style.params.options : {});
        this.tileVisualizationQueue.push([styleId, visu]);
        if (this.viewVisualizationState[viewIndex].visualizedTileLayers.has(styleId)) {
            this.viewVisualizationState[viewIndex].visualizedTileLayers.get(styleId)?.push(visu);
        } else {
            this.viewVisualizationState[viewIndex].visualizedTileLayers.set(styleId, [visu]);
        }
    }

    setViewport(viewIndex: number, viewport: Viewport) {
        while (this.viewVisualizationState.length <= viewIndex) {
            this.viewVisualizationState.push(new ViewVisualizationState());
        }
        this.viewVisualizationState[viewIndex].viewport = viewport;
        this.setTileLevelForViewport(viewIndex);
        this.update().then();
    }

    getPrioritisedTiles(viewIndex: number) {
        let tiles = new Array<[number, FeatureTile]>();
        for (const [_, tile] of this.loadedTileLayers) {
            tiles.push([coreLib.getTilePriorityById(this.viewVisualizationState[viewIndex].viewport, tile.tileId), tile]);
        }
        tiles.sort((a, b) => b[0] - a[0]);
        return tiles.map(val => val[1]);
    }

    getFeatureTile(tileKey: string): FeatureTile | null {
        return this.loadedTileLayers.get(tileKey) || null;
    }

    async loadTiles(tileKeys: Set<string | null>): Promise<Map<string, FeatureTile>> {
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

            this.update().then();
            tile = await selectionTilePromise;
            result.set(tileKey, tile);
        }

        return result;
    }

    async highlightFeatures(tileFeatureIds: [number, (TileFeatureId | null | string)][],
                            focus: boolean = false, mode: HighlightMode = coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
        // Load the tiles for the selection.
        const tiles = await this.loadTiles(new Set(tileFeatureIds.filter(s =>
            s[1] && typeof s[1] !== "string"
            ).map(s =>
                (s[1] as TileFeatureId).mapTileKey
            )
        ));

        // Ensure that the feature really exists in the tile.
        let features = new Array<FeatureWrapper>();
        for (let el of tileFeatureIds) {
            const id = el[1];
            if (typeof id == "string") {
                // When clicking on geometry that represents a highlight,
                // this is reflected in the feature id. By processing this
                // info here, a hover highlight can be turned into a selection.
                if (id == "hover-highlight") {
                    features = this.hoverTopic.getValue();
                } else if (id == "selection-highlight") {
                    features = this.stateService.selectionTopicState.getValue();
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
                if (featureSetsEqual(this.stateService.selectionTopicState.getValue(), features)) {
                    return;
                }
            }
            if (featureSetsEqual(this.hoverTopic.getValue(), features)) {
                return;
            }
            this.hoverTopic.next(features);
        } else if (mode == coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
            if (featureSetsEqual(this.stateService.selectionTopicState.getValue(), features)) {
                return;
            }
            if (featureSetsEqual(this.hoverTopic.getValue(), features)) {
                this.hoverTopic.next([]);
            }
            this.stateService.selectionTopicState.next(features);
        } else {
            console.error(`Unsupported highlight mode!`);
        }

        // TODO: Focus on bounding box of all features?
        // NOTE: Currently only focuses on the first feature. Should calculate bounding box
        // of all selected features and focus on that area for better UX when multiple features are selected.
        if (focus && features.length) {
            this.focusOnFeature(tileFeatureIds[0][0], features[0]);
        }
    }

    focusOnFeature(viewIndex: number, feature: FeatureWrapper) {
        const position = feature.peek((parsedFeature: Feature) => parsedFeature.center());
        this.moveToWgs84PositionTopic.next({targetView: viewIndex, x: position.x, y: position.y});
    }

    setTileLevelForViewport(viewIndex: number) {
        // Validate viewport data
        if (this.viewVisualizationState.length <= viewIndex || !this.viewVisualizationState[viewIndex].viewport ||
            !isFinite(this.viewVisualizationState[viewIndex].viewport.south) ||
            !isFinite(this.viewVisualizationState[viewIndex].viewport.west) ||
            !isFinite(this.viewVisualizationState[viewIndex].viewport.width) ||
            !isFinite(this.viewVisualizationState[viewIndex].viewport.height) ||
            !isFinite(this.viewVisualizationState[viewIndex].viewport.camPosLon) ||
            !isFinite(this.viewVisualizationState[viewIndex].viewport.camPosLat)) {
            console.error('Invalid viewport data in setTileLevelForViewport:', this.viewVisualizationState);
            return;
        }

        try {
            for (const level of [...Array(MAX_ZOOM_LEVEL + 1).keys()]) {
                const numTileIds = coreLib.getNumTileIds(this.viewVisualizationState[viewIndex].viewport, level);

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

    *tileLayersForTileId(tileId: bigint): Generator<FeatureTile> {
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
        for (let viewIndex = 0; viewIndex < this.viewVisualizationState.length; viewIndex++) {
            for (const [styleId, tileVisualizations] of this.viewVisualizationState[viewIndex].visualizedTileLayers) {
                tileVisualizations.forEach(tileVisu => {
                    try {
                        tileVisu.destroy(viewer);
                    } catch (error) {
                        console.warn('Error destroying tile visualization:', error);
                    }
                });
            }
            this.viewVisualizationState[viewIndex].visualizedTileLayers.clear();
            this.tileVisualizationQueue = [];
        }
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

    toggleMapLayerVisibility(viewIndex: number, mapId: string, layerId: string = "",
                             state: boolean | undefined = undefined, deferUpdate: boolean = false) {
        this.maps.getValue().toggleMapLayerVisibility(viewIndex, mapId, layerId, state, deferUpdate);
        if (!deferUpdate) {
            this.update().then();
        }
    }

    toggleLayerTileBorderVisibility(viewIndex: number, mapId: string, layerId: string) {
        this.maps.getValue().toggleLayerTileBorderVisibility(viewIndex, mapId, layerId);
        this.update().then();
    }

    setMapLayerLevel(viewIndex: number, mapId: string, layerId: string, level: number) {
        this.maps.getValue().setMapLayerLevel(viewIndex, mapId, layerId, level);
        this.update().then();
    }
}
