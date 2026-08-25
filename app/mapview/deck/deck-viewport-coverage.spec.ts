import {describe, expect, it} from "vitest";
import {clippedGeographicBounds} from "./deck-viewport-coverage";
import {
    createDeckMapViewport,
    type DeckMapCameraState
} from "./navigation/web-mercator-feature-navigation";

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

const BASE_CAMERA: DeckMapCameraState = {
    longitude: 11.1277,
    latitude: 47.996,
    zoom: 16,
    pitch: 45,
    bearing: 20
};

describe("deck viewport coverage", () => {
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

    it("covers visible ground near the horizon without producing an unbounded request", () => {
        const camera: DeckMapCameraState = {
            longitude: -122.40739031,
            latitude: 37.73602083,
            zoom: 22,
            pitch: 82.52418133,
            bearing: 150.67968734,
            position: [0, 0, 0]
        };
        const viewport = createDeckMapViewport(camera, 1905, 2053, false);
        const bounds = clippedGeographicBounds(viewport, camera.longitude, 0.05);
        const [visibleLongitude, visibleLatitude] = viewport.unproject(
            [viewport.width / 2, 650],
            {targetZ: 0}
        );

        expect(visibleLongitude).toBeGreaterThanOrEqual(bounds.west);
        expect(visibleLongitude).toBeLessThanOrEqual(bounds.west + bounds.width);
        expect(visibleLatitude).toBeGreaterThanOrEqual(bounds.south);
        expect(visibleLatitude).toBeLessThanOrEqual(bounds.south + bounds.height);
        expect(bounds.width).toBeLessThan(0.1);
        expect(bounds.height).toBeLessThan(0.1);
    });
});
