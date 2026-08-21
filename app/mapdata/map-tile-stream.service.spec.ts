import "@angular/compiler";
import {BehaviorSubject, Subject} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {MapTileStreamService} from "./map-tile-stream.service";

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

        service.updateFilterTileExpiry(ref as any, 7, 3, 1_999);

        expect(internal.tileExpiryScheduler.schedule).toHaveBeenCalledWith(
            ref,
            7,
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
            tileIds: [7]
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
                tileIds: []
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
