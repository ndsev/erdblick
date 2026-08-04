import {describe, expect, it} from "vitest";
import {
    createDeckMapViewport,
    DECK_MAP_DEFAULT_ALTITUDE,
    DECK_MAP_FAR_Z_MULTIPLIER,
    DECK_MAP_FOV_DEGREES,
    DECK_MAP_NEAR_Z_MULTIPLIER,
    isNavigationAnchorUsable,
    longitudeInNearestWorld,
    MIN_NAVIGATION_ANCHOR_DISTANCE_METERS,
    navigationAnchorDistanceMeters,
    type DeckMapCameraState,
    viewStateKeepingAnchor,
    viewStateKeepingSafeNavigationAnchor,
    viewStateOrbitingNavigationAnchor
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

    it("keeps the OrbitView target distance while changing map bearing and pitch", () => {
        const pixel: [number, number] = [420, 300];
        const before = createDeckMapViewport(
            BASE_CAMERA,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const anchor = before.unproject(pixel, {targetZ: 120}) as NavigationAnchor;
        const initialDistance = navigationAnchorDistanceMeters(before, anchor);

        const nextState = viewStateOrbitingNavigationAnchor(
            BASE_CAMERA,
            {...BASE_CAMERA, pitch: 72, bearing: 115},
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
        const projected = after.project(anchor);

        expect(navigationAnchorDistanceMeters(after, anchor)).toBeCloseTo(initialDistance, 5);
        expect(Math.abs(projected[0] - pixel[0])).toBeLessThan(0.1);
        expect(Math.abs(projected[1] - pixel[1])).toBeLessThan(0.1);
    });

    it("keeps a close off-centre feature fixed through a high-pitch orbit", () => {
        const currentState = {
            longitude: 11.625965550000046,
            latitude: 48.23150152,
            zoom: 15.206566216823559,
            pitch: 68.44308175262151,
            bearing: 350.39624489258654
        };
        const anchor: NavigationAnchor = [
            11.629150001605632,
            48.219418961344246,
            536.3788352571614
        ];
        const pixel: [number, number] = [1054.6673221401506, 476.85862027499496];
        const before = createDeckMapViewport(currentState, 1280, 720, false);
        const next = viewStateOrbitingNavigationAnchor(
            currentState,
            {
                ...currentState,
                pitch: 70.80835578796129,
                bearing: 4.458744892586537
            },
            anchor,
            pixel,
            1280,
            720,
            false
        );
        const after = createDeckMapViewport(next, 1280, 720, false);
        const projected = after.project(anchor);

        expect(Math.abs(
            navigationAnchorDistanceMeters(after, anchor)
            - navigationAnchorDistanceMeters(before, anchor)
        )).toBeLessThan(0.01);
        expect(projected[0]).toBeCloseTo(pixel[0], 4);
        expect(projected[1]).toBeCloseTo(pixel[1], 4);
        expect(projected[2]).toBeGreaterThan(0);
        expect(projected[2]).toBeLessThan(1);
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
            {...currentState, zoom: 16},
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
        expect(requestedState.zoom).toBeLessThan(16);
        expect(isNavigationAnchorUsable(after, anchor)).toBe(true);
        expect(navigationAnchorDistanceMeters(after, anchor))
            .toBeGreaterThanOrEqual(MIN_NAVIGATION_ANCHOR_DISTANCE_METERS);
        expect(Math.abs(projected[0] - pixel[0])).toBeLessThan(1);
        // panByPosition3D loses a few CSS pixels of vertical precision only at
        // the final close-clip boundary of the default deck.gl perspective lens.
        expect(Math.abs(projected[1] - pixel[1])).toBeLessThan(4);
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
