import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {addMetersToLngLat} from "@math.gl/web-mercator";

import type {NavigationAnchor} from "./navigation/feature-navigation.types";
import {createDeckMapViewport} from "./navigation/web-mercator-feature-navigation";
import {projectNavigationTarget} from "./deck-navigation-target";
import {DeckMapView3D} from "./deck-view3d";

interface DeckViewTestInternals {
    deck: {
        getCanvas: () => {style: CSSStyleDeclaration; getBoundingClientRect: () => DOMRect};
        redraw: (reason?: string) => void;
        setProps: (props: unknown) => void;
    } | null;
    deckDevice: {
        getDefaultCanvasContext: () => {
            setDrawingBufferSize: (width: number, height: number) => void;
        };
    } | null;
    viewState: {
        longitude: number;
        latitude: number;
        zoom: number;
        pitch: number;
        bearing: number;
        maxPitch: number;
    };
    lastCanvasCssSize?: {width: number; height: number};
    clippedLayoutCanvasCssSize?: {width: number; height: number};
}

interface MarkerTestInternals extends DeckViewTestInternals {
    stateService: {
        markerState: {getValue: () => boolean};
        markedPositionState: {getValue: () => number[]};
    };
    featureSearchService: {markerGraphics: () => string};
    layerRegistry: {upsert: (...args: unknown[]) => void};
    updateLocationMarkerOverlay(): void;
}

interface CameraPersistenceTestInternals {
    viewState: {
        longitude: number;
        latitude: number;
        zoom: number;
        pitch: number;
        bearing: number;
        maxPitch: number;
        position: [number, number, number];
    };
    stateService: {
        setView: (...args: unknown[]) => void;
    };
    pushViewStateToAppState(): void;
}

interface GestureTargetTestInternals {
    pickNavigationTarget: ReturnType<typeof vi.fn>;
    resolveControllerNavigationTarget(screenPosition: [number, number]): NavigationAnchor | null;
}

/** Creates a 3D deck view with service collaborators outside the focused unit scope. */
function createView(): DeckMapView3D {
    return new DeckMapView3D(
        0,
        "canvas",
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    );
}

/** Installs the minimal deck canvas contract needed by layout-resize tests. */
function installDeckMock(
    view: DeckMapView3D,
    width: number,
    height: number
): {
    setProps: ReturnType<typeof vi.fn>;
    redraw: ReturnType<typeof vi.fn>;
    setDrawingBufferSize: ReturnType<typeof vi.fn>;
} {
    const setProps = vi.fn();
    const redraw = vi.fn();
    const setDrawingBufferSize = vi.fn();
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
    const internals = view as unknown as DeckViewTestInternals;
    internals.deck = {
        getCanvas: () => canvas,
        setProps,
        redraw
    };
    internals.deckDevice = {
        getDefaultCanvasContext: () => ({setDrawingBufferSize})
    };
    return {setProps, redraw, setDrawingBufferSize};
}

describe("Deck navigation target and layout", () => {
    it("does not issue a synchronous GPU pick when a gesture starts without a hover target", () => {
        const view = createView();
        const internals = view as unknown as GestureTargetTestInternals;
        internals.pickNavigationTarget = vi.fn();

        expect(internals.resolveControllerNavigationTarget([500, 350])).toBeNull();
        expect(internals.pickNavigationTarget).not.toHaveBeenCalled();
    });

    it("projects a vertical surface target with a fixed eight-pixel major radius", () => {
        const state = {
            longitude: 11,
            latitude: 48,
            zoom: 17,
            pitch: 60,
            bearing: 35,
            maxPitch: 85
        };
        const center: NavigationAnchor = [11, 48, 120];
        const viewport = createDeckMapViewport(state, 1000, 700, false);
        const projection = projectNavigationTarget({
            position: center,
            surfaceNormal: [1, 0, 0]
        }, viewport);

        expect(projection).not.toBeNull();
        const radii = projection?.ring.map(position => Math.hypot(
            position[0] - projection.center[0],
            position[1] - projection.center[1]
        )) ?? [];
        expect(Math.max(...radii)).toBeCloseTo(8, 2);

        const north = viewport.project(addMetersToLngLat(center, [0, 1, 0]));
        const expectedDirection = [
            north[0] - (projection?.center[0] ?? 0),
            north[1] - (projection?.center[1] ?? 0)
        ];
        const firstDirection = [
            (projection?.ring[0][0] ?? 0) - (projection?.center[0] ?? 0),
            (projection?.ring[0][1] ?? 0) - (projection?.center[1] ?? 0)
        ];
        expect(firstDirection[0] * expectedDirection[1]
            - firstDirection[1] * expectedDirection[0]).toBeCloseTo(0, 6);
    });

    it("uses a fixed eight-pixel circle when no surface orientation exists", () => {
        const viewport = createDeckMapViewport({
            longitude: 11,
            latitude: 48,
            zoom: 17,
            pitch: 75,
            bearing: 35
        }, 1000, 700, false);
        const projection = projectNavigationTarget({position: [11, 48, 120]}, viewport);
        const radii = projection?.ring.map(position => Math.hypot(
            position[0] - projection.center[0],
            position[1] - projection.center[1]
        )) ?? [];

        expect(radii).toHaveLength(40);
        for (const radius of radii) {
            expect(radius).toBeCloseTo(8, 8);
        }
    });

    it("renders valid targets in the negative half of normalized device depth", () => {
        const viewport = createDeckMapViewport({
            longitude: 11,
            latitude: 48,
            zoom: 17,
            pitch: 60,
            bearing: 35
        }, 1000, 700, false);
        const position = viewport.unproject([500, 350, -0.5]) as NavigationAnchor;
        const projection = projectNavigationTarget({position}, viewport);

        expect(viewport.getTargetInfo(position)?.isValid).toBe(true);
        expect(projection?.center[0]).toBeCloseTo(500, 3);
        expect(projection?.center[1]).toBeCloseTo(350, 3);
    });

    it("keeps the location marker camera-facing and fixed in CSS pixels", () => {
        const view = createView();
        const internals = view as unknown as MarkerTestInternals;
        installDeckMock(view, 1000, 700);
        internals.stateService.markerState = {getValue: () => true};
        internals.stateService.markedPositionState = {getValue: () => [11, 48, 120]};
        internals.featureSearchService.markerGraphics = () => "marker.svg";
        const upsert = vi.spyOn(internals.layerRegistry, "upsert");

        internals.updateLocationMarkerOverlay();

        const layer = upsert.mock.calls[0][1] as {
            props: {
                billboard: boolean;
                sizeUnits: string;
                getSize: (datum: unknown) => number;
                data: unknown[];
            };
        };
        expect(layer.props.billboard).toBe(true);
        expect(layer.props.sizeUnits).toBe("pixels");
        expect(layer.props.getSize(layer.props.data[0])).toBe(32);
    });

    it("round-trips deck.gl's target-relative map-centre offset through app state", () => {
        const view = createView();
        const internals = view as unknown as CameraPersistenceTestInternals;
        const setView = vi.fn();
        internals.stateService.setView = setView;
        const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame")
            .mockReturnValue(17);

        try {
            view.setViewFromState({
                destination: {lon: 11, lat: 48, alt: 1250},
                orientation: {heading: 0.25, pitch: -0.5, roll: 0},
                position: [1.5, -2.5, 325.25]
            });
            expect(internals.viewState.position).toEqual([1.5, -2.5, 325.25]);

            internals.pushViewStateToAppState();

            expect(setView).toHaveBeenCalledOnce();
            expect(setView.mock.calls[0][3]).toEqual([1.5, -2.5, 325.25]);
        } finally {
            requestAnimationFrame.mockRestore();
        }
    });

    it("synchronizes the public Deck size and drawing buffer in one resize transaction", () => {
        const view = createView();
        const internals = view as unknown as DeckViewTestInternals;
        const initialState = {...internals.viewState};
        const deck = installDeckMock(view, 640, 700);
        const resizeCallbacks: FrameRequestCallback[] = [];
        const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame")
            .mockImplementation(callback => {
                resizeCallbacks.push(callback);
                return 17;
            });

        try {
            view.prepareForLayoutResize({width: 640, height: 700});

            expect(deck.setProps).toHaveBeenNthCalledWith(1, {
                width: 640,
                height: 700,
                style: expect.objectContaining({width: "640px", height: "700px"})
            });
            expect(internals.viewState).toEqual(initialState);
            expect(deck.setDrawingBufferSize).toHaveBeenCalledWith(640, 700);

            resizeCallbacks[0]?.(0);
            expect(deck.setProps).toHaveBeenNthCalledWith(2, {
                width: "100%",
                height: "100%",
                style: expect.any(Object)
            });
        } finally {
            requestAnimationFrame.mockRestore();
        }
    });

    it("clips the existing projection without moving the camera when the inspection dock opens", () => {
        const view = createView();
        const internals = view as unknown as DeckViewTestInternals;
        internals.viewState = {
            longitude: 11,
            latitude: 48,
            zoom: 17,
            pitch: 60,
            bearing: 35,
            maxPitch: 85
        };
        const initialState = {...internals.viewState};
        internals.lastCanvasCssSize = {width: 1000, height: 700};
        const deck = installDeckMock(view, 1000, 700);
        const resizeCallbacks: FrameRequestCallback[] = [];
        const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame")
            .mockImplementation(callback => {
                resizeCallbacks.push(callback);
                return 17;
            });

        try {
            view.prepareForLayoutResize({width: 640, height: 700});

            expect(internals.viewState).toEqual(initialState);
            expect(internals.clippedLayoutCanvasCssSize).toEqual({width: 1000, height: 700});
            expect(deck.setProps).toHaveBeenNthCalledWith(1, {
                width: 1000,
                height: 700,
                style: expect.objectContaining({width: "1000px", height: "700px"})
            });
            expect(deck.setDrawingBufferSize).toHaveBeenNthCalledWith(1, 1000, 700);
            expect(resizeCallbacks).toHaveLength(0);

            view.prepareForLayoutResize({width: 1000, height: 700});
            expect(internals.viewState).toEqual(initialState);
            expect(internals.clippedLayoutCanvasCssSize).toBeUndefined();
            expect(deck.setProps).toHaveBeenNthCalledWith(2, {
                width: 1000,
                height: 700,
                style: expect.objectContaining({width: "1000px", height: "700px"})
            });
            expect(resizeCallbacks).toHaveLength(1);
            resizeCallbacks[0]?.(0);
            expect(deck.setProps).toHaveBeenNthCalledWith(3, {
                width: "100%",
                height: "100%",
                style: expect.any(Object)
            });
        } finally {
            requestAnimationFrame.mockRestore();
        }
    });
});
