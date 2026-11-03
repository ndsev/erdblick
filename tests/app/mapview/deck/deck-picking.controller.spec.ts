import type { PickingInfo } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeckPicking } from "../../../../app/mapview/deck/deck-picking.controller";

/** Supplies a deferred readback so cancellation can be tested without a device. */
function fixture() {
    let resolvePick!: (info: PickingInfo | null) => void;
    const readback = new Promise<PickingInfo | null>(resolve => { resolvePick = resolve; });
    const layerProps = {id: "features", data: [],
        drillPickEligible: true, navigationAnchorEligible: true,
        subsetPickResolver: () => [{mapTileKey: "tile", featureId: "feature"}]
    };
    const layer = new ScatterplotLayer(layerProps);
    const deck = {
        props: {layers: [layer]},
        pickObjectAsync: vi.fn(() => readback), pickObjectsAsync: vi.fn(async () => []),
        pickObject: vi.fn(), pickMultipleObjects: vi.fn(() => []),
        setProps: vi.fn(), getCanvas: () => document.createElement("canvas")
    };
    const onHover = vi.fn();
    const onNavigation = vi.fn();
    const picking = new DeckPicking({deck: () => deck, scene: () => null, viewport: () => null},
        () => ({radius: 2, maxObjects: 5, navigationAnchors: false}), onHover, onNavigation);
    const hit: PickingInfo = {layer, object: {featureAddress: 1}, index: 0, color: null, picked: true, x: 30, y: 40, pixelRatio: 1};
    return {picking, deck, onHover, onNavigation, resolvePick, hit};
}

afterEach(() => vi.useRealTimers());

describe("DeckPicking lifetime", () => {
    it.each(["leave", "destroy"])("ignores an in-flight readback after %s and cancels deeper picking", async action => {
        vi.useFakeTimers();
        const h = fixture();
        h.picking.pointerEnter();
        h.picking.pointerMove({x: 10, y: 20}, 0);
        await vi.advanceTimersByTimeAsync(20);
        expect(h.deck.pickObjectAsync).toHaveBeenCalledOnce();
        if (action === "leave") h.picking.pointerLeave(true);
        else h.picking.destroy();
        h.onHover.mockClear();
        h.resolvePick(h.hit);
        await vi.advanceTimersByTimeAsync(200);
        expect(h.onHover).not.toHaveBeenCalled();
        expect(h.deck.pickObjectsAsync).not.toHaveBeenCalled();
        expect(h.picking.hoveredFeatureIds.getValue()).toEqual([]);
    });

    it("coalesces pointer moves and preserves inspection-owned hover on leaving the canvas", async () => {
        vi.useFakeTimers();
        const h = fixture();
        h.picking.pointerEnter();
        h.picking.pointerMove({x: 10, y: 20}, 0);
        h.picking.pointerMove({x: 30, y: 40}, 0);
        await vi.advanceTimersByTimeAsync(20);
        expect(h.deck.pickObjectAsync).toHaveBeenCalledOnce();
        expect(h.deck.pickObjectAsync).toHaveBeenCalledWith(expect.objectContaining({x: 30, y: 40}));
        h.resolvePick(h.hit);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.picking.hoveredFeatureIds.getValue()).toEqual([{mapTileKey: "tile", featureId: "feature"}]);
        h.picking.pointerLeave(true);
        expect(h.onHover).toHaveBeenLastCalledWith({featureIds: [], updateInspection: false});
        h.picking.destroy();
    });
});
