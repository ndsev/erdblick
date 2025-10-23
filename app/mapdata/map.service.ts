import {Injectable} from "@angular/core";
import {Fetch} from "./fetch";
import {FeatureTile, FeatureWrapper} from "./features.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {TileVisualization} from "../mapview/visualization.model";
import {BehaviorSubject, Subject} from "rxjs";
import {ErdblickStyle, StyleService} from "../styledata/style.service";
import {Feature, HighlightMode, TileLayerParser, Viewport} from '../../build/libs/core/erdblick-core';
import {AppStateService, InspectionPanelModel, TileFeatureId} from "../shared/appstate.service";
import {SidePanelService, SidePanelState} from "../shared/sidepanel.service";
import {InfoMessageService} from "../shared/info.service";
import {MAX_ZOOM_LEVEL} from "../search/feature.search.service";
import {MergedPointsTile, PointMergeService} from "../mapview/pointmerge.service";
import {KeyboardService} from "../shared/keyboard.service";
import * as uuid from 'uuid';
import {MapInfoItem, MapLayerTree, StyleOptionNode} from "./map.tree.model";
import {Cartesian3, Viewer} from "../integrations/cesium";

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
    visualizationQueue: TileVisualization[] = [];
}

export interface SelectedFeatures {
    viewIndex: number;
    features: FeatureWrapper[];
}

/**
 * Erdblick map service class. This class is responsible for keeping track
 * of the following objects:
 *  (1) available maps
 *  (2) currently loaded tiles
 *  (3) rendered visualizations per view and affine style sheets.
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
    private selectionVisualizations: TileVisualization[];
    private hoverVisualizations: TileVisualization[];
    private viewVisualizationState: ViewVisualizationState[] = [];
    private GeometryType?: typeof coreLib.GeomType;

    tileParser: TileLayerParser | null = null;
    tileVisualizationTopic: Subject<TileVisualization>;
    tileVisualizationDestructionTopic: Subject<TileVisualization>;
    mergedTileVisualizationDestructionTopic: Subject<MergedPointsTile>;
    moveToWgs84PositionTopic: Subject<{ targetView: number, x: number, y: number, z?: number }>;
    originAndNormalForFeatureZoomTopic: Subject<{ targetView: number, origin: Cartesian3, normal: Cartesian3}> = new Subject();
    hoverTopic = new BehaviorSubject<FeatureWrapper[]>([]);
    selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
    styleOptionChangedTopic: Subject<[StyleOptionNode, number]> = new Subject<[StyleOptionNode, number]>();

    maps$: BehaviorSubject<MapLayerTree> = new BehaviorSubject<MapLayerTree>(new MapLayerTree([], this.selectionTopic, this.stateService, this.styleService));
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
        this.selectionVisualizations = [];
        this.hoverVisualizations = [];
        this.viewVisualizationState = [];

        // Triggered when a tile layer is freshly rendered and should be added to the frontend.
        this.tileVisualizationTopic = new Subject<TileVisualization>();

        // Triggered when a tile layer is being removed.
        this.tileVisualizationDestructionTopic = new Subject<TileVisualization>();
        this.mergedTileVisualizationDestructionTopic = new Subject<MergedPointsTile>();

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
        this.GeometryType = coreLib.GeomType;

        // Instantiate the TileLayerParser.
        this.tileParser = new coreLib.TileLayerParser();

        // Initial call to processTileStream: will keep calling itself
        this.processTileStream();
        this.processVisualizationTasks();

        this.styleService.styleRemovedForId.subscribe(styleId => {
            this.viewVisualizationState.forEach(state => {
                state.visualizationQueue = [];
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
        this.styleOptionChangedTopic.subscribe(([optionNode, viewIndex]) => {
            if (viewIndex >= this.viewVisualizationState.length) {
                return;
            }

            const viewState = this.viewVisualizationState[viewIndex];
            const visualizationsForStyle = viewState.visualizedTileLayers.get(optionNode.styleId);
            if (!visualizationsForStyle) {
                return;
            }
            // Get rid of all merged point tiles for the view+map+layer+style.
            const mapViewLayerStyleId = this.pointMergeService.makeMapViewLayerStyleId(
                viewIndex,
                optionNode.mapId,
                optionNode.layerId,
                optionNode.styleId,
                coreLib.HighlightMode.NO_HIGHLIGHT);
            for (const removedMergedPointsTile of this.pointMergeService.clear(mapViewLayerStyleId)) {
                this.mergedTileVisualizationDestructionTopic.next(removedMergedPointsTile);
            }
            // Remove all currently queued visualizations for the map+layer+style which changed.
            viewState.visualizationQueue = viewState.visualizationQueue.filter(visu => {
                return visu.styleId !== optionNode.styleId || visu.tile.mapName !== optionNode.mapId || visu.tile.layerName !== optionNode.layerId;
            });
            // Redraw all visualizations for the map+layer+style.
            for (const visu of visualizationsForStyle) {
                console.assert(
                    visu.viewIndex === viewIndex,
                    `The viewIndex of the visualization must correspond to its visualization collection index. Expected ${viewIndex}, got ${visu.viewIndex}.`);
                if (visu.tile.mapName === optionNode.mapId && visu.tile.layerName === optionNode.layerId) {
                    visu.setStyleOption(optionNode.id, optionNode.value[viewIndex]);
                    viewState.visualizationQueue.unshift(visu);
                }
            }
        })

        await this.reloadDataSources();

        this.stateService.getSelectedFeaturesObservable().subscribe(async selected => {
            const convertedSelections: InspectionPanelModel<FeatureWrapper>[] = [];
            for (const selection of selected) {
                convertedSelections.push({
                    id: selection.id,
                    pinned: selection.pinned,
                    size: selection.size,
                    selectedFeatures: await this.loadFeatures(selection.selectedFeatures),
                    selectedSourceData: selection.selectedSourceData
                });
            }
            this.selectionTopic.next(convertedSelections);
        });
        this.selectionTopic.subscribe(selectedPanels => {
            // TODO: Consider only visualizing updated selections/features and not the whole set of the panels
            const selectedFeatures = selectedPanels.map(panel => panel.selectedFeatures).flat();
            this.visualizeHighlights(coreLib.HighlightMode.SELECTION_HIGHLIGHT, selectedFeatures);
            // If a hovered feature is selected, eliminate it from the hover highlights.
            const hoveredFeatures = this.hoverTopic.getValue();
            if (hoveredFeatures.length) {
                this.hoverTopic.next(hoveredFeatures.filter(hoveredFeature =>
                    !selectedFeatures.some(selectedFeature => selectedFeature.equals(hoveredFeature))
                ));
            }
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
        let currentQueueLength = this.viewVisualizationState.reduce(
            (sum, state) => sum + state.visualizationQueue.length,
            0
        );

        let nextViewIndexToProcess = 0;
        while (currentQueueLength > 0) {
            // Check if the time budget is exceeded.
            if (Date.now() - startTime > timeBudget) {
                break;
            }

            const viewState = this.viewVisualizationState[nextViewIndexToProcess];
            const entry = viewState.visualizationQueue.shift();
            if (entry !== undefined) {
                this.tileVisualizationTopic.next(entry);
                currentQueueLength--;
            }
            nextViewIndexToProcess++;
            nextViewIndexToProcess %= this.viewVisualizationState.length;
        }

        // Continue visualizing tiles with a delay.
        const delay = currentQueueLength ? 0 : 10;
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
                this.maps$.next(new MapLayerTree(maps, this.selectionTopic, this.stateService, this.styleService));
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
                v.selectedFeatures.some(feature => feature.featureTile.mapTileKey == tileLayer.mapTileKey))) {
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
                        styleEnabled = this.styleService.styles.get(styleId)!.visible;
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
        this.viewVisualizationState.forEach((state, viewIndex) => {
            state.visualizationQueue = [];
            // Schedule updates for visualizations which have changed (high-detail, border etc.)
            const visualizedTileLayers: Map<string, Set<string>> = new Map();
            state.visualizedTileLayers.forEach((tileVisus, styleId) => {
                tileVisus.forEach(tileVisu => {
                    if (tileVisu.isDirty()) {
                        state.visualizationQueue.push(tileVisu);
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
                    if (style.visible && style.featureLayerStyle?.hasLayerAffinity(tileLayer.layerName)) {
                        this.renderTileLayer(viewIndex, tileLayer, style);
                    }
                } else {
                    // TODO: Don't render for each style anymore.
                    //   (render if style is active and relevant for map layer...)
                    this.styleService.styles.forEach((style) => {
                        if (style.visible && style.featureLayerStyle?.hasLayerAffinity(tileLayer.layerName)) {
                            this.renderTileLayer(viewIndex, tileLayer, style);
                        }
                    });
                }
            }
        });
    }

    private removeTileLayer(tileLayer: FeatureTile) {
        tileLayer.destroy();
        for (const viewState of this.viewVisualizationState) {
            for (let [styleId, tileVisus] of viewState.visualizedTileLayers) {
                tileVisus = tileVisus.filter(tileVisu => {
                    if (tileVisu.tile.mapTileKey === tileLayer.mapTileKey) {
                        this.tileVisualizationDestructionTopic.next(tileVisu);
                        return false;
                    }
                    return true;
                });
                if (tileVisus.length) {
                    viewState.visualizedTileLayers.set(styleId, tileVisus);
                } else {
                    viewState.visualizedTileLayers.delete(styleId);
                }
            }
            viewState.visualizationQueue = viewState.visualizationQueue.filter(tileVisu => {
                return tileVisu.tile.mapTileKey !== tileLayer.mapTileKey;
            });
        }
        this.loadedTileLayers.delete(tileLayer.mapTileKey);
        this.statsDialogNeedsUpdate.next();
    }

    private renderTileLayer(viewIndex: number, tileLayer: FeatureTile, style: ErdblickStyle) {
        const wasmStyle = style.featureLayerStyle;
        if (!wasmStyle) {
            return;
        }
        if (!style.visible) {
            return;
        }

        const styleId = style.id;
        const mapName = tileLayer.mapName;
        const layerName = tileLayer.layerName;
        const viewState = this.viewVisualizationState[viewIndex];
        let visu = new TileVisualization(
            viewIndex,
            tileLayer,
            this.pointMergeService,
            (tileKey: string) => this.getFeatureTile(tileKey),
            wasmStyle,
            tileLayer.preventCulling || viewState.highDetailTileIds.has(tileLayer.tileId),
            coreLib.HighlightMode.NO_HIGHLIGHT,
            [],
            this.maps.getMapLayerBorderState(viewIndex, mapName, layerName),
            this.maps.getLayerStyleOptions(viewIndex, mapName, layerName, styleId));
        viewState.visualizationQueue.push(visu);
        if (viewState.visualizedTileLayers.has(styleId)) {
            viewState.visualizedTileLayers.get(styleId)?.push(visu);
        } else {
            viewState.visualizedTileLayers.set(styleId, [visu]);
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

    async loadFeatures(tileFeatureIds: (TileFeatureId | null | string)[]): Promise<FeatureWrapper[]> {
        // Load the tiles.
        const tiles = await this.loadTiles(new Set(tileFeatureIds.filter(s =>
                s && typeof s !== "string"
            ).map(s =>
                (s as TileFeatureId).mapTileKey
            )
        ));

        // Ensure that the feature really exists in the tile.
        const features: FeatureWrapper[] = [];
        for (const id of tileFeatureIds) {
            if (typeof id === "string") {
                // When clicking on geometry that represents a highlight,
                // this is reflected in the feature id. By processing this
                // info here, a hover highlight can be turned into a selection.
                if (id === "hover-highlight") {
                    return this.hoverTopic.getValue();
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
        return features;
    }

    async setHoveredFeatures(tileFeatureIds: (TileFeatureId | null | string)[]) {
        const features = await this.loadFeatures(tileFeatureIds);
        if (!features.length) {
            this.hoverTopic.next(features);
            return;
        }

        const selectedFeatures = this.selectionTopic.getValue().map(panel => {
            return panel.selectedFeatures;
        }).flat();
        // TODO: Use a set difference?
        if (featureSetsEqual(selectedFeatures, features) || featureSetsEqual(this.hoverTopic.getValue(), features)) {
            return;
        }
        this.hoverTopic.next(features);
    }

    focusOnFeature(viewIndex: number, feature: FeatureWrapper) {
        const position = feature.peek((parsedFeature: Feature) => parsedFeature.center());
        this.moveToWgs84PositionTopic.next({targetView: viewIndex, x: position.x, y: position.y});
    }

    zoomToFeature(viewIndex: number, featureWrapper: FeatureWrapper) {
        featureWrapper.peek((feature: Feature) => {
            const center = feature.center() as Cartesian3;
            const centerCartesian = Cartesian3.fromDegrees(center.x, center.y, center.z);
            let radiusPoint = feature.boundingRadiusEndPoint() as Cartesian3;
            radiusPoint = Cartesian3.fromDegrees(radiusPoint.x, radiusPoint.y, radiusPoint.z);
            const boundingRadius = Cartesian3.distance(centerCartesian, radiusPoint);
            const geometryType = feature.getGeometryType() as any;

            if (geometryType === this.GeometryType?.Mesh) {
                // Get the first triangle from the mesh, and calculate the
                // camera perspective from its normal.
                // TODO: Use a more efficient WASM function like feature.firstTriangle() to get the first triangle.
                const inspectionModel = feature.inspectionModel()
                let triangle: Array<Cartesian3> = [];
                if (this) {
                    for (const section of inspectionModel) {
                        if (section.key == "Geometry") {
                            for (let i = 0; i < 3; i++) {
                                const cartographic = section.children[0].children[i].value.map((coordinate: string) => Number(coordinate));
                                if (cartographic.length == 3) {
                                    triangle.push(Cartesian3.fromDegrees(cartographic[0], cartographic[1], cartographic[2]));
                                }
                            }
                            break;
                        }
                    }
                }
                const normal = Cartesian3.cross(
                    Cartesian3.subtract(triangle[1], triangle[0], new Cartesian3()),
                    Cartesian3.subtract(triangle[2], triangle[0], new Cartesian3()),
                    new Cartesian3()
                );
                Cartesian3.negate(normal, normal);
                Cartesian3.normalize(normal, normal);
                Cartesian3.multiplyByScalar(normal, 3 * boundingRadius, normal);
                this.originAndNormalForFeatureZoomTopic.next({
                    targetView: viewIndex,
                    origin: centerCartesian,
                    normal: normal
                });
            }

            // Fallback for lines/points: Just move the camera to the position.
            this.moveToWgs84PositionTopic.next({
                targetView: viewIndex,
                x: center.x,
                y: center.y,
                // TODO: Calculate height using faux Cesium camera with target view rectangle.
                z: center.z + 3 * boundingRadius
            });
        })
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
        const featureWrappersForTile = new Map<FeatureTile, FeatureWrapper[]>();
        for (const wrapper of featureWrappers) {
            if (!featureWrappersForTile.has(wrapper.featureTile)) {
                featureWrappersForTile.set(wrapper.featureTile, []);
            }
            featureWrappersForTile.get(wrapper.featureTile)!.push(wrapper);
        }

        for (const [featureTile, features] of featureWrappersForTile) {
            const featureIds = features.map(fw => fw.featureId);
            for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                // Do not render the highlight for any view that doesn't need it.
                if (!this.viewNeedsFeatureTile(viewIndex, featureTile)) {
                    continue;
                }

                for (let [_, style] of this.styleService.styles) {
                    if (style.featureLayerStyle && style.visible && style.featureLayerStyle.hasLayerAffinity(featureTile.layerName)) {
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
                            this.maps.getLayerStyleOptions(viewIndex, featureTile.mapName, featureTile.layerName, style.id));
                        this.tileVisualizationTopic.next(visu);
                        visualizationCollection.push(visu);
                    }
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
    clearAllTileVisualizations(viewIndex: number, viewer: Viewer): void {
        if (viewIndex >= this.stateService.numViews) {
            return;
        }
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
        this.viewVisualizationState[viewIndex].visualizationQueue = [];
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

    /**
     * Returns an internal layerId for a human-readable layer name.
     *
     * @param layerName Layer id to get the name for
     */
    sourceDataLayerIdForLayerName(layerName: string) {
        for (const [_, mapInfo] of this.maps.maps.entries()) {
            for (const [_, layerInfo] of mapInfo.layers.entries()) {
                if (layerInfo.type == "SourceData") {
                    if (this.layerNameForSourceDataLayerId(layerInfo.id) == layerName ||
                        this.layerNameForSourceDataLayerId(layerInfo.id) == layerName.replace('-', '.') ||
                        layerInfo.id == layerName) {
                        return layerInfo.id;
                    }
                }
            }
        }
        return null;
    }

    findLayersForMapId(mapId: string, isMetadata: boolean = false) {
        const map = this.maps.maps.get(mapId);
        if (map) {
            const prefix = isMetadata ? "Metadata" : "SourceData";
            const dataLayers = new Set<string>();
            for (const layer of map.layers.values()) {
                if (layer.type === "SourceData" && layer.id.startsWith(prefix)) {
                    dataLayers.add(layer.id);
                }
            }
            return [...dataLayers].map(layerId => ({
                id: layerId,
                name: this.layerNameForSourceDataLayerId(layerId, isMetadata)
            })).sort((a, b) => a.name.localeCompare(b.name));
        }
        return [];
    }

    /**
     * Returns a human-readable layer name for a layer id.
     *
     * @param layerId Layer id to get the name for
     * @param isMetadata Matches the metadata SourceDataLayers
     */
    layerNameForSourceDataLayerId(layerId: string, isMetadata: boolean = false) {
        const match = isMetadata ?
            layerId.match(/^Metadata-(.+)-(.+)/) :
            layerId.match(/^SourceData-(.+\.)([^.]+)/);
        if (!match) {
            return layerId;
        }
        return `${match[2]}`.replace('-', '.');
    }
}
