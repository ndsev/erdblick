import {describe, expect, it} from "vitest";
import {GpuMemoryBudget} from "../../../../app/mapview/deck/gpu-memory-budget.model";

describe("aggregate GPU memory admission", () => {
    it("bypasses only the allowance when disabled and keeps ownership for re-enabling", () => {
        const budget = new GpuMemoryBudget(100);
        const releaseFirst = budget.allocate(100);
        expect(() => budget.allocate(1)).toThrow("GPU allocation allowance exhausted");
        budget.setEnabled(false);
        const reservation = budget.reserve(200);
        const releaseSecond = reservation.run(() => budget.allocate(200));
        reservation.release();
        expect(budget.allocatedBytes).toBe(300);
        expect(budget.reservedBytes).toBe(0);
        expect(() => budget.allocate(NaN)).toThrow("Invalid GPU allocation size");
        budget.setEnabled(true);
        expect(budget.availableBytes).toBe(0);
        expect(() => budget.allocate(1)).toThrow("GPU allocation allowance exhausted");
        releaseFirst();
        releaseSecond();
        expect(budget.availableBytes).toBe(100);
    });

    it("distinguishes reusable installed ranges from a failed job's temporary buffers", () => {
        const budget = new GpuMemoryBudget(1000);
        const release = budget.allocate(1000);
        budget.beginRetirement()(); // Publishing or abandoning staging is not reusable installed capacity.
        expect(budget.reclamationVersion).toBe(0);
        const finish = budget.beginRetirement();
        finish(true);
        finish(true);
        expect(budget.reclamationVersion).toBe(1);
        expect(budget.availableBytes).toBe(0); // A range can be reusable inside a still-live buffer.
        release();
    });

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
        const tracked = {count: 300};
        budget.observeTrackedTotal(tracked);
        budget.observeTrackedTotal(tracked);
        expect(budget.availableBytes).toBe(700);
        const reservation = budget.reserve(600);
        reservation.release();
        reservation.release();
        expect(budget.availableBytes).toBe(700);
        budget.setLimit(200);
        expect(() => budget.allocate(1)).toThrow();
        release();
        tracked.count -= 100;
        expect(budget.availableBytes).toBe(0);
    });

    it("recovers admission when other luma resources are freed without growing a primitive store", () => {
        const budget = new GpuMemoryBudget(1000);
        const release = budget.allocate(100);
        const tracked = {count: 1000};
        budget.observeTrackedTotal(tracked);
        expect(() => budget.reserve(1)).toThrow("GPU allocation allowance exhausted");

        // A background texture is destroyed while primitive buffers stay unchanged.
        tracked.count = 200;
        expect(budget.availableBytes).toBe(800);
        const reservation = budget.reserve(800);
        expect(budget.availableBytes).toBe(0);
        reservation.release();

        // Newly allocated resources must reduce admission just as promptly.
        tracked.count = 600;
        expect(budget.availableBytes).toBe(400);
        expect(() => budget.reserve(401)).toThrow("GPU allocation allowance exhausted");
        release();
        tracked.count -= 100;
        expect(budget.availableBytes).toBe(500);
    });
});
