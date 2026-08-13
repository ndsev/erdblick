import type {InteractionState, MapInteractionTargetContext} from "@deck.gl/core";
import {describe, expect, it, vi} from "vitest";
import type {NavigationAnchor, NavigationVisualTarget} from "./feature-navigation.types";
import {createDeckMapViewport} from "./web-mercator-feature-navigation";
import {ErdblickTargetNavigationAdapter} from "./erdblick-target-navigation-adapter";

const VIEW_ID = "deck-view-3";
const viewport = createDeckMapViewport({
    longitude: 11.12,
    latitude: 48,
    zoom: 16,
    pitch: 55,
    bearing: 25,
    position: [0, 0, 0]
}, 1000, 700, false);

function context(
    screenPosition: [number, number] | null,
    viewId = VIEW_ID
): MapInteractionTargetContext {
    return {
        viewId,
        operation: screenPosition ? "rotate" : "zoom",
        source: screenPosition ? "pointer" : "keyboard",
        screenPosition,
        viewport
    };
}

function targetAt(
    screenPosition: [number, number],
    altitude = 120
): NavigationVisualTarget {
    return {
        position: viewport.unproject(screenPosition, {targetZ: altitude}) as NavigationAnchor,
        surfaceNormal: [0, 0, 1]
    };
}

describe("ErdblickTargetNavigationAdapter", () => {
    it("publishes only the snapped numeric coordinate and projected pixel to deck.gl", () => {
        const richTarget = targetAt([320, 280]);
        const resolveTarget = vi.fn(() => richTarget);
        const onTargetChange = vi.fn();
        const adapter = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget,
            getRetainedTarget: () => null,
            onTargetChange
        });

        const resolved = adapter.resolveInteractionTarget(context([324, 282]));
        expect(resolveTarget).toHaveBeenCalledWith([324, 282]);
        expect(resolved).toEqual({
            coordinate: richTarget.position,
            screenPosition: expect.any(Array)
        });
        expect(Math.abs(resolved!.screenPosition[0] - 320)).toBeLessThan(0.1);
        expect(Math.abs(resolved!.screenPosition[1] - 280)).toBeLessThan(0.1);
        expect(resolved).not.toHaveProperty("surfaceNormal");

        adapter.handleInteractionState({
            viewId: VIEW_ID,
            interactionTargetPosition: resolved!.coordinate
        });
        expect(onTargetChange).toHaveBeenCalledWith(richTarget, true);
        adapter.handleInteractionState({
            viewId: VIEW_ID,
            interactionTargetPosition: undefined
        });
        expect(onTargetChange).toHaveBeenLastCalledWith(richTarget, false);
    });

    it("uses a visible retained target for pointerless commands and otherwise samples center", () => {
        const retained = targetAt([430, 310]);
        const centerTarget = targetAt([500, 350], 0);
        const resolveTarget = vi.fn(() => centerTarget);
        const adapter = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget,
            getRetainedTarget: () => retained,
            onTargetChange: vi.fn()
        });

        const resolved = adapter.resolveInteractionTarget(context(null));
        expect(resolved?.coordinate).toEqual(retained.position);
        expect(resolveTarget).not.toHaveBeenCalled();

        const unavailable = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget,
            getRetainedTarget: () => ({position: [0, 89, 0]}),
            onTargetChange: vi.fn()
        });
        expect(unavailable.resolveInteractionTarget(context(null))?.coordinate)
            .toEqual(centerTarget.position);
        expect(resolveTarget).toHaveBeenCalledWith([500, 350]);
    });

    it("treats null and mismatched views as authoritative fallback and resets lifecycle", () => {
        const richTarget = targetAt([320, 280]);
        const onTargetChange = vi.fn();
        const adapter = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget: () => richTarget,
            getRetainedTarget: () => null,
            onTargetChange
        });

        expect(adapter.resolveInteractionTarget(context([320, 280], "another-view"))).toBeNull();
        const resolved = adapter.resolveInteractionTarget(context([320, 280]))!;
        adapter.handleInteractionState({
            viewId: VIEW_ID,
            interactionTargetPosition: resolved.coordinate
        });
        adapter.handleInteractionState({
            viewId: "another-view",
            interactionTargetPosition: undefined
        } as InteractionState);
        expect(onTargetChange).toHaveBeenCalledTimes(1);

        adapter.reset();
        expect(onTargetChange).toHaveBeenLastCalledWith(richTarget, false);
        adapter.reset();
        expect(onTargetChange).toHaveBeenCalledTimes(2);
    });
});
