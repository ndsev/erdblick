import {BehaviorSubject} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {subscribeCoordinateFrames} from "./coordinate-frame-stream";

describe("subscribeCoordinateFrames", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("coalesces renderer coordinates at an animation-frame boundary", async () => {
        vi.useFakeTimers();
        vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback =>
            window.setTimeout(() => callback(performance.now()), 16));
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(handle =>
            window.clearTimeout(handle));

        const coordinates = new BehaviorSubject<number | null>(null);
        const ngZone = {run: vi.fn((callback: () => void) => callback())};
        const received: Array<number | null> = [];
        const subscription = subscribeCoordinateFrames(
            coordinates,
            ngZone,
            value => received.push(value)
        );

        coordinates.next(1);
        coordinates.next(2);

        expect(received).toEqual([]);
        await vi.advanceTimersByTimeAsync(16);

        expect(received).toEqual([2]);
        expect(ngZone.run).toHaveBeenCalledTimes(1);

        subscription.unsubscribe();
    });
});
