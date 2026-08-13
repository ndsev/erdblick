import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {TileExpiryScheduler} from "./tile-expiry-scheduler";

describe("TileExpiryScheduler", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("replaces and cancels indexed entries without leaving per-tile timers", () => {
        const owner = {};
        const expired = vi.fn();
        const scheduler = new TileExpiryScheduler(expired);

        scheduler.schedule(owner, 1, 1, 1_100);
        scheduler.schedule(owner, 1, 2, 1_200);
        scheduler.schedule(owner, 2, 1, 1_150);
        scheduler.cancel(owner, 2);

        expect(scheduler.size).toBe(1);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(201);
        expect(expired).toHaveBeenCalledWith(owner, [{
            tileId: 1,
            deliveryEpoch: 2
        }]);
        expect(scheduler.size).toBe(0);
    });

    it("drains simultaneous expiry in bounded task quanta", () => {
        const owner = {};
        const batches: number[][] = [];
        const scheduler = new TileExpiryScheduler(
            (_owner, tokens) => batches.push(tokens.map(token => token.tileId)),
            2
        );
        for (let tileId = 0; tileId < 5; ++tileId) {
            scheduler.schedule(owner, tileId, 1, 1_010);
        }

        vi.advanceTimersByTime(11);
        expect(batches).toEqual([[0, 1]]);
        vi.runAllTimers();
        expect(batches.flat()).toEqual([0, 1, 2, 3, 4]);
    });

    it("uses one timer for five hundred thousand independently tracked tiles", () => {
        const owner = {};
        const scheduler = new TileExpiryScheduler(() => {});
        for (let tileId = 0; tileId < 500_000; ++tileId) {
            scheduler.schedule(owner, tileId, 1, 10_000 + tileId);
        }

        expect(scheduler.size).toBe(500_000);
        expect(vi.getTimerCount()).toBe(1);
        scheduler.cancelOwner(owner);
        expect(scheduler.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});
