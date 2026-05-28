import {Injectable, NgZone} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";
import {MapInfoService} from "./map-info.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapTileRequestStatus, MapTileStreamClient} from "./tilestream";
import type {
    MapTileStreamSearchStatusPayload,
    MapTileStreamStatusPayload,
    MapTileStreamTransportCompressionStats
} from "./tilestream";
import {FeatureTile, FeatureWrapper} from "./features.model";
import {
    BackendRequestProgress,
    FeatureSearchDataPlaneRequest,
    FeatureSearchTileRequest,
    FeatureSearchTileState,
    RequestedLayerProgressState,
    SearchLayerTileSet,
    SearchResultTileEntry,
    SearchResultTileEvictedPayload,
    SearchResultTilePayload,
    SelectionTileRequest,
    TileDataChange,
    TileSearchResultLayerLike
} from "./map-runtime.model";
import {SearchResultTile} from "./search-result-tile.model";
import {coreLib, uint8ArrayFromWasm, uint8ArrayToWasm} from "../integrations/wasm";
import {AppStateService, TileFeatureId} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {
    normalizeFeatureSearchRenderStrategy
} from "../shared/feature-search-state";

interface LayerRequestEntry {
    mapId: string;
    layerId: string;
    tileIdToNextMissingStage: Map<number, number>;
    priorityTileIds: Set<number>;
}

interface ExpectedLayerEntry {
    mapId: string;
    layerId: string;
    tileIdToRequestedMaxStage: Map<number, number>;
}

interface SearchResultRenderTile {
    searchId: string;
    refresh: number;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: bigint;
    tile: SearchResultTile;
}

/**
 * Owns mapget `/tiles` transport, feature/search tile caches, request diffing, and tile-load progress.
 */
@Injectable({providedIn: "root"})
export class MapTileStreamService {
    public readonly loadedTileLayers: Map<string, FeatureTile> = new Map();
    public readonly tilePipelinePaused$ = new BehaviorSubject<boolean>(false);
    public readonly tileDataChanged = new Subject<TileDataChange>();
    public readonly tileCacheChanged = new Subject<string>();
    public readonly selectionTileUpdated = new Subject<string>();
    public readonly searchResultTileReceived = new Subject<SearchResultTilePayload>();
    public readonly searchResultTileEvicted = new Subject<SearchResultTileEvictedPayload>();
    public readonly searchStatusReceived = new Subject<MapTileStreamSearchStatusPayload>();
    public readonly searchRenderTileChanged = new Subject<SearchResultTile>();
    public readonly searchRenderTileRemoved = new Subject<{searchId: string; sourceTileKey: string}>();

    private tileStream: MapTileStreamClient|null = null;
    private readonly selectionTileRequests: SelectionTileRequest[] = [];
    private readonly selectedTileKeys: Set<string> = new Set<string>();
    private updateTimer: ReturnType<typeof setTimeout> | null = null;
    private updateInProgress = false;
    private updatePending = false;
    private updateRequestedWhilePaused = false;
    private blockedTileLoadInfoShown = false;
    private readonly updateDebounceMs = 50;
    private lastUpdateAt = 0;
    private stageRequestProgress: Array<{done: number; total: number}> = [];
    private pendingRequestedTileKeysByStage: Array<Set<string>> = [];
    private requestedLayerProgressByKey: Map<string, RequestedLayerProgressState> = new Map();
    private backendRequestProgress: BackendRequestProgress = {done: 0, total: 0, allDone: true};
    private viewportLoadStartedAtMs: number | null = null;
    private viewportRenderCompletedAtMs: number | null = null;
    private activeFeatureSearchRequests: Map<string, FeatureSearchDataPlaneRequest> = new Map();
    private pendingFeatureSearchCancellations: Map<string, FeatureSearchDataPlaneRequest> = new Map();
    private pendingFeatureSearchCancellationLayerKeysById: Map<string, Set<string>> = new Map();
    private lastFeatureSearchRequestSignature = "";
    private featureSearchRefreshById: Map<string, number> = new Map();
    private featureSearchFingerprintById: Map<string, string> = new Map();
    private lastFeatureSearchUpdateSerialById: Map<string, number> = new Map();
    private featureSearchTileStatesById: Map<string, Map<string, FeatureSearchTileState>> = new Map();
    private searchResultRenderTilesByKey: Map<string, SearchResultRenderTile> = new Map();
    private searchResultMaxRefreshById: Map<string, number> = new Map();

    constructor(
        private readonly stateService: AppStateService,
        private readonly mapInfo: MapInfoService,
        private readonly viewState: MapViewStateService,
        private readonly messageService: InfoMessageService,
        private readonly ngZone: NgZone
    ) {
        this.stateService.tilePullCompressionEnabledState.subscribe(enabled => {
            this.tileStream?.setPullCompressionEnabled(enabled);
        });
        this.viewState.viewStateChanged.subscribe(() => this.scheduleUpdate());
    }

    /** Wires the transport callbacks and loads datasource metadata before viewport requests start. */
    async initialize() {
        this.tileStream = new MapTileStreamClient("/tiles", this.mapInfo.tileLayerParser);
        this.tileStream.setPullCompressionEnabled(this.stateService.tilePullCompressionEnabled);
        this.tileStream.setFrameProcessingPaused(this.tilePipelinePaused);
        this.tileStream.onFeatures = (payload) => {
            this.ngZone.runOutsideAngular(() => this.addTileFeatureLayer(payload));
        };
        this.tileStream.onSearchResults = (payload) => {
            this.ngZone.runOutsideAngular(() => this.addTileSearchResultLayer(payload));
        };
        this.tileStream.onStatus = (status) => {
            this.ngZone.runOutsideAngular(() => this.handleTilesRequestStatus(status));
        };
        this.tileStream.onSearchStatus = (status) => {
            this.ngZone.runOutsideAngular(() => this.handleSearchStatus(status));
        };
        this.tileStream.onError = (event) => {
            console.error("Tile WebSocket error.", event);
        };
        await this.mapInfo.reloadDataSources();
    }

    /** Returns whether tile loading and parsing are currently paused. */
    get tilePipelinePaused(): boolean {
        return this.tilePipelinePaused$.getValue();
    }

    /** Replaces the active server-side feature-search definitions used by the next `/tiles` request. */
    setFeatureSearchRequests(requests: FeatureSearchDataPlaneRequest[]): void {
        const normalized = requests
            .filter(request => request.searchId && request.query)
            .map(request => ({
                ...request,
                autoUpdate: !!request.autoUpdate,
                updateSerial: Number.isFinite(Number(request.updateSerial))
                    ? Math.max(0, Math.floor(Number(request.updateSerial)))
                    : 0,
                generationSerial: Number.isFinite(Number(request.generationSerial))
                    ? Math.max(0, Math.floor(Number(request.generationSerial)))
                    : 0,
                paused: !!request.paused,
                showResultsOnMap: request.showResultsOnMap !== false,
                pinColor: (request.pinColor || "").trim(),
                searchStyleRules: [...(request.searchStyleRules ?? [])],
                renderStrategy: normalizeFeatureSearchRenderStrategy(request.renderStrategy),
                withFields: Array.from(new Set((request.withFields ?? []).filter(Boolean))).sort()
            }))
            .sort((lhs, rhs) => lhs.searchId.localeCompare(rhs.searchId));
        const signature = JSON.stringify(normalized);
        if (signature === this.lastFeatureSearchRequestSignature) {
            return;
        }

        const nextIds = new Set(normalized.map(request => request.searchId));
        for (const [searchId, request] of this.activeFeatureSearchRequests) {
            if (!nextIds.has(searchId)) {
                this.pendingFeatureSearchCancellations.set(searchId, request);
                this.pendingFeatureSearchCancellationLayerKeysById.set(
                    searchId,
                    this.layerKeysForFeatureSearchTileStates(searchId)
                );
                this.clearFeatureSearchTileStates(searchId, true);
            }
        }

        this.activeFeatureSearchRequests = new Map(normalized.map(request => [request.searchId, request]));
        for (const request of normalized) {
            this.refreshForFeatureSearchDefinition(request);
        }
        this.lastFeatureSearchRequestSignature = signature;
        this.scheduleUpdate();
    }

    /** Returns one active search request, if it still exists. */
    activeFeatureSearchRequest(searchId: string): FeatureSearchDataPlaneRequest | undefined {
        return this.activeFeatureSearchRequests.get(searchId);
    }

    /** Returns a stable snapshot of active search requests for render ordering. */
    activeFeatureSearchRequestsSnapshot(): FeatureSearchDataPlaneRequest[] {
        return Array.from(this.activeFeatureSearchRequests.values());
    }

    /** Iterates the current high-fidelity search-result render tiles. */
    searchResultRenderTiles(): Iterable<SearchResultRenderTile> {
        return this.searchResultRenderTilesByKey.values();
    }

    /** Returns whether one high-fidelity search-result render tile is still cached. */
    hasSearchResultRenderTile(searchId: string, sourceTileKey: string): boolean {
        return this.searchResultRenderTilesByKey.has(this.searchResultRenderTileKey(searchId, sourceTileKey));
    }

    /** Builds the cache key for one search/result source tile pair. */
    searchResultRenderTileKey(searchId: string, sourceTileKey: string): string {
        return `${searchId}:${sourceTileKey}`;
    }

    /** Replaces the tile keys currently pinned by inspection selection. */
    setSelectedTileKeys(tileKeys: Iterable<string>): void {
        this.selectedTileKeys.clear();
        for (const key of tileKeys) {
            this.selectedTileKeys.add(key);
        }
        this.scheduleUpdate();
    }

    /** Returns a snapshot of the current logical `/tiles` backend request progress. */
    getBackendRequestProgress(): BackendRequestProgress {
        return {...this.backendRequestProgress};
    }

    /** Returns per-stage viewport completeness counters derived from requested vs. received tiles. */
    getRequestedStageProgress(): Array<{done: number; total: number}> {
        return this.stageRequestProgress.map(counter => ({...counter}));
    }

    /** Chooses human-readable stage labels, falling back to `Stage N` when layers disagree. */
    getRequestedStageLabels(): string[] {
        const labelsByStage: Array<Set<string>> = [];
        const ensureStageLabelSet = (stage: number) => {
            while (labelsByStage.length <= stage) {
                labelsByStage.push(new Set<string>());
            }
        };

        for (const layerState of this.requestedLayerProgressByKey.values()) {
            const stageLabels = this.mapInfo.getLayerStageLabels(
                layerState.mapId,
                layerState.layerId,
                layerState.stageCount
            );
            for (let stage = 0; stage < layerState.stageCount; stage++) {
                ensureStageLabelSet(stage);
                labelsByStage[stage].add(stageLabels[stage] ?? `Stage ${stage}`);
            }
        }

        return this.stageRequestProgress.map((_, stage) => {
            const stageLabels = labelsByStage[stage];
            if (!stageLabels || stageLabels.size !== 1) {
                return `Stage ${stage}`;
            }
            const [label] = Array.from(stageLabels.values());
            return label;
        });
    }

    /** Proxies `/tiles/next` compression stats while tolerating an uninitialized tile stream. */
    getTileStreamTransportCompressionStats(): MapTileStreamTransportCompressionStats {
        return this.tileStream?.getTransportCompressionStats() ?? {
            totalPullResponses: 0,
            totalPullGzipResponses: 0,
            totalUncompressedBytes: 0,
            knownCompressedBytes: 0,
            knownCompressedUncompressedBytes: 0,
            responsesWithKnownCompressedBytes: 0,
            compressionRatioPct: null,
            compressionSavingsPct: null,
            knownCompressedCoveragePct: 0,
        };
    }

    /** Returns whether the `/tiles` websocket is currently connected. */
    isTileStreamConnected(): boolean {
        return this.tileStream?.isOpen() ?? false;
    }

    /** Returns the number of frames waiting in the parser-side queue. */
    getPendingFrameQueueSize(): number {
        return this.tileStream?.getPendingFrameQueueSize() ?? 0;
    }

    /** Returns the downstream byte rate measured by the tile stream. */
    getDownstreamBytesPerSecond(): number {
        return this.tileStream?.getDownstreamBytesPerSecond() ?? 0;
    }

    /** Pauses tile parsing and update requests while diagnostics inspect the pipeline. */
    pauseTilePipeline(source: 'diagnostics' | string = 'diagnostics') {
        if (this.tilePipelinePaused) {
            return;
        }
        this.tilePipelinePaused$.next(true);
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        this.updateRequestedWhilePaused = this.updateRequestedWhilePaused || this.updatePending;
        this.tileStream?.setFrameProcessingPaused(true);
        this.showInfoMessage('Tile pipeline paused');
        console.info(`Tile pipeline paused (${source})`);
    }

    /** Resumes the tile pipeline and replays any deferred update request. */
    resumeTilePipeline(source: 'diagnostics' | string = 'diagnostics') {
        if (!this.tilePipelinePaused) {
            return;
        }
        this.tilePipelinePaused$.next(false);
        this.blockedTileLoadInfoShown = false;
        this.tileStream?.setFrameProcessingPaused(false);
        this.showInfoMessage('Tile pipeline resumed');
        console.info(`Tile pipeline resumed (${source})`);

        const needsUpdate = this.updatePending
            || this.updateRequestedWhilePaused
            || this.selectionTileRequests.length > 0;
        this.updateRequestedWhilePaused = false;
        if (needsUpdate) {
            this.scheduleOutsideAngular(() => this.scheduleUpdate(), 0);
        }
    }

    /** Convenience toggle for the diagnostics pause control. */
    toggleTilePipelinePause(source: 'diagnostics' | string = 'diagnostics') {
        if (this.tilePipelinePaused) {
            this.resumeTilePipeline(source);
        } else {
            this.pauseTilePipeline(source);
        }
    }

    /** Debounces expensive viewport updates while still guaranteeing a trailing refresh. */
    scheduleUpdate() {
        this.updatePending = true;
        if (this.tilePipelinePaused) {
            this.updateRequestedWhilePaused = true;
            return;
        }
        if (this.updateTimer) {
            return;
        }
        const elapsed = Date.now() - this.lastUpdateAt;
        const delay = Math.max(0, this.updateDebounceMs - elapsed);
        this.updateTimer = this.scheduleOutsideAngular(() => {
            this.updateTimer = null;
            this.runUpdate().then();
        }, delay);
    }

    /** Recomputes visible tiles, refreshes backend requests, and evicts stale tiles. */
    private async runUpdate() {
        if (this.tilePipelinePaused) {
            this.updatePending = true;
            this.updateRequestedWhilePaused = true;
            return;
        }
        if (this.updateInProgress) {
            this.updatePending = true;
            return;
        }
        this.updateInProgress = true;
        this.updatePending = false;
        try {
            this.viewState.recalculateVisibleTiles();
            await this.updateMapDataRequest();
            if (this.tilePipelinePaused) {
                this.updatePending = true;
                this.updateRequestedWhilePaused = true;
                return;
            }
            this.updateEvictLoadedLayers();
            this.tileCacheChanged.next("update");
        } finally {
            this.updateInProgress = false;
            this.lastUpdateAt = Date.now();
            if (this.updatePending) {
                this.scheduleUpdate();
            }
        }
    }

    /** Returns the highest stage currently expected for this tile, or null when no request expects it. */
    getRequestedMaxStageForTile(tile: FeatureTile): number | null {
        const stageCount = this.mapInfo.getLayerStageCount(tile.mapName, tile.layerName);
        const maxLayerStage = Math.max(0, stageCount - 1);
        let requestedMaxStage: number | null = tile.preventCulling ? maxLayerStage : null;

        for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
            if (!this.mapInfo.maps.getMapLayerVisibility(viewIndex, tile.mapName, tile.layerName)) {
                continue;
            }
            if (!this.viewShowsFeatureTile(viewIndex, tile)) {
                continue;
            }
            requestedMaxStage = maxLayerStage;
            break;
        }

        return requestedMaxStage;
    }

    /** Returns whether inspection can safely assume that every advertised stage for this tile is loaded. */
    isTileInspectionDataComplete(tile: FeatureTile): boolean {
        return tile.isComplete(this.mapInfo.getLayerStageCount(tile.mapName, tile.layerName));
    }

    /** Returns a loaded feature tile by key, accepting legacy and canonical key forms. */
    getFeatureTile(tileKey: string): FeatureTile | null {
        const canonicalTileKey = this.canonicalizeMapTileKey(tileKey);
        const tile = this.loadedTileLayers.get(canonicalTileKey);
        if (!tile || !tile.hasData()) {
            return null;
        }
        return tile;
    }

    /** Resolves an address-based feature reference back to a stable tile/feature id pair. */
    resolveTileFeatureIdByAddress(tileKey: string, featureAddress: number): TileFeatureId | null {
        if (!Number.isInteger(featureAddress) || featureAddress < 0) {
            return null;
        }
        const canonicalTileKey = this.canonicalizeMapTileKey(tileKey);
        const tile = this.loadedTileLayers.get(canonicalTileKey);
        if (!tile || !tile.hasData()) {
            return null;
        }
        if (featureAddress >= tile.numFeatures) {
            return null;
        }
        const featureId = tile.featureIdByAddress(featureAddress);
        return featureId ? {
            mapTileKey: canonicalTileKey,
            featureId
        } : null;
    }

    /** Ensures a set of tiles is loaded, using selection-style pin requests for cache misses. */
    async loadTiles(tileKeys: Set<string | null>): Promise<Map<string, FeatureTile>> {
        const result = new Map<string, FeatureTile>();

        for (const tileKey of tileKeys) {
            if (!tileKey) {
                continue;
            }

            const canonicalTileKey = this.canonicalizeMapTileKey(tileKey);
            const parsedTileKey = this.parseMapTileKeySafe(canonicalTileKey);
            if (!parsedTileKey) {
                continue;
            }
            const [mapId, layerId, tileId] = parsedTileKey;

            let tile = this.loadedTileLayers.get(canonicalTileKey);
            if (tile && tile.hasData()) {
                result.set(tileKey, tile);
                result.set(canonicalTileKey, tile);
                continue;
            }

            if (this.tilePipelinePaused) {
                this.showPausedTileLoadInfoOnce();
                continue;
            }

            const selectionTileRequest: SelectionTileRequest =  {
                remoteRequest: {
                    mapId: mapId,
                    layerId: layerId,
                    tileIds: [Number(tileId)],
                },
                tileKey: canonicalTileKey,
                resolveWhenInspectionComplete: false,
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
            result.set(canonicalTileKey, tile);
        }

        return result;
    }

    /**
     * Resolves tile/feature ids to `FeatureWrapper`s.
     * `allowIncomplete` keeps selection restore usable before all tile stages arrived.
     */
    async loadFeatures(
        tileFeatureIds: (TileFeatureId | null)[],
        options?: {allowIncomplete?: boolean}
    ): Promise<FeatureWrapper[]> {
        const normalizedIds = tileFeatureIds.filter((tileFeatureId): tileFeatureId is TileFeatureId => !!tileFeatureId);
        const allowIncomplete = options?.allowIncomplete ?? false;

        if (allowIncomplete) {
            const features: FeatureWrapper[] = [];

            for (const id of normalizedIds) {
                const canonicalTileKey = this.canonicalizeMapTileKey(id.mapTileKey);
                const parsedTileKey = this.parseMapTileKeySafe(canonicalTileKey);
                let tile = this.loadedTileLayers.get(canonicalTileKey) ?? this.loadedTileLayers.get(id.mapTileKey);

                if (!tile && parsedTileKey) {
                    const [mapId, layerId, tileId] = parsedTileKey;
                    this.ensureTilePlaceholder(mapId, layerId, tileId, true);
                    tile = this.loadedTileLayers.get(canonicalTileKey);
                }

                if (!tile) {
                    console.error(`Could not prepare tile ${id.mapTileKey} for inspection restore!`);
                    continue;
                }

                tile.preventCulling = true;

                const resolvedFeatureId = id.featureId || "";
                if (!resolvedFeatureId) {
                    continue;
                }

                const inspectionDataComplete = this.isTileInspectionDataComplete(tile);
                if (!inspectionDataComplete) {
                    if (parsedTileKey) {
                        const [mapId, layerId, tileId] = parsedTileKey;
                        this.pinTileForSelectionInspection(mapId, layerId, tileId, canonicalTileKey);
                    }
                    features.push(new FeatureWrapper(resolvedFeatureId, tile));
                    continue;
                }

                if (!tile.has(resolvedFeatureId)) {
                    const [mapId, layerId, tileId] = parsedTileKey ?? ["", "", 0n];
                    this.showErrorMessage(
                        `The feature ${id.featureId} does not exist in the ${layerId} layer of tile ${tileId} of map ${mapId}.`);
                    continue;
                }

                features.push(new FeatureWrapper(resolvedFeatureId, tile));
            }

            return features;
        }

        const tiles = await this.loadTiles(new Set(normalizedIds.map(id => id.mapTileKey)));
        const features: FeatureWrapper[] = [];
        for (const id of normalizedIds) {
            const tile = tiles.get(id?.mapTileKey || "");
            if (!tile) {
                console.error(`Could not load tile ${id?.mapTileKey} for highlighting!`);
                continue;
            }

            const resolvedFeatureId = id?.featureId || "";
            if (!resolvedFeatureId) {
                continue;
            }
            if (!tile.has(resolvedFeatureId)) {
                const parsedTileKey = this.parseMapTileKeySafe(id?.mapTileKey || "");
                const [mapId, layerId, tileId] = parsedTileKey ?? ["", "", 0n];
                this.showErrorMessage(
                    `The feature ${id?.featureId} does not exist in the ${layerId} layer of tile ${tileId} of map ${mapId}.`);
                continue;
            }

            features.push(new FeatureWrapper(resolvedFeatureId, tile));
        }
        return features;
    }

    /** Hydrates an incoming tile payload and updates caches. */
    addTileFeatureLayer(tileLayerBlob: Uint8Array, preventCulling: boolean = false) {
        const mapTileMetadata = uint8ArrayToWasm(wasmBlob => {
            return this.mapInfo.tileLayerParser.readTileLayerMetadata(wasmBlob);
        }, tileLayerBlob) as {
            id: string;
            mapName: string;
            layerName: string;
            tileId: bigint;
            stage?: number;
        };
        const tileStage = Number.isInteger(mapTileMetadata.stage) ? Number(mapTileMetadata.stage) : 0;
        const canonicalMapTileKey = mapTileMetadata.id
            ? this.canonicalizeMapTileKey(mapTileMetadata.id)
            : coreLib.getTileFeatureLayerKey(
                mapTileMetadata.mapName,
                mapTileMetadata.layerName,
                mapTileMetadata.tileId);
        const existingTile = this.loadedTileLayers.get(canonicalMapTileKey);
        let tileLayer: FeatureTile;
        if (existingTile) {
            tileLayer = existingTile;
            tileLayer.preventCulling = tileLayer.preventCulling || preventCulling;
            tileLayer.hydrateFromBlob(tileLayerBlob, tileStage);
        } else {
            tileLayer = new FeatureTile(this.mapInfo.tileLayerParser, tileLayerBlob, preventCulling);
            this.loadedTileLayers.set(canonicalMapTileKey, tileLayer);
        }
        this.mapInfo.trackObservedLayerStage(mapTileMetadata.mapName, mapTileMetadata.layerName, tileStage);
        this.expandRequestedStageProgressForObservedStage(mapTileMetadata.mapName, mapTileMetadata.layerName);
        this.markRequestedStageAsReceived(canonicalMapTileKey, tileStage);

        this.resolveWaitingSelectionTileRequests(tileLayer);
        this.tileDataChanged.next({tileKey: tileLayer.mapTileKey, tile: tileLayer, reason: "loaded"});
        this.tileCacheChanged.next("loaded");
        if (this.selectedTileKeys.has(tileLayer.mapTileKey)) {
            this.selectionTileUpdated.next(tileLayer.mapTileKey);
        }
        if (tileLayer.legalInfo) {
            this.mapInfo.setLegalInfo(tileLayer.mapName, tileLayer.legalInfo);
        }
    }

    /** Parses a streamed TileSearchResultLayer and forwards its compact UI payload. */
    private addTileSearchResultLayer(searchResultLayerBlob: Uint8Array) {
        const searchResultLayer = uint8ArrayToWasm(wasmBlob => {
            return this.mapInfo.tileLayerParser.readTileSearchResultLayer(wasmBlob) as TileSearchResultLayerLike;
        }, searchResultLayerBlob);
        if (!searchResultLayer) {
            return;
        }

        try {
            const rawInfo = (searchResultLayer.info?.() ?? {}) as Record<string, unknown>;
            const searchId = typeof rawInfo["searchId"] === "string" ? rawInfo["searchId"] : "";
            if (!searchId) {
                return;
            }

            const refresh = Number(rawInfo["refresh"] ?? 0);
            const resultFieldsValue = searchResultLayer.resultFields?.();
            const resultFields = Array.isArray(resultFieldsValue) ? resultFieldsValue.map(String) : [];
            const resultCountValue = Number(rawInfo["resultCount"] ?? searchResultLayer.numResults?.() ?? 0);
            const tileId = this.bigIntFromUnknown(searchResultLayer.tileId());
            const sourceMapId = typeof rawInfo["sourceMapId"] === "string"
                ? rawInfo["sourceMapId"]
                : searchResultLayer.mapId();
            const sourceLayerId = typeof rawInfo["sourceLayerId"] === "string"
                ? rawInfo["sourceLayerId"]
                : searchResultLayer.layerId();
            const sourceTileId = rawInfo["sourceTileId"] !== undefined
                ? this.bigIntFromUnknown(rawInfo["sourceTileId"], tileId)
                : tileId;
            const sourceTileKey = coreLib.getTileFeatureLayerKey(sourceMapId, sourceLayerId, sourceTileId);
            const rawEntriesValue = searchResultLayer.resultEntries?.();
            const rawEntries = Array.isArray(rawEntriesValue) ? rawEntriesValue as SearchResultTileEntry[] : [];
            const entries = rawEntries.map(entry => ({
                ...entry,
                mapTileKey: entry.mapTileKey
                    ? this.canonicalizeMapTileKey(entry.mapTileKey)
                    : sourceTileKey
            }));
            const tracesValue = rawInfo["traces"];
            const traces = tracesValue && typeof tracesValue === "object" && !Array.isArray(tracesValue)
                ? tracesValue as Record<string, unknown>
                : null;
            const diagnostics = searchResultLayer.copyDiagnostics
                ? uint8ArrayFromWasm(buffer => {
                    searchResultLayer.copyDiagnostics?.(buffer);
                    return true;
                })
                : null;
            const normalizedRefresh = Number.isFinite(refresh) ? refresh : 0;
            const accepted = this.addSearchResultRenderTile(
                searchId,
                normalizedRefresh,
                sourceTileKey,
                sourceMapId,
                sourceLayerId,
                sourceTileId,
                searchResultLayer.nodeId(),
                searchResultLayerBlob,
                Number.isFinite(resultCountValue) ? resultCountValue : entries.length
            );
            if (!accepted) {
                return;
            }
            const progress = this.featureSearchProgressSnapshot(searchId);

            this.searchResultTileReceived.next({
                searchId,
                refresh: normalizedRefresh,
                mapId: searchResultLayer.mapId(),
                layerId: searchResultLayer.layerId(),
                tileId,
                sourceTileKey,
                sourceMapId,
                sourceLayerId,
                sourceTileId,
                resultCount: Number.isFinite(resultCountValue) ? resultCountValue : entries.length,
                resultFields,
                ...progress,
                traces,
                diagnostics,
                entries
            });
        } finally {
            searchResultLayer.delete?.();
        }
    }

    /** Stores one streamed result layer for queued high-fidelity rendering. */
    private addSearchResultRenderTile(
        searchId: string,
        refresh: number,
        sourceTileKey: string,
        sourceMapId: string,
        sourceLayerId: string,
        sourceTileId: bigint,
        nodeId: string,
        layerBlob: Uint8Array,
        resultCount: number
    ): boolean {
        if (!this.activeFeatureSearchRequests.has(searchId)) {
            return false;
        }
        const currentRefresh = this.featureSearchRefreshById.get(searchId);
        if (currentRefresh !== undefined && refresh !== currentRefresh) {
            return false;
        }
        const previousMaxRefresh = this.searchResultMaxRefreshById.get(searchId) ?? -1;
        if (refresh < previousMaxRefresh) {
            return false;
        }
        if (refresh > previousMaxRefresh) {
            this.clearSearchResultRenderTilesForSearch(searchId, refresh);
            this.searchResultMaxRefreshById.set(searchId, refresh);
        }
        this.markFeatureSearchTileCompleted(searchId, refresh, sourceTileKey);
        if (resultCount <= 0) {
            this.removeSearchResultRenderTile(searchId, sourceTileKey);
            return true;
        }

        const update = {refresh, nodeId, layerBlob};
        const key = this.searchResultRenderTileKey(searchId, sourceTileKey);
        const tile = this.searchResultRenderTilesByKey.get(key)?.tile ?? new SearchResultTile(
            this.mapInfo.tileLayerParser,
            searchId,
            sourceTileKey,
            sourceMapId,
            sourceLayerId,
            sourceTileId,
            update
        );
        if (this.searchResultRenderTilesByKey.has(key)) {
            tile.update(update);
        }
        tile.setRenderOrder(this.searchResultTileRenderOrder(sourceTileId));
        this.searchResultRenderTilesByKey.set(key, {
            searchId,
            refresh,
            sourceTileKey,
            sourceMapId,
            sourceLayerId,
            sourceTileId,
            tile
        });
        this.searchRenderTileChanged.next(tile);
        return true;
    }

    /** Removes one cached search-result tile and notifies render/UI consumers. */
    private removeSearchResultRenderTile(searchId: string, sourceTileKey: string): void {
        const key = this.searchResultRenderTileKey(searchId, sourceTileKey);
        const renderTile = this.searchResultRenderTilesByKey.get(key);
        if (!renderTile || !this.searchResultRenderTilesByKey.delete(key)) {
            return;
        }
        renderTile.tile.dispose();
        this.searchRenderTileRemoved.next({searchId, sourceTileKey});
    }

    /** Removes cached result tiles for a search, optionally only stale refreshes. */
    private clearSearchResultRenderTilesForSearch(searchId: string, refreshBefore?: number): void {
        for (const renderTile of Array.from(this.searchResultRenderTilesByKey.values())) {
            if (renderTile.searchId !== searchId) {
                continue;
            }
            if (refreshBefore !== undefined && renderTile.refresh >= refreshBefore) {
                continue;
            }
            this.removeSearchResultRenderTile(searchId, renderTile.sourceTileKey);
        }
        if (refreshBefore === undefined) {
            this.searchResultMaxRefreshById.delete(searchId);
        }
    }

    /** Evicts cached tiles that are neither visible nor pinned for selection/inspection. */
    private updateEvictLoadedLayers() {
        const evictTileLayer = (tileLayer: FeatureTile) => {
            if (tileLayer.preventCulling || this.selectedTileKeys.has(tileLayer.mapTileKey)) {
                return false;
            }
            return this.viewState.viewVisualizationState.every((_, viewIndex) => {
                return !this.viewShowsFeatureTile(viewIndex, tileLayer);
            });
        }
        const newTileLayers = new Map<string, FeatureTile>();
        for (const tileLayer of this.loadedTileLayers.values()) {
            if (evictTileLayer(tileLayer)) {
                tileLayer.dispose();
                this.tileDataChanged.next({tileKey: tileLayer.mapTileKey, tile: tileLayer, reason: "evicted"});
            } else {
                newTileLayers.set(tileLayer.mapTileKey, tileLayer);
            }
        }
        this.loadedTileLayers.clear();
        for (const [key, tile] of newTileLayers) {
            this.loadedTileLayers.set(key, tile);
        }
    }

    /** Recomputes the logical `/tiles` request from visible tiles and pinned selection tiles. */
    private async updateMapDataRequest() {
        if (this.tilePipelinePaused) {
            return;
        }

        const requestByLayer = new Map<string, LayerRequestEntry>();
        const expectedByLayer = new Map<string, ExpectedLayerEntry>();
        const visibleSearchLayerTiles = new Map<string, SearchLayerTileSet>();
        const queueTile = (
            mapId: string,
            layerId: string,
            tileId: number,
            nextMissingStage: number,
            priority = false
        ) => {
            const tileLevel = Math.trunc(tileId % 0x10000);
            const key = `${mapId}/${layerId}/${tileLevel}`;
            let entry = requestByLayer.get(key);
            if (!entry) {
                entry = {mapId, layerId, tileIdToNextMissingStage: new Map<number, number>(), priorityTileIds: new Set<number>()};
                requestByLayer.set(key, entry);
            }
            if (priority) {
                entry.priorityTileIds.add(tileId);
            }
            const previousStage = entry.tileIdToNextMissingStage.get(tileId);
            if (previousStage === undefined || nextMissingStage < previousStage) {
                entry.tileIdToNextMissingStage.set(tileId, nextMissingStage);
            }
        };
        const trackRequestedTile = (mapId: string, layerId: string, tileId: number, requestedMaxStage: number) => {
            const key = `${mapId}/${layerId}`;
            let entry = expectedByLayer.get(key);
            if (!entry) {
                entry = {mapId, layerId, tileIdToRequestedMaxStage: new Map<number, number>()};
                expectedByLayer.set(key, entry);
            }
            const previousMaxStage = entry.tileIdToRequestedMaxStage.get(tileId);
            if (previousMaxStage === undefined || requestedMaxStage > previousMaxStage) {
                entry.tileIdToRequestedMaxStage.set(tileId, requestedMaxStage);
            }
        };

        for (const selectionTileRequest of this.selectionTileRequests) {
            const mapLayerItem = this.mapInfo.maps.maps
                .get(selectionTileRequest.remoteRequest.mapId)?.layers
                .get(selectionTileRequest.remoteRequest.layerId);
            if (mapLayerItem) {
                for (const tileId of selectionTileRequest.remoteRequest.tileIds) {
                    this.ensureTilePlaceholder(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId,
                        BigInt(tileId),
                        true);
                    const selectionStageCount = this.mapInfo.getLayerStageCount(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId
                    );
                    const selectionRequestedMaxStage = Math.max(0, selectionStageCount - 1);
                    trackRequestedTile(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId,
                        tileId,
                        selectionRequestedMaxStage
                    );
                    const nextMissingStage = this.tileMinimumMissingStage(
                        selectionTileRequest.remoteRequest.mapId,
                        selectionTileRequest.remoteRequest.layerId,
                        BigInt(tileId),
                        selectionRequestedMaxStage);
                    if (nextMissingStage !== undefined) {
                        queueTile(
                            selectionTileRequest.remoteRequest.mapId,
                            selectionTileRequest.remoteRequest.layerId,
                            tileId,
                            nextMissingStage,
                            true);
                    }
                }
            } else {
                selectionTileRequest.reject!("Map layer is not available.");
            }
        }

        for (const [mapName, map] of this.mapInfo.maps.maps) {
            for (const layer of map.allFeatureLayers()) {
                for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                    if (!this.mapInfo.maps.getMapLayerVisibility(viewIndex, mapName, layer.id)) {
                        continue;
                    }
                    const level = this.viewState.getEffectiveMapLayerLevel(viewIndex, mapName, layer.id);
                    const tileIds = this.viewState.viewVisualizationState[viewIndex].visibleTileIdsPerLevel.get(level);
                    if (tileIds === undefined) {
                        continue;
                    }
                    for (const tileId of tileIds) {
                        const tileMapLayerKey = coreLib.getTileFeatureLayerKey(mapName, layer.id, tileId);
                        const isSelectedTile = this.selectedTileKeys.has(tileMapLayerKey);
                        this.trackVisibleSearchLayerTile(visibleSearchLayerTiles, mapName, layer.id, tileId, isSelectedTile);
                        const existingTile = this.loadedTileLayers.get(tileMapLayerKey);
                        if (!existingTile) {
                            this.ensureTilePlaceholder(mapName, layer.id, tileId, false);
                        }
                        const stageCount = this.mapInfo.getLayerStageCount(mapName, layer.id);
                        const layerMaxStage = Math.max(0, stageCount - 1);
                        trackRequestedTile(mapName, layer.id, Number(tileId), layerMaxStage);
                        const nextMissingStage = this.tileMinimumMissingStage(mapName, layer.id, tileId, layerMaxStage);
                        if (nextMissingStage !== undefined) {
                            queueTile(mapName, layer.id, Number(tileId), nextMissingStage, isSelectedTile);
                        }
                    }
                }
            }
        }

        const requests: any[] = Array.from(requestByLayer.values()).map(entry => {
            let maxRequestedStage = 0;
            for (const nextMissingStage of entry.tileIdToNextMissingStage.values()) {
                if (nextMissingStage > maxRequestedStage) {
                    maxRequestedStage = nextMissingStage;
                }
            }
            const tileIdsByNextStage = Array.from(
                {length: Math.max(1, maxRequestedStage + 1)},
                () => new Array<number>());
            for (const [tileId, nextMissingStage] of entry.tileIdToNextMissingStage.entries()) {
                tileIdsByNextStage[nextMissingStage].push(tileId);
            }
            const request: {
                mapId: string;
                layerId: string;
                tileIdsByNextStage: number[][];
                priorityTileIds?: number[];
            } = {
                mapId: entry.mapId,
                layerId: entry.layerId,
                tileIdsByNextStage,
            };
            if (entry.priorityTileIds.size) {
                request.priorityTileIds = Array.from(entry.priorityTileIds);
            }
            return request;
        });
        requests.push(...this.buildFeatureSearchTileRequests(visibleSearchLayerTiles));

        this.resetRequestedStageProgressFromExpected(expectedByLayer);

        if (this.tilePipelinePaused) {
            return;
        }
        const hasPendingRequestedStages = this.stageRequestProgress
            .some(counter => counter.total > 0 && counter.done < counter.total);
        if (!requests.length && hasPendingRequestedStages) {
            return;
        }
        const requestSent = await this.tileStream!.updateRequest(requests);
        if (requestSent) {
            const previousProgress = this.backendRequestProgress;
            const hasPreviousProgress = previousProgress.total > 0;
            const newTotal = requests.length;
            const preservePreviousProgress = newTotal === 0
                && hasPreviousProgress
                && !previousProgress.allDone;
            if (newTotal > 0) {
                this.backendRequestProgress = {done: 0, total: newTotal, allDone: false};
                this.viewportLoadStartedAtMs = performance.now();
                this.viewportRenderCompletedAtMs = null;
            } else if (!preservePreviousProgress) {
                this.backendRequestProgress = {done: 0, total: 0, allDone: true};
                this.viewportLoadStartedAtMs = performance.now();
                this.viewportRenderCompletedAtMs = this.viewportLoadStartedAtMs;
            }
        }
    }

    /** Replaces the expected-stage bookkeeping after a new viewport request was assembled. */
    private resetRequestedStageProgressFromExpected(expectedByLayer: Map<string, ExpectedLayerEntry>) {
        this.requestedLayerProgressByKey.clear();
        if (!expectedByLayer.size) {
            this.rebuildRequestedStageProgressFromLayerState();
            return;
        }

        for (const entry of expectedByLayer.values()) {
            if (!entry.tileIdToRequestedMaxStage.size) {
                continue;
            }
            const layerKey = this.mapInfo.layerRequestKey(entry.mapId, entry.layerId);
            const layerStageCount = Math.max(1, this.mapInfo.getLayerStageCount(entry.mapId, entry.layerId));
            const layerState: RequestedLayerProgressState = {
                mapId: entry.mapId,
                layerId: entry.layerId,
                tileMaxRequestedStageByKey: new Map<string, number>(),
                stageCount: layerStageCount
            };

            for (const [tileId, requestedMaxStage] of entry.tileIdToRequestedMaxStage.entries()) {
                const clampedMaxStage = Math.max(0, Math.min(layerStageCount - 1, Math.floor(requestedMaxStage)));
                const tileKey = coreLib.getTileFeatureLayerKey(entry.mapId, entry.layerId, BigInt(tileId));
                const existingMaxStage = layerState.tileMaxRequestedStageByKey.get(tileKey) ?? -1;
                if (clampedMaxStage > existingMaxStage) {
                    layerState.tileMaxRequestedStageByKey.set(tileKey, clampedMaxStage);
                }
            }

            if (layerState.tileMaxRequestedStageByKey.size) {
                this.requestedLayerProgressByKey.set(layerKey, layerState);
            }
        }

        this.mapInfo.setRequestedLayerProgress(this.requestedLayerProgressByKey);
        this.rebuildRequestedStageProgressFromLayerState();
    }

    /** Recomputes per-stage progress from the currently expected layers and the already loaded tiles. */
    private rebuildRequestedStageProgressFromLayerState() {
        this.stageRequestProgress = [];
        this.pendingRequestedTileKeysByStage = [];
        if (!this.requestedLayerProgressByKey.size) {
            return;
        }

        const ensureStageCapacity = (stage: number) => {
            while (this.pendingRequestedTileKeysByStage.length <= stage) {
                this.pendingRequestedTileKeysByStage.push(new Set<string>());
            }
        };

        for (const layerState of this.requestedLayerProgressByKey.values()) {
            if (!layerState.tileMaxRequestedStageByKey.size) {
                continue;
            }
            for (const [tileKey, maxRequestedStage] of layerState.tileMaxRequestedStageByKey.entries()) {
                const stageLimit = Math.max(0, Math.min(layerState.stageCount - 1, Math.floor(maxRequestedStage)));
                for (let stage = 0; stage <= stageLimit; stage++) {
                    ensureStageCapacity(stage);
                    this.pendingRequestedTileKeysByStage[stage].add(tileKey);
                }
            }
        }

        for (let stage = 0; stage < this.pendingRequestedTileKeysByStage.length; stage++) {
            const pendingSet = this.pendingRequestedTileKeysByStage[stage];
            const totalRequested = pendingSet.size;
            for (const tileKey of Array.from(pendingSet)) {
                const loadedTile = this.loadedTileLayers.get(tileKey);
                if (loadedTile && loadedTile.hasStage(stage)) {
                    pendingSet.delete(tileKey);
                }
            }
            this.stageRequestProgress[stage] = {
                total: totalRequested,
                done: Math.max(0, totalRequested - pendingSet.size),
            };
        }
    }

    /** Expands requested-stage bookkeeping if payloads reveal additional stages. */
    private expandRequestedStageProgressForObservedStage(mapId: string, layerId: string): void {
        const layerKey = this.mapInfo.layerRequestKey(mapId, layerId);
        const requestedLayerState = this.requestedLayerProgressByKey.get(layerKey);
        if (!requestedLayerState) {
            return;
        }
        const observedStageCount = this.mapInfo.getLayerStageCount(mapId, layerId);
        if (observedStageCount <= requestedLayerState.stageCount) {
            return;
        }
        const oldMaxStage = requestedLayerState.stageCount - 1;
        requestedLayerState.stageCount = observedStageCount;
        const newMaxStage = observedStageCount - 1;
        for (const [tileKey, maxRequestedStage] of requestedLayerState.tileMaxRequestedStageByKey.entries()) {
            if (maxRequestedStage >= oldMaxStage) {
                requestedLayerState.tileMaxRequestedStageByKey.set(tileKey, newMaxStage);
            }
        }
        this.mapInfo.setRequestedLayerProgress(this.requestedLayerProgressByKey);
        this.rebuildRequestedStageProgressFromLayerState();
    }

    /** Marks one requested tile/stage pair as received and updates the derived progress counters. */
    private markRequestedStageAsReceived(tileKey: string, stage: number) {
        if (!Number.isInteger(stage) || stage < 0 || stage >= this.pendingRequestedTileKeysByStage.length) {
            return;
        }
        const pendingSet = this.pendingRequestedTileKeysByStage[stage];
        if (!pendingSet.delete(tileKey)) {
            return;
        }
        const counter = this.stageRequestProgress[stage];
        if (!counter) {
            return;
        }
        counter.done = Math.max(0, counter.total - pendingSet.size);
    }

    /** Returns whether a tile should currently be visible in a view after viewport and level checks. */
    viewShowsFeatureTile(viewIndex: number, tile: FeatureTile, skipViewportCheck: boolean = false) {
        const viewState = this.viewState.viewVisualizationState[viewIndex];
        if (!viewState) {
            console.error("Attempt to access non-existing view index.");
            return false;
        }
        if (!skipViewportCheck && !viewState.visibleTileIds.has(tile.tileId)) {
            return false;
        }
        return this.mapInfo.maps.getMapLayerVisibility(viewIndex, tile.mapName, tile.layerName) &&
            tile.level() === this.viewState.getEffectiveMapLayerLevel(viewIndex, tile.mapName, tile.layerName);
    }

    /** Returns loaded tiles ordered by visibility, render order, and backend priority for diagnostics. */
    getPrioritisedTiles(viewIndex: number) {
        const state = this.viewState.viewVisualizationState[viewIndex];
        const tiles = new Array<{
            visibilityRank: number;
            renderOrderRank: number;
            priorityRank: number;
            tile: FeatureTile;
        }>();
        for (const [_, tile] of this.loadedTileLayers) {
            if (!tile.hasData()) {
                continue;
            }
            const isVisibleInView = this.viewShowsFeatureTile(viewIndex, tile);
            const renderOrderRank = state.getTileOrder(tile.tileId);
            const priorityRank = coreLib.getTilePriorityById(state.viewport, tile.tileId);
            tiles.push({visibilityRank: isVisibleInView ? 0 : 1, renderOrderRank, priorityRank, tile});
        }
        tiles.sort((lhs, rhs) => {
            if (lhs.visibilityRank !== rhs.visibilityRank) {
                return lhs.visibilityRank - rhs.visibilityRank;
            }
            if (lhs.renderOrderRank !== rhs.renderOrderRank) {
                return lhs.renderOrderRank - rhs.renderOrderRank;
            }
            if (lhs.priorityRank !== rhs.priorityRank) {
                return rhs.priorityRank - lhs.priorityRank;
            }
            return lhs.tile.mapTileKey.localeCompare(rhs.tile.mapTileKey);
        });
        return tiles.map(val => val.tile);
    }

    /** Normalizes tile keys so legacy and canonical string forms map to the same cache entry. */
    canonicalizeMapTileKey(tileKey: string): string {
        const parsed = this.parseMapTileKeySafe(tileKey);
        if (!parsed) {
            return tileKey;
        }
        const [mapId, layerId, tileId] = parsed;
        return coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
    }

    /** Parses tile keys defensively, including a fallback for older slash-separated forms. */
    parseMapTileKeySafe(tileKey: string): [string, string, bigint] | null {
        try {
            const [mapId, layerId, tileId] = coreLib.parseMapTileKey(tileKey);
            return [mapId, layerId, this.bigIntFromUnknown(tileId)];
        } catch (_error) {
            const parts = tileKey.split('/');
            if (parts.length < 3) {
                return null;
            }
            try {
                return [parts[0], parts[1], BigInt(parts[2])];
            } catch (_parseError) {
                return null;
            }
        }
    }

    /** Converts embind-returned ids to bigint without assuming one fixed JS representation. */
    private bigIntFromUnknown(value: unknown, fallback: bigint = 0n): bigint {
        if (typeof value === "bigint") {
            return value;
        }
        if (typeof value === "number" && Number.isFinite(value)) {
            return BigInt(Math.trunc(value));
        }
        if (typeof value === "string" && value.length > 0) {
            try {
                return BigInt(value);
            } catch (_error) {
                return fallback;
            }
        }
        return fallback;
    }

    /** Ensures a placeholder `FeatureTile` exists so selection and progress logic can reference missing tiles. */
    private ensureTilePlaceholder(mapId: string, layerId: string, tileId: bigint, preventCulling: boolean): boolean {
        const tileKey = coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
        const existing = this.loadedTileLayers.get(tileKey);
        if (existing) {
            if (preventCulling) {
                existing.preventCulling = true;
            }
            return false;
        }

        const placeholder = new FeatureTile(this.mapInfo.tileLayerParser, null, preventCulling, {
            mapTileKey: tileKey,
            mapName: mapId,
            layerName: layerId,
            tileId: tileId,
        });
        this.loadedTileLayers.set(tileKey, placeholder);
        this.tileDataChanged.next({tileKey, tile: placeholder, reason: "placeholder"});
        this.tileCacheChanged.next("placeholder");

        return true;
    }

    /** Pins a tile until inspection has seen every advertised stage, without exposing a caller-visible promise. */
    private pinTileForSelectionInspection(mapId: string, layerId: string, tileId: bigint, canonicalTileKey: string): void {
        if (this.selectionTileRequests.some(request => request.tileKey === canonicalTileKey)) {
            return;
        }

        this.selectionTileRequests.push({
            remoteRequest: {mapId, layerId, tileIds: [Number(tileId)]},
            tileKey: canonicalTileKey,
            resolveWhenInspectionComplete: true,
            resolve: () => {},
            reject: () => {}
        });
        this.scheduleUpdate();
    }

    /** Resolves pending selection tile requests satisfied by one hydrated tile. */
    private resolveWaitingSelectionTileRequests(tileLayer: FeatureTile): void {
        const retainedRequests: SelectionTileRequest[] = [];
        for (const request of this.selectionTileRequests) {
            if (tileLayer.mapTileKey !== request.tileKey) {
                retainedRequests.push(request);
                continue;
            }
            if (request.resolveWhenInspectionComplete && !this.isTileInspectionDataComplete(tileLayer)) {
                retainedRequests.push(request);
                continue;
            }
            request.resolve!(tileLayer);
        }
        this.selectionTileRequests.length = 0;
        this.selectionTileRequests.push(...retainedRequests);
    }

    /** Emits the paused-pipeline info toast only once per paused interval. */
    private showPausedTileLoadInfoOnce() {
        if (this.blockedTileLoadInfoShown) {
            return;
        }
        this.blockedTileLoadInfoShown = true;
        this.showInfoMessage('Tile pipeline is paused; cannot load additional tiles');
    }

    /** Returns the earliest missing stage for a tile, clamped to the stage actually requested. */
    private tileMinimumMissingStage(
        mapId: string,
        layerId: string,
        tileId: bigint,
        requestedMaxStage?: number
    ): number | undefined {
        const tileKey = coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
        const tile = this.loadedTileLayers.get(tileKey);
        const stageCount = this.mapInfo.getLayerStageCount(mapId, layerId);
        const clampedMaxStage = Math.max(0, Math.min(stageCount - 1, Math.floor(requestedMaxStage ?? (stageCount - 1))));
        if (!tile) {
            return clampedMaxStage >= 0 ? 0 : undefined;
        }
        return tile.nextMissingStage(clampedMaxStage + 1);
    }

    /** Updates backend progress and surfaces terminal request failures from `/tiles` status payloads. */
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
        if (!requests.length) {
            if (status.allDone && this.backendRequestProgress.total > 0 && !this.backendRequestProgress.allDone) {
                this.backendRequestProgress = {
                    ...this.backendRequestProgress,
                    done: this.backendRequestProgress.total,
                    allDone: true,
                    requestId: status.requestId ?? this.backendRequestProgress.requestId
                };
                this.tryFinalizeViewportRenderDuration();
            }
            return;
        }
        const doneRequests = requests.filter(req => req.status !== MapTileRequestStatus.Open).length;
        this.backendRequestProgress = {done: doneRequests, total: requests.length, allDone: !!status.allDone, requestId: status.requestId};
        this.tryFinalizeViewportRenderDuration();

        if (!status.allDone) {
            return;
        }
        const failures = requests.filter(req =>
            req.status !== MapTileRequestStatus.Success && req.status !== MapTileRequestStatus.Open);
        if (!failures.length) {
            return;
        }
        const summary = failures
            .map(req => {
                const noDataSourceSuffix = req.status === MapTileRequestStatus.NoDataSource && req.noDataSourceReason
                    ? ` (${req.noDataSourceReason})`
                    : "";
                return `${req.mapId}/${req.layerId}: ${req.statusText}${noDataSourceSuffix}`;
            })
            .join(", ");
        const detail = statusMessage ? ` (${statusMessage})` : "";
        this.showErrorMessage(`Tile request failed: ${summary}${detail}`);
    }

    /** Publishes server-side search progress independently from regular tile request progress. */
    private handleSearchStatus(status: MapTileStreamSearchStatusPayload) {
        if (!status || status.type !== "mapget.search.status") {
            return;
        }
        if (!this.activeFeatureSearchRequests.has(status.searchId)) {
            return;
        }
        const refresh = Number(status.refresh ?? 0);
        const currentRefresh = this.featureSearchRefreshById.get(status.searchId);
        if (currentRefresh !== undefined && refresh !== currentRefresh) {
            return;
        }
        this.searchStatusReceived.next({...status, ...this.featureSearchProgressSnapshot(status.searchId)});
    }

    /** Resolves persisted search scope state to the concrete token expected by mapget. */
    private resolveFeatureSearchScope(request: FeatureSearchDataPlaneRequest): "feature" | "attribute" {
        if (request.scope === "feature" || request.scope === "attribute") {
            return request.scope;
        }
        return this.mapInfo.isAttributeScopeSearchQuery(request.query) ? "attribute" : "feature";
    }

    /** Encodes map/layer ids without relying on slash splitting, since map ids may be grouped paths. */
    private featureSearchLayerKey(mapId: string, layerId: string): string {
        return JSON.stringify([mapId, layerId]);
    }

    /** Adds one source tile to the reusable visible-tile plan consumed by map loading and search. */
    private trackVisibleSearchLayerTile(
        visibleLayerTiles: Map<string, SearchLayerTileSet>,
        mapId: string,
        layerId: string,
        tileId: bigint,
        priority: boolean
    ): void {
        const key = this.featureSearchLayerKey(mapId, layerId);
        let entry = visibleLayerTiles.get(key);
        if (!entry) {
            entry = {mapId, layerId, tileIds: new Set<number>(), priorityTileIds: new Set<number>()};
            visibleLayerTiles.set(key, entry);
        }
        const numericTileId = Number(tileId);
        entry.tileIds.add(numericTileId);
        if (priority) {
            entry.priorityTileIds.add(numericTileId);
        }
    }

    /** Decodes a key produced by featureSearchLayerKey(). */
    private parseFeatureSearchLayerKey(key: string): {mapId: string; layerId: string} | null {
        try {
            const parsed = JSON.parse(key);
            if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
                return {mapId: parsed[0], layerId: parsed[1]};
            }
        } catch (_error) {
            // Ignore malformed legacy keys.
        }
        return null;
    }

    /** Builds the stable logical-search fingerprint that owns the backend refresh generation. */
    private featureSearchDefinitionFingerprint(request: FeatureSearchDataPlaneRequest): string {
        return JSON.stringify({
            searchId: request.searchId,
            generationSerial: request.generationSerial,
            query: request.query,
            scope: this.resolveFeatureSearchScope(request),
            withFields: request.withFields
        });
    }

    /** Bumps refresh only when old chunks for this search id must be treated as stale. */
    private refreshForFeatureSearchDefinition(request: FeatureSearchDataPlaneRequest): number {
        const fingerprint = this.featureSearchDefinitionFingerprint(request);
        const searchId = request.searchId;
        if (this.featureSearchFingerprintById.get(searchId) === fingerprint) {
            return this.featureSearchRefreshById.get(searchId) ?? 0;
        }
        const nextRefresh = (this.featureSearchRefreshById.get(searchId) ?? 0) + 1;
        this.featureSearchFingerprintById.set(searchId, fingerprint);
        this.featureSearchRefreshById.set(searchId, nextRefresh);
        this.clearFeatureSearchTileStates(searchId, true);
        return nextRefresh;
    }

    /** Returns the mutable per-source-tile state table for one search. */
    private featureSearchTileStates(searchId: string): Map<string, FeatureSearchTileState> {
        let states = this.featureSearchTileStatesById.get(searchId);
        if (!states) {
            states = new Map<string, FeatureSearchTileState>();
            this.featureSearchTileStatesById.set(searchId, states);
        }
        return states;
    }

    /** Returns all concrete source layers currently represented by one search's tile state. */
    private layerKeysForFeatureSearchTileStates(searchId: string): Set<string> {
        const result = new Set<string>();
        const states = this.featureSearchTileStatesById.get(searchId);
        if (!states) {
            return result;
        }
        for (const state of states.values()) {
            result.add(this.featureSearchLayerKey(state.mapId, state.layerId));
        }
        return result;
    }

    /** Removes one source tile from local search coverage and optionally from UI-facing result state. */
    private removeFeatureSearchTileState(searchId: string, sourceTileKey: string, notifyEviction: boolean): void {
        const states = this.featureSearchTileStatesById.get(searchId);
        states?.delete(sourceTileKey);
        this.removeSearchResultRenderTile(searchId, sourceTileKey);
        if (notifyEviction) {
            this.searchResultTileEvicted.next({searchId, sourceTileKey});
        }
    }

    /** Clears all per-tile state for one search generation. */
    private clearFeatureSearchTileStates(searchId: string, notifyEvictions: boolean): void {
        const states = this.featureSearchTileStatesById.get(searchId);
        if (states) {
            for (const sourceTileKey of Array.from(states.keys())) {
                this.removeFeatureSearchTileState(searchId, sourceTileKey, notifyEvictions);
            }
        }
        this.featureSearchTileStatesById.delete(searchId);
        this.lastFeatureSearchUpdateSerialById.delete(searchId);
        this.clearSearchResultRenderTilesForSearch(searchId);
    }

    /** Freezes current results but makes unfinished tiles eligible for re-request after resume. */
    private markFeatureSearchTilesPending(searchId: string): void {
        const states = this.featureSearchTileStatesById.get(searchId);
        if (!states) {
            return;
        }
        for (const state of states.values()) {
            if (!state.completed) {
                state.requested = false;
            }
        }
    }

    /** Adopts the current visible tile plan for an auto-update or explicit area update. */
    private adoptFeatureSearchVisibleTiles(
        searchId: string,
        refresh: number,
        visibleLayerTiles: Map<string, SearchLayerTileSet>
    ): void {
        const states = this.featureSearchTileStates(searchId);
        const desiredKeys = new Set<string>();
        for (const entry of visibleLayerTiles.values()) {
            for (const tileId of entry.tileIds) {
                const sourceTileKey = coreLib.getTileFeatureLayerKey(entry.mapId, entry.layerId, BigInt(tileId));
                desiredKeys.add(sourceTileKey);
                const priority = entry.priorityTileIds.has(tileId);
                const existing = states.get(sourceTileKey);
                if (existing && existing.refresh === refresh) {
                    existing.priority = priority;
                    continue;
                }
                states.set(sourceTileKey, {
                    mapId: entry.mapId,
                    layerId: entry.layerId,
                    tileId,
                    sourceTileKey,
                    refresh,
                    priority,
                    requested: false,
                    completed: false
                });
            }
        }

        for (const sourceTileKey of Array.from(states.keys())) {
            if (!desiredKeys.has(sourceTileKey)) {
                this.removeFeatureSearchTileState(searchId, sourceTileKey, true);
            }
        }
    }

    /** Marks one streamed search-result tile as completed, including zero-result tiles. */
    private markFeatureSearchTileCompleted(searchId: string, refresh: number, sourceTileKey: string): void {
        const state = this.featureSearchTileStatesById.get(searchId)?.get(sourceTileKey);
        if (!state || state.refresh !== refresh) {
            return;
        }
        state.completed = true;
        state.requested = false;
    }

    /** Returns current full-coverage search progress, independent from the latest differential backend request. */
    private featureSearchProgressSnapshot(searchId: string): {tilesConsidered: number; tilesCompleted: number} {
        const states = this.featureSearchTileStatesById.get(searchId);
        if (!states) {
            return {tilesConsidered: 0, tilesCompleted: 0};
        }
        let tilesCompleted = 0;
        for (const state of states.values()) {
            if (state.completed) {
                tilesCompleted += 1;
            }
        }
        return {tilesConsidered: states.size, tilesCompleted};
    }

    /** Builds one concrete mapget search request object for a map/layer tile set. */
    private createFeatureSearchTileRequest(
        request: FeatureSearchDataPlaneRequest,
        mapId: string,
        layerId: string,
        tileIds: number[],
        priorityTileIds: number[],
        refresh: number
    ): FeatureSearchTileRequest {
        const result: FeatureSearchTileRequest = {
            mapId,
            layerId,
            tileIds,
            searchId: request.searchId,
            refresh,
            searchQuery: request.query,
            searchScope: this.resolveFeatureSearchScope(request),
        };
        if (priorityTileIds.length) {
            result.priorityTileIds = priorityTileIds;
        }
        if (request.withFields.length) {
            result.withFields = request.withFields;
        }
        return result;
    }

    /** Creates empty tile requests that cancel or pause a server-side search on its previously active layers. */
    private createFeatureSearchCancellationRequests(
        request: FeatureSearchDataPlaneRequest,
        layerKeys: Iterable<string>,
        refresh: number
    ): FeatureSearchTileRequest[] {
        const cancellations: FeatureSearchTileRequest[] = [];
        for (const layerKey of layerKeys) {
            const parsed = this.parseFeatureSearchLayerKey(layerKey);
            if (!parsed) {
                continue;
            }
            cancellations.push(this.createFeatureSearchTileRequest(request, parsed.mapId, parsed.layerId, [], [], refresh));
        }
        return cancellations;
    }

    /** Groups incomplete source tiles into concrete backend search requests. */
    private appendFeatureSearchTileRequests(
        requests: FeatureSearchTileRequest[],
        request: FeatureSearchDataPlaneRequest,
        refresh: number
    ): void {
        const states = this.featureSearchTileStatesById.get(request.searchId);
        if (!states) {
            return;
        }
        const statesByLevelLayer = new Map<string, {mapId: string; layerId: string; tileIds: number[]; priorityTileIds: number[]}>();
        for (const state of states.values()) {
            if (state.completed) {
                continue;
            }
            const tileLevel = Math.trunc(state.tileId % 0x10000);
            const key = `${state.mapId}/${state.layerId}/${tileLevel}`;
            let entry = statesByLevelLayer.get(key);
            if (!entry) {
                entry = {mapId: state.mapId, layerId: state.layerId, tileIds: [], priorityTileIds: []};
                statesByLevelLayer.set(key, entry);
            }
            entry.tileIds.push(state.tileId);
            if (state.priority) {
                entry.priorityTileIds.push(state.tileId);
            }
            state.requested = true;
        }

        const sortedEntries = Array.from(statesByLevelLayer.values())
            .sort((lhs, rhs) => lhs.mapId.localeCompare(rhs.mapId) || lhs.layerId.localeCompare(rhs.layerId));
        for (const entry of sortedEntries) {
            entry.tileIds.sort((lhs, rhs) => lhs - rhs);
            entry.priorityTileIds.sort((lhs, rhs) => lhs - rhs);
            requests.push(this.createFeatureSearchTileRequest(request, entry.mapId, entry.layerId, entry.tileIds, entry.priorityTileIds, refresh));
        }
    }

    /** Builds all active server-side search-as-map requests for the next `/tiles` update. */
    private buildFeatureSearchTileRequests(visibleLayerTiles: Map<string, SearchLayerTileSet>): FeatureSearchTileRequest[] {
        const requests: FeatureSearchTileRequest[] = [];

        for (const [searchId, request] of this.activeFeatureSearchRequests) {
            const refresh = this.refreshForFeatureSearchDefinition(request);

            if (request.paused) {
                const cancellationLayerKeys = this.layerKeysForFeatureSearchTileStates(searchId);
                requests.push(...this.createFeatureSearchCancellationRequests(request, cancellationLayerKeys, refresh));
                this.markFeatureSearchTilesPending(searchId);
                continue;
            }

            const lastUpdateSerial = this.lastFeatureSearchUpdateSerialById.get(searchId);
            const shouldAdoptVisibleTiles = request.autoUpdate
                || lastUpdateSerial !== request.updateSerial
                || !this.featureSearchTileStatesById.has(searchId);
            if (shouldAdoptVisibleTiles && (visibleLayerTiles.size > 0 || request.autoUpdate)) {
                this.adoptFeatureSearchVisibleTiles(searchId, refresh, visibleLayerTiles);
                this.lastFeatureSearchUpdateSerialById.set(searchId, request.updateSerial);
            }

            this.appendFeatureSearchTileRequests(requests, request, refresh);
        }

        for (const [searchId, request] of Array.from(this.pendingFeatureSearchCancellations)) {
            const layerKeys = this.pendingFeatureSearchCancellationLayerKeysById.get(searchId);
            if (layerKeys?.size) {
                const refresh = (this.featureSearchRefreshById.get(searchId) ?? 0) + 1;
                requests.push(...this.createFeatureSearchCancellationRequests(request, layerKeys, refresh));
            }
            this.pendingFeatureSearchCancellations.delete(searchId);
            this.pendingFeatureSearchCancellationLayerKeysById.delete(searchId);
            this.lastFeatureSearchUpdateSerialById.delete(searchId);
            this.featureSearchTileStatesById.delete(searchId);
            this.featureSearchRefreshById.delete(searchId);
            this.featureSearchFingerprintById.delete(searchId);
            this.searchResultMaxRefreshById.delete(searchId);
        }

        return requests;
    }

    /** Uses the best visible-tile ordering rank known across views for detached result tiles. */
    private searchResultTileRenderOrder(tileId: bigint): number {
        let order = FeatureTile.DEFAULT_RENDER_ORDER;
        for (const state of this.viewState.viewVisualizationState) {
            order = Math.min(order, state.getTileOrder(tileId));
        }
        return order;
    }

    /** Closes the viewport render timer once backend requests finished. */
    private tryFinalizeViewportRenderDuration() {
        if (!this.backendRequestProgress.allDone) {
            return;
        }
        if (this.viewportLoadStartedAtMs === null || this.viewportRenderCompletedAtMs !== null) {
            return;
        }
        this.viewportRenderCompletedAtMs = performance.now();
    }

    /** Returns the wall-clock duration of the current viewport load, or zero when idle. */
    currentViewportRenderSeconds(): number {
        if (this.viewportLoadStartedAtMs === null) {
            return 0;
        }
        const endTime = this.viewportRenderCompletedAtMs ?? performance.now();
        return Math.max(0, (endTime - this.viewportLoadStartedAtMs) / 1000);
    }

    /** Schedules timer work outside Angular so frequent stream churn does not trigger global change detection. */
    private scheduleOutsideAngular(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
        return this.ngZone.runOutsideAngular(() => setTimeout(callback, delay));
    }

    /** Proxies an info toast through Angular's zone. */
    private showInfoMessage(message: string) {
        this.ngZone.run(() => this.messageService.showInfo(message));
    }

    /** Proxies an error toast through Angular's zone. */
    private showErrorMessage(message: string) {
        this.ngZone.run(() => this.messageService.showError(message));
    }
}
