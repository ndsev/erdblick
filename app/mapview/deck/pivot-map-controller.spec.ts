import {WebMercatorViewport} from "@deck.gl/core";
import {Timeline} from "@luma.gl/engine";
import {EventManager} from "mjolnir.js";
import {describe, expect, it, vi} from "vitest";
import {
    NavigationPivot,
    NavigationPivotChangeHandler,
    NavigationPivotProvider,
    PivotMapController,
    RetainedNavigationPivotProvider
} from "./pivot-map-controller";
import {longitudeInNearestWorld} from "./deck-camera-navigation";

const VIEW_STATE = {
    id: "map",
    x: 0,
    y: 0,
    width: 1000,
    height: 700,
    longitude: 11.12,
    latitude: 48.0,
    zoom: 16,
    pitch: 55,
    bearing: 25,
    maxPitch: 85
};

/**
 * Builds a controller around a deterministic WebMercator viewport.
 */
function makeController(
    getNavigationPivot: NavigationPivotProvider,
    onNavigationPivotChange: NavigationPivotChangeHandler,
    getRetainedNavigationPivot: RetainedNavigationPivotProvider = () => null
): PivotMapController {
    const controller = new PivotMapController({
        timeline: new Timeline(),
        eventManager: new EventManager(),
        makeViewport: props => new WebMercatorViewport(props),
        onViewStateChange: vi.fn(),
        onStateChange: vi.fn()
    });
    controller.setProps({
        ...VIEW_STATE,
        getNavigationPivot,
        getRetainedNavigationPivot,
        onNavigationPivotChange
    });
    return controller;
}

/**
 * Creates a 3D point that initially projects to the supplied screen position.
 */
function makePivot(
    screenPosition: [number, number],
    altitude: number
): NavigationPivot {
    const viewport = new WebMercatorViewport(VIEW_STATE);
    const [longitude, latitude, resolvedAltitude] = viewport.unproject(
        screenPosition,
        {targetZ: altitude}
    );
    return [longitude, latitude, resolvedAltitude];
}

describe("PivotMapController", () => {
    it("keeps a captured 3D point under the pointer while drag-panning", () => {
        const startPosition: [number, number] = [280, 310];
        const endPosition: [number, number] = [410, 355];
        const pivot = makePivot(startPosition, 120);
        const getPivot = vi.fn(() => pivot);
        const onPivotChange = vi.fn();
        const controller = makeController(getPivot, onPivotChange);

        let state = controller.controllerState.panStart({pos: startPosition});
        state = state.pan({pos: endPosition});
        const viewport = new WebMercatorViewport(state.getViewportProps());
        const projectedPivot = viewport.project(pivot);
        state.panEnd();

        expect(Math.abs(projectedPivot[0] - endPosition[0])).toBeLessThan(0.1);
        expect(Math.abs(projectedPivot[1] - endPosition[1])).toBeLessThan(0.1);
        expect(getPivot).toHaveBeenCalledTimes(1);
        expect(onPivotChange).toHaveBeenNthCalledWith(1, pivot, true);
        expect(onPivotChange).toHaveBeenNthCalledWith(2, pivot, false);
        controller.finalize();
    });

    it("uses the pivot world copy nearest to the controlled map center", () => {
        const startPosition: [number, number] = [280, 310];
        const endPosition: [number, number] = [410, 355];
        const localPivot = makePivot(startPosition, 120);
        const wrappedPivot: NavigationPivot = [
            localPivot[0] + 360,
            localPivot[1],
            localPivot[2]
        ];
        const controller = makeController(() => wrappedPivot, vi.fn());

        let state = controller.controllerState.panStart({pos: startPosition});
        state = state.pan({pos: endPosition});
        const viewport = new WebMercatorViewport(state.getViewportProps());
        const projectedPivot = viewport.project([
            longitudeInNearestWorld(wrappedPivot[0], viewport.longitude),
            wrappedPivot[1],
            wrappedPivot[2]
        ]);
        state.panEnd();

        expect(Math.abs(projectedPivot[0] - endPosition[0])).toBeLessThan(0.1);
        expect(Math.abs(projectedPivot[1] - endPosition[1])).toBeLessThan(0.1);
        controller.finalize();
    });

    it("keeps one locked pivot through compound pinch zoom and rotation", () => {
        const position: [number, number] = [360, 290];
        const pivot = makePivot(position, 80);
        const getPivot = vi.fn(() => pivot);
        const onPivotChange = vi.fn();
        const controller = makeController(getPivot, onPivotChange);

        let state = controller.controllerState.zoomStart({pos: position});
        state = state.rotateStart({pos: position});
        state = state.zoom({pos: position, scale: 1.75});
        state = state.rotate({deltaAngleX: 12});
        const viewport = new WebMercatorViewport(state.getViewportProps());
        const projectedPivot = viewport.project(pivot);
        state = state.zoomEnd();
        expect(onPivotChange).toHaveBeenCalledTimes(1);
        state.rotateEnd();

        expect(Math.abs(projectedPivot[0] - position[0])).toBeLessThan(0.1);
        expect(Math.abs(projectedPivot[1] - position[1])).toBeLessThan(0.1);
        expect(getPivot).toHaveBeenCalledTimes(1);
        expect(onPivotChange).toHaveBeenNthCalledWith(1, pivot, true);
        expect(onPivotChange).toHaveBeenNthCalledWith(2, pivot, false);
        controller.finalize();
    });

    it("anchors one discrete zoom burst to a retained pointer pivot", () => {
        vi.useFakeTimers();
        const position: [number, number] = [520, 330];
        const pivot = makePivot(position, 200);
        const getPivot = vi.fn(() => pivot);
        const onPivotChange = vi.fn();
        const controller = makeController(getPivot, onPivotChange);

        try {
            let state = controller.controllerState.zoom({
                pos: position,
                scale: 0.8
            });
            state = state.zoom({
                pos: position,
                scale: 0.6
            });
            const viewport = new WebMercatorViewport(state.getViewportProps());
            const projectedPivot = viewport.project(pivot);

            expect(Math.abs(projectedPivot[0] - position[0])).toBeLessThan(0.1);
            expect(Math.abs(projectedPivot[1] - position[1])).toBeLessThan(0.1);
            expect(getPivot).toHaveBeenCalledOnce();
            expect(onPivotChange).toHaveBeenCalledOnce();
            expect(onPivotChange).toHaveBeenCalledWith(pivot, true);

            vi.advanceTimersByTime(150);
            expect(onPivotChange).toHaveBeenNthCalledWith(2, pivot, false);
        } finally {
            controller.finalize();
            vi.useRealTimers();
        }
    });

    it("uses the retained pivot for pointerless zoom, tilt, and movement", () => {
        const initialPixel: [number, number] = [340, 280];
        const pivot = makePivot(initialPixel, 150);
        const onPivotChange = vi.fn();
        const controller = makeController(() => null, onPivotChange, () => pivot);

        let state = controller.controllerState.zoomIn(1.5);
        let viewport = new WebMercatorViewport(state.getViewportProps());
        let projectedPivot = viewport.project(pivot);
        expect(Math.abs(projectedPivot[0] - initialPixel[0])).toBeLessThan(0.1);
        expect(Math.abs(projectedPivot[1] - initialPixel[1])).toBeLessThan(0.1);

        state = state.rotateUp(8);
        viewport = new WebMercatorViewport(state.getViewportProps());
        projectedPivot = viewport.project(pivot);
        expect(Math.abs(projectedPivot[0] - initialPixel[0])).toBeLessThan(0.1);
        expect(Math.abs(projectedPivot[1] - initialPixel[1])).toBeLessThan(0.1);

        state = state.moveLeft(80);
        viewport = new WebMercatorViewport(state.getViewportProps());
        projectedPivot = viewport.project(pivot);
        expect(Math.abs(projectedPivot[0] - (initialPixel[0] + 80))).toBeLessThan(0.1);
        expect(Math.abs(projectedPivot[1] - initialPixel[1])).toBeLessThan(0.1);
        expect(onPivotChange).toHaveBeenCalledWith(pivot, false);
        controller.finalize();
    });
});
