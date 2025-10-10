import {Injectable} from "@angular/core";
import {Fetch} from "./fetch";
import {FeatureTile, FeatureWrapper} from "./features.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {TileVisualization} from "../mapview/visualization.model";
import {BehaviorSubject, Subject} from "rxjs";
import {ErdblickStyle, StyleService} from "../styledata/style.service";
import {Feature, HighlightMode, TileLayerParser, Viewport} from '../../build/libs/core/erdblick-core';
import {AppStateService, TileFeatureId} from "../shared/appstate.service";
import {SidePanelService, SidePanelState} from "../shared/sidepanel.service";
import {InfoMessageService} from "../shared/info.service";
import {MAX_ZOOM_LEVEL} from "../search/feature.search.service";
import {PointMergeService} from "../mapview/pointmerge.service";
import {KeyboardService} from "../shared/keyboard.service";
import * as uuid from 'uuid';
import {MapInfoItem, MapLayerTree} from "./map.tree.model";

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

    public loadedTileLayers: Map<string, FeatureTile>;
    public legalInformationPerMap = new Map<string, Set<string>>();
    public legalInformationUpdated = new Subject<boolean>();
    private currentFetch: Fetch | null = null;
    private currentFetchAbort: Fetch | null = null;
    private currentFetchId: number = 0;
    private tileStreamParsingQueue: [Uint8Array, number][];
    private tileVisualizationQueue: TileVisualization[];
    private selectionVisualizations: TileVisualization[];
    private hoverVisualizations: TileVisualization[];
    private viewVisualizationState: ViewVisualizationState[] = [];

    tileParser: TileLayerParser | null = null;
    tileVisualizationTopic: Subject<TileVisualization>;
    tileVisualizationDestructionTopic: Subject<TileVisualization>;
    moveToWgs84PositionTopic: Subject<{ targetView: number, x: number, y: number, z?: number }>;
    hoverTopic: BehaviorSubject<Array<FeatureWrapper>> = new BehaviorSubject<Array<FeatureWrapper>>([]);
    selectionTopic: BehaviorSubject<Array<FeatureWrapper>> = new BehaviorSubject<Array<FeatureWrapper>>([]);

    maps$: BehaviorSubject<MapLayerTree> = new BehaviorSubject<MapLayerTree>(new MapLayerTree([], this.selectionTopic, this.stateService));
    get maps() {
        return this.maps$.getValue();
    }

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

        this.stateService.numViewsState.subscribe(numViews => {
            const diff = numViews - this.viewVisualizationState.length;
            if (!diff) {
                return;
            }

            if (diff > 0) {
                this.viewVisualizationState.push(
                    ...Array.from({ length: diff }, () => new ViewVisualizationState())
                );
            } else {
                this.viewVisualizationState.splice(diff);
            }
        });
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
                    const style = this.styleService.styles.get(styleId);
                    if (style) {
                        this.renderTileLayer(viewIndex, tileLayer, style);
                    }
                }
            });
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

    private processTileStream() {
        const startTime = Date.now();
        const timeBudget = 10; // milliseconds

        while (this.tileStreamParsingQueue.length) {
            // Check if the time budget is exceeded.
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            let [message, messageType] = this.tileStreamParsingQueue.shift()!;
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
                this.tileVisualizationTopic.next(entry);
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
                this.maps$.next(new MapLayerTree(maps, this.selectionTopic, this.stateService));
            })
            .go();
    }

    async update() {
        let tileIdPerLevelPerView: Map<number, Array<bigint>>[] = [];
        const loadLimit = this.stateService.tilesLoadLimit / this.stateService.numViews;
        const visualizeLimit = this.stateService.tilesVisualizeLimit / this.stateService.numViews;

        // Get the tile IDs for the current viewport for each view.
        this.viewVisualizationState.forEach((state, viewIndex) => {
            // Map from level to array of tileIds.
            const tileIdPerLevel = new Map<number, Array<bigint>>();
            state.visibleTileIds = new Set<bigint>();
            state.highDetailTileIds = new Set<bigint>();
            for (let level of this.maps.allLevels(viewIndex)) {
                if (tileIdPerLevel.has(level)) {
                    continue;
                }
                const allViewportTileIds = coreLib.getTileIds(state.viewport, level, loadLimit) as bigint[];

                tileIdPerLevel.set(level, allViewportTileIds);
                state.visibleTileIds = new Set([
                    ...state.visibleTileIds,
                    ...new Set<bigint>(allViewportTileIds)
                ]);
                state.highDetailTileIds = new Set([
                    ...state.highDetailTileIds,
                    ...new Set<bigint>(allViewportTileIds.slice(0, visualizeLimit))
                ]);
            }
            tileIdPerLevelPerView.push(tileIdPerLevel);
        });

        // Evict present non-required tile layers.
        const evictTileLayer = (tileLayer: FeatureTile) => {
            // Is the tile needed to visualize the selection?
            if (tileLayer.preventCulling || this.selectionTopic.getValue().some(v =>
                v.featureTile.mapTileKey == tileLayer.mapTileKey)) {
                return false;
            }
            // Is the tile needed for any view?
            return this.viewVisualizationState.every((_, viewIndex) => {
                return !this.viewNeedsFeatureTile(viewIndex, tileLayer);
            });
        }
        let newTileLayers = new Map();
        for (let tileLayer of this.loadedTileLayers.values()) {
            if (evictTileLayer(tileLayer)) {
                tileLayer.destroy();
            } else {
                newTileLayers.set(tileLayer.mapTileKey, tileLayer);
            }
        }
        this.loadedTileLayers = newTileLayers;

        // Update visualizations.
        this.viewVisualizationState.forEach((state, viewIndex) => {
            state.visualizedTileLayers.forEach((value, styleId) => {
                const tileVisus = value.filter(tileVisu => {
                    const mapName = tileVisu.tile.mapName;
                    const layerName = tileVisu.tile.layerName;
                    if (tileVisu.tile.disposed || !this.viewNeedsFeatureTile(viewIndex, tileVisu.tile)) {
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
                    tileVisu.showTileBorder = this.maps.getMapLayerBorderState(viewIndex, mapName, layerName);
                    tileVisu.isHighDetail = state.highDetailTileIds.has(tileVisu.tile.tileId) || tileVisu.tile.preventCulling;
                    return true;
                });
                if (tileVisus && tileVisus.length) {
                    state.visualizedTileLayers.set(styleId, tileVisus);
                } else {
                    state.visualizedTileLayers.delete(styleId);
                }
            });
        });

        // Update Tile Visualization Queue.
        this.tileVisualizationQueue = [];
        this.viewVisualizationState.forEach((state, viewIndex) => {
            // Schedule updates for visualizations which have changed (high-detail, border etc.)
            const visualizedTileLayers: Map<string, Set<string>> = new Map();
            state.visualizedTileLayers.forEach((tileVisus, styleId) => {
                tileVisus.forEach(tileVisu => {
                    if (tileVisu.isDirty()) {
                        this.tileVisualizationQueue.push(tileVisu);
                    }
                    // Take note that this visualization already exists (for step 2).
                    if (!visualizedTileLayers.has(styleId)) {
                        visualizedTileLayers.set(styleId, new Set<string>());
                    }
                    visualizedTileLayers.get(styleId)!.add(tileVisu.tile.mapTileKey);
                });
            });

            // Schedule new visualizations for which the data is already present.
            for (const [styleId, style] of this.styleService.styles) {
                for (let [tileKey, tile] of this.loadedTileLayers) {
                    if (this.viewNeedsFeatureTile(viewIndex, tile) && !visualizedTileLayers.get(styleId)?.has(tileKey)) {
                        this.renderTileLayer(viewIndex, tile, style);
                    }
                }
            }
        });

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
            const mapLayerItem = this.maps.maps
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

        for (const [mapName, map] of this.maps.maps) {
            for (const layer of map.allFeatureLayers()) {
                // Find tile IDs which are not yet loaded for this map layer combination.
                // We keep a set in addition to the array to ensure that no tile ids are
                // requested twice.
                const requestTilesForMapLayer = []
                const requestTilesForMapLayerSet = new Set<bigint>();

                for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                    if (!this.maps.getMapLayerVisibility(viewIndex, mapName, layer.id)) {
                        continue;
                    }
                    let level = this.maps.getMapLayerLevel(viewIndex, mapName, layer.id);
                    let tileIds = tileIdPerLevelPerView[viewIndex].get(level);
                    if (tileIds === undefined) {
                        continue;
                    }
                    for (let tileId of tileIds!) {
                        const tileMapLayerKey = coreLib.getTileFeatureLayerKey(mapName, layer.id, tileId);
                        if (!this.loadedTileLayers.has(tileMapLayerKey) && !requestTilesForMapLayerSet.has(tileId)) {
                            requestTilesForMapLayer.push(Number(tileId)); // TODO: Get rid of type casting after new tile ids are available
                            requestTilesForMapLayerSet.add(tileId);
                        }
                    }
                }

                // Only add a request if there are tiles to be loaded.
                if (requestTilesForMapLayer.length > 0) {
                    requests.push({
                        mapId: mapName,
                        layerId: layer.id,
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
            if (!this.viewVisualizationState.some(state =>
                state.visibleTileIds.has(tileLayer.tileId))) {
                return;
            }
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
            for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                // Do not render the tile for any view that doesn't need it.
                if (!this.viewNeedsFeatureTile(viewIndex, tileLayer)) {
                    continue;
                }

                if (style && styleId) {
                    this.renderTileLayer(viewIndex, tileLayer, style);
                } else {
                    // TODO: Don't render for each style anymore.
                    //   (render if style is active and relevant for map layer...)
                    this.styleService.styles.forEach((style) => {
                        this.renderTileLayer(viewIndex, tileLayer, style);
                    });
                }
            }
        });
    }

    private removeTileLayer(tileLayer: FeatureTile) {
        tileLayer.destroy();
        for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
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
        this.tileVisualizationQueue = this.tileVisualizationQueue.filter(tileVisu => {
            return tileVisu.tile.mapTileKey !== tileLayer.mapTileKey;
        });
        this.loadedTileLayers.delete(tileLayer.mapTileKey);
        this.statsDialogNeedsUpdate.next();
    }

    private renderTileLayer(viewIndex: number, tileLayer: FeatureTile, style: ErdblickStyle) {
        const wasmStyle = style.featureLayerStyle;
        if (!wasmStyle) {
            return;
        }
        if (style.params !== undefined && !style.params.visible) {
            return;
        }

        const styleId = style.id;
        const mapName = tileLayer.mapName;
        const layerName = tileLayer.layerName;
        let visu = new TileVisualization(
            viewIndex,
            tileLayer,
            this.pointMergeService,
            (tileKey: string) => this.getFeatureTile(tileKey),
            wasmStyle,
            tileLayer.preventCulling ||  this.viewVisualizationState[viewIndex].highDetailTileIds.has(tileLayer.tileId),
            coreLib.HighlightMode.NO_HIGHLIGHT,
            [],
            this.maps.getMapLayerBorderState(viewIndex, mapName, layerName),
            style.params !== undefined ? style.params.options : {});
        this.tileVisualizationQueue.push(visu);
        if (this.viewVisualizationState[viewIndex].visualizedTileLayers.has(styleId)) {
            this.viewVisualizationState[viewIndex].visualizedTileLayers.get(styleId)?.push(visu);
        } else {
            this.viewVisualizationState[viewIndex].visualizedTileLayers.set(styleId, [visu]);
        }
    }

    setViewport(viewIndex: number, viewport: Viewport) {
        const maxIndex = this.viewVisualizationState.length - 1;
        if (viewIndex > maxIndex) {
            console.error(`Attempted to write @ viewIndex: ${viewIndex} but it is out of bounds (${maxIndex})`);
            return;
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
            this.focusOnFeature(tileFeatureIds[0][0], features[0]);
        }
    }

    focusOnFeature(viewIndex: number, feature: FeatureWrapper) {
        const position = feature.peek((parsedFeature: Feature) => parsedFeature.center());
        this.moveToWgs84PositionTopic.next({targetView: viewIndex, x: position.x, y: position.y});
    }

    setTileLevelForViewport(viewIndex: number) {
        // Validate viewport data
        if (this.stateService.numViews <= viewIndex || !this.viewVisualizationState[viewIndex].viewport ||
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
            const visualization = visualizationCollection.pop();
            if (visualization) {
                this.tileVisualizationDestructionTopic.next(visualization);
            }
        }
        if (!featureWrappers.length) {
            return;
        }

        // Apply highlight styles.
        // TODO: Don't blindly trust that all selected features share the same tile.
        const featureTile = featureWrappers[0].featureTile;
        const featureIds = featureWrappers.map(fw => fw.featureId);
        for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
            // TODO: Only run the visualization with style sheets that are relevant for the feature.
            // Do not render the highlight for any view that doesn't need it.
            if (!this.viewNeedsFeatureTile(viewIndex, featureTile)) {
                continue;
            }

            for (let [_, style] of this.styleService.styles) {
                if (style.featureLayerStyle && style.params.visible) {
                    let visu = new TileVisualization(
                        viewIndex,
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
    }

    private setLegalInfo(mapName: string, legalInfo: string): void {
        if (this.legalInformationPerMap.has(mapName)) {
            this.legalInformationPerMap.get(mapName)!.add(legalInfo);
        } else {
            this.legalInformationPerMap.set(mapName, new Set<string>().add(legalInfo));
        }
        this.legalInformationUpdated.next(true);
    }

    /**
     * Clean up all tile visualizations - used during viewer recreation
     */
    clearAllTileVisualizations(viewer: any): void {
        for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
            for (const [_, tileVisualizations] of this.viewVisualizationState[viewIndex].visualizedTileLayers) {
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
        this.maps.toggleMapLayerVisibility(viewIndex, mapId, layerId, state, deferUpdate);
        if (!deferUpdate) {
            this.update().then();
        }
    }

    toggleLayerTileBorderVisibility(viewIndex: number, mapId: string, layerId: string) {
        this.maps.toggleLayerTileBorderVisibility(viewIndex, mapId, layerId);
        this.update().then();
    }

    setMapLayerLevel(viewIndex: number, mapId: string, layerId: string, level: number) {
        this.maps.setMapLayerLevel(viewIndex, mapId, layerId, level);
        this.update().then();
    }

    private viewNeedsFeatureTile(viewIndex: number, tile: FeatureTile) {
        if (viewIndex >= this.viewVisualizationState.length) {
            console.error("Attempt to access non-existing view index.");
            return false;
        }
        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState.visibleTileIds.has(tile.tileId)) {
            return false;
        }
        return this.maps.getMapLayerVisibility(viewIndex, tile.mapName, tile.layerName) &&
            tile.level() === this.maps.getMapLayerLevel(viewIndex, tile.mapName, tile.layerName);
    }
}
