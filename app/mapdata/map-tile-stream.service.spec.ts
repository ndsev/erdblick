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
        } as any, {...retryStateHarness(), tilePullCompressionEnabledState: new Subject<boolean>()} as any as never
    );
}

describe("MapTileStreamService request failures", () => {
    it("aborts a one-shot inspection and destroys its transport without starting locate fallback", async () => {
        const service = serviceHarness();
        const request = vi.spyOn(MapTileStreamClientTiles.prototype, "request").mockImplementation(() => new Promise(() => {}));
        const destroy = vi.spyOn(MapTileStreamClientTiles.prototype, "destroy");
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const controller = new AbortController();
        try {
            const loading = service.loadFeatures([{mapTileKey: "Features:Map:Layer:1", featureId: "Road.1"}], controller.signal);
            expect(request).toHaveBeenCalledOnce();
            controller.abort(new Error("cancelled by caller"));
            await expect(loading).rejects.toThrow("cancelled by caller");
            expect(destroy).toHaveBeenCalledOnce();
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            request.mockRestore(); destroy.mockRestore(); fetchSpy.mockRestore();
        }
    });

    it("locates canonical identities without narrowing object partitions or swallowing cancellation", async () => {
        const service = serviceHarness();
        const tileKey = coreLib.createMapTileKey("Features", "Map", "Other", String(coreLib.getTileIdFromPosition(10, 48, 13)));
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({responses: [[
            {partitionKey: "Features:Map:Layer:object/18446744073709551615", canonicalFeatureId: "Road.9"},
            {partitionKey: tileKey, canonicalFeatureId: "Road.9"}
        ]]})));
        try {
            const controller = new AbortController();
            const matches = await service.locateFeature("Map", "Road.1:attribute#2", "Layer", controller.signal);
            expect(matches).toHaveLength(2);
            expect(matches[0]).toEqual({mapTileKey: "Features:Map:Layer:object/18446744073709551615", featureId: "Road.9"});
            expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)).toEqual({requests: [{mapId: "Map", layerId: "Layer", featureId: "Road.1"}]});
            controller.abort(new Error("cancelled"));
            await expect(service.locateFeature("Map", "Road.1", undefined, controller.signal)).rejects.toThrow("cancelled");
            expect(fetchSpy).toHaveBeenCalledOnce();
        } finally { fetchSpy.mockRestore(); }
    });

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
            } as any, {
                ...retryStateHarness(),
                tilePullCompressionEnabled: false,
                tilePullCompressionEnabledState: new Subject<boolean>()
            } as any as never
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
            } as any, {...retryStateHarness(), tilePullCompressionEnabledState: new Subject<boolean>()} as any as never
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
                } as any, {...retryStateHarness(), tilePullCompressionEnabledState: new Subject<boolean>()} as any as never
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
        internal.tileExpiryScheduler = {
            cancel: vi.fn(),
            schedule: vi.fn()
        };
        const now = vi.spyOn(Date, "now").mockReturnValue(2_000);

        service.updateRetainedTileExpiry(owner, 7, 3, 1_999);

        expect(internal.tileExpiryScheduler.cancel).toHaveBeenCalledWith(owner, 7);
        expect(internal.tileExpiryScheduler.schedule).not.toHaveBeenCalled();
        now.mockRestore();
    });

    it("keeps immediate expiry enabled for filter subscriptions", () => {
        const service = Object.create(
            MapTileStreamService.prototype
        ) as MapTileStreamService;
        const internal = service as any;
        const ref = {filterId: "filter", released: false};
        internal.filterSubscriptionsById = new Map([["filter", ref]]);
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


describe("failed tile expiry", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("does not suppress new viewport coverage while a failed tile waits for expiry", async () => {
        const service = serviceHarness();
        const internal = service as any;
        const updates = vi.fn().mockResolvedValue("sent");
        internal.tileStream = {updateRequest: updates};
        const ref = service.createFilterSubscription({mapId: "Map", layerId: "Layer", channels: []},
            {partitions: [tilePartition(1), tilePartition(2)]},
            {onTile: () => ({status: "accepted", valueVersion: 1})});
        const generation = ref.generation;
        for (const id of [1, 2]) {
            ref.accept({blob: new Uint8Array(), filterId: ref.filterId, generation,
                mapId: "Map", layerId: "Layer", partition: tilePartition(id), partitionKey: `tile:${id}`,
                mapTileKey: `Features:Map:Layer:${id}`, stringPoolId: "source",
                conversionTimestampMs: Date.now(), ttlMs: id === 2 ? 5000 : null,
                error: id === 2 ? "503" : null, dependencies: [], issues: [], info: {}, numEntries: 0,
                geometryVertexCount: 0, glbAttachmentName: "", receivedAt: 0});
        }
        expect(internal.tileExpiryScheduler.size).toBe(1);
        ref.setCoverage({partitions: [tilePartition(1), tilePartition(2), tilePartition(3)]});
        await vi.advanceTimersByTimeAsync(100);
        expect(updates.mock.calls.at(-1)![0][0].partitions).toEqual([{kind: "tile", id: 3}]);
        // Turning off connection retries does not disable value freshness.
        internal.stateService.connectionRetryPolicy = {...DEFAULT_CONNECTION_RETRY_POLICY, enabled: false};
        internal.applyRetryPolicy();
        await vi.advanceTimersByTimeAsync(5000);
        expect(updates.mock.calls.at(-1)![0][0].partitions).toEqual([
            {kind: "tile", id: 2}, {kind: "tile", id: 3}]);
        expect(ref.generation).toBe(generation);
        ref.release();
    });

    it("cancels expiry when the failed output is no longer retained", async () => {
        const service = serviceHarness();
        const owner = {expireTiles: vi.fn()};
        service.updateRetainedTileExpiry(owner, "tile", 3, Date.now() + 5000);
        service.cancelRetainedTileExpiries(owner);
        await vi.advanceTimersByTimeAsync(6000);
        expect(owner.expireTiles).not.toHaveBeenCalled();
    });

    it("returns initial inspection failures promptly instead of hiding them in a retry loop", async () => {
        const service = serviceHarness();
        const internal = service as any;
        const error = new TileDeliveryError("outage", Date.now() + 5000);
        const load = vi.spyOn(internal, "loadFeaturesOnce").mockRejectedValue(error);
        await expect(service.loadFeatures([], new AbortController().signal)).rejects.toBe(error);
        await vi.advanceTimersByTimeAsync(6000);
        expect(load).toHaveBeenCalledOnce();
        expect(internal.activeInspectionLoads).toBe(0);
    });
});
