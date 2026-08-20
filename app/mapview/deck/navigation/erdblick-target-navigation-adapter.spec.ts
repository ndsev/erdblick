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
        surfaceNormal: [0, 0, 1],
        origin: "feature"
    };
}

describe("ErdblickTargetNavigationAdapter", () => {
    it("publishes only the snapped numeric coordinate and projected pixel to deck.gl", () => {
        const richTarget = targetAt([320, 280]);
        const resolveTarget = vi.fn(() => richTarget);
        const onTargetChange = vi.fn();
        const getMinimumTargetDistance = vi.fn(() => 20);
        const adapter = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget,
            getRetainedTarget: () => null,
            getMinimumTargetDistance,
            onTargetChange
        });

        const acquisitionContext = context([324, 282]);
        const resolved = adapter.resolveInteractionTarget(acquisitionContext);
        expect(resolveTarget).toHaveBeenCalledWith(acquisitionContext);
        expect(resolved).toEqual({
            coordinate: richTarget.position,
            screenPosition: expect.any(Array),
            minimumTargetDistance: 20
        });
        expect(getMinimumTargetDistance).toHaveBeenCalledOnce();
        expect(getMinimumTargetDistance).toHaveBeenCalledWith(
            expect.objectContaining({origin: "feature"})
        );
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
        let clearance = 20;
        const getMinimumTargetDistance = vi.fn(() => clearance);
        const adapter = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget,
            getRetainedTarget: () => retained,
            getMinimumTargetDistance,
            onTargetChange: vi.fn()
        });

        const resolved = adapter.resolveInteractionTarget(context(null));
        expect(resolved?.coordinate).toEqual(retained.position);
        expect(resolved?.minimumTargetDistance).toBe(20);
        expect(resolveTarget).not.toHaveBeenCalled();

        adapter.handleInteractionState({
            viewId: VIEW_ID,
            interactionTargetPosition: resolved!.coordinate
        });
        adapter.handleInteractionState({
            viewId: VIEW_ID,
            interactionTargetPosition: undefined
        });
        clearance = 35;
        expect(
            adapter.resolveInteractionTarget(context(null))?.minimumTargetDistance
        ).toBe(35);
        expect(getMinimumTargetDistance).toHaveBeenCalledTimes(2);

        const unavailable = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget,
            getRetainedTarget: () => ({position: [0, 89, 0]}),
            getMinimumTargetDistance: () => undefined,
            onTargetChange: vi.fn()
        });
        const pointerlessContext = context(null);
        expect(unavailable.resolveInteractionTarget(pointerlessContext)?.coordinate)
            .toEqual(centerTarget.position);
        expect(resolveTarget).toHaveBeenCalledWith(pointerlessContext);
    });

    it("treats null and mismatched views as authoritative fallback and resets lifecycle", () => {
        const richTarget = targetAt([320, 280]);
        const onTargetChange = vi.fn();
        const adapter = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget: () => richTarget,
            getRetainedTarget: () => null,
            getMinimumTargetDistance: () => undefined,
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

    it("correlates equivalent antimeridian world copies with pending metadata", () => {
        const richTarget = targetAt([320, 280]);
        const onTargetChange = vi.fn();
        const adapter = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget: () => richTarget,
            getRetainedTarget: () => null,
            getMinimumTargetDistance: () => undefined,
            onTargetChange
        });
        const resolved = adapter.resolveInteractionTarget(context([320, 280]))!;

        adapter.handleInteractionState({
            viewId: VIEW_ID,
            interactionTargetPosition: [
                resolved.coordinate[0] + 360,
                resolved.coordinate[1],
                resolved.coordinate[2]
            ]
        });

        expect(onTargetChange).toHaveBeenCalledWith(
            expect.objectContaining({surfaceNormal: richTarget.surfaceNormal}),
            true
        );
    });
});
