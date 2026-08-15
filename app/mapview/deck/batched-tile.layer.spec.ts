import {afterEach, describe, expect, it, vi} from "vitest";

import {BatchedTileLayer} from "./batched-tile.layer";

/** Builds the minimal mutable tile shape used by TileLayer completion hooks. */
function tile(): Parameters<BatchedTileLayer<string>["_onTileLoad"]>[0] {
    return {layers: [{}]} as Parameters<
        BatchedTileLayer<string>["_onTileLoad"]
    >[0];
}

describe("BatchedTileLayer", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("coalesces multiple tile completions into one Deck update", () => {
        vi.useFakeTimers();
        vi.spyOn(performance, "now").mockReturnValue(100);
        const onTileLoad = vi.fn();
        const layer = new BatchedTileLayer<string>({
            id: "background",
            data: [],
            onTileLoad
        });
        const setNeedsUpdate = vi.spyOn(layer, "setNeedsUpdate")
            .mockImplementation(() => {});
        const first = tile();
        const second = tile();

        layer._onTileLoad(first);
        layer._onTileLoad(second);
        vi.advanceTimersByTime(99);

        expect(first.layers).toBeNull();
        expect(second.layers).toBeNull();
        expect(onTileLoad).toHaveBeenCalledTimes(2);
        expect(setNeedsUpdate).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(setNeedsUpdate).toHaveBeenCalledOnce();
    });

    it("cancels a pending update when the layer is finalized", () => {
        vi.useFakeTimers();
        vi.spyOn(performance, "now").mockReturnValue(100);
        const layer = new BatchedTileLayer<string>({
            id: "background",
            data: []
        });
        const setNeedsUpdate = vi.spyOn(layer, "setNeedsUpdate")
            .mockImplementation(() => {});
        layer._onTileLoad(tile());

        layer.finalizeState();
        vi.runAllTimers();

        expect(setNeedsUpdate).not.toHaveBeenCalled();
    });
});
