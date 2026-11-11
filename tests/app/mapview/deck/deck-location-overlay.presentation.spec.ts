import { afterEach, describe, expect, it, vi } from "vitest";
import { DeckLayerRegistry } from "../../../../app/mapview/deck/deck-layer-registry.util";
import { DeckLocationOverlay } from "../../../../app/mapview/deck/deck-location-overlay.presentation";
import type { LocationAreaLayer } from "../../../../app/mapview/deck/location-area.layer";
import type { LocationArea } from "../../../../app/mapview/render-view.model";

const area: LocationArea = {label: "Place", rectangle: {west: 10, south: 47, east: 14, north: 49},
    polygons: [[[[10, 47], [14, 47], [14, 49], [10, 47]]]]};

/** Exercise a real overlay owner with a manually advanced renderer clock. */
function createOverlay() {
    const registry = new DeckLayerRegistry(null, () => 1, () => {});
    const ticks = new Set<() => void>();
    const upsert = vi.spyOn(registry, "upsert");
    const remove = vi.spyOn(registry, "remove");
    const unavailable = vi.fn();
    const overlay = new DeckLocationOverlay(registry, {
        onTick: callback => {ticks.add(callback);},
        offTick: callback => {ticks.delete(callback);},
        requestRender: vi.fn()
    }, unavailable);
    overlay.setBoundariesEnabled(true);
    return {overlay, registry, ticks, upsert, remove, unavailable,
        layer: () => upsert.mock.calls.at(-1)![1] as LocationAreaLayer};
}

afterEach(() => vi.restoreAllMocks());

describe("DeckLocationOverlay", () => {
    it("rejects area highlights after boundary visibility has been withdrawn", () => {
        const h = createOverlay();
        h.overlay.startLocationAreaHighlight(area);
        h.overlay.setBoundariesEnabled(false);
        h.upsert.mockClear();
        h.overlay.startLocationAreaHighlight(area);
        expect(h.upsert).not.toHaveBeenCalled();
        expect(h.ticks.size).toBe(0);
        expect(h.remove).toHaveBeenLastCalledWith("builtin/location-area");
    });

    it("fades stable polygon data and releases its callback on expiry and replacement", () => {
        const h = createOverlay();
        const now = vi.spyOn(performance, "now").mockReturnValue(1000);
        h.overlay.startLocationAreaHighlight(area);
        const initial = h.layer();
        for (const tick of h.ticks) tick();
        expect(h.layer()).toBe(initial); // The first rendered frame starts the fade.
        h.overlay.onAfterRender();
        now.mockReturnValue(2500);
        for (const tick of h.ticks) tick();
        expect(h.layer().props.opacity).toBeCloseTo(0.5);
        expect(h.layer().props.data).toBe(initial.props.data);
        expect(h.layer().props.pickable).toBe(false);
        const oldTick = [...h.ticks][0];
        h.overlay.startLocationAreaHighlight(area);
        expect(h.ticks.has(oldTick)).toBe(false);
        h.overlay.onAfterRender();
        now.mockReturnValue(5500);
        for (const tick of h.ticks) tick();
        expect(h.ticks.size).toBe(0);
        expect(h.remove).toHaveBeenLastCalledWith("builtin/location-area");
    });

    it("replaces a failed boundary once and ignores errors from retired overlays", async () => {
        const h = createOverlay();
        h.overlay.startLocationAreaHighlight(area);
        const initial = h.layer();
        expect(initial.props.onError!(new Error("Tessellation failed"))).toBe(true);
        await Promise.resolve();
        expect(h.unavailable).toHaveBeenCalledOnce();
        expect(h.layer().props.data).toEqual([[[[10, 47], [14, 47], [14, 49], [10, 49], [10, 47]]]]);
        initial.props.onError!(new Error("Stale boundary failure"));
        await Promise.resolve();
        expect(h.unavailable).toHaveBeenCalledOnce();
        h.layer().props.onError!(new Error("Extent failed too"));
        await Promise.resolve();
        expect(h.ticks.size).toBe(0);
        expect(h.unavailable).toHaveBeenCalledOnce();
    });

    it("cancels a pending boundary fallback and every fade before registry disposal", async () => {
        const h = createOverlay();
        h.registry.upsert("another-owner", {id: "another-owner"});
        h.overlay.startLocationAreaHighlight(area);
        const initial = h.layer();
        h.overlay.startJumpAreaHighlight(area.rectangle);
        h.overlay.startLocationLabel({x: 11, y: 48, label: "Place"});
        h.overlay.updateLocationMarkerOverlay(true, [11, 48], "marker.svg");
        initial.props.onError!(new Error("Pending failure"));
        h.overlay.destroy();
        await Promise.resolve();
        expect(h.unavailable).not.toHaveBeenCalled();
        expect(h.ticks.size).toBe(0);
        expect(h.registry.size).toBe(1);
        h.upsert.mockClear();
        h.overlay.startLocationAreaHighlight(area);
        h.overlay.startLocationLabel({x: 11, y: 48, label: "Late"});
        expect(h.upsert).not.toHaveBeenCalled();
    });
});
