import type {MapInteractionTargetViewStateContext} from "@deck.gl/core";
import {describe, expect, it} from "vitest";
import {
    constrainErdblickTargetNavigationViewState,
    createDeckMapViewport,
    DECK_MAP_DEFAULT_ALTITUDE,
    DECK_MAP_FAR_Z_MULTIPLIER,
    DECK_MAP_FOV_DEGREES,
    DECK_MAP_NEAR_Z_MULTIPLIER,
    isNavigationAnchorUsable,
    longitudeInNearestWorld,
    NAVIGATION_TARGET_NEAR_RELATIVE_EPSILON,
    type DeckMapCameraState,
    viewStateKeepingAnchor,
    viewStateKeepingSafeNavigationAnchor,
    viewStateWithGroundCenter
} from "./web-mercator-feature-navigation";
import type {NavigationAnchor} from "./feature-navigation.types";

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

const BASE_CAMERA: DeckMapCameraState = {
    longitude: 11.1277,
    latitude: 47.996,
    zoom: 16,
    pitch: 45,
    bearing: 20
};

describe("Web Mercator feature navigation", () => {
    it("constructs every viewport with the shared projection contract", () => {
        const viewport = createDeckMapViewport(
            BASE_CAMERA,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );

        expect(DECK_MAP_DEFAULT_ALTITUDE).toBe(1.5);
        expect(DECK_MAP_FOV_DEGREES).toBeCloseTo(36.86989764584402, 12);
        expect(DECK_MAP_NEAR_Z_MULTIPLIER).toBe(0.0005);
        expect(DECK_MAP_FAR_Z_MULTIPLIER).toBe(1.01);
        expect(viewport.fovy).toBe(DECK_MAP_FOV_DEGREES);
        expect(viewport.altitude).toBeCloseTo(DECK_MAP_DEFAULT_ALTITUDE, 12);
    });

    it("turns a high target plane into the equivalent coarse ground zoom", () => {
        const elevatedState: DeckMapCameraState = {
            longitude: 13.64432155,
            latitude: 47.72654096,
            zoom: 14.85,
            pitch: 0,
            bearing: 0,
            position: [0, 0, 2384835.59976474]
        };
        const groundState = viewStateWithGroundCenter(
            elevatedState,
            1600,
            1000,
            false
        );
        const elevatedViewport = createDeckMapViewport(elevatedState, 1600, 1000, false);
        const groundViewport = createDeckMapViewport(groundState, 1600, 1000, false);

        expect(groundState.position).toEqual([0, 0, 0]);
        expect(groundState.zoom).toBeCloseTo(5.0462220736, 8);
        for (const point of [
            [10, 47, 0],
            [13.6, 47.7, 0],
            [15, 49, 1000]
        ]) {
            const before = elevatedViewport.project(point);
            const after = groundViewport.project(point);
            expect(after[0]).toBeCloseTo(before[0], 5);
            expect(after[1]).toBeCloseTo(before[1], 5);
        }
    });

    it("preserves a pitched projection while removing all center-offset components", () => {
        const elevatedState: DeckMapCameraState = {
            ...BASE_CAMERA,
            zoom: 17,
            pitch: 40,
            bearing: 35,
            position: [100, -200, 500]
        };
        const groundState = viewStateWithGroundCenter(
            elevatedState,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const elevatedViewport = createDeckMapViewport(
            elevatedState,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const groundViewport = createDeckMapViewport(
            groundState,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );

        expect(groundState.position).toEqual([0, 0, 0]);
        for (const point of [
            [10.8, 47.9, 0],
            [11.1, 48.0, 500],
            [11.3, 48.2, 1500]
        ]) {
            const before = elevatedViewport.project(point);
            const after = groundViewport.project(point);
            expect(after[0]).toBeCloseTo(before[0], 4);
            expect(after[1]).toBeCloseTo(before[1], 4);
        }
    });

    it("retains an elevated anchor through combined zoom, tilt, and rotation", () => {
        const anchor: NavigationAnchor = [11.1282, 47.9963, 45];
        const before = createDeckMapViewport(
            BASE_CAMERA,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const projectedAnchor = before.project(anchor);
        const pixel: [number, number] = [projectedAnchor[0], projectedAnchor[1]];
        const nextState = viewStateKeepingAnchor(
            {
                ...BASE_CAMERA,
                zoom: 17.3,
                pitch: 70,
                bearing: 120,
                maxPitch: 85
            },
            anchor,
            pixel,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const after = createDeckMapViewport(
            nextState,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const reprojectedAnchor = after.project(anchor);

        expect(reprojectedAnchor[0]).toBeCloseTo(pixel[0], 2);
        expect(reprojectedAnchor[1]).toBeCloseTo(pixel[1], 2);
        expect(nextState.maxPitch).toBe(85);
    });

    it("retains an elevated anchor across the antimeridian world copy", () => {
        const camera = {...BASE_CAMERA, longitude: 179.9, latitude: 0, bearing: 0};
        const physicalAnchor: NavigationAnchor = [-179.95, 0.0003, 45];
        const before = createDeckMapViewport(
            camera,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const beforeAnchor: NavigationAnchor = [
            longitudeInNearestWorld(physicalAnchor[0], camera.longitude),
            physicalAnchor[1],
            physicalAnchor[2]
        ];
        const projectedAnchor = before.project(beforeAnchor);
        const pixel: [number, number] = [projectedAnchor[0], projectedAnchor[1]];
        const nextState = viewStateKeepingAnchor(
            {...camera, zoom: 17, pitch: 65, bearing: 80},
            physicalAnchor,
            pixel,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const normalizedState = {
            ...nextState,
            longitude: ((nextState.longitude + 180) % 360 + 360) % 360 - 180
        };
        const after = createDeckMapViewport(
            normalizedState,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const afterAnchor: NavigationAnchor = [
            longitudeInNearestWorld(physicalAnchor[0], normalizedState.longitude),
            physicalAnchor[1],
            physicalAnchor[2]
        ];
        const reprojectedAnchor = after.project(afterAnchor);

        expect(reprojectedAnchor[0]).toBeCloseTo(pixel[0], 2);
        expect(reprojectedAnchor[1]).toBeCloseTo(pixel[1], 2);
    });

    it("stops an anchored zoom at the last safe state before crossing an elevated anchor", () => {
        const currentState = {...BASE_CAMERA, zoom: 14, pitch: 55};
        const before = createDeckMapViewport(
            currentState,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const pixel: [number, number] = [480, 310];
        const anchor = before.unproject(pixel, {targetZ: 500}) as NavigationAnchor;

        const requestedState = viewStateKeepingSafeNavigationAnchor(
            currentState,
            {...currentState, zoom: 100},
            anchor,
            pixel,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const after = createDeckMapViewport(
            requestedState,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const projected = after.project(anchor);

        expect(requestedState.zoom).toBeGreaterThan(currentState.zoom);
        expect(requestedState.zoom).toBeLessThan(100);
        expect(isNavigationAnchorUsable(after, anchor)).toBe(true);
        const targetInfo = after.getTargetInfo(anchor)!;
        expect(targetInfo.cameraDepth).toBeGreaterThanOrEqual(
            targetInfo.near * (1 + NAVIGATION_TARGET_NEAR_RELATIVE_EPSILON)
        );
        expect(Math.abs(projected[0] - pixel[0])).toBeLessThan(1);
        expect(Math.abs(projected[1] - pixel[1])).toBeLessThan(1);
    });

    it("applies the same maximal-safe zoom policy through deck.gl's controller hook", () => {
        const currentState = {...BASE_CAMERA, zoom: 14, pitch: 55, position: [0, 0, 0] as [number, number, number]};
        const sourceViewport = createDeckMapViewport(
            currentState,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const requestedPixel: [number, number] = [480, 310];
        const target = sourceViewport.unproject(
            requestedPixel,
            {targetZ: 500}
        ) as NavigationAnchor;
        const info = sourceViewport.getTargetInfo(target)!;
        const pixel: [number, number] = [
            info.projectedPosition[0],
            info.projectedPosition[1]
        ];
        const requestedViewState = sourceViewport.getTargetViewState({
            target,
            screenPosition: pixel,
            zoom: 44
        })!;
        const context: MapInteractionTargetViewStateContext = {
            viewId: "deck-view-0",
            operation: "zoom",
            source: "wheel",
            target: {coordinate: target, screenPosition: pixel},
            sourceViewport,
            currentViewState: currentState,
            requestedViewState
        };

        const constrained = constrainErdblickTargetNavigationViewState(context)!;
        const viewport = createDeckMapViewport(
            constrained,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const constrainedInfo = viewport.getTargetInfo(target)!;

        expect(constrained.zoom).toBeGreaterThan(currentState.zoom);
        expect(constrained.zoom).toBeLessThan(requestedViewState.zoom);
        expect(isNavigationAnchorUsable(viewport, target)).toBe(true);
        expect(Math.hypot(
            constrainedInfo.projectedPosition[0] - pixel[0],
            constrainedInfo.projectedPosition[1] - pixel[1]
        )).toBeLessThanOrEqual(0.1);
    });

    it("does not reject a visible feature based on an arbitrary clip-depth fraction", () => {
        const currentState = {
            longitude: 11.625965550000046,
            latitude: 48.23150152,
            zoom: 15.206566216823559,
            pitch: 68.44308175262151,
            bearing: 350.39624489258654
        };
        const viewport = createDeckMapViewport(
            currentState,
            1280,
            720,
            false
        );
        const anchor = viewport.unproject([900, 500, 0.2]) as NavigationAnchor;
        const projected = viewport.project(anchor);
        const pixel: [number, number] = [projected[0], projected[1]];
        const next = viewStateKeepingSafeNavigationAnchor(
            currentState,
            {...currentState, zoom: currentState.zoom + 0.2},
            anchor,
            pixel,
            1280,
            720,
            false
        );

        expect(projected[2]).toBeCloseTo(0.2, 6);
        expect(isNavigationAnchorUsable(viewport, anchor)).toBe(true);
        expect(next.zoom).toBeGreaterThan(currentState.zoom);
    });

    it("accepts valid targets in the negative half of normalized device depth", () => {
        const viewport = createDeckMapViewport(
            BASE_CAMERA,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const anchor = viewport.unproject([640, 360, -0.5]) as NavigationAnchor;
        const info = viewport.getTargetInfo(anchor)!;

        expect(info.projectedPosition[2]).toBeCloseTo(-0.5, 6);
        expect(info.isValid).toBe(true);
        expect(isNavigationAnchorUsable(viewport, anchor, true)).toBe(true);
    });

    it("always allows feature-anchored zoom-out recovery", () => {
        const currentState = {...BASE_CAMERA, zoom: 15, pitch: 55};
        const before = createDeckMapViewport(
            currentState,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const pixel: [number, number] = [480, 310];
        const anchor = before.unproject(pixel, {targetZ: 500}) as NavigationAnchor;

        const zoomedOut = viewStateKeepingSafeNavigationAnchor(
            currentState,
            {...currentState, zoom: 13},
            anchor,
            pixel,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const after = createDeckMapViewport(
            zoomedOut,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );

        expect(zoomedOut.zoom).toBe(13);
        expect(Math.abs(after.project(anchor)[0] - pixel[0])).toBeLessThan(1);
        expect(Math.abs(after.project(anchor)[1] - pixel[1])).toBeLessThan(1);
    });
});
