import {Injectable, NgZone} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";
import {MapInfoService} from "./map-info.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapTileRequestStatus, MapTileStreamClient} from "./tilestream";
import {FeatureSearchResolvedDefinition, FeatureSearchRuntimeState} from "./feature-search-runtime-state.model";
import type {
    MapTileStreamSourceCatalogChangePayload,
    MapTileStreamSearchStatusPayload,
    MapTileStreamStatusPayload,
    MapTileStreamTransportCompressionStats
} from "./tilestream";
import type {TileSearchResultLayer} from "../../build/libs/core/erdblick-core";
import {FeatureTile, FeatureWrapper} from "./features.model";
import {
    BackendRequestProgress,
    FeatureSearchTileRequest,
    MapTileKey,
    RequestedLayerProgressState,
    SearchLayerTileSet,
    SearchCoverageChangedPayload,
    SearchResultTileEntry,
    SearchResultTileEvictedPayload,
    SearchResultTilePayload,
    SearchResultTileRemovedPayload,
    SelectionTileRequest,
    TileDataChange
} from "./map-runtime.model";
import {RelationLocateRequest, RelationLocateResolution, RelationLocateResult} from "./relation-locate.model";
import {SearchResultTile} from "./search-result-tile.model";
import {coreLib, uint8ArrayFromWasm, uint8ArrayToWasm} from "../integrations/wasm";
import {AppStateService, TileFeatureId} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {
    FeatureSearchMapLayerRef,
    FeatureSearchStateEntry,
    featureSearchVisibleInView
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

interface PendingFeatureSearchCancellation {
    runtime: FeatureSearchRuntimeState;
    layerKeys: Set<string>;
    refresh: number;
}

interface FeatureSearchDefinitionUpdateOptions {
    forceGenerationIds?: Iterable<string>;
    updateCoverageIds?: Iterable<string>;
}

interface SearchResultEntryExtractionContext {
    searchId: string;
    refresh: number;
    mapId: string;
    layerId: string;
    tileId: number;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: number;
    requestOrder: number;
    resultCount: number;
    resultFields: string[];
    layerBlob: Uint8Array;
    includeExactPositions: boolean;
}

/**
 * Owns mapget interactive transport, feature/search tile caches, request diffing, and tile-load progress.
 */
@Injectable({providedIn: "root"})
export class MapTileStreamService {
    public readonly loadedTileLayers: Map<MapTileKey, FeatureTile> = new Map();
    public readonly tilePipelinePaused$ = new BehaviorSubject<boolean>(false);
    /** Fine-grained feature-tile payload stream for render/selection consumers. */
    public readonly tileDataChanged = new Subject<TileDataChange>();
    public readonly selectionTileUpdated = new Subject<MapTileKey>();
    public readonly searchResultTileReceived = new Subject<SearchResultTilePayload>();
    public readonly searchResultTileEvicted = new Subject<SearchResultTileEvictedPayload>();
    public readonly searchStatusReceived = new Subject<MapTileStreamSearchStatusPayload>();
    public readonly searchCoverageChanged = new Subject<SearchCoverageChangedPayload>();
    /** Search-result source-tile state changed; consumers may reconcile render/UI projections. */
    public readonly searchResultTileChanged = new Subject<SearchResultTile>();
    /** Search-result source-tile state left the active runtime cache. */
    public readonly searchResultTileRemoved = new Subject<SearchResultTileRemovedPayload>();

    private tileStream: MapTileStreamClient|null = null;
    private readonly selectionTileRequests: SelectionTileRequest[] = [];
    private readonly selectedTileKeys: Set<MapTileKey> = new Set<MapTileKey>();
    private updateTimer: ReturnType<typeof setTimeout> | null = null;
    private updateInProgress = false;
    private updatePending = false;
    private updateRequestedWhilePaused = false;
    private blockedTileLoadInfoShown = false;
    private readonly updateDebounceMs = 50;
    private lastUpdateAt = 0;
    private stageRequestProgress: Array<{done: number; total: number}> = [];
    private pendingRequestedTileKeysByStage: Array<Set<MapTileKey>> = [];
    private requestedLayerProgressByKey: Map<string, RequestedLayerProgressState> = new Map();
    private backendRequestProgress: BackendRequestProgress = {done: 0, total: 0, allDone: true};
    private viewportLoadStartedAtMs: number | null = null;
    private viewportRenderCompletedAtMs: number | null = null;
    /** Per-search runtime state owns differential coverage, refresh generation, and result source tiles. */
    private activeFeatureSearches: Map<string, FeatureSearchRuntimeState> = new Map();
    /** Deferred empty requests that tell mapget to drop removed/paused search layers. */
    private pendingFeatureSearchCancellations: Map<string, PendingFeatureSearchCancellation> = new Map();
    private lastFeatureSearchRequestSignature = "";
    private readonly searchResultEntryBatchSize = 5000;
    private readonly searchResultEntryFrameBudgetMs = 12;
    private sourceCatalogReloadPromise: Promise<void> | null = null;
    private backendProtocolMismatchActive = false;

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
        this.mapInfo.dataSourceInfoChanged.subscribe(() => {
            this.ngZone.runOutsideAngular(() => this.invalidateLoadedDataAfterDataSourceInfoChange());
        });
        this.viewState.viewStateChanged.subscribe(() => this.scheduleUpdate());
    }

    /** Wires the transport callbacks and loads datasource metadata before viewport requests start. */
    async initialize() {
        this.tileStream = new MapTileStreamClient("/interactive", this.mapInfo.tileLayerParser);
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
        this.tileStream.onSourceCatalogChanged = (change) => {
            this.ngZone.runOutsideAngular(() => this.handleSourceCatalogChanged(change));
        };
        this.tileStream.onOpen = () => {
            this.ngZone.run(() => {
                this.backendProtocolMismatchActive = false;
                this.messageService.clearBackendConnectionError();
                this.messageService.clearBackendProtocolError();
            });
        };
        this.tileStream.onProtocolMismatch = (mismatch) => {
            const actual = `${mismatch.actual.major}.${mismatch.actual.minor}.${mismatch.actual.patch}`;
            const expected = `${mismatch.expected.major}.${mismatch.expected.minor}.x`;
            this.backendProtocolMismatchActive = true;
            this.showBackendProtocolErrorMessage(
                `The map backend uses unsupported tile-stream protocol ${actual}; this erdblick build requires ${expected}.`
            );
        };
        this.tileStream.onError = (event) => {
            console.error("Tile WebSocket error.", event);
            if (!this.backendProtocolMismatchActive) {
                this.showBackendConnectionErrorMessage("Could not connect to the map backend.");
            }
        };
        this.tileStream.onClose = (event) => {
            if (!this.backendProtocolMismatchActive && event.code !== 1000) {
                const reason = event.reason ? ` (${event.reason})` : "";
                this.showBackendConnectionErrorMessage(`The map backend connection was closed${reason}.`);
            }
        };
        await this.mapInfo.reloadDataSources();
        this.scheduleUpdate();
    }

    /** Returns whether tile loading and parsing are currently paused. */
    get tilePipelinePaused(): boolean {
        return this.tilePipelinePaused$.getValue();
    }

    /** Replaces the active server-side feature-search definitions used by the next interactive request. */
    setFeatureSearchDefinitions(
        definitions: FeatureSearchResolvedDefinition[],
        options: FeatureSearchDefinitionUpdateOptions = {}
    ): void {
        const forceGenerationIds = new Set(options.forceGenerationIds ?? []);
        const updateCoverageIds = new Set(options.updateCoverageIds ?? []);
        const normalized = definitions
            .filter(definition => definition.id && definition.query)
            .filter(definition => definition.enabled)
            .sort((lhs, rhs) => lhs.id.localeCompare(rhs.id));
        const signature = JSON.stringify(normalized);
        if (signature === this.lastFeatureSearchRequestSignature
            && !forceGenerationIds.size
            && !updateCoverageIds.size) {
            return;
        }

        const nextIds = new Set(normalized.map(definition => definition.id));
        for (const [searchId, runtime] of Array.from(this.activeFeatureSearches.entries())) {
            if (!nextIds.has(searchId)) {
                this.pendingFeatureSearchCancellations.set(searchId, {
                    runtime,
                    layerKeys: runtime.layerKeys(),
                    refresh: runtime.refresh + 1
                });
                this.disposeSearchResultTiles(runtime.clearTiles(), true);
                this.activeFeatureSearches.delete(searchId);
            }
        }

        for (const definition of normalized) {
            let runtime = this.activeFeatureSearches.get(definition.id);
            if (!runtime) {
                runtime = new FeatureSearchRuntimeState(definition, this.mapInfo.tileLayerParser);
                this.activeFeatureSearches.set(definition.id, runtime);
            }
            if (updateCoverageIds.has(definition.id)) {
                runtime.requestCoverageUpdate();
            }
            const removedTiles = runtime.applyDefinition(
                definition,
                forceGenerationIds.has(definition.id)
            );
            this.disposeSearchResultTiles(removedTiles, true);
        }
        this.lastFeatureSearchRequestSignature = signature;
        this.scheduleUpdate();
    }

    /** Returns one active search request, if it still exists. */
    activeFeatureSearchRequest(searchId: string): FeatureSearchStateEntry | undefined {
        return this.activeFeatureSearches.get(searchId)?.definition;
    }

    /** Returns a stable snapshot of active search requests for render ordering. */
    activeFeatureSearchRequestsSnapshot(): FeatureSearchStateEntry[] {
        return Array.from(this.activeFeatureSearches.values()).map(runtime => runtime.definition);
    }

    /** Iterates the current search-result source-tile states. */
    *searchResultTiles(): Iterable<SearchResultTile> {
        for (const runtime of this.activeFeatureSearches.values()) {
            yield* runtime.tilesBySourceKey.values();
        }
    }

    /** Returns whether one search-result source tile exists and currently contains renderable layer data. */
    hasSearchResultTile(searchId: string, sourceTileKey: string): boolean {
        return !!this.activeFeatureSearches.get(searchId)?.tilesBySourceKey.get(sourceTileKey)?.hasResultLayer();
    }

    /** Replaces the tile keys currently pinned by inspection selection. */
    setSelectedTileKeys(tileKeys: Iterable<string>): void {
        this.selectedTileKeys.clear();
        for (const key of tileKeys) {
            this.selectedTileKeys.add(key);
        }
        this.scheduleUpdate();
    }

    /** Returns a snapshot of the current logical interactive backend request progress. */
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

    /** Proxies `/interactive/payload` compression stats while tolerating an uninitialized tile stream. */
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

    /** Drops tile/search payloads decoded against obsolete datasource string pools. */
    private invalidateLoadedDataAfterDataSourceInfoChange(): void {
        this.tileStream?.resetAfterDataSourceInfoChange();
        for (const tile of this.loadedTileLayers.values()) {
            const tileKey = tile.mapTileKey;
            tile.dispose();
            this.tileDataChanged.next({tileKey, tile, reason: "evicted"});
        }
        this.loadedTileLayers.clear();
        this.stageRequestProgress = [];
        this.pendingRequestedTileKeysByStage = [];
        this.requestedLayerProgressByKey.clear();
        this.mapInfo.setRequestedLayerProgress(this.requestedLayerProgressByKey);

        for (const runtime of this.activeFeatureSearches.values()) {
            const removedTiles = runtime.applyDefinition(runtime.definition, true);
            this.disposeSearchResultTiles(removedTiles, true);
            this.emitSearchCoverageChanged(runtime);
        }
        this.scheduleUpdate();
    }

    /** Returns whether the interactive websocket is currently connected. */
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
            await this.updateMapDataRequest();
            if (this.tilePipelinePaused) {
                this.updatePending = true;
                this.updateRequestedWhilePaused = true;
                return;
            }
            this.updateEvictLoadedLayers();
        } finally {
            this.updateInProgress = false;
            this.lastUpdateAt = Date.now();
            if (this.updatePending) {
                this.scheduleUpdate();
            }
        }
    }

    /** Applies lightweight source-status messages or refreshes `/sources` after structural catalog changes. */
    private handleSourceCatalogChanged(change: MapTileStreamSourceCatalogChangePayload): void {
        const currentRevision = this.mapInfo.sourceCatalogRevision;
        if (currentRevision !== null && change.revision < currentRevision) {
            return;
        }
        const requiresFullRefresh = this.sourceCatalogChangeRequiresReload(change);
        if (!requiresFullRefresh && change.source) {
            const needsRefreshAfterPatch = this.mapInfo.sourceCatalogChangeNeedsRefresh(change.source);
            if (this.mapInfo.applySourceCatalogChange(change.source, change.revision)) {
                if (!needsRefreshAfterPatch) {
                    this.scheduleUpdate();
                    return;
                }
            }
        }
        if (!this.sourceCatalogReloadPromise) {
            this.sourceCatalogReloadPromise = this.mapInfo.reloadDataSources()
                .then(() => undefined)
                .finally(() => {
                    this.sourceCatalogReloadPromise = null;
                });
        }
        this.sourceCatalogReloadPromise
            .then(() => this.scheduleUpdate())
            .catch(err => console.error("Failed to refresh datasource catalog.", err));
    }

    /** Returns true for catalog-change reasons that may add/remove/rebuild datasource entries or layers. */
    private sourceCatalogChangeRequiresReload(change: MapTileStreamSourceCatalogChangePayload): boolean {
        const reason = change.reason?.toLowerCase();
        return !change.source
            || reason === "reload"
            || reason === "add"
            || reason === "added"
            || reason === "remove"
            || reason === "removed"
            || reason === "config-error";
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
    async loadTiles(
        tileKeys: Set<string | null>,
        options: {requireAllStages?: boolean} = {}
    ): Promise<Map<string, FeatureTile>> {
        const result = new Map<string, FeatureTile>();
        const requireAllStages = options.requireAllStages ?? false;

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
            if (tile && tile.hasData() && (!requireAllStages || this.isTileInspectionDataComplete(tile))) {
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
                    tileIds: [tileId],
                },
                tileKey: canonicalTileKey,
                resolveWhenInspectionComplete: requireAllStages,
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

    /** Resolves relation targets via `/locate` and ensures the referenced tiles are loaded. */
    async resolveRelationExternalTiles(requests: RelationLocateRequest[]): Promise<RelationLocateResult> {
        if (requests.length === 0) {
            return {responses: [], tiles: []};
        }
        let response: Response | undefined;
        try {
            response = await fetch("locate", {
                body: JSON.stringify({requests}, (_, value) => typeof value === "bigint" ? Number(value) : value),
                method: "POST"
            });
        } catch (error) {
            console.error(`Error during /locate call for relation targets: ${error}`);
            return {responses: [], tiles: []};
        }
        if (!response.ok) {
            console.error(`Locate request for relation targets failed with status ${response.status}.`);
            return {responses: [], tiles: []};
        }
        const locateResponse = await response.json() as {responses?: RelationLocateResolution[][]};
        const tileKeys = new Set<string>();
        for (const resolutions of locateResponse.responses ?? []) {
            for (const resolution of resolutions) {
                if (typeof resolution.tileId === "string" && resolution.tileId.length > 0) {
                    tileKeys.add(resolution.tileId);
                }
            }
        }
        if (tileKeys.size === 0) {
            return {responses: locateResponse.responses ?? [], tiles: []};
        }
        const loadedTiles = await this.loadTiles(tileKeys);
        const seenTileKeys = new Set<string>();
        const relationTiles: FeatureTile[] = [];
        for (const tileKey of tileKeys) {
            const tile = loadedTiles.get(tileKey) ?? null;
            if (!tile || !tile.hasData() || seenTileKeys.has(tile.mapTileKey)) {
                continue;
            }
            seenTileKeys.add(tile.mapTileKey);
            relationTiles.push(tile);
        }
        return {responses: locateResponse.responses ?? [], tiles: relationTiles};
    }

    /**
     * Resolves tile/feature ids to `FeatureWrapper`s.
     *
     * The default path waits for loaded tile data and rejects missing feature ids immediately.
     * `InspectionSelectionService` uses `allowIncomplete` only while restoring saved selections:
     * it may return wrappers backed by placeholder or partially hydrated tiles, then pins those
     * tiles so later inspection-stage data can fill in without losing the panel.
     *
     * `requireAllStages` is for callers that immediately read inspection-derived feature data,
     * such as feature focusing. It waits until all advertised tile stages have arrived instead of
     * resolving after the first feature data stage.
     */
    async loadFeatures(
        tileFeatureIds: (TileFeatureId | null)[],
        options?: {allowIncomplete?: boolean; requireAllStages?: boolean}
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
                    const [mapId, layerId, tileId] = parsedTileKey ?? ["", "", 0];
                    this.showErrorMessage(
                        `The feature ${id.featureId} does not exist in the ${layerId} layer of tile ${tileId} of map ${mapId}.`);
                    continue;
                }

                features.push(new FeatureWrapper(resolvedFeatureId, tile));
            }

            return features;
        }

        const tiles = await this.loadTiles(
            new Set(normalizedIds.map(id => id.mapTileKey)),
            {requireAllStages: options?.requireAllStages ?? false}
        );
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
                const [mapId, layerId, tileId] = parsedTileKey ?? ["", "", 0];
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
            tileId: number;
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
            return this.mapInfo.tileLayerParser.readTileSearchResultLayer(wasmBlob);
        }, searchResultLayerBlob);
        if (!searchResultLayer) {
            return;
        }

        let releaseSearchResultLayer = true;
        try {
            const rawInfo = searchResultLayer.info() as Record<string, unknown>;
            const searchId = typeof rawInfo["searchId"] === "string" ? rawInfo["searchId"] : "";
            if (!searchId) {
                return;
            }

            const refresh = Number(rawInfo["refresh"] ?? 0);
            const resultFieldsValue = searchResultLayer.resultFields();
            const resultFields = Array.isArray(resultFieldsValue) ? resultFieldsValue.map(String) : [];
            const tileId = this.tileIdFromUnknown(searchResultLayer.tileId());
            const sourceMapId = typeof rawInfo["sourceMapId"] === "string"
                ? rawInfo["sourceMapId"]
                : searchResultLayer.mapId();
            const sourceLayerId = typeof rawInfo["sourceLayerId"] === "string"
                ? rawInfo["sourceLayerId"]
                : searchResultLayer.layerId();
            const sourceTileId = rawInfo["sourceTileId"] !== undefined
                ? this.tileIdFromUnknown(rawInfo["sourceTileId"], tileId)
                : tileId;
            const sourceTileKey = coreLib.getTileFeatureLayerKey(sourceMapId, sourceLayerId, sourceTileId);
            const normalizedRefresh = Number.isFinite(refresh) ? refresh : 0;
            const resultCount = Math.max(0, Math.floor(searchResultLayer.numResults()));
            const acceptedTile = this.acceptSearchResultTileLayer(
                searchId,
                normalizedRefresh,
                sourceTileKey,
                searchResultLayer.nodeId(),
                searchResultLayerBlob,
                resultCount
            );
            if (!acceptedTile) {
                return;
            }

            const diagnostics = uint8ArrayFromWasm(buffer => searchResultLayer.copyDiagnostics(buffer));
            const progress = this.activeFeatureSearches.get(searchId)?.progressSnapshot() ?? {
                tilesConsidered: 0,
                tilesCompleted: 0
            };
            const payloadBase: SearchResultEntryExtractionContext = {
                searchId,
                refresh: normalizedRefresh,
                mapId: searchResultLayer.mapId(),
                layerId: searchResultLayer.layerId(),
                tileId,
                sourceTileKey,
                sourceMapId,
                sourceLayerId,
                sourceTileId,
                requestOrder: acceptedTile.requestOrder,
                resultCount,
                resultFields,
                layerBlob: searchResultLayerBlob,
                includeExactPositions: this.searchResultEntriesNeedExactPositions(searchId)
            };

            this.searchResultTileReceived.next({
                ...payloadBase,
                ...progress,
                layerBlob: searchResultLayerBlob,
                diagnostics,
                entries: [],
                entryOffset: 0,
                entriesComplete: resultCount === 0
            });
            if (resultCount > 0) {
                releaseSearchResultLayer = false;
                this.scheduleSearchResultEntryExtraction(searchResultLayer, payloadBase);
            }
        } finally {
            if (releaseSearchResultLayer) {
                searchResultLayer.delete();
            }
        }
    }

    /** Streams expensive per-result entry extraction in small browser-frame chunks. */
    private scheduleSearchResultEntryExtraction(
        searchResultLayer: TileSearchResultLayer,
        payloadBase: SearchResultEntryExtractionContext
    ): void {
        let offset = 0;
        const runBatch = () => {
            const extractEntries = this.searchResultEntryExtractor(searchResultLayer, payloadBase.includeExactPositions);
            if (!this.isCurrentSearchResultTilePayload(payloadBase)) {
                searchResultLayer.delete();
                return;
            }

            const startedAt = performance.now();
            while (offset < payloadBase.resultCount) {
                const batchOffset = offset;
                const batchLimit = Math.min(
                    this.searchResultEntryBatchSize,
                    payloadBase.resultCount - batchOffset);
                const rawEntriesValue = extractEntries(batchOffset, batchLimit);
                const entries = this.normalizeSearchResultEntries(rawEntriesValue, payloadBase.sourceTileKey);
                offset = batchOffset + batchLimit;
                const progress = this.activeFeatureSearches.get(payloadBase.searchId)?.progressSnapshot() ?? {
                    tilesConsidered: 0,
                    tilesCompleted: 0
                };

                this.searchResultTileReceived.next({
                    ...payloadBase,
                    ...progress,
                    diagnostics: null,
                    entries,
                    entryOffset: batchOffset,
                    entriesComplete: offset >= payloadBase.resultCount
                });

                if (performance.now() - startedAt >= this.searchResultEntryFrameBudgetMs) {
                    break;
                }
            }

            if (offset < payloadBase.resultCount) {
                requestAnimationFrame(runBatch);
                return;
            }
            searchResultLayer.delete();
        };
        requestAnimationFrame(runBatch);
    }

    /** Returns whether UI result entries need per-result geometry centers for high-fidelity pin rendering. */
    private searchResultEntriesNeedExactPositions(searchId: string): boolean {
        return !!this.activeFeatureSearches.get(searchId)
            ?.definition.renderStrategy.showHighFiResultDots;
    }

    /** Selects the cheapest native result-entry extractor that still satisfies the current visualization strategy. */
    private searchResultEntryExtractor(
        searchResultLayer: TileSearchResultLayer,
        includeExactPositions: boolean
    ): (offset: number, limit: number) => unknown {
        return includeExactPositions
            ? (offset, limit) => searchResultLayer.resultEntryRange(offset, limit)
            : (offset, limit) => searchResultLayer.resultEntryRangeCompact(offset, limit);
    }

    /** Converts untyped native entry objects to canonical frontend entries for one source tile. */
    private normalizeSearchResultEntries(value: unknown, sourceTileKey: string): SearchResultTileEntry[] {
        const rawEntries = Array.isArray(value) ? value as SearchResultTileEntry[] : [];
        return rawEntries.map(entry => ({
            ...entry,
            mapTileKey: entry.mapTileKey
                ? this.canonicalizeMapTileKey(entry.mapTileKey)
                : sourceTileKey
        }));
    }

    /** Returns whether a delayed entry batch still belongs to the active tile generation. */
    private isCurrentSearchResultTilePayload(payload: SearchResultEntryExtractionContext): boolean {
        const tile = this.activeFeatureSearches.get(payload.searchId)?.tilesBySourceKey.get(payload.sourceTileKey);
        return !!tile
            && !tile.disposed
            && tile.refresh === payload.refresh
            && tile.layerBlob === payload.layerBlob;
    }

    /** Accepts one streamed result layer into the matching source-tile state. */
    private acceptSearchResultTileLayer(
        searchId: string,
        refresh: number,
        sourceTileKey: string,
        nodeId: string,
        layerBlob: Uint8Array,
        resultCount: number
    ): SearchResultTile | null {
        const runtime = this.activeFeatureSearches.get(searchId);
        const tile = runtime?.acceptResultTile(refresh, sourceTileKey, nodeId, layerBlob, resultCount);
        if (tile) {
            this.searchResultTileChanged.next(tile);
        }
        return tile ?? null;
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

    /** Recomputes the logical interactive request from visible tiles and pinned selection tiles. */
    private async updateMapDataRequest() {
        if (this.tilePipelinePaused || !this.tileStream) {
            return;
        }

        const requestByLayer = new Map<string, LayerRequestEntry>();
        const expectedByLayer = new Map<string, ExpectedLayerEntry>();
        const queueTile = (
            mapId: string,
            layerId: string,
            tileId: number,
            nextMissingStage: number,
            priority = false
        ) => {
            const tileLevel = Number(coreLib.getTileLevel(tileId));
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

        const retainedSelectionRequests: SelectionTileRequest[] = [];
        for (const selectionTileRequest of this.selectionTileRequests) {
            const selectionMapId = selectionTileRequest.remoteRequest.mapId;
            const selectionLayerId = selectionTileRequest.remoteRequest.layerId;
            const mapLayerItem = this.mapInfo.maps.maps
                .get(selectionMapId)?.layers
                .get(selectionLayerId);
            if (!mapLayerItem) {
                if (this.mapInfo.isMapInitializing(selectionMapId)) {
                    retainedSelectionRequests.push(selectionTileRequest);
                    continue;
                }
                if (this.mapInfo.isMapFailed(selectionMapId)) {
                    selectionTileRequest.reject!(this.mapInfo.dataSourceStatusText(
                        this.mapInfo.maps.maps.get(selectionMapId)!.info
                    ));
                    continue;
                }
                selectionTileRequest.reject!("Map layer is not available.");
                continue;
            }
            if (!this.mapInfo.isMapLayerReady(selectionMapId, selectionLayerId)) {
                if (this.mapInfo.isMapFailed(selectionMapId)) {
                    selectionTileRequest.reject!(this.mapInfo.dataSourceStatusText(
                        this.mapInfo.maps.maps.get(selectionMapId)!.info
                    ));
                    continue;
                }
                retainedSelectionRequests.push(selectionTileRequest);
                continue;
            }
            retainedSelectionRequests.push(selectionTileRequest);
            for (const tileId of selectionTileRequest.remoteRequest.tileIds) {
                this.ensureTilePlaceholder(
                    selectionMapId,
                    selectionLayerId,
                    tileId,
                    true);
                const selectionStageCount = this.mapInfo.getLayerStageCount(
                    selectionMapId,
                    selectionLayerId
                );
                const selectionRequestedMaxStage = Math.max(0, selectionStageCount - 1);
                trackRequestedTile(
                    selectionMapId,
                    selectionLayerId,
                    tileId,
                    selectionRequestedMaxStage
                );
                const nextMissingStage = this.tileMinimumMissingStage(
                    selectionMapId,
                    selectionLayerId,
                    tileId,
                    selectionRequestedMaxStage);
                if (nextMissingStage !== undefined) {
                    queueTile(
                        selectionMapId,
                        selectionLayerId,
                        tileId,
                        nextMissingStage,
                        true);
                }
            }
        }
        this.selectionTileRequests.length = 0;
        this.selectionTileRequests.push(...retainedSelectionRequests);

        for (const [mapName, map] of this.mapInfo.maps.maps) {
            if (!this.mapInfo.isMapReady(mapName)) {
                continue;
            }
            for (const layer of map.allFeatureLayers()) {
                if (!this.mapInfo.isMapLayerReady(mapName, layer.id)) {
                    continue;
                }
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
                        const existingTile = this.loadedTileLayers.get(tileMapLayerKey);
                        if (!existingTile) {
                            this.ensureTilePlaceholder(mapName, layer.id, tileId, false);
                        }
                        const stageCount = this.mapInfo.getLayerStageCount(mapName, layer.id);
                        const layerMaxStage = Math.max(0, stageCount - 1);
                        trackRequestedTile(mapName, layer.id, tileId, layerMaxStage);
                        const nextMissingStage = this.tileMinimumMissingStage(mapName, layer.id, tileId, layerMaxStage);
                        if (nextMissingStage !== undefined) {
                            queueTile(mapName, layer.id, tileId, nextMissingStage, isSelectedTile);
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
        requests.push(...this.buildFeatureSearchTileRequests());

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
                const tileKey = coreLib.getTileFeatureLayerKey(entry.mapId, entry.layerId, tileId);
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
    parseMapTileKeySafe(tileKey: string): [string, string, number] | null {
        try {
            const [mapId, layerId, tileId] = coreLib.parseMapTileKey(tileKey);
            return [mapId, layerId, this.tileIdFromUnknown(tileId)];
        } catch (_error) {
            const parts = tileKey.split('/');
            if (parts.length < 3) {
                return null;
            }
            try {
                return [parts[0], parts[1], this.tileIdFromUnknown(parts[2])];
            } catch (_parseError) {
                return null;
            }
        }
    }

    /** Converts embind-returned ids to signed int32 numbers without assuming one fixed JS representation. */
    private tileIdFromUnknown(value: unknown, fallback = 0): number {
        if (typeof value === "bigint") {
            return Number(value);
        }
        if (typeof value === "number" && Number.isFinite(value)) {
            return Math.trunc(value);
        }
        if (typeof value === "string" && value.length > 0) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
                return Math.trunc(parsed);
            }
        }
        return fallback;
    }

    /** Ensures a placeholder `FeatureTile` exists so selection and progress logic can reference missing tiles. */
    private ensureTilePlaceholder(
        mapId: string,
        layerId: string,
        tileId: number,
        preventCulling: boolean,
        tileKeyOverride?: string
    ): boolean {
        const tileKey = tileKeyOverride ?? coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
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

        return true;
    }

    /** Pins a tile until inspection has seen every advertised stage, without exposing a caller-visible promise. */
    private pinTileForSelectionInspection(mapId: string, layerId: string, tileId: number, canonicalTileKey: string): void {
        if (this.selectionTileRequests.some(request => request.tileKey === canonicalTileKey)) {
            return;
        }

        this.selectionTileRequests.push({
            remoteRequest: {mapId, layerId, tileIds: [tileId]},
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
        tileId: number,
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

    /** Updates backend progress and surfaces terminal request failures from interactive status payloads. */
    private handleTilesRequestStatus(status: MapTileStreamStatusPayload) {
        if (!status || status.type !== "mapget.tiles.status") {
            return;
        }
        const requests = status.requests || [];
        const statusMessage = status.message || "";
        if ((statusMessage.includes("Replaced by a new /tiles WebSocket request")
            || statusMessage.includes("Replaced by a new /interactive WebSocket request"))) {
            return;
        }
        if (statusMessage) {
            console.info("Interactive tile status:", statusMessage);
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
        const runtime = this.activeFeatureSearches.get(status.searchId);
        if (!runtime) {
            return;
        }
        const refresh = Number(status.refresh ?? 0);
        if (refresh !== runtime.refresh) {
            return;
        }
        this.searchStatusReceived.next({...status, ...runtime.progressSnapshot()});
    }

    /** Adds one source tile to the reusable visible-tile plan consumed by map loading and search. */
    private trackVisibleSearchLayerTile(
        visibleLayerTiles: Map<string, SearchLayerTileSet>,
        mapId: string,
        layerId: string,
        tileId: number,
        requestOrder: number,
        priority: boolean
    ): void {
        const key = FeatureSearchRuntimeState.layerKey(mapId, layerId);
        let entry = visibleLayerTiles.get(key);
        if (!entry) {
            entry = {mapId, layerId, tiles: new Map<number, {tileId: number; requestOrder: number; priority: boolean}>()};
            visibleLayerTiles.set(key, entry);
        }
        const existing = entry.tiles.get(tileId);
        if (existing) {
            existing.priority = existing.priority || priority;
            return;
        }
        entry.tiles.set(tileId, {tileId, requestOrder, priority});
    }

    /** Emits removal/eviction notifications for search-result tiles no longer owned by a runtime. */
    private disposeSearchResultTiles(tiles: SearchResultTile[], notifyEviction: boolean): void {
        for (const tile of tiles) {
            const {searchId, sourceTileKey} = tile;
            const hadResultLayer = tile.hasResultLayer();
            tile.dispose();
            if (hadResultLayer) {
                this.searchResultTileRemoved.next({searchId, sourceTileKey});
            }
            if (notifyEviction) {
                this.searchResultTileEvicted.next({searchId, sourceTileKey});
            }
        }
    }

    /** Builds all active server-side search-as-map requests for the next interactive update. */
    private buildFeatureSearchTileRequests(): FeatureSearchTileRequest[] {
        const requests: FeatureSearchTileRequest[] = [];

        for (const runtime of this.activeFeatureSearches.values()) {
            if (runtime.definition.paused) {
                requests.push(...runtime.cancellationRequests(
                    runtime.layerKeys(),
                    runtime.refresh
                ));
                runtime.markPendingTilesForResume();
                continue;
            }

            const runtimeVisibleLayerTiles = this.featureSearchCoverageTiles(runtime.definition);
            if (runtime.shouldAdoptVisibleTiles()) {
                const coverageUpdate = runtime.adoptVisibleTiles(runtimeVisibleLayerTiles);
                this.disposeSearchResultTiles(coverageUpdate.removedTiles, true);
                if (coverageUpdate.changed) {
                    this.emitSearchCoverageChanged(runtime);
                }
            }

            requests.push(...runtime.buildPendingRequests());
        }

        for (const [searchId, cancellation] of Array.from(this.pendingFeatureSearchCancellations)) {
            if (cancellation.layerKeys.size) {
                requests.push(...cancellation.runtime.cancellationRequests(
                    cancellation.layerKeys,
                    cancellation.refresh
                ));
            }
            this.pendingFeatureSearchCancellations.delete(searchId);
        }

        return requests;
    }

    /** Announces a frontend coverage-generation change before backend progress statuses catch up. */
    private emitSearchCoverageChanged(runtime: FeatureSearchRuntimeState): void {
        const progress = runtime.progressSnapshot();
        this.searchCoverageChanged.next({
            searchId: runtime.searchId,
            refresh: runtime.refresh,
            ...progress
        });
    }

    /** Builds search-local source-tile coverage from selected layers and current viewports, ignoring Map Panel visibility. */
    private featureSearchCoverageTiles(definition: FeatureSearchStateEntry): Map<string, SearchLayerTileSet> {
        const coverage = new Map<string, SearchLayerTileSet>();
        let requestOrder = 0;
        for (const ref of this.availableFeatureSearchLayerRefs(definition.selectedMapLayers)) {
            for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                if (!featureSearchVisibleInView(definition, viewIndex)) {
                    continue;
                }
                for (const level of this.effectiveFeatureSearchTileLevels(definition, ref, viewIndex)) {
                    const tileIds = this.viewState.visibleSearchTileIdsForLevel(viewIndex, level);
                    for (const tileId of tileIds) {
                        const tileMapLayerKey = coreLib.getTileFeatureLayerKey(ref.mapId, ref.layerId, tileId);
                        this.trackVisibleSearchLayerTile(
                            coverage,
                            ref.mapId,
                            ref.layerId,
                            tileId,
                            requestOrder++,
                            this.selectedTileKeys.has(tileMapLayerKey)
                        );
                    }
                }
            }
        }
        return coverage;
    }

    /** Returns explicit search levels, or the current viewport-derived auto level when the selection is empty. */
    private effectiveFeatureSearchTileLevels(
        definition: FeatureSearchStateEntry,
        ref: FeatureSearchMapLayerRef,
        viewIndex: number
    ): number[] {
        if (definition.selectedTileLevels.length) {
            return definition.selectedTileLevels;
        }
        const autoLevel = this.viewState.autoSearchTileLevel(viewIndex, ref.mapId, ref.layerId);
        return autoLevel === null ? [] : [autoLevel];
    }

    /** Returns selected feature-search layers that still exist in datasource metadata, de-duplicated in state order. */
    private availableFeatureSearchLayerRefs(refs: FeatureSearchMapLayerRef[]): FeatureSearchMapLayerRef[] {
        const result: FeatureSearchMapLayerRef[] = [];
        const seen = new Set<string>();
        for (const ref of refs) {
            const key = FeatureSearchRuntimeState.layerKey(ref.mapId, ref.layerId);
            if (seen.has(key)
                || !this.mapInfo.isMapLayerReady(ref.mapId, ref.layerId)
                || !this.hasFeatureLayer(ref.mapId, ref.layerId)) {
                continue;
            }
            seen.add(key);
            result.push({mapId: ref.mapId, layerId: ref.layerId});
        }
        return result;
    }

    /** Returns whether map metadata still contains this feature layer. */
    private hasFeatureLayer(mapId: string, layerId: string): boolean {
        const map = this.mapInfo.maps.maps.get(mapId);
        return !!map?.allFeatureLayers().some(layer => layer.id === layerId);
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

    /** Shows one sticky backend-state toast without spamming repeated transport events. */
    private showBackendConnectionErrorMessage(message: string) {
        this.ngZone.run(() => this.messageService.showBackendConnectionError(message));
    }

    /** Shows one sticky backend protocol toast without spamming repeated frame events. */
    private showBackendProtocolErrorMessage(message: string) {
        this.ngZone.run(() => this.messageService.showBackendProtocolError(message));
    }
}
