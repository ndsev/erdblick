import { afterEach, describe, expect, it, vi } from "vitest";
import { DeckLayerRegistry } from "../../../../app/mapview/deck/deck-layer-registry.util";
import { rectangleOverlayData } from "../../../../app/mapview/deck/deck-rectangle-overlay.layer";
import { DeckSearchOverlay } from "../../../../app/mapview/deck/deck-search-overlay.presentation";
import { DeckTileOverlay } from "../../../../app/mapview/deck/deck-tile-overlay.presentation";

/** Capture frame ownership explicitly so cancellation is observable. */
function frames() {
    let next = 0;
    const queued = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { queued.set(++next, callback); return next; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
    return {queued, flush() { const callbacks = [...queued.values()]; queued.clear(); callbacks.forEach(callback => callback(0)); }};
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Deck overlay schedules", () => {
    it("coalesces search refreshes and cancels both frame and debounce work on retirement", () => {
        vi.useFakeTimers();
        const frame = frames();
        const registry = new DeckLayerRegistry(null, () => 1, () => {});
        registry.upsert("other", {id: "other"});
        const snapshot = vi.fn(() => null);
        const overlay = new DeckSearchOverlay(registry, snapshot);
        overlay.scheduleUpdate(); overlay.scheduleUpdate();
        expect(frame.queued.size).toBe(1);
        frame.flush();
        expect(snapshot).toHaveBeenCalledOnce();
        overlay.scheduleDataRefresh(); overlay.scheduleUpdate();
        overlay.destroy();
        vi.runAllTimers(); frame.flush();
        expect(snapshot).toHaveBeenCalledOnce();
        expect(registry.size).toBe(1);
        overlay.scheduleUpdate();
        expect(frame.queued.size).toBe(0);
    });

    it("retires tile outlines and pending refreshes without removing another owner's layer", () => {
        vi.useFakeTimers();
        const frame = frames();
        const registry = new DeckLayerRegistry(null, () => 1, () => {});
        registry.upsert("other", {id: "other"});
        const snapshot = vi.fn(() => null);
        const overlay = new DeckTileOverlay(registry, snapshot, () => null);
        overlay.setOutline(rectangleOverlayData(8, 47, 9, 48, [0, 0, 0, 50], [255, 0, 0, 255], 1));
        expect(registry.size).toBe(2);
        overlay.scheduleUpdate(); overlay.scheduleDataRefresh(true);
        overlay.destroy();
        vi.runAllTimers(); frame.flush();
        expect(snapshot).not.toHaveBeenCalled();
        expect(registry.size).toBe(1);
    });
});
