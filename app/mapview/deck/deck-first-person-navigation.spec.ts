import {describe, expect, it} from "vitest";
import {
    createFirstPersonCoverageViewport,
    createFixedFirstPersonCameraState,
    FIRST_PERSON_EYE_HEIGHT_METERS,
    FIRST_PERSON_FAR_METERS,
    FIRST_PERSON_FOCAL_DISTANCE,
    FIRST_PERSON_FOV_DEGREES,
    FIRST_PERSON_NEAR_METERS,
    updateFixedFirstPersonLook
} from "./deck-first-person-navigation";

describe("fixed first-person navigation", () => {
    it("creates an eye-level horizontal camera with an explicit bounded projection", () => {
        const state = createFixedFirstPersonCameraState([11.12, 48.0, 125], 42);

        expect(state).toEqual({
            longitude: 11.12,
            latitude: 48.0,
            position: [0, 0, 125 + FIRST_PERSON_EYE_HEIGHT_METERS],
            bearing: 42,
            pitch: 0,
            minPitch: -89,
            maxPitch: 89
        });
        expect(FIRST_PERSON_FOV_DEGREES).toBe(60);
        expect(FIRST_PERSON_NEAR_METERS).toBe(0.1);
        expect(FIRST_PERSON_FAR_METERS).toBe(1000);
        expect(FIRST_PERSON_FOCAL_DISTANCE).toBe(1);
    });

    it("allows only bounded look changes at the fixed entry position", () => {
        const initial = createFixedFirstPersonCameraState([11.12, 48.0, 125], 42);
        const updated = updateFixedFirstPersonLook(initial, {
            bearing: 405,
            pitch: 120
        });

        expect(updated.longitude).toBe(initial.longitude);
        expect(updated.latitude).toBe(initial.latitude);
        expect(updated.position).toEqual(initial.position);
        expect(updated.bearing).toBe(45);
        expect(updated.pitch).toBe(89);
    });

    it("retains one finite 360-degree coverage plan while the user looks around", () => {
        const target: [number, number, number] = [11.12, 48.0, 125];
        const coverage = createFirstPersonCoverageViewport(target, 42);
        let state = createFixedFirstPersonCameraState(target, 42);

        for (let bearing = 0; bearing < 360; bearing += 30) {
            state = updateFixedFirstPersonLook(state, {bearing, pitch: 0});
            expect(Object.values(coverage).every(Number.isFinite)).toBe(true);
            expect(coverage.camPosLon).toBe(state.longitude);
            expect(coverage.camPosLat).toBe(state.latitude);
        }
        expect(coverage.width).toBeGreaterThan(0.02);
        expect(coverage.height).toBeGreaterThan(0.01);
    });
});
