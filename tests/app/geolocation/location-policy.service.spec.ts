import "@angular/compiler";
import {TestBed} from "@angular/core/testing";
import {afterEach, describe, expect, it} from "vitest";
import {GeolocationState} from "../../../app/geolocation/geolocation.state";
import {testPersistence} from "../../support/state-owners";
import {LOCATION_BOUNDARY_TERMS_REVISION, type LocationBoundaryConsent} from "../../../app/geolocation/location-policy.model";
import {LocationPolicyService} from "../../../app/geolocation/location-policy.service";

function setup(consent: LocationBoundaryConsent = {decision: "unseen", revision: ""}) {
    const state = new GeolocationState(testPersistence());
    state.locationBoundaryConsentState.next(consent);
    TestBed.configureTestingModule({providers: [LocationPolicyService, {provide: GeolocationState, useValue: state}]});
    const policy = TestBed.inject(LocationPolicyService);
    policy.initialize();
    return {policy, state};
}

afterEach(() => TestBed.resetTestingModule());

describe("LocationPolicyService", () => {
    it("keeps boundaries disabled until the first-startup prompt is accepted", () => {
        const {policy, state} = setup();
        expect(policy.dialogMode).toBe("accept");
        expect(policy.pendingSearchEnabled).toBe(true);
        expect(policy.pendingBoundariesEnabled).toBe(false);
        policy.pendingBoundariesEnabled = true;
        expect(policy.boundariesAccepted).toBe(false);
        policy.apply();
        expect(policy.dialogMode).toBeNull();
        expect(policy.boundariesAccepted).toBe(true);
        expect(state.locationBoundaryConsentState.value).toEqual({decision: "accepted", revision: LOCATION_BOUNDARY_TERMS_REVISION});
    });

    it("applies the default choices without enabling boundaries or prompting again", () => {
        const {policy, state} = setup();
        policy.apply();
        const restored = new LocationPolicyService(state);
        restored.initialize();
        expect(restored.dialogMode).toBeNull();
        expect(state.locationSearchEnabled).toBe(true);
        expect(state.locationBoundariesEnabled).toBe(false);
    });

    it("publishes both choices together and disables effective boundaries while search is off", () => {
        const {policy, state} = setup();
        const changes: Array<{enabled: boolean; boundaries: boolean}> = [];
        const subscription = state.locationPolicyChanges.subscribe(value => changes.push(value));
        policy.pendingBoundariesEnabled = true;
        policy.pendingSearchEnabled = false;
        expect(state.locationSearchEnabled).toBe(true);
        policy.apply();
        expect(changes).toEqual([
            {enabled: true, boundaries: false},
            {enabled: false, boundaries: false}
        ]);
        expect(policy.boundariesAccepted).toBe(true);
        policy.setSearchEnabled(true);
        expect(state.locationBoundariesEnabled).toBe(true);
        subscription.unsubscribe();
    });

    it("remembers a refusal without disabling location search or repeating the startup prompt", () => {
        const {policy, state} = setup();
        policy.dismiss();
        policy.initialize();
        expect(policy.dialogMode).toBeNull();
        expect(state.locationBoundaryConsentState.value.decision).toBe("disabled");
        expect(state.locationSearchEnabledState.value).toBe(true);
        const restored = new LocationPolicyService(state);
        restored.initialize();
        expect(restored.dialogMode).toBeNull();
        restored.requestBoundaries(true);
        expect(restored.dialogMode).toBe("accept");
        expect(restored.boundariesAccepted).toBe(false);
    });

    it("requires fresh acceptance after every disable", () => {
        const {policy} = setup({decision: "accepted", revision: LOCATION_BOUNDARY_TERMS_REVISION});
        expect(policy.dialogMode).toBeNull();
        policy.requestBoundaries(false);
        expect(policy.boundariesAccepted).toBe(false);
        policy.requestBoundaries(true);
        expect(policy.dialogMode).toBe("accept");
        expect(policy.pendingBoundariesEnabled).toBe(true);
        expect(policy.boundariesAccepted).toBe(false);
        policy.pendingBoundariesEnabled = false;
        policy.apply();
        expect(policy.boundariesAccepted).toBe(false);
        policy.requestBoundaries(true);
        policy.apply();
        expect(policy.boundariesAccepted).toBe(true);
    });

    it.each(["disabled", "accepted"] as const)("viewing terms preserves a %s decision", decision => {
        const {policy, state} = setup({decision, revision: LOCATION_BOUNDARY_TERMS_REVISION});
        policy.setSearchEnabled(false);
        const before = state.locationBoundaryConsentState.value;
        policy.showDisclaimer();
        expect(policy.dialogMode).toBe("information");
        policy.pendingSearchEnabled = true;
        policy.pendingBoundariesEnabled = !policy.pendingBoundariesEnabled;
        policy.dismiss();
        expect(state.locationBoundaryConsentState.value).toBe(before);
        expect(state.locationSearchEnabledState.value).toBe(false);
        policy.showDisclaimer();
        expect(policy.pendingSearchEnabled).toBe(false);
        expect(policy.pendingBoundariesEnabled).toBe(decision === "accepted");
    });

    it("allows explicit edits when terms are opened from Preferences", () => {
        const {policy, state} = setup({decision: "disabled", revision: LOCATION_BOUNDARY_TERMS_REVISION});
        policy.showDisclaimer();
        policy.pendingBoundariesEnabled = true;
        policy.apply();
        expect(state.locationBoundariesEnabled).toBe(true);
        expect(policy.dialogMode).toBeNull();
    });

    it("does not offer to enable boundaries while search is disabled", () => {
        const {policy} = setup({decision: "disabled", revision: LOCATION_BOUNDARY_TERMS_REVISION});
        policy.setSearchEnabled(false);
        policy.requestBoundaries(true);
        expect(policy.dialogMode).toBeNull();
        expect(policy.boundariesAccepted).toBe(false);
    });

    it("does not apply a stale draft after dismissal", () => {
        const {policy, state} = setup();
        policy.pendingSearchEnabled = false;
        policy.pendingBoundariesEnabled = true;
        policy.dismiss();
        policy.apply();
        expect(state.locationSearchEnabled).toBe(true);
        expect(state.locationBoundariesEnabled).toBe(false);
    });

    it("requires consent for revised terms", () => {
        const {policy} = setup({decision: "accepted", revision: "old"});
        expect(policy.dialogMode).toBe("accept");
        expect(policy.boundariesAccepted).toBe(false);
    });

    it("keeps a disabled decision disabled when terms change", () => {
        const {policy} = setup({decision: "disabled", revision: "old"});
        expect(policy.dialogMode).toBeNull();
        expect(policy.boundariesAccepted).toBe(false);
    });
});
