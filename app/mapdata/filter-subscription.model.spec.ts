import {describe, expect, it, vi} from "vitest";
import {
    FilterSubscriptionRef,
    filterSubscriptionCoverageMembershipEqual,
    type FilterSubscriptionOwner,
    type TileSubsetDelivery
} from "./filter-subscription.model";

function definition() {
    return {
        mapId: "Map",
        layerId: "Layer",
        channels: []
    };
}

function delivery(tileId: number, generation: number, deliveryEpoch = 1) {
    return {
        blob: new Uint8Array(),
        filterId: "styled",
        generation,
        deliveryEpoch,
        mapId: "Map",
        layerId: "Layer",
        tileId,
        mapTileKey: `Features:Map:Layer:${tileId}`,
        conversionTimestampMs: 1_000,
        ttlMs: 100,
        receivedAt: 0
    } as unknown as TileSubsetDelivery;
}

describe("FilterSubscriptionRef", () => {
    it("keeps semantic generation across tile coverage and priority changes", () => {
        const owner: FilterSubscriptionOwner = {
            updateFilterSubscription: vi.fn(),
            releaseFilterSubscription: vi.fn()
        };
        const ref = new FilterSubscriptionRef(
            owner,
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile: vi.fn()}
        );

        ref.setCoverage({tileIds: [1, 2], priorityTileIds: [2]});

        expect(ref.generation).toBe(1);
        expect(owner.updateFilterSubscription).toHaveBeenCalledOnce();
        expect(ref.requestJson()).toMatchObject({
            generation: 1,
            tileIds: [1, 2],
            priorityTileIds: [2]
        });
    });

    it("does not resubmit structurally equal ordered coverage", () => {
        const owner: FilterSubscriptionOwner = {
            updateFilterSubscription: vi.fn(),
            releaseFilterSubscription: vi.fn()
        };
        const coverage = {
            tileIds: [1, 2],
            priorityTileIds: [2],
            roots: [{
                tileId: 1,
                typeId: "Lane",
                featureId: ["Lane", 1, 42]
            }]
        };
        const ref = new FilterSubscriptionRef(
            owner,
            "styled",
            definition(),
            coverage,
            {onTile: vi.fn()}
        );

        ref.setCoverage(structuredClone(coverage));

        expect(owner.updateFilterSubscription).not.toHaveBeenCalled();
        expect(ref.generation).toBe(1);
    });

    it("treats a pure tile-priority reorder as unchanged membership", () => {
        expect(filterSubscriptionCoverageMembershipEqual(
            {
                tileIds: [3, 2, 1],
                priorityTileIds: [2, 1],
                roots: [{tileId: 2, featureId: "root"}]
            },
            {
                tileIds: [1, 2, 3],
                priorityTileIds: [1, 2],
                roots: [{tileId: 2, featureId: "root"}]
            }
        )).toBe(true);
    });

    it("advances generation when exact relation roots change", () => {
        const owner: FilterSubscriptionOwner = {
            updateFilterSubscription: vi.fn(),
            releaseFilterSubscription: vi.fn()
        };
        const ref = new FilterSubscriptionRef(
            owner,
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile: vi.fn()}
        );

        ref.setCoverage({
            tileIds: [1],
            roots: [{
                tileId: 1,
                typeId: "Lane",
                featureId: "Lane.1.42"
            }]
        });

        expect(ref.generation).toBe(2);
        expect(owner.updateFilterSubscription).toHaveBeenCalledOnce();
    });

    it("refreshes unchanged demand as a new generation and rejects the old delivery", () => {
        const onTile = vi.fn();
        const owner: FilterSubscriptionOwner = {
            updateFilterSubscription: vi.fn(),
            releaseFilterSubscription: vi.fn()
        };
        const ref = new FilterSubscriptionRef(
            owner,
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile}
        );
        const oldDelivery = delivery(1, ref.generation);

        ref.refresh();

        expect(ref.generation).toBe(2);
        expect(ref.requestJson()).toMatchObject({
            mapId: "Map",
            layerId: "Layer",
            tileIds: [1],
            generation: 2
        });
        expect(owner.updateFilterSubscription).toHaveBeenCalledWith(ref, true);
        expect(ref.accept(oldDelivery)).toBe(false);
        expect(ref.accept(delivery(1, ref.generation))).toBe(true);
        expect(onTile).toHaveBeenCalledOnce();
    });

    it("rejects late deliveries outside the current coverage", () => {
        const onTile = vi.fn();
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription: vi.fn(),
                releaseFilterSubscription: vi.fn()
            },
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile}
        );
        const stale = delivery(2, ref.generation);

        expect(ref.accept(stale)).toBe(false);
        expect(onTile).not.toHaveBeenCalled();
    });

    it("accepts an older expired delivery while its newer epoch is only requested", () => {
        const onTile = vi.fn();
        const renewFilterTiles = vi.fn();
        const updateFilterTileExpiry = vi.fn();
        const completeFilterTileRenewal = vi.fn();
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription: vi.fn(),
                releaseFilterSubscription: vi.fn(),
                renewFilterTiles,
                updateFilterTileExpiry,
                completeFilterTileRenewal
            },
            "styled",
            definition(),
            {tileIds: [1]},
            {onTile}
        );

        ref.expireTiles([{tileId: 1, deliveryEpoch: 1}]);

        expect(renewFilterTiles).toHaveBeenCalledWith(ref, [1], 2);
        expect(ref.accept(delivery(1, ref.generation, 1))).toBe(true);
        expect(updateFilterTileExpiry).not.toHaveBeenCalled();
        expect(completeFilterTileRenewal).not.toHaveBeenCalled();
        expect(ref.accept(delivery(1, ref.generation, 2))).toBe(true);
        expect(updateFilterTileExpiry).toHaveBeenCalledWith(
            ref,
            1,
            2,
            1_100
        );
        expect(completeFilterTileRenewal).toHaveBeenCalledWith(ref, 1, 2);
        expect(ref.accept(delivery(1, ref.generation, 1))).toBe(false);
        expect(onTile).toHaveBeenCalledTimes(2);
    });

    it("notifies its consumer when transport state is synchronized", () => {
        const onRequestSynchronized = vi.fn();
        const ref = new FilterSubscriptionRef(
            {
                updateFilterSubscription: vi.fn(),
                releaseFilterSubscription: vi.fn()
            },
            "styled",
            definition(),
            {tileIds: [1]},
            {
                onTile: vi.fn(),
                onRequestSynchronized
            }
        );

        ref.notifyRequestSynchronized();
        ref.suspend();
        ref.notifyRequestSynchronized();

        expect(onRequestSynchronized).toHaveBeenCalledOnce();
    });
});
