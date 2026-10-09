import "@angular/compiler";
import {BehaviorSubject, Subject} from "rxjs";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MapTileStreamService} from "./map-tile-stream.service";
import {TileDeliveryError} from "./tile-diagnostics";
import {MapgetLayer} from "./mapget-layer.model";
import {objectPartition, tilePartition} from "./partition.model";
import {
    MapTileRequestStatus,
    MapTileStreamClientInteractive,
    MapTileStreamClientTiles,
    type MapTileStreamStatusPayload
} from "./tilestream";
import {coreLib} from "../integrations/wasm";
import {DEFAULT_CONNECTION_RETRY_POLICY} from "../shared/connection-retry-policy";

/** Supplies real observable preference values to each transport harness. */
function retryStateHarness() {
    const policy = {...DEFAULT_CONNECTION_RETRY_POLICY};
    return {
        connectionRetryPolicy: policy,
        connectionRetryEnabledState: new BehaviorSubject(policy.enabled),
        connectionRetryInitialDelayMsState: new BehaviorSubject(policy.initialDelayMs),
        connectionRetryBackoffMultiplierState: new BehaviorSubject(policy.backoffMultiplier),
        connectionRetryMaxDelayMsState: new BehaviorSubject(policy.maxDelayMs)
    };
}

function serviceHarness(): MapTileStreamService {
    return new MapTileStreamService(
        {...retryStateHarness(), tilePullCompressionEnabledState: new Subject<boolean>()} as any,
        {dataSourceInfoChanged: new Subject<void>()} as any,
        {} as any,
        {
            run: (callback: () => unknown) => callback(),
            runOutsideAngular: (callback: () => unknown) => callback()
        } as any
    );
}

describe("MapTileStreamService request failures", () => {
    it("logs bulk viewport failures without flooding error toasts", () => {
        const service = serviceHarness();
        const messages = {showError: vi.fn()};
        const internal = service as any;
        internal.messageService = messages;
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            for (let requestId = 1; requestId <= 30; ++requestId) {
                const status: MapTileStreamStatusPayload = {
                    type: "mapget.tiles.status",
                    requestId,
                    allDone: true,
                    requests: [{
                        index: 0,
                        mapId: "Map",
                        layerId: "Lanes",
                        status: MapTileRequestStatus.Aborted,
                        statusText: "SmartLayerService: HTTP 429 Too Many Requests"
                    }]
                };
                internal.acceptRequestStatus(status);
            }

            expect(messages.showError).not.toHaveBeenCalled();
            expect(log).toHaveBeenCalledTimes(30);
            expect(log).toHaveBeenLastCalledWith(
                "Filter request failed: Map/Lanes: SmartLayerService: HTTP 429 Too Many Requests"
            );
            expect(service.getBackendRequestProgress()).toEqual({
                done: 1, total: 1, allDone: true, requestId: 30
            });
        } finally {
            log.mockRestore();
        }
    });
});

describe("MapTileStreamService page lifecycle", () => {
    let service: MapTileStreamService;
    let client: MapTileStreamClientInteractive;
    const connectionError = vi.fn();

    beforeEach(async () => {
        vi.useFakeTimers();
        connectionError.mockClear();
        service = new MapTileStreamService(
            {
                ...retryStateHarness(),
                tilePullCompressionEnabled: false,
                tilePullCompressionEnabledState: new Subject<boolean>()
            } as any,
            {
                dataSourceInfoChanged: new Subject<void>(),
                reloadDataSources: vi.fn().mockResolvedValue(true)
            } as any,
            {showBackendConnectionError: connectionError} as any,
            {
                run: (callback: () => unknown) => callback(),
                runOutsideAngular: (callback: () => unknown) => callback()
            } as any
        );
        await service.initialize();
        client = service['tileStream']!;
        vi.spyOn(client, 'updateRequest').mockResolvedValue('sent');
        vi.spyOn(client, 'close');
        vi.spyOn(client, 'setFrameProcessingPaused');
        await vi.advanceTimersByTimeAsync(100);
        vi.mocked(client.updateRequest).mockClear();
    });

    afterEach(() => {
        service.ngOnDestroy();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("stops scheduled work and ignores late socket callbacks after pagehide", async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        service['scheduleUpdate']();
        service['scheduleAcknowledgementUpdate']();

        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));

        expect(client.close).toHaveBeenCalledWith(1000, 'page hidden');
        expect(client.setFrameProcessingPaused).toHaveBeenLastCalledWith(true);
        expect(vi.getTimerCount()).toBe(0);
        client.onClose?.(new CloseEvent('close', {code: 1006}));
        client.onError?.(new Event('error'));
        service['scheduleUpdate']();
        service['scheduleAcknowledgementUpdate']();
        await service['runUpdate']();
        await vi.advanceTimersByTimeAsync(100);

        expect(client.updateRequest).not.toHaveBeenCalled();
        expect(connectionError).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it("cancels before WebKit unload rejection and resumes a page that stays active", async () => {
        window.dispatchEvent(new Event('beforeunload', {cancelable: true}));

        expect(client.close).toHaveBeenCalledWith(1000, 'page hidden');
        expect(service['pageHidden']).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(client.updateRequest).not.toHaveBeenCalled();
        expect(service['pageHidden']).toBe(true);
        vi.advanceTimersToNextFrame();
        await vi.advanceTimersByTimeAsync(100);

        expect(service['pageHidden']).toBe(false);
        expect(client.updateRequest).toHaveBeenCalledExactlyOnceWith([], true);
        expect(client.setFrameProcessingPaused).toHaveBeenLastCalledWith(false);
    });

    it("cancels unload recovery on pagehide and restores a fresh pending snapshot once", async () => {
        window.dispatchEvent(new Event('beforeunload'));
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
        await vi.advanceTimersByTimeAsync(100);
        expect(client.updateRequest).not.toHaveBeenCalled();

        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
        await vi.advanceTimersByTimeAsync(100);
        expect(client.updateRequest).toHaveBeenCalledExactlyOnceWith([], true);

        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
        await vi.advanceTimersByTimeAsync(100);
        expect(client.updateRequest).toHaveBeenCalledOnce();
    });

    it("preserves the user's diagnostic pause across page restoration", async () => {
        service.tilePipelinePaused$.next(true);
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
        await vi.advanceTimersByTimeAsync(100);

        expect(service.tilePipelinePaused).toBe(true);
        expect(client.setFrameProcessingPaused).toHaveBeenLastCalledWith(true);
        expect(client.updateRequest).not.toHaveBeenCalled();
    });

    it("does not reconnect a protocol-incompatible transport on restoration", async () => {
        service['backendProtocolMismatchActive'] = true;
        window.dispatchEvent(new Event('pagehide'));
        window.dispatchEvent(new Event('pageshow'));
        await vi.advanceTimersByTimeAsync(100);

        expect(client.updateRequest).not.toHaveBeenCalled();
        expect(service['backendProtocolMismatchActive']).toBe(true);
    });

    it("removes listeners and unload recovery when the service is destroyed", async () => {
        window.dispatchEvent(new Event('beforeunload'));
        service.ngOnDestroy();
        vi.mocked(client.close).mockClear();

        window.dispatchEvent(new Event('beforeunload'));
        window.dispatchEvent(new Event('pagehide'));
        window.dispatchEvent(new Event('pageshow'));
        await vi.advanceTimersByTimeAsync(100);

        expect(service['tileStream']).toBeNull();
        expect(client.close).not.toHaveBeenCalled();
        expect(client.updateRequest).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("still reports unexpected disconnects while the page is active", async () => {
        client.onClose?.(new CloseEvent('close', {code: 1006, reason: 'connection lost'}));
        await vi.advanceTimersByTimeAsync(100);

        expect(connectionError).toHaveBeenCalledWith('The map backend connection was closed (connection lost).');
        expect(client.updateRequest).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5000);
        expect(client.updateRequest).toHaveBeenCalledOnce();
    });
});

describe("MapTileStreamService source catalog refresh", () => {
    it("reloads again when a backend reconnect races an in-flight catalog fetch", async () => {
        let finishFirstReload!: () => void;
        const firstReload = new Promise<boolean>(resolve => {
            finishFirstReload = () => resolve(true);
        });
        const mapInfo = {
            dataSourceInfoChanged: new Subject<void>(),
            sourceCatalogRevision: 49,
            reloadDataSources: vi.fn()
                .mockReturnValueOnce(firstReload)
                .mockResolvedValue(true)
        };
        const service = new MapTileStreamService(
            {...retryStateHarness(), tilePullCompressionEnabledState: new Subject<boolean>()} as any,
            mapInfo as any,
            {} as any,
            {
                run: (callback: () => unknown) => callback(),
                runOutsideAngular: (callback: () => unknown) => callback()
            } as any
        );
        const internals = service as any;
        internals.tileStream = {getSourcesRevision: () => 1};
        internals.scheduleUpdate = vi.fn();

        internals.requestSourceCatalogRefresh(49);
        expect(mapInfo.reloadDataSources).toHaveBeenCalledTimes(1);

        // The new backend may reuse or lower the process-local revision while
        // the request started against its predecessor is still unresolved.
        internals.handleSourcesRevisionChanged(1, true);
        finishFirstReload();

        await vi.waitFor(() => expect(mapInfo.reloadDataSources).toHaveBeenCalledTimes(2));
    });
});

describe("MapTileStreamService viewport timing", () => {
    it("freezes the end-to-end timer only once presentation reports completion", () => {
        const service = Object.create(
            MapTileStreamService.prototype
        ) as MapTileStreamService;
        const internal = service as any;
        internal.viewportLoadStartedAtMs = 100;
        internal.viewportCompletedAtMs = null;
        const now = vi.spyOn(performance, "now")
            .mockReturnValueOnce(250)
            .mockReturnValue(400);

        expect(service.currentViewportRenderSeconds()).toBeCloseTo(0.15);
        service.markCurrentViewportRendered();
        expect(service.currentViewportRenderSeconds()).toBeCloseTo(0.3);

        service.markCurrentViewportRendered();
        expect(service.currentViewportRenderSeconds()).toBeCloseTo(0.3);
        now.mockRestore();
    });
});

describe("MapTileStreamService TTL expiry scheduling", () => {
    it("coalesces acceptance-only omission snapshots behind a bounded delay", () => {
        vi.useFakeTimers();
        try {
            const service = new MapTileStreamService(
                {...retryStateHarness(), tilePullCompressionEnabledState: new Subject<boolean>()} as any,
                {dataSourceInfoChanged: new Subject<void>()} as any,
                {} as any,
                {
                    run: (callback: () => unknown) => callback(),
                    runOutsideAngular: (callback: () => unknown) => callback()
                } as any
            );
            const internal = service as any;
            const ref = {filterId: "filter", released: false};
            internal.filterSubscriptionsById.set(ref.filterId, ref);
            internal.scheduleUpdate = vi.fn();

            service.updateFilterSubscription(ref as any, false);
            vi.advanceTimersByTime(75);
            service.updateFilterSubscription(ref as any, false);
            vi.advanceTimersByTime(75);
            service.updateFilterSubscription(ref as any, false);

            expect(internal.scheduleUpdate).not.toHaveBeenCalled();
            vi.advanceTimersByTime(100);
            expect(internal.scheduleUpdate).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not immediately reschedule expired retained values", () => {
        const service = Object.create(
            MapTileStreamService.prototype
        ) as MapTileStreamService;
        const internal = service as any;
        const owner = {expireTiles: vi.fn()};
        internal.retryScheduler = {cancelOwner: vi.fn()};
        internal.retainedRetries = new Map();
        internal.deferredRetainedRetries = new Map();
        internal.tileExpiryScheduler = {
            cancel: vi.fn(),
            schedule: vi.fn()
        };
        const now = vi.spyOn(Date, "now").mockReturnValue(2_000);

        service.updateRetainedTileExpiry(owner, 7, 3, 1_999);

        expect(internal.tileExpiryScheduler.cancel).toHaveBeenCalledWith(
            owner,
            7
        );
        expect(internal.tileExpiryScheduler.schedule).not.toHaveBeenCalled();
        now.mockRestore();
    });

    it("keeps immediate expiry enabled for filter subscriptions", () => {
        const service = Object.create(
            MapTileStreamService.prototype
        ) as MapTileStreamService;
        const internal = service as any;
        const ref = {filterId: "filter", released: false};
        internal.filterRetryDeadlines = new Map();
        internal.filterSubscriptionsById = new Map([["filter", ref]]);
        internal.retryScheduler = {cancel: vi.fn()};
        internal.deferredRetainedRetries = new Map();
        internal.tileExpiryScheduler = {
            cancel: vi.fn(),
            schedule: vi.fn()
        };

        service.updateFilterPartitionExpiry(
            ref as any,
            tilePartition(7),
            3,
            1_999
        );

        expect(internal.tileExpiryScheduler.schedule).toHaveBeenCalledWith(
            ref,
            "tile:7",
            3,
            1_999
        );
    });

    it("passes a forced complete pending snapshot to the transport", async () => {
        const service = Object.create(
            MapTileStreamService.prototype
        ) as MapTileStreamService;
        const internal = service as any;
        const request = {
            mapId: "Map",
            layerId: "Layer",
            filterId: "first",
            generation: 1,
            partitions: [tilePartition(7)]
        };
        const firstRef = {
            filterId: "first",
            released: false,
            suspended: false,
            requestJson: vi.fn(() => request),
            notifyRequestSynchronized: vi.fn()
        };
        const emptyRef = {
            filterId: "empty",
            released: false,
            suspended: false,
            requestJson: vi.fn(() => ({
                mapId: "Map",
                layerId: "Layer",
                filterId: "empty",
                generation: 1,
                partitions: []
            })),
            notifyRequestSynchronized: vi.fn()
        };
        const updateRequest = vi.fn().mockResolvedValue("sent");
        internal.tilePipelinePaused$ = new BehaviorSubject(false);
        internal.updateInProgress = false;
        internal.updatePending = false;
        internal.forceNextUpdate = true;
        internal.filterRetryDeadlines = new Map();
        internal.filterSubscriptionsById = new Map([
            [firstRef.filterId, firstRef],
            [emptyRef.filterId, emptyRef]
        ]);
        internal.tileStream = {updateRequest};
        internal.lastUpdateAt = 0;
        internal.backendRequestProgress = {done: 0, total: 0, allDone: true};
        internal.viewportLoadStartedAtMs = null;
        internal.viewportCompletedAtMs = null;
        internal.scheduleUpdate = vi.fn();

        await internal.runUpdate();

        expect(updateRequest).toHaveBeenCalledWith([request], true);
        expect(internal.forceNextUpdate).toBe(false);
        expect(firstRef.notifyRequestSynchronized).toHaveBeenCalledOnce();
        expect(emptyRef.notifyRequestSynchronized).toHaveBeenCalledOnce();
    });
});

describe("MapTileStreamService object discovery", () => {
    it("bounds cached discovery tiles without evicting current or pending work", () => {
        const service = serviceHarness() as any;
        const cache = new Map<number, unknown>();
        cache.set(0, {pending: Promise.resolve({objects: [], expiresAtMs: null})});
        for (let tileId = 1; tileId <= 4_100; ++tileId) {
            cache.set(tileId, {
                value: {objects: [], expiresAtMs: null}
            });
        }

        service.trimObjectDiscoveryCache(cache, new Set([1]));

        expect(cache.size).toBe(4_096);
        expect(cache.has(0)).toBe(true);
        expect(cache.has(1)).toBe(true);
    });

    it("preserves uint64 identities and deduplicates by discovery priority", async () => {
        const service = serviceHarness();
        const layer = new MapgetLayer(
            "smart-source",
            "pool",
            "SmartMap",
            "Road",
            {
                partitionKind: "object",
                tileAssociationLevel: 13
            } as never
        );
        const firstId = "9007199254740993";
        const lastId = "18446744073709551615";
        const response = {
            ok: true,
            status: 200,
            statusText: "OK",
            json: vi.fn(async () => ({responses: [{
                mapId: "SmartMap",
                layerId: "Road",
                sourceId: "smart-source",
                tileId: 102,
                status: "success",
                timestamp: 1_000,
                ttlMs: 800,
                objects: [{
                    id: firstId,
                    bounds: [11, 48, 12, 49]
                }]
            }, {
                mapId: "SmartMap",
                layerId: "Road",
                sourceId: "smart-source",
                tileId: 101,
                status: "success",
                timestamp: 1_000,
                ttlMs: 500,
                objects: [
                    {id: firstId, bounds: [10, 47, 11, 48]},
                    {id: lastId}
                ]
            }]}) )
        };
        const fetchMock = vi.fn(async (
            _input: RequestInfo | URL,
            _init?: RequestInit
        ) => response);
        const now = vi.spyOn(Date, "now").mockReturnValue(1_100);
        vi.stubGlobal("fetch", fetchMock);
        try {
            const first = await service.discoverObjectPartitions(
                layer,
                [101, 102, 101]
            );

            expect(first).toEqual({
                associations: [{
                    partition: objectPartition(firstId),
                    bounds: [10, 47, 11, 48],
                    discoveryTileId: 101
                }, {
                    partition: objectPartition(lastId),
                    discoveryTileId: 101
                }],
                expiresAtMs: 1_500
            });
            expect(fetchMock).toHaveBeenCalledOnce();
            expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)))
                .toEqual({requests: [{
                    mapId: "SmartMap",
                    layerId: "Road",
                    sourceId: "smart-source",
                    tileIds: [101, 102]
                }]});

            const reprioritized = await service.discoverObjectPartitions(
                layer,
                [102, 101]
            );
            expect(reprioritized.associations[0]).toEqual({
                partition: objectPartition(firstId),
                bounds: [11, 48, 12, 49],
                discoveryTileId: 102
            });
            expect(fetchMock).toHaveBeenCalledOnce();
        } finally {
            now.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    it("rejects malformed discovery bounds instead of poisoning coverage", async () => {
        const service = serviceHarness();
        const layer = new MapgetLayer("", "pool", "Map", "Road", {
            partitionKind: "object",
            tileAssociationLevel: 13
        } as never);
        vi.stubGlobal("fetch", vi.fn(async () => ({
            ok: true,
            json: async () => ({responses: [{
                mapId: "Map",
                layerId: "Road",
                tileId: 7,
                status: "success",
                timestamp: 1_000,
                ttlMs: 0,
                objects: [{id: "1", bounds: [0, -91, 1, 0]}]
            }]})
        })));
        try {
            await expect(service.discoverObjectPartitions(layer, [7]))
                .rejects.toThrow(/invalid bounds/);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});


describe("explicit datasource retry hints", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("delays pending-only retries, coalesces failures and retains the generation", async () => {
        const service = serviceHarness();
        const internal = service as any;
        const updates = vi.fn().mockResolvedValue("sent");
        internal.tileStream = {updateRequest: updates};
        const ref = service.createFilterSubscription({mapId: "Map", layerId: "Layer", channels: []},
            {partitions: [tilePartition(1), tilePartition(2)]}, {onTile: () => ({status: "accepted", valueVersion: 1})});
        // One output was already accepted when the other failed.
        (ref as any).pendingPartitionKeys.delete("tile:1");
        const status = {type: "mapget.filter.status", filterId: ref.filterId, generation: ref.generation,
            state: "Failed", error: "503", retryAfterMs: 5000};
        internal.acceptFilterStatus(status);
        internal.acceptFilterStatus(status);
        expect(internal.retryScheduler.size).toBe(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(updates.mock.calls.at(-1)![0]).toEqual([]);
        await vi.advanceTimersByTimeAsync(4950);
        const requests = updates.mock.calls.at(-1)![0];
        expect(requests).toHaveLength(1);
        expect(requests[0].generation).toBe(status.generation);
        expect(requests[0].partitions).toEqual([{kind: "tile", id: 2}]);
        internal.acceptFilterStatus(status);
        expect(internal.filterRetryDeadlines.get(ref).at - Date.now()).toBe(10000);
        internal.stateService.connectionRetryPolicy = {...DEFAULT_CONNECTION_RETRY_POLICY, enabled: false};
        internal.applyRetryPolicy();
        expect(internal.retryScheduler.size).toBe(0);
        expect(internal.filterRetryDeadlines.get(ref).at).toBe(Infinity);
        internal.stateService.connectionRetryPolicy = {...DEFAULT_CONNECTION_RETRY_POLICY, maxDelayMs: 6000};
        internal.applyRetryPolicy();
        expect(internal.filterRetryDeadlines.get(ref).at - Date.now()).toBe(6000);
        internal.acceptFilterStatus({...status, state: "Success", error: undefined});
        expect(internal.filterRetryDeadlines.has(ref)).toBe(false);
        ref.release();
    });

    it("cancels released retries and never infers eligibility from a message", async () => {
        const service = serviceHarness();
        const internal = service as any;
        const ref = service.createFilterSubscription({mapId: "Map", layerId: "Layer", channels: []},
            {partitions: [tilePartition(1)]}, {onTile: () => ({status: "accepted", valueVersion: 1})});
        const failed = {type: "mapget.filter.status", filterId: ref.filterId, generation: ref.generation,
            state: "Failed", error: "503"};
        internal.acceptFilterStatus(failed);
        expect(internal.retryScheduler.size).toBe(0);
        internal.acceptFilterStatus({...failed, retryAfterMs: 5000});
        ref.release();
        expect(internal.retryScheduler.size).toBe(0);
        await vi.advanceTimersByTimeAsync(6000);
        expect(internal.filterRetryDeadlines.size).toBe(0);
    });

    it("defers retained retries while paused and cancels disposed owners", async () => {
        const service = serviceHarness();
        const internal = service as any;
        const owner = {expireTiles: vi.fn()};
        service.tilePipelinePaused$.next(true);
        service.scheduleRetainedTileRetry(owner, "tile", 3, new TileDeliveryError("outage", 5000));
        await vi.advanceTimersByTimeAsync(5001);
        expect(owner.expireTiles).not.toHaveBeenCalled();
        service.tilePipelinePaused$.next(false);
        internal.flushRetainedRetries();
        expect(owner.expireTiles).toHaveBeenCalledWith([{tileId: "tile", valueVersion: 3}]);
        service.scheduleRetainedTileRetry(owner, "tile", 3, new TileDeliveryError("outage", 5000));
        service.cancelRetainedTileExpiries(owner);
        await vi.advanceTimersByTimeAsync(5001);
        expect(owner.expireTiles).toHaveBeenCalledOnce();
    });

    it.each(["refresh", "suspend", "empty coverage", "success", "permanent error"])(
        "removes obsolete delayed work after %s", (action) => {
            const service = serviceHarness();
            const internal = service as any;
            const ref = service.createFilterSubscription({mapId: "Map", layerId: "Layer", channels: []},
                {partitions: [tilePartition(1)]}, {onTile: () => ({status: "accepted", valueVersion: 1})});
            const status = {type: "mapget.filter.status", filterId: ref.filterId, generation: ref.generation,
                state: "Failed", error: "outage", retryAfterMs: 5000};
            internal.acceptFilterStatus(status);
            expect(internal.retryScheduler.size).toBe(1);
            if (action === "refresh") ref.refresh();
            else if (action === "suspend") ref.suspend();
            else if (action === "empty coverage") ref.setCoverage({partitions: []});
            else internal.acceptFilterStatus({...status, retryAfterMs: undefined,
                state: action === "success" ? "Success" : "Failed",
                error: action === "success" ? undefined : "invalid schema"});
            expect(internal.retryScheduler.size).toBe(0);
            expect(internal.filterRetryDeadlines.size).toBe(0);
            ref.release();
        });

    it("keeps an initial inspection pending until a transient failure recovers", async () => {
        const service = serviceHarness();
        const internal = service as any;
        const load = vi.spyOn(internal, "loadFeaturesOnce")
            .mockRejectedValueOnce(new TileDeliveryError("outage", 5000)).mockResolvedValue([]);
        const pending = service.loadFeatures([], new AbortController().signal);
        await vi.advanceTimersByTimeAsync(4999);
        expect(load).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(2);
        await expect(pending).resolves.toEqual([]);
        expect(load).toHaveBeenCalledTimes(2);
        expect(internal.retryScheduler.size).toBe(0);
    });
});


it("cancels an initial inspection while it is waiting to retry", async () => {
    vi.useFakeTimers();
    const service = serviceHarness();
    const internal = service as any;
    const load = vi.spyOn(internal, "loadFeaturesOnce").mockRejectedValue(new TileDeliveryError("outage", 5000));
    const controller = new AbortController();
    try {
        const pending = service.loadFeatures([], controller.signal);
        await vi.advanceTimersByTimeAsync(1);
        expect(internal.retryScheduler.size).toBe(1);
        controller.abort(new Error("panel closed"));
        await expect(pending).rejects.toThrow("panel closed");
        expect(internal.retryScheduler.size).toBe(0);
        await vi.advanceTimersByTimeAsync(6000);
        expect(load).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
});
