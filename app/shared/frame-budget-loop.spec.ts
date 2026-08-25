import {describe, expect, it, vi} from "vitest";
import {FrameBudgetLoop} from "./frame-budget-loop";

describe("FrameBudgetLoop", () => {
    it("stops the active slice immediately when paused by its consumer", () => {
        const callbacks: FrameRequestCallback[] = [];
        const requestAnimationFrame = vi.spyOn(
            globalThis,
            "requestAnimationFrame"
        ).mockImplementation(callback => {
            callbacks.push(callback);
            return callbacks.length;
        });
        const cancelAnimationFrame = vi.spyOn(
            globalThis,
            "cancelAnimationFrame"
        ).mockImplementation(() => {});
        const now = vi.spyOn(performance, "now").mockReturnValue(0);
        const observed: number[] = [];
        let loop: FrameBudgetLoop<number>;
        loop = new FrameBudgetLoop(item => {
            observed.push(item);
            loop.setPaused(true);
            return true;
        });
        try {
            loop.enqueueMany([1, 2]);
            callbacks.shift()!(0);

            expect(observed).toEqual([1]);
            expect(loop.length).toBe(1);
        } finally {
            loop.dispose();
            now.mockRestore();
            requestAnimationFrame.mockRestore();
            cancelAnimationFrame.mockRestore();
        }
    });
});
