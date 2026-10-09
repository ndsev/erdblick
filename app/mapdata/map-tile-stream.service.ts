import {Injectable, NgZone, OnDestroy} from "@angular/core";
import {auditTime, BehaviorSubject, combineLatest, Subject, Subscription} from "rxjs";
import {MapInfoService} from "./map-info.service";
import {
    MapTileRequestStatus,
    MapTileStreamClientInteractive,
    MapTileStreamClientTiles,
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
import {TileDeliveryError} from "./tile-diagnostics";
import {TileExpiryScheduler} from "./tile-expiry-scheduler";
import {
    ConnectionRetryAttempt, ConnectionRetryPolicy, connectionRetryDeadline,
    recordConnectionFailure
} from "../shared/connection-retry-policy";
import {
    parseMapPartitionKey,
    parsePartition,
    partitionJson,
    partitionKey,
    partitionKeySuffix,
    type ObjectPartitionId,
    type PartitionId
} from "./partition.model";
import type {MapgetLayer} from "./mapget-layer.model";

export interface RetainedTileExpiryOwner {
    expireTiles(tokens: ReadonlyArray<{
        tileId: string | number;
        valueVersion: number;
    }>): void;
}

type StreamExpiryOwner = RetainedTileExpiryOwner | FilterSubscriptionRef;

/** A failure remains owned until recovery, cancellation or a new generation. */
interface OwnedRetry extends ConnectionRetryAttempt {
    generation: number;
    retryable: boolean;
    sourceMapId?: string;
}

export interface BackendRequestProgress {
    done: number;
    total: number;
    allDone: boolean;
    requestId?: number;
}

export interface ObjectPartitionAssociation {
    readonly partition: ObjectPartitionId;
    readonly bounds?: readonly [number, number, number, number];
    readonly discoveryTileId: number;
}

export interface ObjectDiscoveryCoverage {
    readonly associations: readonly ObjectPartitionAssociation[];
    readonly expiresAtMs: number | null;
}

interface ObjectDiscoveryTileValue {
    readonly objects: ReadonlyArray<{
        partition: ObjectPartitionId;
        bounds?: readonly [number, number, number, number];
    }>;
    readonly expiresAtMs: number | null;
}

interface ObjectDiscoveryCacheEntry {
    value?: ObjectDiscoveryTileValue;
    pending?: Promise<ObjectDiscoveryTileValue>;
}

const MAX_OBJECT_DISCOVERY_CACHE_TILES = 4096;

/**
 * Owns interactive filter transport and attachment refs.
 *
 * Delivered subsets are transferred directly to their subscription owner.
 * Complete feature data is fetched only through feature-restricted, one-shot
 * `/tiles` requests for inspection and is never inserted into a viewport cache.
 */
@Injectable({providedIn: "root"})
export class MapTileStreamService implements OnDestroy {
    readonly tilePipelinePaused$ = new BehaviorSubject<boolean>(false);
    readonly filterStatusReceived =
        new Subject<MapTileStreamFilterStatusPayload>();

    private tileStream: MapTileStreamClientInteractive | null = null;
    private pageHidden = false;
    private pageResumeFrame: number | null = null;
    private readonly filterSubscriptionsById =
        new Map<string, FilterSubscriptionRef>();
    private nextFilterSubscriptionId = 0;
    private updateTimer: ReturnType<typeof setTimeout> | null = null;
    private acknowledgementTimer: ReturnType<typeof setTimeout> | null = null;
    private acknowledgementPending = false;
    private acknowledgementBurstStartedAt = 0;
    private updatePending = false;
    private updateInProgress = false;
    private updateRequestedWhilePaused = false;
    private forceNextUpdate = false;
    private readonly tileExpiryScheduler =
        new TileExpiryScheduler<StreamExpiryOwner, string | number>(
            (owner, tokens) => {
                if (owner instanceof FilterSubscriptionRef) {
                    owner.expirePartitions(tokens.map(token => ({
                        partitionKey: String(token.tileId),
                        valueVersion: token.valueVersion
                    })));
                } else {
                    owner.expireTiles(tokens);
                }
            }
        );
    private readonly deferredRetainedRetries = new Map<RetainedTileExpiryOwner, Array<{tileId: string | number; valueVersion: number}>>();
    private readonly filterRetryDeadlines = new Map<FilterSubscriptionRef, OwnedRetry>();
    private readonly retainedRetries = new Map<RetainedTileExpiryOwner, Map<string | number, OwnedRetry>>();
    private connectionRetry?: ConnectionRetryAttempt;
    private connectionTerminalError = "";
    private activeInspectionLoads = 0;
    private retryPolicy: ConnectionRetryPolicy;
    private readonly stateSubscriptions = new Subscription();
    private readonly connectionRetryOwner: RetainedTileExpiryOwner = {expireTiles: () => {
        if (this.connectionRetry) this.connectionRetry.at = 0;
        this.forceNextUpdate = true;
        this.scheduleUpdate();
    }};
    private readonly retryScheduler = new TileExpiryScheduler<StreamExpiryOwner, string | number>(
        (owner, tokens) => {
            if (owner instanceof FilterSubscriptionRef) {
                if (!owner.released && !owner.suspended &&
                    owner.generation === tokens[0].valueVersion &&
                    this.filterSubscriptionsById.get(owner.filterId) === owner &&
                    !this.backendProtocolMismatchActive) {
                    this.updateFilterSubscription(owner, true);
                }
            } else if (!this.backendProtocolMismatchActive) {
                for (const token of tokens) {
                    const retry = this.retainedRetries.get(owner)?.get(token.tileId);
                    if (retry) retry.at = 0;
                }
                if (this.pageHidden || this.tilePipelinePaused)
                    this.deferredRetainedRetries.set(owner, tokens);
                else owner.expireTiles(tokens);
            }
        }
    );
    private readonly updateDebounceMs = 25;
    private readonly acknowledgementQuietMs = 100;
    private readonly acknowledgementMaxLatencyMs = 500;
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
    private readonly objectDiscoveryCache =
        new WeakMap<MapgetLayer, Map<number, ObjectDiscoveryCacheEntry>>();

    constructor(
        private readonly stateService: AppStateService,
        private readonly mapInfo: MapInfoService,
        private readonly messageService: InfoMessageService,
        private readonly ngZone: NgZone
    ) {
        this.retryPolicy = this.stateService.connectionRetryPolicy;
        this.stateSubscriptions.add(combineLatest([
            this.stateService.connectionRetryEnabledState,
            this.stateService.connectionRetryInitialDelayMsState,
            this.stateService.connectionRetryBackoffMultiplierState,
            this.stateService.connectionRetryMaxDelayMsState
        ]).pipe(auditTime(0)).subscribe(() => this.applyRetryPolicy()));
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
        this.tileStream = new MapTileStreamClientInteractive(
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
            this.ngZone.runOutsideAngular(() => {
                this.clearConnectionFailure();
                this.handleSourcesRevisionChanged(revision, reconnected);
            });
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
            this.retryScheduler.dispose();
            this.filterRetryDeadlines.clear();
            this.retainedRetries.clear();
            this.connectionRetry = undefined;
            this.showBackendProtocolError(
                `The map backend uses unsupported tile-stream protocol ${actual}; ` +
                `this erdblick build requires ${expected}.`
            );
        };
        this.tileStream.onError = event => {
            if (this.pageHidden) {
                return;
            }
            console.error("Tile WebSocket error.", event);
            if (!this.backendProtocolMismatchActive) {
                this.scheduleConnectionRetry("Could not connect to the map backend.");
                this.showBackendConnectionError(
                    "Could not connect to the map backend."
                );
            }
        };
        this.tileStream.onClose = event => {
            if (this.pageHidden) {
                return;
            }
            if (!this.backendProtocolMismatchActive && event.code !== 1000) {
                const detail = event.reason ? ` (${event.reason})` : "";
                this.showBackendConnectionError(
                    `The map backend connection was closed${detail}.`
                );
                if (event.code === 1002 || event.code === 1003 || event.code === 1008) {
                    this.connectionTerminalError = event.reason || "Backend rejected the connection.";
                    this.retryScheduler.cancelOwner(this.connectionRetryOwner);
                    this.connectionRetry = undefined;
                } else {
                    this.scheduleConnectionRetry(event.reason || "Backend connection closed.");
                }
            }
            if (!this.backendProtocolMismatchActive) {
                this.scheduleUpdate();
            }
        };
        this.ngZone.runOutsideAngular(() => {
            window.addEventListener("beforeunload", this.onBeforeUnload);
            window.addEventListener("pagehide", this.onPageHide);
            window.addEventListener("pageshow", this.onPageShow);
        });
        await this.mapInfo.reloadDataSources();
        this.scheduleUpdate();
    }

    /** WebKit may cancel fetches before pagehide; resume only when this document renders again. */
    private readonly onBeforeUnload = (): void => {
        this.onPageHide();
        // A zero-delay timer can reopen the socket while WebKit is still unloading.
        this.pageResumeFrame = requestAnimationFrame(() => {
            this.pageResumeFrame = null;
            this.onPageShow();
        });
    };

    /** Stops transport work without destroying state that a back/forward-cache restore still needs. */
    private readonly onPageHide = (): void => {
        this.cancelPageResume();
        this.pageHidden = true;
        this.clearUpdateTimers();
        this.tileStream?.setFrameProcessingPaused(true);
        this.tileStream?.close(1000, "page hidden");
    };

    /** A back/forward-cache restore needs a new session and the complete current pending snapshot. */
    private readonly onPageShow = (): void => {
        this.cancelPageResume();
        if (!this.pageHidden) {
            return;
        }
        this.pageHidden = false;
        this.flushRetainedRetries();
        this.tileStream?.clearPendingFrames();
        this.tileStream?.setFrameProcessingPaused(this.tilePipelinePaused);
        this.forceNextUpdate = true;
        if (!this.backendProtocolMismatchActive) {
            this.scheduleUpdate();
        }
    };

    /** Prevents a deferred cancelled-navigation recovery from reviving a hidden or destroyed page. */
    private cancelPageResume(): void {
        if (this.pageResumeFrame !== null) {
            cancelAnimationFrame(this.pageResumeFrame);
            this.pageResumeFrame = null;
        }
    }

    /** Removes page listeners and releases the owned transport when the Angular root is destroyed. */
    ngOnDestroy(): void {
        this.stateSubscriptions.unsubscribe();
        window.removeEventListener("beforeunload", this.onBeforeUnload);
        window.removeEventListener("pagehide", this.onPageHide);
        window.removeEventListener("pageshow", this.onPageShow);
        this.onPageHide();
        this.tileStream?.destroy();
        this.tileStream = null;
        this.tileExpiryScheduler.dispose();
        this.retryScheduler.dispose();
        this.filterRetryDeadlines.clear();
        this.deferredRetainedRetries.clear();
        this.retainedRetries.clear();
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
        if (coverage.partitions.length > 0) {
            this.updateFilterSubscription(ref, true);
        }
        return ref;
    }

    /**
     * Resolve visible spatial discovery tiles into one ordered object union.
     * Per-tile results are cached only for their advertised semantic lifetime;
     * concurrent callers share the same bounded HTTP batch.
     */
    async discoverObjectPartitions(
        layer: MapgetLayer,
        discoveryTileIds: readonly number[]
    ): Promise<ObjectDiscoveryCoverage> {
        if (layer.partitionKind !== "object" ||
            layer.tileAssociationLevel === null) {
            throw new Error(
                `Layer '${layer.key}' does not advertise object discovery.`
            );
        }
        const uniqueTiles = [...new Set(discoveryTileIds.map(Number))];
        if (!uniqueTiles.length) {
            return {associations: [], expiresAtMs: null};
        }
        let cache = this.objectDiscoveryCache.get(layer);
        if (!cache) {
            cache = new Map();
            this.objectDiscoveryCache.set(layer, cache);
        }
        const now = Date.now();
        const missing = uniqueTiles.filter(tileId => {
            const entry = cache!.get(tileId);
            return !entry?.pending && (!entry?.value ||
                (entry.value.expiresAtMs !== null &&
                    now >= entry.value.expiresAtMs));
        });
        for (let offset = 0; offset < missing.length; offset += 256) {
            const tileIds = missing.slice(offset, offset + 256);
            const batch = this.fetchObjectDiscoveryBatch(layer, tileIds);
            tileIds.forEach((tileId, index) => {
                const pending = batch.then(values => values[index]);
                const entry: ObjectDiscoveryCacheEntry = {pending};
                cache!.set(tileId, entry);
                pending.then(value => {
                    if (cache!.get(tileId) === entry) {
                        cache!.set(tileId, {value});
                    }
                }).catch(() => {
                    if (cache!.get(tileId) === entry) {
                        cache!.delete(tileId);
                    }
                });
            });
        }
        const values = await Promise.all(uniqueTiles.map(async tileId => {
            const entry = cache!.get(tileId);
            if (entry?.pending) {
                return entry.pending;
            }
            if (entry?.value) {
                return entry.value;
            }
            throw new Error(
                `Object discovery cache lost tile '${tileId}'.`
            );
        }));
        this.trimObjectDiscoveryCache(cache, new Set(uniqueTiles));
        const seen = new Set<string>();
        const associations: ObjectPartitionAssociation[] = [];
        let expiresAtMs: number | null = null;
        values.forEach((value, tileIndex) => {
            if (value.expiresAtMs !== null) {
                expiresAtMs = expiresAtMs === null
                    ? value.expiresAtMs
                    : Math.min(expiresAtMs, value.expiresAtMs);
            }
            for (const object of value.objects) {
                const key = partitionKey(object.partition);
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                associations.push({
                    partition: object.partition,
                    ...(object.bounds ? {bounds: object.bounds} : {}),
                    discoveryTileId: uniqueTiles[tileIndex]
                });
            }
        });
        return {associations, expiresAtMs};
    }

    /** Bound long-running pan sessions without evicting current or in-flight discovery. */
    private trimObjectDiscoveryCache(
        cache: Map<number, ObjectDiscoveryCacheEntry>,
        protectedTileIds: ReadonlySet<number>
    ): void {
        if (cache.size <= MAX_OBJECT_DISCOVERY_CACHE_TILES) {
            return;
        }
        for (const [tileId, entry] of cache) {
            if (cache.size <= MAX_OBJECT_DISCOVERY_CACHE_TILES) {
                break;
            }
            if (!entry.pending && !protectedTileIds.has(tileId)) {
                cache.delete(tileId);
            }
        }
    }

    /** Load one server-limited discovery batch and validate every response slot. */
    private async fetchObjectDiscoveryBatch(
        layer: MapgetLayer,
        tileIds: readonly number[]
    ): Promise<ObjectDiscoveryTileValue[]> {
        const response = await fetch("/objects/discover", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                requests: [{
                    mapId: layer.mapId,
                    layerId: layer.layerId,
                    ...(layer.sourceId ? {sourceId: layer.sourceId} : {}),
                    tileIds
                }]
            })
        });
        if (!response.ok) {
            throw new Error(
                `Object discovery for '${layer.key}' failed with ` +
                `${response.status} ${response.statusText}.`
            );
        }
        const body = await response.json() as {responses?: unknown[]};
        if (!Array.isArray(body.responses) ||
            body.responses.length !== tileIds.length) {
            throw new Error(
                `Object discovery for '${layer.key}' returned an ` +
                "incomplete response."
            );
        }
        const byTile = new Map<number, ObjectDiscoveryTileValue>();
        for (const raw of body.responses) {
            const item = raw as {
                mapId?: unknown;
                layerId?: unknown;
                tileId?: unknown;
                sourceId?: unknown;
                status?: unknown;
                message?: unknown;
                timestamp?: unknown;
                ttlMs?: unknown;
                objects?: unknown;
            };
            const tileId = Number(item.tileId);
            if (item.mapId !== layer.mapId ||
                item.layerId !== layer.layerId ||
                item.sourceId !== (layer.sourceId || undefined) ||
                !tileIds.includes(tileId) ||
                byTile.has(tileId)) {
                throw new Error(
                    `Object discovery for '${layer.key}' returned an ` +
                    "unexpected identity."
                );
            }
            if (item.status === "failed") {
                throw new Error(
                    `Object discovery for '${layer.key}' tile ${tileId} ` +
                    `failed: ${String(item.message ?? "unknown error")}`
                );
            }
            if (item.status !== "success" && item.status !== "unavailable") {
                throw new Error(
                    `Object discovery for '${layer.key}' returned invalid status.`
                );
            }
            const timestamp = Number(item.timestamp);
            const ttlMs = Number(item.ttlMs);
            const expiresAtMs = timestamp + ttlMs;
            if (!Number.isSafeInteger(timestamp) || timestamp < 0 ||
                !Number.isSafeInteger(ttlMs) || ttlMs < 0 ||
                !Number.isSafeInteger(expiresAtMs)) {
                throw new Error(
                    `Object discovery for '${layer.key}' returned invalid freshness.`
                );
            }
            const objects = item.status === "success"
                ? this.parseDiscoveredObjects(item.objects, layer.key)
                : [];
            byTile.set(tileId, {
                objects,
                expiresAtMs: ttlMs === 0 ? null : expiresAtMs
            });
        }
        return tileIds.map(tileId => byTile.get(tileId)!);
    }

    /** Parse lossless object references and optional WGS84 bounds. */
    private parseDiscoveredObjects(
        value: unknown,
        layerKey: string
    ): ObjectDiscoveryTileValue["objects"] {
        if (!Array.isArray(value)) {
            throw new Error(
                `Object discovery for '${layerKey}' returned invalid objects.`
            );
        }
        return value.map(raw => {
            const item = raw as {id?: unknown; bounds?: unknown};
            const partition = parsePartition({
                kind: "object",
                id: item.id
            });
            if (partition.kind !== "object") {
                throw new Error("Object discovery returned a tile partition.");
            }
            if (item.bounds === undefined) {
                return {partition};
            }
            if (!Array.isArray(item.bounds) || item.bounds.length !== 4 ||
                item.bounds.some(coordinate =>
                    typeof coordinate !== "number" ||
                    !Number.isFinite(coordinate)
                ) ||
                item.bounds[0] < -180 || item.bounds[0] > 180 ||
                item.bounds[2] < -180 || item.bounds[2] > 180 ||
                item.bounds[1] < -90 || item.bounds[3] > 90 ||
                item.bounds[1] > item.bounds[3]) {
                throw new Error(
                    `Object discovery for '${layerKey}' returned invalid bounds.`
                );
            }
            return {
                partition,
                bounds: item.bounds as [number, number, number, number]
            };
        });
    }

    updateFilterSubscription(
        ref: FilterSubscriptionRef,
        force: boolean
    ): void {
        const retry = this.filterRetryDeadlines.get(ref);
        if (retry && (retry.generation !== ref.generation || ref.suspended ||
            !(ref.requestJson()["partitions"] as unknown[]).length)) {
            this.retryScheduler.cancelOwner(ref);
            this.filterRetryDeadlines.delete(ref);
        }
        if (!ref.released &&
            this.filterSubscriptionsById.get(ref.filterId) === ref) {
            if (force) {
                this.forceNextUpdate = true;
                this.scheduleUpdate();
            } else {
                this.scheduleAcknowledgementUpdate();
            }
        }
    }

    updateFilterPartitionExpiry(
        ref: FilterSubscriptionRef,
        partition: PartitionId,
        valueVersion: number,
        expiresAtMs: number | null
    ): void {
        if (this.filterSubscriptionsById.get(ref.filterId) !== ref ||
            ref.released) {
            return;
        }
        if (expiresAtMs === null) {
            this.tileExpiryScheduler.cancel(ref, partitionKey(partition));
            return;
        }
        this.tileExpiryScheduler.schedule(
            ref,
            partitionKey(partition),
            valueVersion,
            expiresAtMs
        );
    }

    /** Shares the application's indexed one-timer heap with retained non-subset tiles. */
    updateRetainedTileExpiry(
        owner: RetainedTileExpiryOwner,
        tileId: string | number,
        valueVersion: number,
        expiresAtMs: number | null
    ): void {
        this.retryScheduler.cancelOwner(owner);
        this.retainedRetries.delete(owner);
        this.deferredRetainedRetries.delete(owner);
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

    private flushRetainedRetries(): void {
        if (this.pageHidden || this.tilePipelinePaused || this.backendProtocolMismatchActive || !this.retryPolicy.enabled) return;
        const pending = [...this.deferredRetainedRetries];
        this.deferredRetainedRetries.clear();
        for (const [owner, tokens] of pending) owner.expireTiles(tokens);
    }

    /** Retry only explicitly transient errors while the caller retains ownership. */
    scheduleRetainedTileRetry(owner: RetainedTileExpiryOwner, tileId: string | number,
                              valueVersion: number, error: unknown): boolean {
        if (!(error instanceof TileDeliveryError) || this.backendProtocolMismatchActive) return false;
        const retryable = error.retryAfterMs !== null;
        if (!retryable && !error.serviceError) return false;
        let entries = this.retainedRetries.get(owner);
        if (!entries) this.retainedRetries.set(owner, entries = new Map());
        const previous = entries.get(tileId);
        const retry: OwnedRetry = {...recordConnectionFailure(
            previous?.generation === valueVersion ? previous : undefined,
            error.message, error.retryAfterMs ?? 0), generation: valueVersion, retryable,
            sourceMapId: error.mapId};
        entries.set(tileId, retry);
        this.scheduleOwnedRetry(owner, tileId, retry);
        return retryable;
    }

    cancelRetainedTileExpiries(
        owner: RetainedTileExpiryOwner
    ): void {
        this.tileExpiryScheduler.cancelOwner(owner);
        this.retryScheduler.cancelOwner(owner);
        this.deferredRetainedRetries.delete(owner);
        this.retainedRetries.delete(owner);
    }

    cancelFilterPartitionExpiries(
        ref: FilterSubscriptionRef,
        partitions?: readonly PartitionId[]
    ): void {
        if (partitions) {
            for (const partition of partitions) {
                this.tileExpiryScheduler.cancel(ref, partitionKey(partition));
            }
            return;
        }
        this.tileExpiryScheduler.cancelOwner(ref);
    }

    releaseFilterSubscription(ref: FilterSubscriptionRef): void {
        if (this.filterSubscriptionsById.get(ref.filterId) !== ref) {
            return;
        }
        this.cancelFilterPartitionExpiries(ref);
        this.retryScheduler.cancelOwner(ref);
        this.filterRetryDeadlines.delete(ref);
        this.filterSubscriptionsById.delete(ref.filterId);
        this.scheduleUpdate();
    }

    retainTileAttachment(request: {
        mapId: string;
        layerId: string;
        partition: PartitionId;
        name: string;
        sourceId?: string;
        incarnation?: number;
    }): TileAttachmentRef {
        const key = [
            request.mapId,
            request.layerId,
            partitionKey(request.partition),
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
        tileFeatureIds: (TileFeatureId | null)[],
        signal?: AbortSignal
    ): Promise<FeatureWrapper[]> {
        let wake: (() => void) | undefined;
        const owner: RetainedTileExpiryOwner = {expireTiles: () => wake?.()};
        const cancel = () => this.cancelRetainedTileExpiries(owner);
        let retainTerminalFailure = false;
        signal?.addEventListener("abort", cancel, {once: true});
        try { while (true) {
            signal?.throwIfAborted();
            try {
                const finishLoading = this.beginInspectionLoad();
                try { return await this.loadFeaturesOnce(tileFeatureIds, signal); }
                finally { finishLoading(); }
            }
            catch (error) {
                if (!signal || !(error instanceof TileDeliveryError)) throw error;
                const scheduled = this.scheduleRetainedTileRetry(owner, "inspection", 0, error);
                if (!scheduled) {
                    retainTerminalFailure = error.serviceError && !signal.aborted;
                    throw error;
                }
                await new Promise<void>((resolve, reject) => {
                    wake = () => {
                        signal.removeEventListener("abort", abort);
                        resolve();
                    };
                    const abort = () => {
                        cancel();
                        reject(signal.reason);
                    };
                    signal.addEventListener("abort", abort, {once: true});
                    if (signal.aborted) abort();
                });
            }
        } } finally {
            if (!retainTerminalFailure) {
                signal?.removeEventListener("abort", cancel);
                cancel();
            }
        }
    }

    private async loadFeaturesOnce(
        tileFeatureIds: (TileFeatureId | null)[], signal?: AbortSignal
    ): Promise<FeatureWrapper[]> {
        signal?.throwIfAborted();
        const requested = tileFeatureIds.filter(
            (value): value is TileFeatureId => !!value
        );
        if (!requested.length) {
            return [];
        }
        const direct = await this.loadFeaturesFromDeclaredTiles(requested, signal);
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

        const relocated = await this.locateCanonicalFeatures(missing, signal);
        const relocatedRequests = relocated
            .filter((value): value is TileFeatureId => !!value);
        const relocatedFeatures = relocatedRequests.length
            ? await this.loadFeaturesFromDeclaredTiles(relocatedRequests, signal)
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
        requested: TileFeatureId[],
        signal?: AbortSignal
    ): Promise<FeatureWrapper[]> {
        signal?.throwIfAborted();
        if (this.tilePipelinePaused) {
            this.showInfo(
                "Tile pipeline is paused; cannot load inspection features."
            );
            return [];
        }

        const groups = new Map<string, {
            mapId: string;
            layerId: string;
            partitions: Map<string, {
                partition: PartitionId;
                ids: string[];
            }>;
        }>();
        for (const feature of requested) {
            const parsed = this.parseMapPartitionKeySafe(feature.mapTileKey);
            if (!parsed) {
                continue;
            }
            const [mapId, layerId, partition] = parsed;
            const groupKey = `${mapId}\n${layerId}`;
            let group = groups.get(groupKey);
            if (!group) {
                group = {mapId, layerId, partitions: new Map()};
                groups.set(groupKey, group);
            }
            const key = partitionKey(partition);
            let entry = group.partitions.get(key);
            if (!entry) {
                entry = {partition, ids: []};
                group.partitions.set(key, entry);
            }
            const baseId = stripFeatureInspectionTarget(feature.featureId);
            if (!entry.ids.includes(baseId)) {
                entry.ids.push(baseId);
            }
        }
        const distinctPartitionCount = [...groups.values()]
            .reduce((count, group) => count + group.partitions.size, 0);
        if (distinctPartitionCount > MAX_NUM_TILES_TO_LOAD) {
            throw new Error(
                `Inspection feature request exceeds ` +
                `${MAX_NUM_TILES_TO_LOAD} partitions.`
            );
        }

        const transport = new MapTileStreamClientTiles(
            "/tiles",
            this.mapInfo.tileLayerParser
        );
        transport.onFields = () =>
            this.mapInfo.invalidateFieldDictBlobCache();
        const tiles = new Map<string, InspectionFeatureTile>();
        transport.onFeatures = blob => {
            const tile = new InspectionFeatureTile(
                this.mapInfo.tileLayerParser,
                blob
            );
            tiles.set(tile.mapTileKey, tile);
            for (const warning of tile.warnings) console.warn(`Tile warning (${tile.mapTileKey}): ${warning}`);
            if (tile.legalInfo) {
                this.mapInfo.setLegalInfo(tile.mapName, tile.legalInfo);
            }
        };
        const requests = [...groups.values()].map(group => ({
            mapId: group.mapId,
            layerId: group.layerId,
            partitions: [...group.partitions.values()].map(entry =>
                partitionJson(entry.partition)
            ),
            featureIds: [...group.partitions.values()].map(entry => ({
                partition: partitionJson(entry.partition),
                ids: entry.ids
            }))
        }));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        try {
            const cancelled = new Promise<never>((_, reject) => {
                abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
                signal?.addEventListener("abort", abort, {once: true});
                if (signal?.aborted) abort();
            });
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(
                        "Inspection feature request timed out."
                    )),
                    30_000
                );
            });
            await Promise.race([
                transport.request(requests),
                timeoutPromise,
                cancelled
            ]);
            if (tiles.size < distinctPartitionCount) {
                console.warn(
                    "Inspection feature request returned fewer partitions than requested.",
                    {requested: distinctPartitionCount, received: tiles.size}
                );
            }
        } finally {
            if (abort) signal?.removeEventListener("abort", abort);
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
        requested: TileFeatureId[],
        signal?: AbortSignal
    ): Promise<Array<TileFeatureId | null>> {
        const requests = requested.map(feature => {
            const parsed = this.parseMapPartitionKeySafe(feature.mapTileKey);
            return parsed
                ? {
                    mapId: parsed[0],
                    layerId: parsed[1],
                    partition: partitionJson(parsed[2]),
                    featureId: stripFeatureInspectionTarget(feature.featureId)
                }
                : null;
        });
        const validRequests = requests.filter(
            (request): request is {
                mapId: string;
                layerId: string;
                partition: PartitionId;
                featureId: string;
            } => !!request
        );
        if (!validRequests.length) {
            return requested.map(() => null);
        }
        try {
            const response = await fetch("/locate", {
                signal,
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
                    partitionKey?: string;
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
                        typeof (candidate.partitionKey ?? candidate.tileId) ===
                            "string" &&
                        this.parseMapPartitionKeySafe(
                            candidate.partitionKey ?? candidate.tileId!
                        ) !== null
                    )
                    .sort((left, right) =>
                        String(left.partitionKey ?? left.tileId).localeCompare(
                            String(right.partitionKey ?? right.tileId)
                        ) ||
                        String(left.canonicalFeatureId ?? "")
                            .localeCompare(String(right.canonicalFeatureId ?? ""))
                    );
                const candidate = candidates[0];
                const mapTileKey = candidate?.partitionKey ?? candidate?.tileId;
                if (!mapTileKey) {
                    return null;
                }
                return {
                    mapTileKey,
                    featureId: candidate.canonicalFeatureId ??
                        request.featureId
                };
            });
        } catch (error) {
            signal?.throwIfAborted();
            console.warn("Canonical feature locate failed.", error);
            return requested.map(() => null);
        }
    }

    private featureIdentityKey(feature: TileFeatureId): string {
        return `${feature.mapTileKey}\n${stripFeatureInspectionTarget(feature.featureId)}`;
    }

    parseMapTileKeySafe(tileKey: string): [string, string, number] | null {
        const parsed = this.parseMapPartitionKeySafe(tileKey);
        return parsed?.[2].kind === "tile"
            ? [parsed[0], parsed[1], parsed[2].id]
            : null;
    }

    /** Parse a generic MapPartitionKey without narrowing an object id. */
    parseMapPartitionKeySafe(
        key: string
    ): [string, string, PartitionId] | null {
        try {
            return parseMapPartitionKey(coreLib, key);
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
        this.clearUpdateTimers();
        this.updateRequestedWhilePaused ||=
            this.updatePending || this.acknowledgementPending;
        this.tileStream?.setFrameProcessingPaused(true);
        this.showInfo("Tile pipeline paused");
        console.info(`Tile pipeline paused (${source})`);
    }

    /** Cancels both scheduled control updates without discarding their pending-work state. */
    private clearUpdateTimers(): void {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        if (this.acknowledgementTimer) {
            clearTimeout(this.acknowledgementTimer);
            this.acknowledgementTimer = null;
        }
    }

    resumeTilePipeline(source: string = "diagnostics"): void {
        if (!this.tilePipelinePaused) {
            return;
        }
        this.tilePipelinePaused$.next(false);
        this.flushRetainedRetries();
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

    /** Counts actual inspection transfers separately from promises waiting for a retry. */
    beginInspectionLoad(): () => void {
        ++this.activeInspectionLoads;
        return () => --this.activeInspectionLoads;
    }

    /** Schedules through the existing heap; disabled/terminal failures keep state but no timer. */
    private scheduleOwnedRetry(owner: StreamExpiryOwner, key: string | number, retry: OwnedRetry): void {
        retry.at = retry.retryable ? connectionRetryDeadline(this.retryPolicy, retry) : Infinity;
        this.retryScheduler.schedule(owner, key, retry.generation, retry.at);
    }

    /** Recomputes waiting deadlines when preferences change, retaining attempts and live work. */
    private applyRetryPolicy(): void {
        this.retryPolicy = this.stateService.connectionRetryPolicy;
        for (const [owner, retry] of this.filterRetryDeadlines) {
            if (retry.at > 0) this.scheduleOwnedRetry(owner, "retry", retry);
        }
        for (const [owner, entries] of this.retainedRetries) {
            for (const [key, retry] of entries) {
                if (retry.at > 0 || this.deferredRetainedRetries.has(owner)) this.scheduleOwnedRetry(owner, key, retry);
            }
            this.deferredRetainedRetries.delete(owner);
        }
        if (this.connectionRetry && this.connectionRetry.at > 0) {
            this.connectionRetry.at = connectionRetryDeadline(this.retryPolicy, this.connectionRetry);
            this.retryScheduler.schedule(this.connectionRetryOwner, "connection", 0, this.connectionRetry.at);
            this.deferredRetainedRetries.delete(this.connectionRetryOwner);
        }
    }

    /** Coalesces error/close callbacks for one failed connection attempt. */
    private scheduleConnectionRetry(message: string): void {
        if (this.pageHidden || this.backendProtocolMismatchActive || this.connectionTerminalError) return;
        this.backendRequestProgress = {done: 0, total: 0, allDone: true};
        this.connectionRetry = recordConnectionFailure(this.connectionRetry, message);
        this.connectionRetry.at = connectionRetryDeadline(this.retryPolicy, this.connectionRetry);
        this.retryScheduler.schedule(this.connectionRetryOwner, "connection", 0, this.connectionRetry.at);
    }

    /** A compatible context/status frame proves recovery; an open TCP/WebSocket alone does not. */
    private clearConnectionFailure(): void {
        this.connectionRetry = undefined;
        this.connectionTerminalError = "";
        this.retryScheduler.cancelOwner(this.connectionRetryOwner);
    }

    /** Current owner state drives the circle; historical logs and pending counts do not. */
    getConnectionDiagnostics(): {retrying: boolean; failed: boolean; loading: boolean; message: string} {
        const catalog = this.mapInfo.getSourceRecoveryState();
        const retries = [
            ...[...this.filterRetryDeadlines].filter(([owner, retry]) =>
                !owner.released && !owner.suspended && owner.generation === retry.generation).map(([, retry]) => retry),
            ...[...this.retainedRetries.values()].flatMap(entries => [...entries.values()])
        ];
        const browserRetrying = this.retryPolicy.enabled &&
            (!!this.connectionRetry || retries.some(retry => retry.retryable));
        const activeFilters = [...this.filterSubscriptionsById.values()].some(ref =>
            !ref.released && !ref.suspended && ref.pendingPartitionCount > 0 &&
            !(this.filterRetryDeadlines.get(ref)?.at));
        const loading = this.isTileStreamConnected() && !this.connectionRetry &&
            (this.activeInspectionLoads > 0 || (!this.backendRequestProgress.allDone && activeFilters));
        const describe = (retry: ConnectionRetryAttempt, source: string, eligible = true) => {
            const action = !eligible ? "No automatic retry." : !this.retryPolicy.enabled ? "Automatic retry disabled." :
                retry.at > 0 ? `Retry in ${Math.max(0, Math.ceil((retry.at - Date.now()) / 1000))} s.` : "Retrying.";
            return `${source}: ${retry.message} ${action}`;
        };
        const messages = [catalog.message, this.connectionTerminalError,
            this.connectionRetry && describe(this.connectionRetry, "Backend"),
            ...retries.map(retry => describe(retry, retry.sourceMapId || "Datasource", retry.retryable))].filter(Boolean);
        return {
            retrying: catalog.retrying || (!this.pageHidden && !this.tilePipelinePaused && browserRetrying),
            failed: catalog.failed || retries.length > 0 || !!this.connectionRetry ||
                !!this.connectionTerminalError || this.backendProtocolMismatchActive,
            loading,
            message: [...new Set(messages)].join("\n")
        };
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
                .reduce((count, ref) => count + ref.pendingPartitionCount, 0)
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
        if (this.pageHidden) {
            return;
        }
        if (this.acknowledgementTimer) {
            clearTimeout(this.acknowledgementTimer);
            this.acknowledgementTimer = null;
        }
        this.acknowledgementPending = false;
        this.acknowledgementBurstStartedAt = 0;
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

    /** Coalesce acceptance-only omission snapshots without delaying forced work. */
    private scheduleAcknowledgementUpdate(): void {
        if (this.pageHidden) {
            return;
        }
        this.acknowledgementPending = true;
        if (this.tilePipelinePaused) {
            this.updateRequestedWhilePaused = true;
            return;
        }
        const now = Date.now();
        if (!this.acknowledgementBurstStartedAt) {
            this.acknowledgementBurstStartedAt = now;
        }
        const dueAt = Math.min(
            now + this.acknowledgementQuietMs,
            this.acknowledgementBurstStartedAt +
                this.acknowledgementMaxLatencyMs
        );
        if (this.acknowledgementTimer) {
            clearTimeout(this.acknowledgementTimer);
        }
        this.acknowledgementTimer = this.ngZone.runOutsideAngular(() =>
            setTimeout(() => {
                this.acknowledgementTimer = null;
                this.acknowledgementPending = false;
                this.acknowledgementBurstStartedAt = 0;
                this.scheduleUpdate();
            }, Math.max(0, dueAt - now))
        );
    }

    private async runUpdate(): Promise<void> {
        if (this.pageHidden) {
            return;
        }
        if (this.tilePipelinePaused) {
            this.updateRequestedWhilePaused = true;
            return;
        }
        if (this.backendProtocolMismatchActive || this.connectionTerminalError ||
            (this.connectionRetry && this.connectionRetry.at > Date.now())) return;
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
            const requestedRefs = activeRefs
                .filter(ref => {
                    const retry = this.filterRetryDeadlines.get(ref);
                    return !retry || retry.generation !== ref.generation || retry.at <= Date.now();
                });
            const requests = requestedRefs.map(ref => ref.requestJson())
                // The envelope is a complete replacement. Omitting an empty
                // subscription both avoids useless startup work and cancels
                // previously sent coverage when its last tile disappears.
                .filter(request =>
                    Array.isArray(request["partitions"]) &&
                    request["partitions"].length > 0
                );
            for (const ref of requestedRefs) {
                const retry = this.filterRetryDeadlines.get(ref);
                if (retry) retry.at = 0;
            }
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
            if (updateResult === "failed" && !this.isTileStreamConnected()) {
                this.scheduleConnectionRetry("Could not connect to the map backend.");
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
                partition: unknown;
                tileId: number;
                legalInfo?: string;
                warnings?: string[];
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
            const partition = parsePartition(metadata.layer.partition);
            if (!subscription.covers(partition)) {
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
                partition,
                partitionKey: partitionKey(partition),
                mapTileKey: coreLib.createMapTileKey(
                    "Features",
                    mapId,
                    layerId,
                    partitionKeySuffix(partition)
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
                warnings: metadata.layer.warnings ?? [],
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
        if (status.error && Number.isFinite(status.retryAfterMs) && status.retryAfterMs! > 0 &&
            !subscription.released && !subscription.suspended && !this.backendProtocolMismatchActive &&
            (subscription.requestJson()["partitions"] as unknown[]).length > 0) {
            const previous = this.filterRetryDeadlines.get(subscription);
            const retry: OwnedRetry = {...recordConnectionFailure(
                previous?.generation === subscription.generation ? previous : undefined,
                status.error, status.retryAfterMs), generation: subscription.generation,
                retryable: true, sourceMapId: status.errorSourceMapId ?? status.mapId};
            this.filterRetryDeadlines.set(subscription, retry);
            this.scheduleOwnedRetry(subscription, "retry", retry);
        } else if (status.state === "Success" || status.error) {
            this.retryScheduler.cancelOwner(subscription);
            this.filterRetryDeadlines.delete(subscription);
            if (status.error && status.serviceError) {
                this.filterRetryDeadlines.set(subscription, {
                    ...recordConnectionFailure(undefined, status.error), generation: subscription.generation,
                    retryable: false, at: Infinity, sourceMapId: status.errorSourceMapId ?? status.mapId
                });
            }
        }
        subscription.acceptStatus(status);
        this.filterStatusReceived.next(status);
    }

    private acceptRequestStatus(status: MapTileStreamStatusPayload): void {
        if (!status || status.type !== "mapget.tiles.status") {
            return;
        }
        this.clearConnectionFailure();
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
            // Viewport failures can arrive in bulk. Keep them in diagnostics
            // (which captures console errors), not in one toast per request.
            console.error(
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
            partition: PartitionId;
            name: string;
            sourceId?: string;
            incarnation?: number;
        },
        signal: AbortSignal
    ): Promise<TileAttachmentValue | null> {
        const query = new URLSearchParams({
            mapId: request.mapId,
            layerId: request.layerId,
            partition: JSON.stringify(partitionJson(request.partition)),
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
