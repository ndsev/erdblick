import {WebMercatorViewport} from "@deck.gl/core";
import {Timeline} from "@luma.gl/engine";
import {EventManager} from "mjolnir.js";
import {describe, expect, it, vi} from "vitest";
import {
    FeatureNavigationMapController
} from "./feature-navigation-map-controller";
import type {
    NavigationAnchor,
    NavigationAnchorChangeHandler,
    NavigationAnchorProvider,
    RetainedNavigationAnchorProvider
} from "./feature-navigation.types";
import {
    DECK_MAP_FAR_Z_MULTIPLIER,
    DECK_MAP_FOV_DEGREES,
    DECK_MAP_NEAR_Z_MULTIPLIER,
    longitudeInNearestWorld,
    navigationAnchorDistanceMeters
} from "./web-mercator-feature-navigation";

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
    maxPitch: 85,
    fovy: DECK_MAP_FOV_DEGREES,
    nearZMultiplier: DECK_MAP_NEAR_Z_MULTIPLIER,
    farZMultiplier: DECK_MAP_FAR_Z_MULTIPLIER
};

/** Creates the same projection contract used by the MapView under test. */
function makeViewport(
    props: ConstructorParameters<typeof WebMercatorViewport>[0]
): WebMercatorViewport {
    return new WebMercatorViewport({
        ...props,
        fovy: DECK_MAP_FOV_DEGREES,
        nearZMultiplier: DECK_MAP_NEAR_Z_MULTIPLIER,
        farZMultiplier: DECK_MAP_FAR_Z_MULTIPLIER
    });
}

/**
 * Builds a controller around a deterministic WebMercator viewport.
 */
function makeController(
    getNavigationAnchor: NavigationAnchorProvider,
    onNavigationAnchorChange: NavigationAnchorChangeHandler,
    getRetainedNavigationAnchor: RetainedNavigationAnchorProvider = () => null
): FeatureNavigationMapController {
    const controller = new FeatureNavigationMapController({
        timeline: new Timeline(),
        eventManager: new EventManager(),
        makeViewport,
        onViewStateChange: vi.fn(),
        onStateChange: vi.fn()
    });
    controller.setProps({
        ...VIEW_STATE,
        getNavigationAnchor,
        getRetainedNavigationAnchor,
        onNavigationAnchorChange
    });
    return controller;
}

/**
 * Creates a 3D point that initially projects to the supplied screen position.
 */
function makeAnchor(
    screenPosition: [number, number],
    altitude: number
): NavigationAnchor {
    const viewport = makeViewport(VIEW_STATE);
    const [longitude, latitude, resolvedAltitude] = viewport.unproject(
        screenPosition,
        {targetZ: altitude}
    );
    return [longitude, latitude, resolvedAltitude];
}

describe("FeatureNavigationMapController", () => {
    it("keeps a captured 3D point under the pointer while drag-panning", () => {
        const startPosition: [number, number] = [280, 310];
        const endPosition: [number, number] = [410, 355];
        const anchor = makeAnchor(startPosition, 120);
        const getAnchor = vi.fn(() => anchor);
        const onAnchorChange = vi.fn();
        const controller = makeController(getAnchor, onAnchorChange);

        let state = controller.controllerState.panStart({pos: startPosition});
        state = state.pan({pos: endPosition});
        const viewport = makeViewport(state.getViewportProps());
        const projectedAnchor = viewport.project(anchor);
        state.panEnd();

        expect(Math.abs(projectedAnchor[0] - endPosition[0])).toBeLessThan(0.1);
        expect(Math.abs(projectedAnchor[1] - endPosition[1])).toBeLessThan(0.1);
        expect(getAnchor).toHaveBeenCalledTimes(1);
        expect(onAnchorChange).toHaveBeenNthCalledWith(1, anchor, true);
        expect(onAnchorChange).toHaveBeenNthCalledWith(2, anchor, false);
        controller.finalize();
    });

    it("uses the anchor world copy nearest to the controlled map center", () => {
        const startPosition: [number, number] = [280, 310];
        const endPosition: [number, number] = [410, 355];
        const localAnchor = makeAnchor(startPosition, 120);
        const wrappedAnchor: NavigationAnchor = [
            localAnchor[0] + 360,
            localAnchor[1],
            localAnchor[2]
        ];
        const controller = makeController(() => wrappedAnchor, vi.fn());

        let state = controller.controllerState.panStart({pos: startPosition});
        state = state.pan({pos: endPosition});
        const viewport = makeViewport(state.getViewportProps());
        const projectedAnchor = viewport.project([
            longitudeInNearestWorld(wrappedAnchor[0], viewport.longitude),
            wrappedAnchor[1],
            wrappedAnchor[2]
        ]);
        state.panEnd();

        expect(Math.abs(projectedAnchor[0] - endPosition[0])).toBeLessThan(0.1);
        expect(Math.abs(projectedAnchor[1] - endPosition[1])).toBeLessThan(0.1);
        controller.finalize();
    });

    it("falls back to stock drag-pan behavior when no 3D anchor is available", () => {
        const startPosition: [number, number] = [280, 310];
        const endPosition: [number, number] = [410, 355];
        const getAnchor = vi.fn(() => null);
        const onAnchorChange = vi.fn();
        const controller = makeController(getAnchor, onAnchorChange);

        let state = controller.controllerState.panStart({pos: startPosition});
        const initialProps = state.getViewportProps();
        state = state.pan({pos: endPosition});
        const movedProps = state.getViewportProps();
        state.panEnd();

        expect(movedProps.longitude).not.toBe(initialProps.longitude);
        expect(movedProps.latitude).not.toBe(initialProps.latitude);
        expect(getAnchor).toHaveBeenCalledOnce();
        expect(onAnchorChange).toHaveBeenNthCalledWith(1, null, true);
        expect(onAnchorChange).toHaveBeenNthCalledWith(2, null, false);
        controller.finalize();
    });

    it("uses callback props replaced after controller construction", () => {
        const position: [number, number] = [360, 290];
        const firstAnchor = makeAnchor(position, 40);
        const secondAnchor = makeAnchor(position, 140);
        const firstProvider = vi.fn(() => firstAnchor);
        const secondProvider = vi.fn(() => secondAnchor);
        const onAnchorChange = vi.fn();
        const controller = makeController(firstProvider, onAnchorChange);
        controller.setProps({
            ...VIEW_STATE,
            getNavigationAnchor: secondProvider,
            onNavigationAnchorChange: onAnchorChange
        });

        const state = controller.controllerState.panStart({pos: position});
        state.panEnd();

        expect(firstProvider).not.toHaveBeenCalled();
        expect(secondProvider).toHaveBeenCalledOnce();
        expect(onAnchorChange).toHaveBeenNthCalledWith(1, secondAnchor, true);
        expect(onAnchorChange).toHaveBeenNthCalledWith(2, secondAnchor, false);
        controller.finalize();
    });

    it("keeps one locked anchor through compound pinch zoom and rotation", () => {
        const position: [number, number] = [360, 290];
        const anchor = makeAnchor(position, 80);
        const getAnchor = vi.fn(() => anchor);
        const onAnchorChange = vi.fn();
        const controller = makeController(getAnchor, onAnchorChange);

        let state = controller.controllerState.zoomStart({pos: position});
        state = state.rotateStart({pos: position});
        state = state.zoom({pos: position, scale: 1.75});
        state = state.rotate({deltaAngleX: 12});
        const viewport = makeViewport(state.getViewportProps());
        const projectedAnchor = viewport.project(anchor);
        state = state.zoomEnd();
        expect(onAnchorChange).toHaveBeenCalledTimes(1);
        state.rotateEnd();

        expect(Math.abs(projectedAnchor[0] - position[0])).toBeLessThan(0.1);
        expect(Math.abs(projectedAnchor[1] - position[1])).toBeLessThan(0.1);
        expect(getAnchor).toHaveBeenCalledTimes(1);
        expect(onAnchorChange).toHaveBeenNthCalledWith(1, anchor, true);
        expect(onAnchorChange).toHaveBeenNthCalledWith(2, anchor, false);
        controller.finalize();
    });

    it("retains the physical orbit radius during a pure pointer rotation", () => {
        const position: [number, number] = [360, 290];
        const anchor = makeAnchor(position, 80);
        const controller = makeController(() => anchor, vi.fn());

        let state = controller.controllerState.rotateStart({pos: position});
        const initialViewport = makeViewport(state.getViewportProps());
        const initialDistance = navigationAnchorDistanceMeters(initialViewport, anchor);
        state = state.rotate({deltaAngleX: 17, deltaAngleY: -9});
        const rotatedViewport = makeViewport(state.getViewportProps());
        const rotatedDistance = navigationAnchorDistanceMeters(rotatedViewport, anchor);
        const projectedAnchor = rotatedViewport.project(anchor);
        state.rotateEnd();

        expect(rotatedDistance).toBeCloseTo(initialDistance, 5);
        expect(projectedAnchor[0]).toBeCloseTo(position[0], 2);
        expect(projectedAnchor[1]).toBeCloseTo(position[1], 2);
        controller.finalize();
    });

    it("keeps a snapped feature at its own pixel instead of pulling it under the pointer", () => {
        const pointer: [number, number] = [360, 290];
        const anchorPixel: [number, number] = [368, 286];
        const anchor = makeAnchor(anchorPixel, 80);
        const controller = makeController(() => anchor, vi.fn());

        let state = controller.controllerState.rotateStart({pos: pointer});
        state = state.rotate({deltaAngleX: 17, deltaAngleY: -9});
        const projected = makeViewport(state.getViewportProps()).project(anchor);
        state.rotateEnd();

        expect(Math.abs(projected[0] - anchorPixel[0])).toBeLessThan(0.1);
        expect(Math.abs(projected[1] - anchorPixel[1])).toBeLessThan(0.1);
        controller.finalize();
    });

    it("keeps a snapped feature at its own pixel during wheel zoom", () => {
        vi.useFakeTimers();
        const pointer: [number, number] = [360, 290];
        const anchorPixel: [number, number] = [368, 286];
        const anchor = makeAnchor(anchorPixel, 80);
        const controller = makeController(() => anchor, vi.fn());

        try {
            const state = controller.controllerState.zoom({pos: pointer, scale: 1.4});
            const projected = makeViewport(state.getViewportProps()).project(anchor);

            expect(Math.abs(projected[0] - anchorPixel[0])).toBeLessThan(0.1);
            expect(Math.abs(projected[1] - anchorPixel[1])).toBeLessThan(0.1);
        } finally {
            controller.finalize();
            vi.useRealTimers();
        }
    });

    it("anchors one discrete zoom burst to a retained pointer anchor", () => {
        vi.useFakeTimers();
        const position: [number, number] = [520, 330];
        const anchor = makeAnchor(position, 200);
        const getAnchor = vi.fn(() => anchor);
        const onAnchorChange = vi.fn();
        const controller = makeController(getAnchor, onAnchorChange);

        try {
            let state = controller.controllerState.zoom({
                pos: position,
                scale: 0.8
            });
            state = state.zoom({
                pos: position,
                scale: 0.6
            });
            const viewport = makeViewport(state.getViewportProps());
            const projectedAnchor = viewport.project(anchor);

            expect(Math.abs(projectedAnchor[0] - position[0])).toBeLessThan(0.1);
            expect(Math.abs(projectedAnchor[1] - position[1])).toBeLessThan(0.1);
            expect(getAnchor).toHaveBeenCalledOnce();
            expect(onAnchorChange).toHaveBeenCalledOnce();
            expect(onAnchorChange).toHaveBeenCalledWith(anchor, true);

            vi.advanceTimersByTime(150);
            expect(onAnchorChange).toHaveBeenNthCalledWith(2, anchor, false);
        } finally {
            controller.finalize();
            vi.useRealTimers();
        }
    });

    it("releases a pending discrete anchor exactly once when finalized", () => {
        vi.useFakeTimers();
        const position: [number, number] = [520, 330];
        const anchor = makeAnchor(position, 200);
        const onAnchorChange = vi.fn();
        const controller = makeController(() => anchor, onAnchorChange);

        try {
            controller.controllerState.zoom({pos: position, scale: 0.8});
            controller.finalize();
            vi.advanceTimersByTime(300);

            expect(onAnchorChange).toHaveBeenNthCalledWith(1, anchor, true);
            expect(onAnchorChange).toHaveBeenNthCalledWith(2, anchor, false);
            expect(onAnchorChange).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("reuses the same wheel target after close clipping prevents a fresh pick", () => {
        vi.useFakeTimers();
        const position: [number, number] = [520, 330];
        const anchor = makeAnchor(position, 200);
        const getAnchor = vi.fn<NavigationAnchorProvider>()
            .mockReturnValueOnce(anchor)
            .mockReturnValue(null);
        const controller = makeController(getAnchor, vi.fn());

        try {
            let state = controller.controllerState.zoom({pos: position, scale: 1.2});
            vi.advanceTimersByTime(150);
            state = state.zoom({pos: position, scale: 1.4});
            const projected = makeViewport(state.getViewportProps()).project(anchor);

            expect(getAnchor).toHaveBeenCalledOnce();
            expect(Math.abs(projected[0] - position[0])).toBeLessThan(0.1);
            expect(Math.abs(projected[1] - position[1])).toBeLessThan(0.1);
        } finally {
            controller.finalize();
            vi.useRealTimers();
        }
    });

    it("releases an unfinished continuous gesture when finalized", () => {
        const position: [number, number] = [360, 290];
        const anchor = makeAnchor(position, 80);
        const onAnchorChange = vi.fn();
        const controller = makeController(() => anchor, onAnchorChange);

        controller.controllerState.panStart({pos: position});
        controller.finalize();

        expect(onAnchorChange).toHaveBeenNthCalledWith(1, anchor, true);
        expect(onAnchorChange).toHaveBeenNthCalledWith(2, anchor, false);
        expect(onAnchorChange).toHaveBeenCalledTimes(2);
    });

    it("uses the retained anchor for pointerless zoom, tilt, and movement", () => {
        const initialPixel: [number, number] = [340, 280];
        const anchor = makeAnchor(initialPixel, 150);
        const onAnchorChange = vi.fn();
        const controller = makeController(() => null, onAnchorChange, () => anchor);

        let state = controller.controllerState.zoomIn(1.5);
        let viewport = makeViewport(state.getViewportProps());
        let projectedAnchor = viewport.project(anchor);
        const distanceBeforeTilt = navigationAnchorDistanceMeters(viewport, anchor);
        expect(Math.abs(projectedAnchor[0] - initialPixel[0])).toBeLessThan(0.1);
        expect(Math.abs(projectedAnchor[1] - initialPixel[1])).toBeLessThan(1);

        state = state.rotateUp(8);
        viewport = makeViewport(state.getViewportProps());
        projectedAnchor = viewport.project(anchor);
        expect(navigationAnchorDistanceMeters(viewport, anchor)).toBeCloseTo(distanceBeforeTilt, 5);
        expect(Math.abs(projectedAnchor[0] - initialPixel[0])).toBeLessThan(0.1);
        expect(Math.abs(projectedAnchor[1] - initialPixel[1])).toBeLessThan(1);

        state = state.moveLeft(80);
        viewport = makeViewport(state.getViewportProps());
        projectedAnchor = viewport.project(anchor);
        expect(Math.abs(projectedAnchor[0] - (initialPixel[0] + 80))).toBeLessThan(1);
        expect(Math.abs(projectedAnchor[1] - initialPixel[1])).toBeLessThan(1);
        expect(onAnchorChange).toHaveBeenCalledWith(anchor, false);
        controller.finalize();
    });
});
