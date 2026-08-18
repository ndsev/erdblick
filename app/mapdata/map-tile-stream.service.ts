import {Injectable, NgZone} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";
import {MapInfoService} from "./map-info.service";
import {
    MapTileRequestStatus,
    MapTileStreamClient,
    type MapTileStreamFilterStatusPayload,
    type MapTileStreamSourceCatalogChangePayload,
    type MapTileStreamStatusPayload,
    type MapTileStreamTransportCompressionStats
} from "./tilestream";
import {
    FilterSubscriptionCallbacks,
    FilterSubscriptionCoverage,
    FilterSubscriptionDefinition,
    FilterSubscriptionRef,
    TileAttachmentRef,
    TileAttachmentValue,
    TileSubsetDelivery
} from "./filter-subscription.model";
import {
    FeatureWrapper,
    InspectionFeatureTile
} from "./feature-inspection.model";
import {
    coreLib,
    uint8ArrayToWasm,
    uint8ArrayToWasmOrThrow
} from "../integrations/wasm";
import {
    AppStateService,
    MAX_NUM_TILES_TO_LOAD,
    TileFeatureId
} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {stripFeatureInspectionTarget} from "../shared/tile-feature-id";
import {TileExpiryScheduler} from "./tile-expiry-scheduler";

export interface RetainedTileExpiryOwner {
    expireTiles(tokens: ReadonlyArray<{
        tileId: number;
        valueVersion: number;
    }>): void;
}

export interface BackendRequestProgress {
    done: number;
    total: number;
    allDone: boolean;
    requestId?: number;
}

/**
 * Owns interactive filter transport and attachment refs.
 *
 * Delivered subsets are transferred directly to their subscription owner.
 * Complete feature data is fetched only through feature-restricted, one-shot
 * `/tiles` requests for inspection and is never inserted into a viewport cache.
 */
@Injectable({providedIn: "root"})
export class MapTileStreamService {
    readonly tilePipelinePaused$ = new BehaviorSubject<boolean>(false);
    readonly filterStatusReceived =
        new Subject<MapTileStreamFilterStatusPayload>();

    private tileStream: MapTileStreamClient | null = null;
    private readonly filterSubscriptionsById =
        new Map<string, FilterSubscriptionRef>();
    private nextFilterSubscriptionId = 0;
    private updateTimer: ReturnType<typeof setTimeout> | null = null;
    private updatePending = false;
    private updateInProgress = false;
    private updateRequestedWhilePaused = false;
    private forceNextUpdate = false;
    private readonly tileExpiryScheduler =
        new TileExpiryScheduler<RetainedTileExpiryOwner>(
            (owner, tokens) => owner.expireTiles(tokens)
        );
    private readonly updateDebounceMs = 25;
    private lastUpdateAt = 0;
    private backendRequestProgress: BackendRequestProgress = {
        done: 0,
        total: 0,
        allDone: true
    };
    private viewportLoadStartedAtMs: number | null = null;
    private viewportCompletedAtMs: number | null = null;
    private sourceCatalogReloadPromise: Promise<void> | null = null;
    private sourceCatalogRefreshTargetRevision: number | null = null;
    /** Guarantees an authoritative refresh after an older connection's in-flight reload completes. */
    private sourceCatalogReloadAfterCurrent: boolean = false;
    private backendProtocolMismatchActive = false;
    private readonly liveAttachments = new Map<string, {
        controller: AbortController;
        refs: Set<TileAttachmentRef>;
        promise: Promise<TileAttachmentValue | null>;
    }>();

    constructor(
        private readonly stateService: AppStateService,
        private readonly mapInfo: MapInfoService,
        private readonly messageService: InfoMessageService,
        private readonly ngZone: NgZone
    ) {
        this.stateService.tilePullCompressionEnabledState.subscribe(enabled =>
            this.tileStream?.setPullCompressionEnabled(enabled)
        );
        this.mapInfo.dataSourceInfoChanged.subscribe(() => {
            this.ngZone.runOutsideAngular(() => {
                this.tileStream?.resetAfterDataSourceInfoChange();
                this.scheduleUpdate();
            });
        });
    }

    async initialize(): Promise<void> {
        this.tileStream = new MapTileStreamClient(
            "/interactive",
            this.mapInfo.tileLayerParser
        );
        this.tileStream.setPullCompressionEnabled(
            this.stateService.tilePullCompressionEnabled
        );
        this.tileStream.setFrameProcessingPaused(this.tilePipelinePaused);
        this.tileStream.onSubsets = payload =>
            this.ngZone.runOutsideAngular(() => this.acceptSubset(payload));
        this.tileStream.onFields = () =>
            this.mapInfo.invalidateFieldDictBlobCache();
        this.tileStream.onStatus = status =>
            this.ngZone.runOutsideAngular(() => this.acceptRequestStatus(status));
        this.tileStream.onFilterStatus = status =>
            this.ngZone.runOutsideAngular(() => this.acceptFilterStatus(status));
        this.tileStream.onSourceCatalogChanged = change =>
            this.ngZone.runOutsideAngular(() =>
                this.handleSourceCatalogChanged(change)
            );
        this.tileStream.onSourcesRevisionChanged = (revision, reconnected) =>
            this.ngZone.runOutsideAngular(() =>
                this.handleSourcesRevisionChanged(revision, reconnected)
            );
        this.tileStream.onOpen = () => this.ngZone.run(() => {
            this.backendProtocolMismatchActive = false;
            this.messageService.clearBackendConnectionError();
            this.messageService.clearBackendProtocolError();
            // A websocket reconnect creates a blank server-side session, so
            // resend the authoritative complete pending-work snapshot.
            this.scheduleUpdate();
        });
        this.tileStream.onProtocolMismatch = mismatch => {
            const actual =
                `${mismatch.actual.major}.${mismatch.actual.minor}.${mismatch.actual.patch}`;
            const expected =
                `${mismatch.expected.major}.${mismatch.expected.minor}.x`;
            this.backendProtocolMismatchActive = true;
            this.showBackendProtocolError(
                `The map backend uses unsupported tile-stream protocol ${actual}; ` +
                `this erdblick build requires ${expected}.`
            );
        };
        this.tileStream.onError = event => {
            console.error("Tile WebSocket error.", event);
            if (!this.backendProtocolMismatchActive) {
                this.showBackendConnectionError(
                    "Could not connect to the map backend."
                );
            }
        };
        this.tileStream.onClose = event => {
            if (!this.backendProtocolMismatchActive && event.code !== 1000) {
                const detail = event.reason ? ` (${event.reason})` : "";
                this.showBackendConnectionError(
                    `The map backend connection was closed${detail}.`
                );
            }
            if (!this.backendProtocolMismatchActive) {
                this.scheduleUpdate();
            }
        };
        await this.mapInfo.reloadDataSources();
        this.scheduleUpdate();
    }

    createFilterSubscription(
        definition: FilterSubscriptionDefinition,
        coverage: FilterSubscriptionCoverage,
        callbacks: FilterSubscriptionCallbacks,
        filterId?: string
    ): FilterSubscriptionRef {
        const resolvedId = filterId?.trim() ||
            `erdblick-filter-${++this.nextFilterSubscriptionId}`;
        if (this.filterSubscriptionsById.has(resolvedId)) {
            throw new Error(`Filter subscription '${resolvedId}' already exists.`);
        }
        const ref = new FilterSubscriptionRef(
            this,
            resolvedId,
            definition,
            coverage,
            callbacks
        );
        this.filterSubscriptionsById.set(resolvedId, ref);
        // Most styled layers are created immediately before their first
        // viewport reconciliation. Avoid sending an empty generation that has
        // no output demand and will be replaced a few milliseconds later.
        if (coverage.tileIds.length > 0) {
            this.updateFilterSubscription(ref, true);
        }
        return ref;
    }

    updateFilterSubscription(
        ref: FilterSubscriptionRef,
        force: boolean
    ): void {
        if (!ref.released &&
            this.filterSubscriptionsById.get(ref.filterId) === ref) {
            this.forceNextUpdate ||= force;
            this.scheduleUpdate();
        }
    }

    updateFilterTileExpiry(
        ref: FilterSubscriptionRef,
        tileId: number,
        valueVersion: number,
        expiresAtMs: number | null
    ): void {
        if (this.filterSubscriptionsById.get(ref.filterId) !== ref ||
            ref.released) {
            return;
        }
        if (expiresAtMs === null) {
            this.tileExpiryScheduler.cancel(ref, tileId);
            return;
        }
        this.tileExpiryScheduler.schedule(
            ref,
            tileId,
            valueVersion,
            expiresAtMs
        );
    }

    /** Shares the application's indexed one-timer heap with retained non-subset tiles. */
    updateRetainedTileExpiry(
        owner: RetainedTileExpiryOwner,
        tileId: number,
        valueVersion: number,
        expiresAtMs: number | null
    ): void {
        // This value came from an explicit request which just completed. If
        // its encoded lifetime elapsed in transit, retrying it immediately
        // creates a self-sustaining request loop without making it fresher.
        if (expiresAtMs === null || expiresAtMs <= Date.now()) {
            this.tileExpiryScheduler.cancel(owner, tileId);
            return;
        }
        this.tileExpiryScheduler.schedule(
            owner,
            tileId,
            valueVersion,
            expiresAtMs
        );
    }

    cancelRetainedTileExpiries(
        owner: RetainedTileExpiryOwner
    ): void {
        this.tileExpiryScheduler.cancelOwner(owner);
    }

    cancelFilterTileExpiries(
        ref: FilterSubscriptionRef,
        tileIds?: readonly number[]
    ): void {
        if (tileIds) {
            for (const tileId of tileIds) {
                this.tileExpiryScheduler.cancel(ref, tileId);
            }
            return;
        }
        this.tileExpiryScheduler.cancelOwner(ref);
    }

    releaseFilterSubscription(ref: FilterSubscriptionRef): void {
        if (this.filterSubscriptionsById.get(ref.filterId) !== ref) {
            return;
        }
        this.cancelFilterTileExpiries(ref);
        this.filterSubscriptionsById.delete(ref.filterId);
        this.scheduleUpdate();
    }

    retainTileAttachment(request: {
        mapId: string;
        layerId: string;
        tileId: number;
        name: string;
        sourceId?: string;
        incarnation?: number;
    }): TileAttachmentRef {
        const key = [
            request.mapId,
            request.layerId,
            Math.trunc(request.tileId),
            request.name,
            Math.max(0, Math.trunc(request.incarnation ?? 0))
        ].map(value => encodeURIComponent(String(value))).join("/");
        let live = this.liveAttachments.get(key);
        if (!live) {
            const controller = new AbortController();
            const promise = this.fetchTileAttachment(
                request,
                controller.signal
            );
            live = {
                controller,
                refs: new Set<TileAttachmentRef>(),
                promise
            };
            this.liveAttachments.set(key, live);
            promise.finally(() => {
                if (this.liveAttachments.get(key) === live &&
                    live?.refs.size === 0) {
                    this.liveAttachments.delete(key);
                }
            });
        }
        const ref = new TileAttachmentRef(this, key, live.promise);
        live.refs.add(ref);
        live.promise.then(value => {
            if (ref.state === "released") {
                return;
            }
            if (value) {
                ref.value = value;
                ref.state = "ready";
            } else {
                ref.error = "Attachment transfer returned no value.";
                ref.state = "failed";
            }
        }).catch(error => {
            if (ref.state !== "released") {
                ref.error = error instanceof Error
                    ? error.message
                    : String(error);
                ref.state = "failed";
            }
        });
        return ref;
    }

    releaseTileAttachment(ref: TileAttachmentRef): void {
        const live = this.liveAttachments.get(ref.key);
        if (!live) {
            return;
        }
        live.refs.delete(ref);
        if (live.refs.size === 0) {
            live.controller.abort();
            this.liveAttachments.delete(ref.key);
        }
    }

    /**
     * Fetches complete models only for the explicitly requested feature IDs.
     * The returned wrappers own their response blobs; this service retains none.
     */
    async loadFeatures(
        tileFeatureIds: (TileFeatureId | null)[]
    ): Promise<FeatureWrapper[]> {
        const requested = tileFeatureIds.filter(
            (value): value is TileFeatureId => !!value
        );
        if (!requested.length) {
            return [];
        }
        const direct = await this.loadFeaturesFromDeclaredTiles(requested);
        const directByKey = new Map(direct.map(feature => [
            this.featureIdentityKey(feature),
            feature
        ]));
        const missing = requested.filter(feature =>
            !directByKey.has(this.featureIdentityKey(feature))
        );
        if (!missing.length) {
            return requested.flatMap(feature => {
                const result = directByKey.get(this.featureIdentityKey(feature));
                return result ? [result] : [];
            });
        }

        const relocated = await this.locateCanonicalFeatures(missing);
        const relocatedRequests = relocated
            .filter((value): value is TileFeatureId => !!value);
        const relocatedFeatures = relocatedRequests.length
            ? await this.loadFeaturesFromDeclaredTiles(relocatedRequests)
            : [];
        const relocatedByKey = new Map(relocatedFeatures.map(feature => [
            this.featureIdentityKey(feature),
            feature
        ]));
        const resolvedForOriginal = new Map<string, FeatureWrapper>();
        missing.forEach((original, index) => {
            const identity = relocated[index];
            if (!identity) {
                return;
            }
            const wrapper = relocatedByKey.get(this.featureIdentityKey(identity));
            if (wrapper) {
                resolvedForOriginal.set(this.featureIdentityKey(original), wrapper);
            }
        });
        return requested.flatMap(feature => {
            const key = this.featureIdentityKey(feature);
            const result = directByKey.get(key) ?? resolvedForOriginal.get(key);
            return result ? [result] : [];
        });
    }

    private async loadFeaturesFromDeclaredTiles(
        requested: TileFeatureId[]
    ): Promise<FeatureWrapper[]> {
        if (this.tilePipelinePaused) {
            this.showInfo(
                "Tile pipeline is paused; cannot load inspection features."
            );
            return [];
        }

        const groups = new Map<string, {
            mapId: string;
            layerId: string;
            tiles: Map<number, string[]>;
        }>();
        for (const feature of requested) {
            const parsed = this.parseMapTileKeySafe(feature.mapTileKey);
            if (!parsed) {
                continue;
            }
            const [mapId, layerId, tileId] = parsed;
            const groupKey = `${mapId}\n${layerId}`;
            let group = groups.get(groupKey);
            if (!group) {
                group = {mapId, layerId, tiles: new Map()};
                groups.set(groupKey, group);
            }
            let ids = group.tiles.get(tileId);
            if (!ids) {
                ids = [];
                group.tiles.set(tileId, ids);
            }
            const baseId = stripFeatureInspectionTarget(feature.featureId);
            if (!ids.includes(baseId)) {
                ids.push(baseId);
            }
        }
        const distinctTileCount = [...groups.values()]
            .reduce((count, group) => count + group.tiles.size, 0);
        if (distinctTileCount > MAX_NUM_TILES_TO_LOAD) {
            throw new Error(
                `Inspection feature request exceeds ${MAX_NUM_TILES_TO_LOAD} tiles.`
            );
        }

        const transport = new MapTileStreamClient(
            "/tiles",
            this.mapInfo.tileLayerParser
        );
        transport.onFields = () =>
            this.mapInfo.invalidateFieldDictBlobCache();
        transport.setPullCompressionEnabled(
            this.stateService.tilePullCompressionEnabled
        );
        const tiles = new Map<string, InspectionFeatureTile>();
        let expectedFeatureTileCount: number | null = null;
        let resolveFeatureTilesReady: () => void = () => {};
        const featureTilesReady = new Promise<void>(resolve => {
            resolveFeatureTilesReady = resolve;
        });
        const resolveFeatureTilesIfReady = () => {
            if (expectedFeatureTileCount !== null &&
                tiles.size >= expectedFeatureTileCount) {
                resolveFeatureTilesReady();
            }
        };
        transport.onFeatures = blob => {
            try {
                const tile = new InspectionFeatureTile(
                    this.mapInfo.tileLayerParser,
                    blob
                );
                tiles.set(tile.mapTileKey, tile);
                resolveFeatureTilesIfReady();
                if (tile.legalInfo) {
                    this.mapInfo.setLegalInfo(tile.mapName, tile.legalInfo);
                }
            } catch (error) {
                console.error("Could not decode inspection feature tile.", error);
            }
        };
        let rejectProtocolMismatch: (error: Error) => void = () => {};
        const protocolMismatch = new Promise<never>((_, reject) => {
            rejectProtocolMismatch = reject;
        });
        transport.onProtocolMismatch = mismatch => rejectProtocolMismatch(
            new Error(
                `Inspection request received protocol ${mismatch.actual.major}.` +
                `${mismatch.actual.minor}.${mismatch.actual.patch}.`
            )
        );

        const requests = [...groups.values()].map(group => ({
            mapId: group.mapId,
            layerId: group.layerId,
            tileIds: [...group.tiles.keys()],
            featureIds: [...group.tiles].map(([tileId, ids]) => ({
                tileId,
                ids
            }))
        }));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const updateResult = await transport.updateRequest(requests);
            if (updateResult !== "sent") {
                return [];
            }
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(
                        "Inspection feature request timed out."
                    )),
                    30_000
                );
            });
            const status = await Promise.race([
                transport.waitForCompletion(),
                protocolMismatch,
                timeoutPromise
            ]);

            // Terminal status travels over the websocket while tile values can
            // still be in parallel pull responses. A successful request is not
            // consumable until every promised feature tile has crossed that
            // transport boundary.
            expectedFeatureTileCount = status.requests.reduce(
                (count, requestStatus) => {
                    if (requestStatus.status !== MapTileRequestStatus.Success) {
                        return count;
                    }
                    const request = requests[requestStatus.index];
                    return count + (request?.tileIds.length ?? 0);
                },
                0
            );
            resolveFeatureTilesIfReady();
            if (tiles.size < expectedFeatureTileCount) {
                await Promise.race([
                    featureTilesReady,
                    protocolMismatch,
                    timeoutPromise
                ]);
            }

            const failures = status.requests.filter(request =>
                request.status !== MapTileRequestStatus.Success
            );
            if (failures.length) {
                console.warn("Inspection feature request was incomplete.", failures);
            }
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
            transport.destroy();
        }

        return requested.flatMap(feature => {
            const tile = tiles.get(feature.mapTileKey);
            return tile?.contains(feature.featureId)
                ? [new FeatureWrapper(feature.featureId, tile)]
                : [];
        });
    }

    /**
     * Resolves identities whose picked owner tile does not contain the feature.
     * `/locate` schema-resolves canonical IDs and may return another layer/level.
     */
    private async locateCanonicalFeatures(
        requested: TileFeatureId[]
    ): Promise<Array<TileFeatureId | null>> {
        const requests = requested.map(feature => {
            const parsed = this.parseMapTileKeySafe(feature.mapTileKey);
            return parsed
                ? {
                    mapId: parsed[0],
                    featureId: stripFeatureInspectionTarget(feature.featureId)
                }
                : null;
        });
        const validRequests = requests.filter(
            (request): request is {mapId: string; featureId: string} => !!request
        );
        if (!validRequests.length) {
            return requested.map(() => null);
        }
        try {
            const response = await fetch("/locate", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({requests: validRequests})
            });
            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status}: ${response.statusText}`
                );
            }
            const payload = await response.json() as {
                responses?: Array<Array<{
                    tileId?: string;
                    canonicalFeatureId?: string;
                }>>;
            };
            let validIndex = 0;
            return requests.map((request): TileFeatureId | null => {
                if (!request) {
                    return null;
                }
                const candidates = [...(payload.responses?.[validIndex++] ?? [])]
                    .filter(candidate =>
                        typeof candidate.tileId === "string" &&
                        this.parseMapTileKeySafe(candidate.tileId) !== null
                    )
                    .sort((left, right) =>
                        String(left.tileId).localeCompare(String(right.tileId)) ||
                        String(left.canonicalFeatureId ?? "")
                            .localeCompare(String(right.canonicalFeatureId ?? ""))
                    );
                const candidate = candidates[0];
                if (!candidate?.tileId) {
                    return null;
                }
                return {
                    mapTileKey: candidate.tileId,
                    featureId: candidate.canonicalFeatureId ??
                        request.featureId
                };
            });
        } catch (error) {
            console.warn("Canonical feature locate failed.", error);
            return requested.map(() => null);
        }
    }

    private featureIdentityKey(feature: TileFeatureId): string {
        return `${feature.mapTileKey}\n${stripFeatureInspectionTarget(feature.featureId)}`;
    }

    parseMapTileKeySafe(tileKey: string): [string, string, number] | null {
        try {
            const [mapId, layerId, tileId] = coreLib.parseMapTileKey(tileKey);
            const numericTileId = Number(tileId);
            return Number.isInteger(numericTileId)
                ? [mapId, layerId, numericTileId]
                : null;
        } catch (_error) {
            return null;
        }
    }

    get tilePipelinePaused(): boolean {
        return this.tilePipelinePaused$.getValue();
    }

    pauseTilePipeline(source: string = "diagnostics"): void {
        if (this.tilePipelinePaused) {
            return;
        }
        this.tilePipelinePaused$.next(true);
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        this.updateRequestedWhilePaused ||= this.updatePending;
        this.tileStream?.setFrameProcessingPaused(true);
        this.showInfo("Tile pipeline paused");
        console.info(`Tile pipeline paused (${source})`);
    }

    resumeTilePipeline(source: string = "diagnostics"): void {
        if (!this.tilePipelinePaused) {
            return;
        }
        this.tilePipelinePaused$.next(false);
        this.tileStream?.setFrameProcessingPaused(false);
        this.showInfo("Tile pipeline resumed");
        console.info(`Tile pipeline resumed (${source})`);
        if (this.updatePending || this.updateRequestedWhilePaused) {
            this.updateRequestedWhilePaused = false;
            this.scheduleUpdate();
        }
    }

    toggleTilePipelinePause(source: string = "diagnostics"): void {
        if (this.tilePipelinePaused) {
            this.resumeTilePipeline(source);
        } else {
            this.pauseTilePipeline(source);
        }
    }

    isTileStreamConnected(): boolean {
        return this.tileStream?.isOpen() ?? false;
    }

    getPendingFrameQueueSize(): number {
        return this.tileStream?.getPendingFrameQueueSize() ?? 0;
    }

    getDownstreamBytesPerSecond(): number {
        return this.tileStream?.getDownstreamBytesPerSecond() ?? 0;
    }

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
            knownCompressedCoveragePct: 0
        };
    }

    getBackendRequestProgress(): BackendRequestProgress {
        return {...this.backendRequestProgress};
    }

    currentViewportRenderSeconds(): number {
        if (this.viewportLoadStartedAtMs === null) {
            return 0;
        }
        const end = this.viewportCompletedAtMs ?? performance.now();
        return Math.max(0, (end - this.viewportLoadStartedAtMs) / 1000);
    }

    /** Freezes the end-to-end viewport timer after all presentation work is terminal. */
    markCurrentViewportRendered(): void {
        if (this.viewportLoadStartedAtMs !== null &&
            this.viewportCompletedAtMs === null) {
            this.viewportCompletedAtMs = performance.now();
        }
    }

    featureSearchDiagnosticsSnapshot(): unknown {
        return {
            updatePending: this.updatePending,
            updateInProgress: this.updateInProgress,
            transport: this.tileStream?.getDebugState() ?? null,
            backendRequestProgress: this.getBackendRequestProgress(),
            tileExpiry: {
                scheduledTiles: this.tileExpiryScheduler.size,
                pendingFilterTiles: [...this.filterSubscriptionsById.values()]
                    .reduce((count, ref) => count + ref.pendingTileCount, 0)
            },
            activeFilters: [...this.filterSubscriptionsById.values()].map(ref => ({
                filterId: ref.filterId,
                generation: ref.generation,
                suspended: ref.suspended,
                released: ref.released
            }))
        };
    }

    private scheduleUpdate(): void {
        this.updatePending = true;
        if (this.tilePipelinePaused) {
            this.updateRequestedWhilePaused = true;
            return;
        }
        if (this.updateTimer) {
            return;
        }
        const delay = Math.max(
            0,
            this.updateDebounceMs - (Date.now() - this.lastUpdateAt)
        );
        this.updateTimer = this.ngZone.runOutsideAngular(() =>
            setTimeout(() => {
                this.updateTimer = null;
                void this.runUpdate();
            }, delay)
        );
    }

    private async runUpdate(): Promise<void> {
        if (this.tilePipelinePaused) {
            this.updateRequestedWhilePaused = true;
            return;
        }
        if (this.updateInProgress) {
            this.updatePending = true;
            return;
        }
        this.updateInProgress = true;
        this.updatePending = false;
        const force = this.forceNextUpdate;
        this.forceNextUpdate = false;
        try {
            const activeRefs = [...this.filterSubscriptionsById.values()]
                .filter(ref => !ref.released && !ref.suspended);
            const requests = activeRefs
                .map(ref => ref.requestJson())
                // The envelope is a complete replacement. Omitting an empty
                // subscription both avoids useless startup work and cancels
                // previously sent coverage when its last tile disappears.
                .filter(request =>
                    Array.isArray(request["tileIds"]) &&
                    request["tileIds"].length > 0
                );
            const updateResult =
                await this.tileStream?.updateRequest(requests, force);
            if (updateResult && updateResult !== "failed") {
                for (const ref of activeRefs) {
                    if (this.filterSubscriptionsById.get(ref.filterId) === ref) {
                        ref.notifyRequestSynchronized();
                    }
                }
            }
            if (updateResult === "sent") {
                this.backendRequestProgress = {
                    done: 0,
                    total: requests.length,
                    allDone: requests.length === 0
                };
                this.viewportLoadStartedAtMs = performance.now();
                this.viewportCompletedAtMs = requests.length === 0
                    ? this.viewportLoadStartedAtMs
                    : null;
            }
        } finally {
            this.updateInProgress = false;
            this.lastUpdateAt = Date.now();
            if (this.updatePending) {
                this.scheduleUpdate();
            }
        }
    }

    private acceptSubset(subsetBlob: Uint8Array): void {
        let metadata: {
            layer: {
                mapName: string;
                layerName: string;
                tileId: number;
                legalInfo?: string;
                stringPoolId?: string;
                conversionTimestampMs?: number;
                ttlMs?: number;
                scalarFields?: Record<string, unknown>;
            };
            filterId: string;
            generation: bigint | number;
            dependencies?: TileSubsetDelivery["dependencies"];
            issues?: TileSubsetDelivery["issues"];
            glbAttachmentName?: string;
        };
        try {
            metadata = uint8ArrayToWasmOrThrow(
                data => this.mapInfo.tileLayerParser
                    .readTileSubsetLayerMetadata(data),
                subsetBlob
            ) as unknown as typeof metadata;
        } catch (error) {
            throw new Error(
                "Failed to read TileSubsetLayer metadata.",
                {cause: error}
            );
        }
        const filterId = String(metadata.filterId);
        const generation = Number(metadata.generation);
        const subscription = this.filterSubscriptionsById.get(filterId);
        if (!subscription) {
            return;
        }
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new Error(
                `Filter '${filterId}' supplied an invalid generation.`
            );
        }
        if (subscription.generation !== generation) {
            return;
        }

        try {
            const mapId = String(metadata.layer.mapName);
            const layerId = String(metadata.layer.layerName);
            const tileId = Number(metadata.layer.tileId);
            if (!Number.isInteger(tileId)) {
                throw new Error(
                    `Filter '${filterId}' supplied an invalid tile id.`
                );
            }
            if (!subscription.covers(tileId)) {
                return;
            }
            const scalarFields =
                metadata.layer.scalarFields &&
                typeof metadata.layer.scalarFields === "object"
                    ? metadata.layer.scalarFields as Record<string, unknown>
                    : {};
            const rawEntryCount = Number(
                scalarFields["Filter/Entries/Total#count"] ?? 0
            );
            const rawGeometryVertexCount = Number(
                scalarFields["Filter/Geometry/Vertices#count"] ?? 0
            );
            const rawConversionTimestampMs = Number(
                metadata.layer.conversionTimestampMs
            );
            const rawTtlMs = Number(metadata.layer.ttlMs);
            const delivery: TileSubsetDelivery = {
                blob: subsetBlob,
                filterId,
                generation,
                mapId,
                layerId,
                tileId,
                mapTileKey: coreLib.getTileFeatureLayerKey(
                    mapId,
                    layerId,
                    tileId
                ),
                stringPoolId: String(metadata.layer.stringPoolId ?? ""),
                conversionTimestampMs:
                    Number.isFinite(rawConversionTimestampMs)
                        ? rawConversionTimestampMs
                        : null,
                ttlMs: Number.isFinite(rawTtlMs) && rawTtlMs > 0
                    ? rawTtlMs
                    : null,
                dependencies: Array.isArray(metadata.dependencies)
                    ? metadata.dependencies
                    : [],
                issues: Array.isArray(metadata.issues)
                    ? metadata.issues
                    : [],
                info: scalarFields,
                numEntries: Number.isFinite(rawEntryCount)
                    ? Math.max(0, Math.floor(rawEntryCount))
                    : 0,
                geometryVertexCount:
                    Number.isFinite(rawGeometryVertexCount)
                        ? Math.max(
                            0,
                            Math.floor(rawGeometryVertexCount)
                        )
                        : 0,
                glbAttachmentName: String(
                    metadata.glbAttachmentName ?? ""
                ),
                receivedAt: performance.now()
            };
            const admission = subscription.accept(delivery);
            if (admission === "accepted" && metadata.layer.legalInfo) {
                this.mapInfo.setLegalInfo(
                    mapId,
                    String(metadata.layer.legalInfo)
                );
            }
        } catch (error) {
            const message =
                `Failed to install filter '${filterId}' generation ${generation}: ` +
                (error instanceof Error ? error.message : String(error));
            subscription.reportError(message);
            throw new Error(message, {cause: error});
        }
    }

    private acceptFilterStatus(status: MapTileStreamFilterStatusPayload): void {
        if (!status || status.type !== "mapget.filter.status") {
            return;
        }
        const subscription = this.filterSubscriptionsById.get(status.filterId);
        if (!subscription ||
            subscription.generation !== Number(status.generation)) {
            return;
        }
        subscription.acceptStatus(status);
        this.filterStatusReceived.next(status);
    }

    private acceptRequestStatus(status: MapTileStreamStatusPayload): void {
        if (!status || status.type !== "mapget.tiles.status") {
            return;
        }
        const total = status.requests.length || this.backendRequestProgress.total;
        const done = status.allDone
            ? total
            : status.requests.filter(request =>
                request.status !== MapTileRequestStatus.Open
            ).length;
        this.backendRequestProgress = {
            done,
            total,
            allDone: Boolean(status.allDone),
            requestId: status.requestId
        };
        const failures = status.allDone
            ? status.requests.filter(request =>
                request.status !== MapTileRequestStatus.Success
            )
            : [];
        if (failures.length) {
            this.showError(
                "Filter request failed: " +
                failures.map(request =>
                    `${request.mapId}/${request.layerId}: ${request.statusText}`
                ).join(", ")
            );
        }
    }

    private async fetchTileAttachment(
        request: {
            mapId: string;
            layerId: string;
            tileId: number;
            name: string;
            sourceId?: string;
            incarnation?: number;
        },
        signal: AbortSignal
    ): Promise<TileAttachmentValue | null> {
        const query = new URLSearchParams({
            mapId: request.mapId,
            layerId: request.layerId,
            tileId: String(Math.trunc(request.tileId)),
            name: request.name
        });
        if (request.sourceId) {
            query.set("sourceId", request.sourceId);
        }
        const response = await fetch(`/attachment?${query}`, {
            method: "GET",
            signal,
            // A new subset incarnation may legitimately reuse the same name
            // for changed bytes. Revalidate instead of serving the browser's
            // prior URL cache entry blindly.
            cache: "no-cache"
        });
        if (!response.ok) {
            throw new Error(
                `Attachment '${request.name}' failed with ` +
                `${response.status} ${response.statusText}.`
            );
        }
        return {
            bytes: new Uint8Array(await response.arrayBuffer()),
            etag: response.headers.get("ETag"),
            mimeType: response.headers.get("Content-Type") ||
                "application/octet-stream"
        };
    }

    private handleSourceCatalogChanged(
        change: MapTileStreamSourceCatalogChangePayload
    ): void {
        const currentRevision = this.mapInfo.sourceCatalogRevision;
        if (currentRevision !== null && change.revision < currentRevision) {
            return;
        }
        if (!this.sourceCatalogChangeRequiresReload(change) && change.source) {
            const needsRefresh =
                this.mapInfo.sourceCatalogChangeNeedsRefresh(change.source);
            if (this.mapInfo.applySourceCatalogChange(
                change.source,
                change.revision
            ) && !needsRefresh) {
                this.scheduleUpdate();
                return;
            }
        }
        this.requestSourceCatalogRefresh(change.revision);
    }

    /** Refreshes `/sources` when request-context frames prove our catalog snapshot is stale. */
    private handleSourcesRevisionChanged(
        revision: number,
        reconnected: boolean
    ): void {
        const currentRevision = this.mapInfo.sourceCatalogRevision;
        if (!reconnected &&
            currentRevision !== null &&
            currentRevision >= revision) {
            return;
        }
        // Catalog revisions are process-local. The first context frame after a
        // reconnect must discard targets from the previous backend incarnation.
        this.requestSourceCatalogRefresh(revision, reconnected);
    }

    private sourceCatalogChangeRequiresReload(
        change: MapTileStreamSourceCatalogChangePayload
    ): boolean {
        const reason = change.reason?.toLowerCase();
        return !change.source ||
            reason === "reload" ||
            reason === "add" ||
            reason === "added" ||
            reason === "remove" ||
            reason === "removed" ||
            reason === "config-error";
    }

    /** Coalesces refreshes while keeping revision targets scoped to one backend connection. */
    private requestSourceCatalogRefresh(
        targetRevision: number | null = null,
        resetRevisionEpoch: boolean = false
    ): void {
        if (targetRevision !== null && Number.isFinite(targetRevision)) {
            const normalized = Math.max(0, Math.floor(targetRevision));
            this.sourceCatalogRefreshTargetRevision =
                resetRevisionEpoch ||
                this.sourceCatalogRefreshTargetRevision === null
                    ? normalized
                    : Math.max(
                        this.sourceCatalogRefreshTargetRevision,
                        normalized
                    );
        } else if (resetRevisionEpoch) {
            this.sourceCatalogRefreshTargetRevision = null;
        }
        if (this.sourceCatalogReloadPromise) {
            // The running fetch may belong to the previous backend process. A
            // second fetch is required even if its response happens to look current.
            this.sourceCatalogReloadAfterCurrent ||= resetRevisionEpoch;
            return;
        }
        this.sourceCatalogReloadPromise = this.reloadSourceCatalogUntilCaughtUp()
            .then(() => this.scheduleUpdate())
            .catch(error =>
                console.error("Failed to refresh datasource catalog.", error)
            )
            .finally(() => {
                this.sourceCatalogReloadPromise = null;
                if (this.sourceCatalogReloadAfterCurrent) {
                    this.sourceCatalogReloadAfterCurrent = false;
                    this.sourceCatalogRefreshTargetRevision = null;
                    this.requestSourceCatalogRefresh();
                    return;
                }
                const pendingRevision = this.sourceCatalogRefreshTargetRevision;
                if (pendingRevision !== null) {
                    const currentRevision = this.mapInfo.sourceCatalogRevision;
                    if (currentRevision === null ||
                        currentRevision < pendingRevision) {
                        this.requestSourceCatalogRefresh(pendingRevision);
                    } else {
                        this.sourceCatalogRefreshTargetRevision = null;
                    }
                }
            });
    }

    private async reloadSourceCatalogUntilCaughtUp(): Promise<void> {
        for (let attempt = 0; attempt < 2; ++attempt) {
            const requested = this.sourceCatalogRefreshTargetRevision;
            this.sourceCatalogRefreshTargetRevision = null;
            await this.mapInfo.reloadDataSources();
            const streamRevision = this.tileStream?.getSourcesRevision() ?? null;
            const target = Math.max(requested ?? -1, streamRevision ?? -1);
            if (target < 0 ||
                (this.mapInfo.sourceCatalogRevision ?? -1) >= target) {
                return;
            }
            this.sourceCatalogRefreshTargetRevision = target;
        }
    }

    private showInfo(message: string): void {
        this.ngZone.run(() => this.messageService.showInfo(message));
    }

    private showError(message: string): void {
        this.ngZone.run(() => this.messageService.showError(message));
    }

    private showBackendConnectionError(message: string): void {
        this.ngZone.run(() =>
            this.messageService.showBackendConnectionError(message)
        );
    }

    private showBackendProtocolError(message: string): void {
        this.ngZone.run(() =>
            this.messageService.showBackendProtocolError(message)
        );
    }
}
