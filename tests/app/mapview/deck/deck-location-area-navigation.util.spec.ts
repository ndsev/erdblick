import {describe, expect, it} from "vitest";
import {
    fitLocationArea,
    locationOverlayPolygons,
    LOCATION_MERCATOR_LATITUDE
} from "../../../../app/mapview/deck/deck-location-area-navigation.util";
import {
    createDeckMapViewport,
    type DeckMapCameraState
} from "../../../../app/mapview/deck/navigation/web-mercator-feature-navigation.adapter";
import type {LocationArea} from "../../../../app/mapview/render-view.model";

const state: DeckMapCameraState = {longitude: 11, latitude: 48, zoom: 12, pitch: 60, bearing: 45, position: [40, 70, 800]};

describe("Location area fitting", () => {
    it.each([
        {width: 320, height: 600, west: -5, south: 0, east: 5, north: 10},
        {width: 800, height: 600, west: -5, south: 60, east: 5, north: 70},
        {width: 400, height: 600, west: -180, south: -20, east: 180, north: 20},
        {width: 500, height: 300, west: 10, south: 47, east: 14, north: 49},
        {width: 300, height: 500, west: 170, south: 47, east: 185, north: 49},
        {width: 1, height: 1, west: -180, south: -90, east: 180, north: 90}
    ])("contains the complete extent in $width × $height at both projections", bounds => {
        for (const orthographic of [false, true]) {
            const fitted = fitLocationArea(bounds, state, bounds.width, bounds.height, orthographic)!;
            expect(fitted).toBeDefined();
            expect(fitted.position).toEqual([0, 0, 0]);
            const viewport = createDeckMapViewport(fitted, bounds.width, bounds.height, orthographic);
            const padding = Math.min(24, bounds.width / 4, bounds.height / 4);
            for (const lon of [bounds.west, bounds.east]) for (const lat of [bounds.south, bounds.north]) {
                const [x, y, z] = viewport.project([lon, Math.max(-LOCATION_MERCATOR_LATITUDE, Math.min(LOCATION_MERCATOR_LATITUDE, lat)), 0]);
                expect(x).toBeGreaterThanOrEqual(padding - 0.001);
                expect(x).toBeLessThanOrEqual(bounds.width - padding + 0.001);
                expect(y).toBeGreaterThanOrEqual(padding - 0.001);
                expect(y).toBeLessThanOrEqual(bounds.height - padding + 0.001);
                expect(z).toBeGreaterThanOrEqual(-1);
                expect(z).toBeLessThanOrEqual(1);
            }
        }
    });

    it("preserves ordinary 3D orientation and permits negative zoom", () => {
        const fitted = fitLocationArea({west: -180, south: -20, east: 180, north: 20}, state, 400, 600, false)!;
        expect(fitted.pitch).toBe(60);
        expect(fitted.bearing).toBe(45);
        expect(fitted.zoom).toBeLessThan(0);
    });

    it("waits for visible dimensions instead of computing a non-finite camera", () => {
        expect(fitLocationArea({west: 1, south: 1, east: 2, north: 2}, state, 0, 600, false)).toBeUndefined();
    });
});

describe("Location overlay geometry", () => {
    it("keeps holes and separate components without mutating input", () => {
        const area: LocationArea = {label: "Area", rectangle: {west: 0, south: 0, east: 20, north: 10}, polygons: [
            [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]],
            [[[15, 0], [20, 0], [20, 5], [15, 5], [15, 0]]]
        ]};
        const before = JSON.stringify(area);
        const polygons = locationOverlayPolygons(area);
        expect(polygons).toHaveLength(2);
        expect(polygons[0]).toHaveLength(2);
        expect(JSON.stringify(area)).toBe(before);
    });

    it("splits dateline polygons with holes into local world pieces", () => {
        const polygons = locationOverlayPolygons({label: "Crossing", rectangle: {west: 170, east: 190, south: 0, north: 10}, polygons: [
            [[[170, 0], [-170, 0], [-170, 10], [170, 10], [170, 0]], [[175, 2], [-175, 2], [-175, 8], [175, 8], [175, 2]]]
        ]});
        expect(polygons).toHaveLength(2);
        for (const polygon of polygons) for (const ring of polygon) for (let index = 1; index < ring.length; index++) {
            expect(Math.abs(ring[index][0] - ring[index - 1][0])).toBeLessThanOrEqual(20);
        }
        expect(polygons.every(polygon => polygon.length === 2)).toBe(true);
    });

    it.each([false, true])("preserves full-width polar coverage (geometry=%s)", geometry => {
        const polygons = locationOverlayPolygons({label: "Polar", rectangle: {west: -180, south: -90, east: 180, north: -60},
            ...(geometry ? {polygons: [[[[-180, -90], [180, -90], [180, -60], [-180, -60], [-180, -90]]]] as LocationArea["polygons"]} : {})});
        expect(polygons.length).toBeGreaterThan(0);
        const points = polygons.flat(2);
        expect(Math.min(...points.map(p => p[0]))).toBe(-180);
        expect(Math.max(...points.map(p => p[0]))).toBe(180);
        expect(points.every(p => Math.abs(p[1]) <= LOCATION_MERCATOR_LATITUDE + 1e-8)).toBe(true);
    });
});
