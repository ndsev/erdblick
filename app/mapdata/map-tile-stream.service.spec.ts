import "@angular/compiler";
import {Subject} from "rxjs";
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

describe("MapTileStreamService TTL renewal scheduling", () => {
    it("does not immediately renew expired retained values", () => {
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

    it("takes bounded round-robin owner slices without capping queued coverage", () => {
        const service = Object.create(
            MapTileStreamService.prototype
        ) as MapTileStreamService;
        const internal = service as any;
        const firstRef = {filterId: "first"};
        const secondRef = {filterId: "second"};
        internal.lastDispatchedRenewalRef = null;
        internal.maxRenewalTilesPerOwnerSlice = 512;
        internal.pendingFilterRenewals = [
            {
                ref: firstRef,
                tileIds: Array.from({length: 5_000}, (_, index) => index),
                deliveryEpoch: 2
            },
            {
                ref: secondRef,
                tileIds: Array.from({length: 5_000}, (_, index) => index + 10_000),
                deliveryEpoch: 2
            }
        ];

        const selected = internal.takeFairRenewalBatch(1_024);

        expect(selected.map((item: any) => item.ref)).toEqual([
            firstRef,
            secondRef
        ]);
        expect(selected.map((item: any) => item.tileIds.length)).toEqual([
            512,
            512
        ]);
        expect(internal.pendingFilterRenewals.map(
            (item: any) => item.tileIds.length
        )).toEqual([4_488, 4_488]);
    });
});
