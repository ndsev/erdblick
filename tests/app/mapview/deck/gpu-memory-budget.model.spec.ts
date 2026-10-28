import {describe, expect, it} from "vitest";
import {GpuMemoryBudget} from "../../../../app/mapview/deck/gpu-memory-budget.model";

describe("aggregate GPU memory admission", () => {
    it("waits for every scene to finish retirement and completes each fence once", async () => {
        const budget = new GpuMemoryBudget(1000);
        const first = budget.beginRetirement();
        const second = budget.beginRetirement();
        const waiting = budget.retirement;
        first();
        first();
        expect(budget.retirement).toBe(waiting);
        second();
        await waiting;
        expect(budget.retirement).toBeNull();
    });

    it("accounts for replacement overlap and concurrent reservations", () => {
        const budget = new GpuMemoryBudget(1000);
        const oldBuffer = budget.allocate(400);
        const replacement = budget.reserve(500);
        expect(() => budget.reserve(101)).toThrow();
        const newBuffer = replacement.run(() => budget.allocate(500));
        expect(budget.allocatedBytes).toBe(900);
        expect(budget.reservedBytes).toBe(0);
        expect(() => budget.allocate(101)).toThrow();
        oldBuffer();
        replacement.release();
        newBuffer();
        newBuffer();
        expect(budget.availableBytes).toBe(1000);
    });

    it("releases cancelled reservations and includes other luma resources once", () => {
        const budget = new GpuMemoryBudget(1000);
        const release = budget.allocate(100);
        budget.observeTrackedTotal(300);
        budget.observeTrackedTotal(300);
        expect(budget.availableBytes).toBe(700);
        const reservation = budget.reserve(600);
        reservation.release();
        reservation.release();
        expect(budget.availableBytes).toBe(700);
        budget.setLimit(200);
        expect(() => budget.allocate(1)).toThrow();
        release();
        expect(budget.availableBytes).toBe(0);
    });
});
