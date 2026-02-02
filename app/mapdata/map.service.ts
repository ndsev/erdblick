import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {
    MapTileRequestStatus,
    MapTileStreamClient,
    MAP_TILE_STREAM_HEADER_SIZE,
    MAP_TILE_STREAM_TYPE_FEATURES,
    MAP_TILE_STREAM_TYPE_FIELDS,
    MAP_TILE_STREAM_TYPE_LOAD_STATE,
    MAP_TILE_STREAM_TYPE_SOURCEDATA,
} from "./map-tile-stream-client";
import type {MapTileStreamLoadStatePayload, MapTileStreamStatusPayload, TileLoadState} from "./map-tile-stream-client";
import {FeatureTile, FeatureWrapper} from "./features.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {TileVisualization} from "../mapview/visualization.model";
import {BehaviorSubject, distinctUntilChanged, firstValueFrom, skip, Subject} from "rxjs";
import {ErdblickStyle, StyleService} from "../styledata/style.service";
import {Feature, HighlightMode, TileLayerParser, Viewport} from '../../build/libs/core/erdblick-core';
import {AppStateService, InspectionPanelModel, TileFeatureId, VIEW_SYNC_LAYERS} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {MergedPointsTile, PointMergeService} from "../mapview/pointmerge.service";
import {KeyboardService} from "../shared/keyboard.service";
import {MapInfoItem, MapLayerTree, StyleOptionNode, SyncViewsResult} from "./map.tree.model";
import {Cartesian3, Viewer, Rectangle} from "../integrations/cesium";
import {deepEquals} from "../shared/app-state";

const infoUrl = "sources";
const tileUrl = "tiles";

/**
 * Determine if two lists of feature wrappers have the same features.
 */
function featureSetsEqual(rhs: TileFeatureId[], lhs: TileFeatureId[]) {
    return rhs.length === lhs.length && rhs.every(rf =>
        lhs.some(lf =>
            rf.mapTileKey === lf.mapTileKey && rf.featureId === lf.featureId));
}

function featureSetContains(container: TileFeatureId[], maybeSubset: TileFeatureId[]) {
    if (!maybeSubset.length) {
        return false;
    }
    return maybeSubset.every(candidate => container.some(item =>
        item.mapTileKey === candidate.mapTileKey && item.featureId == candidate.featureId));
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
    visibleTileIdsPerLevel = new Map<number, Array<bigint>>();
    highDetailTileIds: Set<bigint> = new Set();
    visualizationQueue: TileVisualization[] = [];
    private visualizedTileLayers: Map<string, Map<string, TileVisualization>> = new Map();

    getVisualization(styleId: string, tileKey: string): TileVisualization | undefined {
        return this.visualizedTileLayers.get(styleId)?.get(tileKey);
    }

    putVisualization(styleId: string, tileKey: string, visu: TileVisualization) {
        let tileVisus = this.visualizedTileLayers.get(styleId);
        if (!tileVisus) {
            tileVisus = new Map<string, TileVisualization>();
            this.visualizedTileLayers.set(styleId, tileVisus);
        }
        tileVisus.set(tileKey, visu);
    }

    hasVisualizations(styleId: string): boolean {
        return this.visualizedTileLayers.has(styleId);
    }

    *removeVisualizations(styleId?: string, tileKey?: string): Generator<TileVisualization> {
        if (styleId !== undefined) {
            if (tileKey !== undefined) {
                const tileVisus = this.visualizedTileLayers.get(styleId);
                if (!tileVisus) {
                    return;
                }
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                    tileVisus.delete(tileKey);
                }
                if (!tileVisus.size) {
                    this.visualizedTileLayers.delete(styleId);
                }
                return;
            }
            const tileVisus = this.visualizedTileLayers.get(styleId);
            if (tileVisus) {
                for (const visu of tileVisus.values()) {
                    yield visu;
                }
            }
            this.visualizedTileLayers.delete(styleId);
            return;
        }

        if (tileKey !== undefined) {
            const stylesToDelete: string[] = [];
            for (const [style, tileVisus] of this.visualizedTileLayers) {
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                    tileVisus.delete(tileKey);
                }
                if (!tileVisus.size) {
                    stylesToDelete.push(style);
                }
            }
            for (const style of stylesToDelete) {
                this.visualizedTileLayers.delete(style);
            }
            return;
        }

        for (const tileVisus of this.visualizedTileLayers.values()) {
            for (const visu of tileVisus.values()) {
                yield visu;
            }
        }
        this.visualizedTileLayers.clear();
    }

    *getVisualizedStyleIds(): Generator<string> {
        for (const styleId of Array.from(this.visualizedTileLayers.keys())) {
            yield styleId;
        }
    }

    *getVisualizations(styleId?: string, tileKey?: string): Generator<TileVisualization> {
        if (styleId !== undefined) {
            const tileVisus = this.visualizedTileLayers.get(styleId);
            if (!tileVisus) {
                return;
            }
            if (tileKey !== undefined) {
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                }
                return;
            }
            for (const visu of tileVisus.values()) {
                yield visu;
            }
            return;
        }

        if (tileKey !== undefined) {
            for (const tileVisus of this.visualizedTileLayers.values()) {
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                }
            }
            return;
        }

        for (const tileVisus of this.visualizedTileLayers.values()) {
            for (const visu of tileVisus.values()) {
                yield visu;
            }
        }
    }

    recalculateTileIds(loadLimit: number, visualizeLimit: number, levels: Iterable<number>) {
        this.visibleTileIds.clear();
        this.highDetailTileIds.clear();
        this.visibleTileIdsPerLevel.clear();
        for (let level of levels) {
            if (this.visibleTileIdsPerLevel.has(level)) {
                continue;
            }
            const visibleTileIdsForLevel = coreLib.getTileIds(this.viewport, level, loadLimit) as bigint[];
            this.visibleTileIdsPerLevel.set(level, visibleTileIdsForLevel);
            this.visibleTileIds = new Set([
                ...this.visibleTileIds,
                ...new Set<bigint>(visibleTileIdsForLevel)
            ]);
            this.highDetailTileIds = new Set([
                ...this.highDetailTileIds,
                ...new Set<bigint>(visibleTileIdsForLevel.slice(0, visualizeLimit))
            ]);
        }
    }
}

interface SelectionTileRequest {
    remoteRequest: {
        mapId: string,
        layerId: string,
        tileIds: Array<number>
    };
    tileKey: string;
    resolve: null | ((tile: FeatureTile) => void);
    reject: null | ((why: any) => void);
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
    private tilesSocket: MapTileStreamClient | null = null;
    private lastTilesRequestBody: string | null = null;
    private tileStreamParsingQueue: [Uint8Array, number][];
    private selectionVisualizations: TileVisualization[];
    private hoverVisualizations: TileVisualization[];
    private viewVisualizationState: ViewVisualizationState[] = [];
    private GeometryType?: typeof coreLib.GeomType;
    private updateTimer: ReturnType<typeof setTimeout> | null = null;
    private updateInProgress: boolean = false;
    private updatePending: boolean = false;
    private readonly updateDebounceMs: number = 50;
    private lastUpdateAt: number = 0;

    tileParser: TileLayerParser | null = null;
    tileVisualizationTopic: Subject<TileVisualization>;
    tileVisualizationDestructionTopic: Subject<TileVisualization>;
    mergedTileVisualizationDestructionTopic: Subject<MergedPointsTile>;
    moveToWgs84PositionTopic: Subject<{ targetView: number, x: number, y: number, z?: number }>;
    moveToRectangleTopic: Subject<{ targetView: number, rectangle: Rectangle }>;
    originAndNormalForFeatureZoomTopic: Subject<{ targetView: number, origin: Cartesian3, normal: Cartesian3}> = new Subject();
    hoverTopic = new BehaviorSubject<FeatureWrapper[]>([]);
    selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
    styleOptionChangedTopic: Subject<[StyleOptionNode, number]> = new Subject<[StyleOptionNode, number]>();

    maps$: BehaviorSubject<MapLayerTree> = new BehaviorSubject<MapLayerTree>(new MapLayerTree([], this.selectionTopic, this.stateService, this.styleService));
    get maps() {
        return this.maps$.getValue();
    }

    selectionTileRequests: SelectionTileRequest[] = [];
    statsDialogVisible: boolean = false;
    statsDialogNeedsUpdate: Subject<void> = new Subject<void>();

    constructor(public styleService: StyleService,
                public stateService: AppStateService,
                private httpClient: HttpClient,
                private messageService: InfoMessageService,
                private pointMergeService: PointMergeService,
                private keyboardService: KeyboardService) {
        this.loadedTileLayers = new Map();
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
        this.moveToRectangleTopic = new Subject<{ targetView: number, rectangle: Rectangle }>();


        this.stateService.numViewsState.subscribe(numViews => {
            const diff = numViews - this.viewVisualizationState.length;

            if (diff > 0) {
                this.viewVisualizationState.push(
                    ...Array.from({ length: diff }, () => new ViewVisualizationState()));
            } else if (diff < 0) {
                this.viewVisualizationState.splice(diff);
            }

            this.reapplySyncOptionsForAllViews();
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
                for (const tileVisu of state.removeVisualizations(styleId)) {
                    this.tileVisualizationDestructionTopic.next(tileVisu);
                }
            });
            this.stateService.prune(this.maps.maps, this.styleService.styles);
        });
        this.styleService.styleAddedForId.subscribe(styleId => {
            this.viewVisualizationState.forEach((state, viewIndex) => {
                for (let [_, tileLayer] of this.loadedTileLayers) {
                    const style = this.styleService.styles.get(styleId);
                    if (style) {
                        this.renderTileLayerOnDemand(viewIndex, tileLayer, style);
                    }
                }
            });
        });
        this.styleOptionChangedTopic.subscribe(([optionNode, viewIndex]) => {
            this.applyStyleOptionChange(optionNode, viewIndex);

            if (this.isSyncOptionsForViewEnabled(viewIndex)) {
                const syncedOptions = this.maps.syncLayers(viewIndex, optionNode.mapId, optionNode.layerId);
                for (const syncedOption of syncedOptions) {
                    this.applyStyleOptionChange(syncedOption, viewIndex);
                }
            }

            const syncResult = this.syncViewsIfEnabled(viewIndex);
            if (syncResult?.viewConfigChanged) {
                this.scheduleUpdate();
            }
        });

        await this.reloadDataSources();

        let layerSyncEnabled = this.stateService.viewSync.includes(VIEW_SYNC_LAYERS);
        this.stateService.viewSyncState.subscribe(syncModes => {
            const enabled = syncModes.includes(VIEW_SYNC_LAYERS);
            if (enabled && !layerSyncEnabled) {
                const result = this.syncViewsIfEnabled(this.stateService.focusedView);
                if (result?.viewConfigChanged) {
                    this.scheduleUpdate();
                }
            }
            layerSyncEnabled = enabled;
        });

        this.stateService.numViewsState.pipe(distinctUntilChanged(), skip(1)).subscribe(_ => {
            this.stateService.prune(this.maps.maps, this.styleService.styles);
        });
        this.stateService.selectionState.subscribe(async selected => {
            const convertedSelections: InspectionPanelModel<FeatureWrapper>[] = [];
            for (const selection of selected) {
                // Only push a new panel if the selection changed. Otherwise,
                // just reuse the old panel so that the inspection trees in existing
                // opened panels are not recalculated.
                const existing = this.selectionTopic.getValue().find(p => p.id === selection.id);
                if (existing && featureSetsEqual(selection.features, existing.features) && deepEquals(existing.sourceData, selection.sourceData)) {
                    existing.pinned = selection.pinned;
                    existing.color = selection.color;
                    existing.size = selection.size;
                    convertedSelections.push(existing);
                    continue;
                }
                const features = await this.loadFeatures(selection.features);
                convertedSelections.push({
                    id: selection.id,
                    pinned: selection.pinned,
                    size: selection.size,
                    features: features,
                    sourceData: selection.sourceData,
                    color: selection.color
                });
            }
            this.selectionTopic.next(convertedSelections);
        });
        this.selectionTopic.subscribe(selectedPanels => {
            // TODO: Consider only visualizing updated selections/features and not the whole set of the panels
            this.visualizeHighlights(coreLib.HighlightMode.SELECTION_HIGHLIGHT, selectedPanels);
            // If a hovered feature is selected, eliminate it from the hover highlights.
            const hoveredFeatures = this.hoverTopic.getValue();
            if (hoveredFeatures.length) {
                this.hoverTopic.next(hoveredFeatures.filter(hoveredFeature =>
                    !selectedPanels.some(panel =>
                        panel.features.some(feature => feature.equals(hoveredFeature)))));
            }
        });
        this.hoverTopic.subscribe(hoveredFeatureWrappers => {
            this.visualizeHighlights(coreLib.HighlightMode.HOVER_HIGHLIGHT, [{
                features: hoveredFeatureWrappers}]);
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
            if (messageType === MAP_TILE_STREAM_TYPE_FIELDS) {
                uint8ArrayToWasm((wasmBuffer: any) => {
                    this.tileParser!.readFieldDictUpdate(wasmBuffer);
                }, message);
            } else if (messageType === MAP_TILE_STREAM_TYPE_FEATURES) {
                const tileLayerBlob = message.slice(MAP_TILE_STREAM_HEADER_SIZE);
                this.addTileFeatureLayer(tileLayerBlob);
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

    private getTilesSocket(): MapTileStreamClient {
        if (!this.tilesSocket) {
            this.tilesSocket = new MapTileStreamClient(tileUrl);
            this.tilesSocket.onFrame = (message, messageType) => {
                if (messageType === MAP_TILE_STREAM_TYPE_FIELDS || messageType === MAP_TILE_STREAM_TYPE_FEATURES) {
                    this.tileStreamParsingQueue.push([message, messageType]);
                    return;
                }
                if (messageType === MAP_TILE_STREAM_TYPE_SOURCEDATA) {
                    return;
                }
                console.warn(`Ignoring unknown /tiles message type ${messageType}.`);
            };
            this.tilesSocket.onStatus = (status) => this.handleTilesRequestStatus(status);
            this.tilesSocket.onLoadState = (payload) => this.handleTilesLoadState(payload);
            this.tilesSocket.onClose = () => {
                this.lastTilesRequestBody = null;
            };
            this.tilesSocket.onError = (event) => {
                console.error("Tile WebSocket error.", event);
            };
        }
        return this.tilesSocket;
    }

    private handleTilesRequestStatus(status: MapTileStreamStatusPayload) {
        if (!status || status.type !== "mapget.tiles.status") {
            return;
        }
        const requests = status.requests || [];
        const statusMessage = status.message || "";
        if (statusMessage.includes("Replaced by a new /tiles WebSocket request")) {
            return;
        }
        if (statusMessage) {
            console.info("/tiles status:", statusMessage);
        }
        if (!status.allDone) {
            return;
        }
        const failures = requests.filter(req =>
            req.status !== MapTileRequestStatus.Success && req.status !== MapTileRequestStatus.Open);
        if (!failures.length) {
            return;
        }
        const summary = failures
            .map(req => `${req.mapId}/${req.layerId}: ${req.statusText}`)
            .join(", ");
        const detail = statusMessage ? ` (${statusMessage})` : "";
        this.messageService.showError(`Tile request failed: ${summary}${detail}`);
    }

    private handleTilesLoadState(payload: MapTileStreamLoadStatePayload) {
        if (!payload || payload.type !== "mapget.tiles.load-state") {
            return;
        }

        const tileId = BigInt(payload.tileId);
        const tileKey = coreLib.getTileFeatureLayerKey(payload.mapId, payload.layerId, tileId);
        const tile = this.loadedTileLayers.get(tileKey);
        if (!tile) {
            return;
        }

        this.applyTileLoadState(tile, payload.state);
    }

    public scheduleUpdate() {
        this.updatePending = true;
        if (this.updateTimer) {
            return;
        }
        const elapsed = Date.now() - this.lastUpdateAt;
        const delay = Math.max(0, this.updateDebounceMs - elapsed);
        this.updateTimer = setTimeout(() => {
            this.updateTimer = null;
            this.runUpdate().then();
        }, delay);
    }

    private async runUpdate() {
        if (this.updateInProgress) {
            this.updatePending = true;
            return;
        }
        this.updateInProgress = true;
        this.updatePending = false;
        try {
            // Get the tile IDs for the current viewport for each view.
            const loadLimit = this.stateService.tilesLoadLimit / this.stateService.numViews;
            const visualizeLimit = this.stateService.tilesVisualizeLimit / this.stateService.numViews;
            this.viewVisualizationState.forEach((state, viewIndex) => {
                state.recalculateTileIds(loadLimit, visualizeLimit, this.maps.allLevels(viewIndex));
            });

            await this.updateMapDataRequest();
            this.updateEvictLoadedLayers();
            this.updateVisualizations();
        } finally {
            this.updateInProgress = false;
            this.lastUpdateAt = Date.now();
            if (this.updatePending) {
                this.scheduleUpdate();
            }
        }
    }

    private applyTileLoadState(tile: FeatureTile, status: TileLoadState) {
        tile.status = status;
        const tileKey = tile.mapTileKey;
        for (const viewState of this.viewVisualizationState) {
            for (const visu of viewState.getVisualizations(undefined, tileKey)) {
                visu.updateStatus();
            }
        }
    }

    private ensureTilePlaceholder(mapId: string, layerId: string, tileId: bigint, preventCulling: boolean): boolean {
        if (!this.tileParser) {
            return false;
        }
        const tileKey = coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
        const existing = this.loadedTileLayers.get(tileKey);
        if (existing) {
            if (preventCulling) {
                existing.preventCulling = true;
            }
            return false;
        }

        const placeholder = new FeatureTile(this.tileParser, null, preventCulling, {
            mapTileKey: tileKey,
            mapName: mapId,
            layerName: layerId,
            tileId: tileId,
        });
        this.loadedTileLayers.set(tileKey, placeholder);
        this.statsDialogNeedsUpdate.next();

        return true;
    }

    private applyStyleOptionChange(optionNode: StyleOptionNode, viewIndex: number) {
        if (viewIndex >= this.viewVisualizationState.length) {
            return;
        }
        if (optionNode.value.length <= viewIndex) {
            return;
        }

        const viewState = this.viewVisualizationState[viewIndex];
        if (!viewState.hasVisualizations(optionNode.styleId)) {
            return;
        }

        const mapViewLayerStyleId = this.pointMergeService.makeMapViewLayerStyleId(
            viewIndex,
            optionNode.mapId,
            optionNode.layerId,
            optionNode.styleId,
            coreLib.HighlightMode.NO_HIGHLIGHT);
        for (const removedMergedPointsTile of this.pointMergeService.clear(mapViewLayerStyleId)) {
            this.mergedTileVisualizationDestructionTopic.next(removedMergedPointsTile);
        }

        viewState.visualizationQueue = viewState.visualizationQueue.filter(visu =>
            visu.styleId !== optionNode.styleId ||
            visu.tile.mapName !== optionNode.mapId ||
            visu.tile.layerName !== optionNode.layerId
        );

        const optionValue = optionNode.value[viewIndex];
        for (const visu of viewState.getVisualizations(optionNode.styleId)) {
            console.assert(
                visu.viewIndex === viewIndex,
                `The viewIndex of the visualization must correspond to its visualization collection index. Expected ${viewIndex}, got ${visu.viewIndex}.`
            );
            if (visu.tile.mapName === optionNode.mapId && visu.tile.layerName === optionNode.layerId) {
                visu.setStyleOption(optionNode.id, optionValue);
                viewState.visualizationQueue.unshift(visu);
            }
        }
    }

    public setSyncOptionsForView(viewIndex: number, enabled: boolean) {
        const current = this.stateService.getLayerSyncOption(viewIndex);
        if (current !== enabled) {
            this.stateService.setLayerSyncOption(viewIndex, enabled);
        }
        if (!enabled) {
            return;
        }

        this.applySyncOptionsForView(viewIndex);
    }

    public isSyncOptionsForViewEnabled(viewIndex: number): boolean {
        return this.stateService.getLayerSyncOption(viewIndex);
    }

    private syncViewsIfEnabled(viewIndex: number): SyncViewsResult | null {
        if (!this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return null;
        }
        const result = this.maps.syncViews(viewIndex);
        for (const [optionNode, targetIndex] of result.styleOptionChanges) {
            this.applyStyleOptionChange(optionNode, targetIndex);
        }

        this.syncOsmSettingsFromView(viewIndex);

        return result;
    }

    private applySyncOptionsForView(viewIndex: number) {
        for (const layer of this.maps.allFeatureLayers()) {
            const syncedOptions = this.maps.syncLayers(viewIndex, layer.mapId, layer.id);
            for (const syncedOption of syncedOptions) {
                this.applyStyleOptionChange(syncedOption, viewIndex);
            }
        }
        const result = this.syncViewsIfEnabled(viewIndex);
        if (result?.viewConfigChanged) {
            this.scheduleUpdate();
        }
    }

    private reapplySyncOptionsForAllViews() {
        const numViews = this.stateService.numViews;
        for (let viewIndex = 0; viewIndex < numViews; viewIndex++) {
            if (this.stateService.getLayerSyncOption(viewIndex)) {
                this.applySyncOptionsForView(viewIndex);
            }
        }
    }

    private syncOsmSettingsFromView(viewIndex: number): boolean {
        const numViews = this.stateService.numViews;
        if (viewIndex < 0 || viewIndex >= numViews) {
            return false;
        }
        const sourceOsmEnabled = this.stateService.osmEnabledState.getValue(viewIndex);
        const sourceOsmOpacity = this.stateService.osmOpacityState.getValue(viewIndex);
        let changed = false;
        for (let targetIndex = 0; targetIndex < numViews; targetIndex++) {
            if (targetIndex === viewIndex) {
                continue;
            }
            if (this.stateService.osmEnabledState.getValue(targetIndex) !== sourceOsmEnabled) {
                this.stateService.osmEnabledState.next(targetIndex, sourceOsmEnabled);
                changed = true;
            }
            if (this.stateService.osmOpacityState.getValue(targetIndex) !== sourceOsmOpacity) {
                this.stateService.osmOpacityState.next(targetIndex, sourceOsmOpacity);
                changed = true;
            }
        }
        return changed;
    }

    public syncOsmSettings(viewIndex: number) {
        if (!this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return;
        }
        this.syncOsmSettingsFromView(viewIndex);
    }

    async reloadDataSources() {
        try {
            const result = await firstValueFrom(this.httpClient.get<Array<MapInfoItem>>(infoUrl));
            const maps = result.filter(m => !m.addOn).map(mapInfo => mapInfo);
            this.maps$.next(new MapLayerTree(maps, this.selectionTopic, this.stateService, this.styleService));
            this.reapplySyncOptionsForAllViews();

            const jsonString = JSON.stringify(result);
            const infoBuffer = new TextEncoder().encode(jsonString);
            uint8ArrayToWasm((wasmBuffer: any) => {
                this.tileParser!.setDataSourceInfo(wasmBuffer);
                console.log("Loaded data source info.");
            }, infoBuffer);
        } catch (err) {
            console.error("Failed to load data source info.", err);
        }
    }

    private updateEvictLoadedLayers() {
        // Evict present non-required tile layers.
        const evictTileLayer = (tileLayer: FeatureTile) => {
            // Is the tile needed to visualize the selection?
            if (tileLayer.preventCulling || this.selectionTopic.getValue().some(v =>
                v.features.some(feature => feature.featureTile.mapTileKey == tileLayer.mapTileKey))) {
                return false;
            }
            // Is the tile needed for any view?
            return this.viewVisualizationState.every((_, viewIndex) => {
                return !this.viewShowsFeatureTile(viewIndex, tileLayer);
            });
        }
        let newTileLayers = new Map();
        for (let tileLayer of this.loadedTileLayers.values()) {
            if (evictTileLayer(tileLayer)) {
                tileLayer.dispose();
            } else {
                newTileLayers.set(tileLayer.mapTileKey, tileLayer);
            }
        }
        this.loadedTileLayers = newTileLayers;
    }

    private updateVisualizations() {
        // Update visualizations - first, delete stale visualizations.
        this.viewVisualizationState.forEach((state, viewIndex) => {
            for (const styleId of state.getVisualizedStyleIds()) {
                let styleEnabled = false;
                if (this.styleService.styles.has(styleId)) {
                    styleEnabled = this.styleService.styles.get(styleId)!.visible;
                }
                const removals: string[] = [];
                for (const tileVisu of state.getVisualizations(styleId)) {
                    if (tileVisu.tile.disposed || !this.viewShowsFeatureTile(viewIndex, tileVisu.tile)) {
                        this.tileVisualizationDestructionTopic.next(tileVisu);
                        removals.push(tileVisu.tile.mapTileKey);
                        continue;
                    }
                    if (styleId != "_builtin" && !styleEnabled) {
                        this.tileVisualizationDestructionTopic.next(tileVisu);
                        removals.push(tileVisu.tile.mapTileKey);
                        continue;
                    }
                    tileVisu.showTileBorder = this.maps.getViewTileBorderState(viewIndex);
                    tileVisu.isHighDetail = state.highDetailTileIds.has(tileVisu.tile.tileId) || tileVisu.tile.preventCulling;
                }
                for (const tileKey of removals) {
                    state.removeVisualizations(styleId, tileKey).forEach(_ => _);
                }
            }
        });

        // Update Tile Visualization Queue.
        this.viewVisualizationState.forEach((state, viewIndex) => {
            state.visualizationQueue = [];
            // Schedule new or dirty visualizations.
            for (const [_, style] of this.styleService.styles) {
                for (let [_, tile] of this.loadedTileLayers) {
                    if (this.viewShowsFeatureTile(viewIndex, tile)) {
                        this.renderTileLayerOnDemand(viewIndex, tile, style);
                    }
                }
            }
        });
    }

    private async updateMapDataRequest() {
        // Request non-present required tile layers.
        const requestByLayer = new Map<string, {mapId: string, layerId: string, tileIds: number[], tileIdSet: Set<number>}>();
        const queueTiles = (mapId: string, layerId: string, tileIds: Array<number>) => {
            if (!tileIds.length) {
                return;
            }
            const key = `${mapId}/${layerId}`;
            let entry = requestByLayer.get(key);
            if (!entry) {
                entry = {mapId, layerId, tileIds: [], tileIdSet: new Set<number>()};
                requestByLayer.set(key, entry);
            }
            for (const tileId of tileIds) {
                if (!entry.tileIdSet.has(tileId)) {
                    entry.tileIds.push(tileId);
                    entry.tileIdSet.add(tileId);
                }
            }
        };
        for (const selectionTileRequest of this.selectionTileRequests) {
            // Do not go forward with the selection tile request, if it
            // pertains to a map layer that is not available anymore.
            const mapLayerItem = this.maps.maps
                .get(selectionTileRequest.remoteRequest.mapId)?.layers
                .get(selectionTileRequest.remoteRequest.layerId);
            if (mapLayerItem) {
                queueTiles(
                    selectionTileRequest.remoteRequest.mapId,
                    selectionTileRequest.remoteRequest.layerId,
                    selectionTileRequest.remoteRequest.tileIds);
                for (const tileId of selectionTileRequest.remoteRequest.tileIds) {
                    this.ensureTilePlaceholder(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId,
                        BigInt(tileId),
                        true);
                }
            } else {
                selectionTileRequest.reject!("Map layer is not available.");
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
                    let tileIds = this.viewVisualizationState[viewIndex].visibleTileIdsPerLevel.get(level);
                    if (tileIds === undefined) {
                        continue;
                    }
                    for (let tileId of tileIds!) {
                        const tileMapLayerKey = coreLib.getTileFeatureLayerKey(mapName, layer.id, tileId);
                        const existingTile = this.loadedTileLayers.get(tileMapLayerKey);
                        if ((!existingTile || !existingTile.hasData()) && !requestTilesForMapLayerSet.has(tileId)) {
                            requestTilesForMapLayer.push(Number(tileId)); // TODO: Get rid of type casting after new tile ids are available
                            requestTilesForMapLayerSet.add(tileId);
                            this.ensureTilePlaceholder(mapName, layer.id, tileId, false)
                        }
                    }
                }

                // Only add a request if there are tiles to be loaded.
                if (requestTilesForMapLayer.length > 0) {
                    queueTiles(mapName, layer.id, requestTilesForMapLayer);
                }
            }
        }

        const requests = Array.from(requestByLayer.values()).map(entry => ({
            mapId: entry.mapId,
            layerId: entry.layerId,
            tileIds: entry.tileIds
        }));

        const requestBody = {
            requests: requests,
            stringPoolOffsets: this.tileParser!.getFieldDictOffsets(),
        };

        // Nothing to do if all requests are empty.
        if (requests.length === 0) {
            return;
        }

        const newRequestBody = JSON.stringify(requestBody);
        const tilesSocket = this.getTilesSocket();

        // Ensure that the new request is different from the previous one.
        if (this.lastTilesRequestBody === newRequestBody) {
            return;
        }
        this.lastTilesRequestBody = newRequestBody;

        // Make sure that there are no unparsed bytes lingering from the previous response stream.
        this.tileParser!.reset();
        this.tileStreamParsingQueue = [];

        await tilesSocket.connect();
        try {
            await tilesSocket.sendRequest(requestBody);
        } catch (err) {
            this.lastTilesRequestBody = null;
            console.error("Failed to send /tiles request.", err);
            this.messageService.showError("Failed to send /tiles request.");
        }
    }

    addTileFeatureLayer(tileLayerBlob: any, style: ErdblickStyle | null = null, preventCulling: boolean = false) {
        if (!this.tileParser) {
            return;
        }
        const mapTileMetadata = uint8ArrayToWasm((wasmBlob: any) => {
            return this.tileParser!.readTileLayerMetadata(wasmBlob);
        }, tileLayerBlob);
        const existingTile = this.loadedTileLayers.get(mapTileMetadata.id);
        let tileLayer: FeatureTile;
        if (existingTile) {
            tileLayer = existingTile;
            tileLayer.preventCulling = tileLayer.preventCulling || preventCulling;
            tileLayer.hydrateFromBlob(tileLayerBlob);
        } else {
            tileLayer = new FeatureTile(this.tileParser!, tileLayerBlob, preventCulling);
            this.loadedTileLayers.set(tileLayer.mapTileKey, tileLayer);
        }
        this.applyTileLoadState(tileLayer, tileLayer.status);

        // Consider, if this tile is needed by a selection tile request.
        this.selectionTileRequests = this.selectionTileRequests.filter(request => {
            if (tileLayer.mapTileKey === request.tileKey) {
                request.resolve!(tileLayer);
                return false;
            }
            return true;
        });

        this.statsDialogNeedsUpdate.next();

        // Update legal information if any.
        if (tileLayer.legalInfo) {
            this.setLegalInfo(tileLayer.mapName, tileLayer.legalInfo);
        }
        if (style && !this.styleService.styles.has(style.id)) {
            for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                if (!this.viewShowsFeatureTile(viewIndex, tileLayer)) {
                    continue;
                }
                this.renderTileLayer(viewIndex, tileLayer, style);
            }
        }

        // Ensure that visualizations which now have data are queued for rendering.
        this.updateVisualizations();
    }

    private renderTileLayerOnDemand(viewIndex: number, tileLayer: FeatureTile, style: ErdblickStyle) {
        if (style.visible && style.featureLayerStyle.hasLayerAffinity(tileLayer.layerName)) {
            this.renderTileLayer(viewIndex, tileLayer, style);
        }
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
        const tileKey = tileLayer.mapTileKey;
        const viewState = this.viewVisualizationState[viewIndex];
        const existing = viewState.getVisualization(styleId, tileKey);
        if (existing) {
            existing.showTileBorder = this.maps.getViewTileBorderState(viewIndex);
            existing.isHighDetail = tileLayer.preventCulling || viewState.highDetailTileIds.has(tileLayer.tileId);
            if (existing.isDirty()) {
                existing.updateStatus(true);
                viewState.visualizationQueue.push(existing);
            }
            return;
        }
        let visu = new TileVisualization(
            viewIndex,
            tileLayer,
            this.pointMergeService,
            (tileKey: string) => this.getFeatureTile(tileKey),
            wasmStyle,
            tileLayer.preventCulling || viewState.highDetailTileIds.has(tileLayer.tileId),
            coreLib.HighlightMode.NO_HIGHLIGHT,
            [],
            this.maps.getViewTileBorderState(viewIndex),
            this.maps.getLayerStyleOptions(viewIndex, mapName, layerName, styleId));
        visu.updateStatus(true);
        viewState.visualizationQueue.push(visu);
        viewState.putVisualization(styleId, tileKey, visu);
    }

    setViewport(viewIndex: number, viewport: Viewport) {
        const maxIndex = this.viewVisualizationState.length - 1;
        if (viewIndex > maxIndex) {
            console.error(`Attempted to write @ viewIndex: ${viewIndex} but it is out of bounds (${maxIndex})`);
            return;
        }
        this.viewVisualizationState[viewIndex].viewport = viewport;
        this.scheduleUpdate();
    }

    getPrioritisedTiles(viewIndex: number) {
        let tiles = new Array<[number, FeatureTile]>();
        for (const [_, tile] of this.loadedTileLayers) {
            if (!tile.hasData()) {
                continue;
            }
            tiles.push([coreLib.getTilePriorityById(this.viewVisualizationState[viewIndex].viewport, tile.tileId), tile]);
        }
        tiles.sort((a, b) => b[0] - a[0]);
        return tiles.map(val => val[1]);
    }

    getFeatureTile(tileKey: string): FeatureTile | null {
        const tile = this.loadedTileLayers.get(tileKey);
        if (!tile || !tile.hasData()) {
            return null;
        }
        return tile;
    }

    async loadTiles(tileKeys: Set<string | null>): Promise<Map<string, FeatureTile>> {
        const result = new Map<string, FeatureTile>();

        // TODO: Optimize this loop to make just a single update call.
        // NOTE: Currently each missing tile triggers a separate update() call, which is inefficient.
        // Should batch all missing tiles and make a single update call for better performance.
        for (const tileKey of tileKeys) {
            if (!tileKey) {
                continue;
            }

            let tile = this.loadedTileLayers.get(tileKey);
            if (tile && tile.hasData()) {
                result.set(tileKey, tile);
                continue;
            }

            const [mapId, layerId, tileId] = coreLib.parseMapTileKey(tileKey);
            const selectionTileRequest: SelectionTileRequest =  {
                remoteRequest: {
                    mapId: mapId,
                    layerId: layerId,
                    tileIds: [Number(tileId)],
                },
                tileKey: tileKey,
                resolve: null,
                reject: null
            };

            const selectionTilePromise = new Promise<FeatureTile>((resolve, reject) => {
                selectionTileRequest.resolve = resolve;
                selectionTileRequest.reject = reject;
            });

            this.selectionTileRequests.push(selectionTileRequest);
            this.scheduleUpdate();
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
                const [mapId, layerId, tileId] = coreLib.parseMapTileKey(id?.mapTileKey || "");
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

        const selectedFeatures = this.selectionTopic.getValue().flatMap(panel => panel.features);
        const currentHover = this.hoverTopic.getValue();

        if (featureSetsEqual(selectedFeatures, features) || featureSetsEqual(currentHover, features)) {
            return;
        }
        if (featureSetContains(selectedFeatures, features)) {
            if (currentHover.length) {
                this.hoverTopic.next([]);
            }
            return;
        }
        this.hoverTopic.next(features);
    }

    async focusOnFeature(viewIndex: number, tileFeatureId: TileFeatureId) {
        const features = await this.loadFeatures([tileFeatureId]);
        if (!features.length) {
            this.messageService.showError(`Could not locate feature ${tileFeatureId.featureId} in ${tileFeatureId.mapTileKey}!`)
            return;
        }
        const position = features[0].peek((parsedFeature: Feature) => parsedFeature.center());
        this.moveToWgs84PositionTopic.next({targetView: viewIndex, x: position.x, y: position.y});
    }

    zoomToFeature(viewIndex: number|undefined, featureWrapper: FeatureWrapper) {
        const runForTargetViewOrAllAffected = (cb: (viewIndex: number)=>void) => {
            if (viewIndex !== undefined) {
                cb(viewIndex);
            }
            for (let i = 0; i < this.stateService.numViews; ++i) {
                if (this.viewShowsFeatureTile(i, featureWrapper.featureTile, true)) {
                    cb(i);
                }
            }
        }

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
                runForTargetViewOrAllAffected(vi =>
                    this.originAndNormalForFeatureZoomTopic.next({
                        targetView: vi,
                        origin: centerCartesian,
                        normal: normal
                    }));
            }

            // Fallback for lines/points: Just move the camera to the position.
            runForTargetViewOrAllAffected(vi =>
                this.moveToWgs84PositionTopic.next({
                    targetView: vi,
                    x: center.x,
                    y: center.y,
                    // TODO: Calculate height using faux Cesium camera with target view rectangle.
                    z: center.z + 3 * boundingRadius
                }));
        });
    }

    *tileLayersForTileId(tileId: bigint): Generator<FeatureTile> {
        for (const tile of this.loadedTileLayers.values()) {
            if (tile.tileId == tileId && tile.hasData()) {
                yield tile;
            }
        }
    }

    private visualizeHighlights(mode: HighlightMode, groups: {features: FeatureWrapper[], color?: string, id?: number}[]) {
        let visualizationCollection = null;
        switch (mode) {
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT:
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

        // Apply highlight styles.
        for (const group of groups) {
            const featureWrappersForTile = new Map<FeatureTile, FeatureWrapper[]>();
            for (const wrapper of group.features) {
                if (!featureWrappersForTile.has(wrapper.featureTile)) {
                    featureWrappersForTile.set(wrapper.featureTile, []);
                }
                featureWrappersForTile.get(wrapper.featureTile)!.push(wrapper);
            }

            for (const [featureTile, features] of featureWrappersForTile) {
                const featureIds = features.map(fw => fw.featureId);
                for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                    // Do not render the highlight for any view that doesn't need it.
                    if (!this.viewShowsFeatureTile(viewIndex, featureTile, true)) {
                        continue;
                    }
                    for (let [_, style] of this.styleService.styles) {
                        if (style.visible && style.featureLayerStyle.hasLayerAffinity(featureTile.layerName)) {
                            const styleOptions = this.maps.getLayerStyleOptions(
                                viewIndex, featureTile.mapName, featureTile.layerName, style.id) ?? {};
                            if (group.color) {
                                styleOptions["selectableFeatureHighlightColor"] = group.color;
                            }
                            let visualization = new TileVisualization(
                                viewIndex,
                                featureTile,
                                this.pointMergeService,
                                (tileKey: string) => this.getFeatureTile(tileKey),
                                style.featureLayerStyle,
                                true,
                                mode,
                                featureIds,
                                false,
                                styleOptions);
                            this.tileVisualizationTopic.next(visualization);
                            visualizationCollection.push(visualization);
                        }
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
     * Clean up all tile visualizations - used during viewer deletion.
     */
    clearAllTileVisualizations(viewIndex: number, viewer: Viewer): void {
        if (viewIndex >= this.stateService.numViews) {
            return;
        }
        for (const tileVisu of this.viewVisualizationState[viewIndex].removeVisualizations()) {
            try {
                tileVisu.destroy(viewer);
            } catch (error) {
                console.warn('Error destroying tile visualization:', error);
            }
        }
        this.viewVisualizationState[viewIndex].visualizationQueue = [];
    }

    setMapLayerVisibility(viewIndex: number, mapOrGroupId: string, layerId: string = "", state: boolean) {
        this.maps.setMapLayerVisibility(viewIndex, mapOrGroupId, layerId, state);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    toggleViewTileBorderVisibility(viewIndex: number) {
        const nextState = !this.maps.getViewTileBorderState(viewIndex);
        this.maps.setViewTileBorderState(viewIndex, nextState);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    setMapLayerLevel(viewIndex: number, mapId: string, layerId: string, level: number) {
        this.maps.setMapLayerLevel(viewIndex, mapId, layerId, level);
        this.syncViewsIfEnabled(viewIndex);
        this.scheduleUpdate();
    }

    private viewShowsFeatureTile(viewIndex: number, tile: FeatureTile, skipViewportCheck: boolean = false) {
        if (viewIndex >= this.viewVisualizationState.length) {
            console.error("Attempt to access non-existing view index.");
            return false;
        }
        if (!skipViewportCheck) {
            const viewState = this.viewVisualizationState[viewIndex];
            if (!viewState.visibleTileIds.has(tile.tileId)) {
                return false;
            }
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
