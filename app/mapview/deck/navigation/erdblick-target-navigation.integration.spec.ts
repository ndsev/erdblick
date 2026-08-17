import {
    MapController,
    MapView,
    type InteractionState,
    type MapViewState,
    type WebMercatorViewport
} from "@deck.gl/core";
import {Timeline} from "@luma.gl/engine";
import {describe, expect, it, vi} from "vitest";
import type {NavigationAnchor, NavigationVisualTarget} from "./feature-navigation.types";
import {ErdblickTargetNavigationAdapter} from "./erdblick-target-navigation-adapter";

const VIEW_SIZE = {width: 1000, height: 700};
const VIEW_ID = "deck-view-2";
const START_PIXEL: [number, number] = [280, 310];

/** Minimal gesture object accepted by the controller's public event seam. */
function gestureEvent(
    type: string,
    screenPosition: [number, number],
    delta: [number, number] = [0, 0],
    rightButton = false
) {
    const event = {
        type,
        pointerType: "mouse",
        offsetCenter: {x: screenPosition[0], y: screenPosition[1]},
        deltaX: delta[0],
        deltaY: delta[1],
        velocity: 0,
        velocityX: 0,
        velocityY: 0,
        deltaTime: 0,
        scale: 1,
        rotation: 0,
        rightButton,
        srcEvent: {button: rightButton ? 2 : 0, preventDefault() {}},
        handled: false,
        stopPropagation() {
            event.handled = true;
        }
    };
    return event;
}

describe("Erdblick target navigation integration", () => {
    it("adapts one rich deep-pick target through stock MapController lifecycle", () => {
        const view = new MapView({
            id: VIEW_ID,
            ...VIEW_SIZE,
            controller: true
        });
        const makeViewport = (viewState: Record<string, unknown>) =>
            view.makeViewport({
                ...VIEW_SIZE,
                viewState: viewState as MapViewState
            }) as WebMercatorViewport;
        const initialViewState = {
            longitude: 11.12,
            latitude: 48,
            zoom: 16,
            pitch: 55,
            bearing: 25,
            maxPitch: 85,
            position: [0, 0, 0]
        };
        let currentProps: Record<string, unknown> = {
            ...view.controller,
            ...view.getDimensions(VIEW_SIZE),
            id: VIEW_ID,
            ...initialViewState
        };
        const initialViewport = makeViewport(currentProps);
        const richTarget: NavigationVisualTarget = {
            position: initialViewport.unproject(
                START_PIXEL,
                {targetZ: 120}
            ) as NavigationAnchor,
            surfaceNormal: [0, 0, 1]
        };
        const resolveTarget = vi.fn(() => richTarget);
        const targetChanges: Array<{target: NavigationVisualTarget; active: boolean}> = [];
        const adapter = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget,
            getRetainedTarget: () => null,
            onTargetChange: (target, active) => targetChanges.push({target, active})
        });
        let controller!: MapController;
        controller = new MapController({
            timeline: new Timeline(),
            eventManager: null as never,
            makeViewport,
            onViewStateChange: ({viewState}) => {
                currentProps = {...currentProps, ...viewState};
                controller.setProps(currentProps as never);
            },
            onStateChange: (state: InteractionState) =>
                adapter.handleInteractionState(state)
        });
        currentProps = {
            ...currentProps,
            _targetNavigation: true,
            getInteractionTarget: adapter.resolveInteractionTarget
        };
        controller.setProps(currentProps as never);

        const endPixel: [number, number] = [410, 355];
        controller.handleEvent(gestureEvent("panstart", START_PIXEL) as never);
        controller.handleEvent(gestureEvent(
            "panmove",
            endPixel,
            [endPixel[0] - START_PIXEL[0], endPixel[1] - START_PIXEL[1]]
        ) as never);
        const viewport = makeViewport(controller.controllerState.getViewportProps());
        const projected = viewport.project(richTarget.position);
        controller.handleEvent(gestureEvent("panend", endPixel) as never);

        expect(resolveTarget).toHaveBeenCalledTimes(1);
        expect(Math.abs(projected[0] - endPixel[0])).toBeLessThanOrEqual(0.1);
        expect(Math.abs(projected[1] - endPixel[1])).toBeLessThanOrEqual(0.1);
        expect(targetChanges).toEqual([
            {target: richTarget, active: true},
            {target: richTarget, active: false}
        ]);
        controller.finalize();
    });

    it("keeps a right-drag rotation target at its acquired screen position", () => {
        const view = new MapView({
            id: VIEW_ID,
            ...VIEW_SIZE,
            controller: true
        });
        const makeViewport = (viewState: Record<string, unknown>) =>
            view.makeViewport({
                ...VIEW_SIZE,
                viewState: viewState as MapViewState
            }) as WebMercatorViewport;
        const initialViewState = {
            longitude: 11.12,
            latitude: 48,
            zoom: 16,
            pitch: 55,
            bearing: 25,
            maxPitch: 85,
            position: [0, 0, 0]
        };
        let currentProps: Record<string, unknown> = {
            ...view.controller,
            ...view.getDimensions(VIEW_SIZE),
            id: VIEW_ID,
            ...initialViewState
        };
        const initialViewport = makeViewport(currentProps);
        const richTarget: NavigationVisualTarget = {
            position: initialViewport.unproject(
                START_PIXEL,
                {targetZ: 120}
            ) as NavigationAnchor
        };
        const adapter = new ErdblickTargetNavigationAdapter({
            viewId: VIEW_ID,
            resolveTarget: () => richTarget,
            getRetainedTarget: () => null,
            onTargetChange: vi.fn()
        });
        let controller!: MapController;
        controller = new MapController({
            timeline: new Timeline(),
            eventManager: null as never,
            makeViewport,
            onViewStateChange: ({viewState}) => {
                currentProps = {...currentProps, ...viewState};
                controller.setProps(currentProps as never);
            },
            onStateChange: (state: InteractionState) =>
                adapter.handleInteractionState(state)
        });
        currentProps = {
            ...currentProps,
            _targetNavigation: true,
            getInteractionTarget: adapter.resolveInteractionTarget
        };
        controller.setProps(currentProps as never);

        const endPixel: [number, number] = [430, 390];
        controller.handleEvent(gestureEvent("panstart", START_PIXEL, [0, 0], true) as never);
        controller.handleEvent(gestureEvent(
            "panmove",
            endPixel,
            [endPixel[0] - START_PIXEL[0], endPixel[1] - START_PIXEL[1]],
            true
        ) as never);
        const rotatedProps = controller.controllerState.getViewportProps();
        const projected = makeViewport(rotatedProps).project(richTarget.position);
        controller.handleEvent(gestureEvent("panend", endPixel, [0, 0], true) as never);

        expect(rotatedProps.bearing).not.toBe(initialViewState.bearing);
        expect(rotatedProps.pitch).not.toBe(initialViewState.pitch);
        expect(Math.abs(projected[0] - START_PIXEL[0])).toBeLessThanOrEqual(0.1);
        expect(Math.abs(projected[1] - START_PIXEL[1])).toBeLessThanOrEqual(0.1);
        controller.finalize();
    });
});
