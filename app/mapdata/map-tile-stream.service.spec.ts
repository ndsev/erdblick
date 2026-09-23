import "@angular/compiler";
import {BehaviorSubject, Subject} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {MapTileStreamService} from "./map-tile-stream.service";
import {MapgetLayer} from "./mapget-layer.model";
import {objectPartition, tilePartition} from "./partition.model";

function serviceHarness(): MapTileStreamService {
    return new MapTileStreamService(
        {tilePullCompressionEnabledState: new Subject<boolean>()} as any,
        {dataSourceInfoChanged: new Subject<void>()} as any,
        {} as any,
        {
            run: (callback: () => unknown) => callback(),
            runOutsideAngular: (callback: () => unknown) => callback()
        } as any
    );
}

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
            {tilePullCompressionEnabledState: new Subject<boolean>()} as any,
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
                {tilePullCompressionEnabledState: new Subject<boolean>()} as any,
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
