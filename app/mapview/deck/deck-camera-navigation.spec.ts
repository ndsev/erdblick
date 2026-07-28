import {describe, expect, it} from "vitest";
import {
    clippedGeographicBounds,
    createDeckMapViewport,
    DECK_MAP_FAR_Z_MULTIPLIER,
    DECK_MAP_FOV_DEGREES,
    DECK_MAP_NEAR_Z_MULTIPLIER,
    featurePivotDistanceMeters,
    isFeaturePivotUsable,
    longitudeInNearestWorld,
    MIN_FEATURE_PIVOT_DISTANCE_METERS,
    type DeckMapCameraState,
    viewStateKeepingAnchor,
    viewStateKeepingSafeFeatureAnchor
} from "./deck-camera-navigation";

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

const BASE_CAMERA: DeckMapCameraState = {
    longitude: 11.1277,
    latitude: 47.996,
    zoom: 16,
    pitch: 45,
    bearing: 20
};

describe("deck camera navigation", () => {
    it("constructs every viewport with the shared projection contract", () => {
        const viewport = createDeckMapViewport(
            BASE_CAMERA,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );

        expect(DECK_MAP_FOV_DEGREES).toBe(60);
        expect(DECK_MAP_NEAR_Z_MULTIPLIER).toBe(0.01);
        expect(DECK_MAP_FAR_Z_MULTIPLIER).toBe(1.01);
        expect(viewport.fovy).toBe(DECK_MAP_FOV_DEGREES);
        expect(viewport.altitude).toBeCloseTo(Math.sqrt(3) / 2, 12);
    });

    it("keeps horizon-crossing ground bounds finite and continuous", () => {
        const widths = [59.9, 60, 60.1].map(pitch => {
            const viewport = createDeckMapViewport(
                {...BASE_CAMERA, pitch},
                VIEWPORT_WIDTH,
                VIEWPORT_HEIGHT,
                false
            );
            const bounds = clippedGeographicBounds(viewport, BASE_CAMERA.longitude, 0.05);

            expect(Object.values(bounds).every(Number.isFinite)).toBe(true);
            expect(bounds.width).toBeLessThan(0.2);
            expect(bounds.height).toBeLessThan(0.1);
            return bounds.width;
        });

        expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.001);
    });

    it("unwraps clipped bounds around the current repeated-world center", () => {
        const centerLon = 540;
        const viewport = createDeckMapViewport(
            {...BASE_CAMERA, longitude: centerLon, latitude: 0, zoom: 8, pitch: 70},
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const bounds = clippedGeographicBounds(viewport, centerLon, 0);
        const normalizedViewport = createDeckMapViewport(
            {...BASE_CAMERA, longitude: centerLon - 360, latitude: 0, zoom: 8, pitch: 70},
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const normalizedBounds = clippedGeographicBounds(normalizedViewport, centerLon - 360, 0);

        expect(bounds.west).toBeGreaterThan(centerLon - 180);
        expect(bounds.west + bounds.width).toBeLessThan(centerLon + 180);
        expect(bounds.west - normalizedBounds.west).toBeCloseTo(360, 8);
        expect(bounds.width).toBeCloseTo(normalizedBounds.width, 8);
    });

    it("returns a canonical full-world footprint at low zoom", () => {
        const centerLon = 25;
        const viewport = createDeckMapViewport(
            {...BASE_CAMERA, longitude: centerLon, latitude: 0, zoom: 1, pitch: 0},
            1920,
            1080,
            false
        );
        const bounds = clippedGeographicBounds(viewport, centerLon, 0.05);

        expect(bounds).toEqual({
            west: -155,
            south: -85.05112878,
            width: 360,
            height: 170.10225756
        });
    });

    it("retains an elevated pivot through combined zoom, tilt, and rotation", () => {
        const pivot: [number, number, number] = [11.1282, 47.9963, 45];
        const before = createDeckMapViewport(
            BASE_CAMERA,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const projectedPivot = before.project(pivot);
        const pixel: [number, number] = [projectedPivot[0], projectedPivot[1]];
        const nextState = viewStateKeepingAnchor(
            {
                ...BASE_CAMERA,
                zoom: 17.3,
                pitch: 70,
                bearing: 120,
                maxPitch: 85
            },
            pivot,
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
        const reprojectedPivot = after.project(pivot);

        expect(reprojectedPivot[0]).toBeCloseTo(pixel[0], 2);
        expect(reprojectedPivot[1]).toBeCloseTo(pixel[1], 2);
        expect(nextState.maxPitch).toBe(85);
    });

    it("retains an elevated pivot across the antimeridian world copy", () => {
        const camera = {...BASE_CAMERA, longitude: 179.9, latitude: 0, bearing: 0};
        const physicalPivot: [number, number, number] = [-179.95, 0.0003, 45];
        const before = createDeckMapViewport(
            camera,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const beforePivot: [number, number, number] = [
            longitudeInNearestWorld(physicalPivot[0], camera.longitude),
            physicalPivot[1],
            physicalPivot[2]
        ];
        const projectedPivot = before.project(beforePivot);
        const pixel: [number, number] = [projectedPivot[0], projectedPivot[1]];
        const nextState = viewStateKeepingAnchor(
            {...camera, zoom: 17, pitch: 65, bearing: 80},
            physicalPivot,
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
        const afterPivot: [number, number, number] = [
            longitudeInNearestWorld(physicalPivot[0], normalizedState.longitude),
            physicalPivot[1],
            physicalPivot[2]
        ];
        const reprojectedPivot = after.project(afterPivot);

        expect(reprojectedPivot[0]).toBeCloseTo(pixel[0], 2);
        expect(reprojectedPivot[1]).toBeCloseTo(pixel[1], 2);
    });

    it("stops an anchored zoom at the last safe state before crossing an elevated pivot", () => {
        const currentState = {...BASE_CAMERA, zoom: 14, pitch: 55};
        const before = createDeckMapViewport(
            currentState,
            VIEWPORT_WIDTH,
            VIEWPORT_HEIGHT,
            false
        );
        const pixel: [number, number] = [480, 310];
        const pivot = before.unproject(pixel, {targetZ: 500}) as [number, number, number];

        const requestedState = viewStateKeepingSafeFeatureAnchor(
            currentState,
            {...currentState, zoom: 16},
            pivot,
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
        const projected = after.project(pivot);

        expect(requestedState.zoom).toBeGreaterThan(currentState.zoom);
        expect(requestedState.zoom).toBeLessThan(16);
        expect(isFeaturePivotUsable(after, pivot)).toBe(true);
        expect(featurePivotDistanceMeters(after, pivot))
            .toBeGreaterThanOrEqual(MIN_FEATURE_PIVOT_DISTANCE_METERS);
        expect(Math.abs(projected[0] - pixel[0])).toBeLessThan(1);
        expect(Math.abs(projected[1] - pixel[1])).toBeLessThan(1);
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
        const pivot = before.unproject(pixel, {targetZ: 500}) as [number, number, number];

        const zoomedOut = viewStateKeepingSafeFeatureAnchor(
            currentState,
            {...currentState, zoom: 13},
            pivot,
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
        expect(Math.abs(after.project(pivot)[0] - pixel[0])).toBeLessThan(1);
        expect(Math.abs(after.project(pivot)[1] - pixel[1])).toBeLessThan(1);
    });
});
