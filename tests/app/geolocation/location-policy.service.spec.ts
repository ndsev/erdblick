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
        expect(policy.boundariesAccepted).toBe(false);
        policy.accept();
        expect(policy.dialogMode).toBeNull();
        expect(policy.boundariesAccepted).toBe(true);
        expect(state.locationBoundaryConsentState.value).toEqual({decision: "accepted", revision: LOCATION_BOUNDARY_TERMS_REVISION});
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
        expect(policy.boundariesAccepted).toBe(false);
        policy.refuse();
        policy.requestBoundaries(true);
        policy.accept();
        expect(policy.boundariesAccepted).toBe(true);
    });

    it.each(["disabled", "accepted"] as const)("viewing terms preserves a %s decision", decision => {
        const {policy, state} = setup({decision, revision: LOCATION_BOUNDARY_TERMS_REVISION});
        policy.setSearchEnabled(false);
        const before = state.locationBoundaryConsentState.value;
        policy.showDisclaimer();
        expect(policy.dialogMode).toBe("information");
        policy.accept(); // Read-only access cannot grant consent.
        policy.dismiss();
        expect(state.locationBoundaryConsentState.value).toBe(before);
        expect(state.locationSearchEnabledState.value).toBe(false);
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
