import {Injectable} from "@angular/core";
import {GeolocationState} from "./geolocation.state";
import {LOCATION_BOUNDARY_TERMS_REVISION, locationBoundaryConsentAccepted} from "./location-policy.model";

/** Owns local location preferences and explicit boundary consent. */
@Injectable({providedIn: "root"})
export class LocationPolicyService {
    dialogMode: "accept" | "information" | null = null;
    private initialized = false;

    constructor(public readonly state: GeolocationState) {}

    /** Prompt after local persistence has loaded, including previously accepted older terms. */
    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;
        const consent = this.state.locationBoundaryConsentState.getValue();
        if (consent.decision === "unseen" ||
            (consent.decision === "accepted" && !locationBoundaryConsentAccepted(consent))) {
            this.dialogMode = "accept";
        }
    }

    get boundariesAccepted(): boolean {
        return locationBoundaryConsentAccepted(this.state.locationBoundaryConsentState.getValue());
    }

    /** Disabling clears consent; every later enable requires a new explicit decision. */
    requestBoundaries(enabled: boolean): void {
        if (enabled) this.dialogMode = "accept";
        else this.refuse();
    }

    /** Change search availability independently of the stored boundary preference. */
    setSearchEnabled(enabled: boolean): void {
        this.state.locationSearchEnabledState.next(enabled);
    }

    /** Read-only access from Preferences never changes acceptance or enabled state. */
    showDisclaimer(): void {
        if (this.dialogMode !== "accept") this.dialogMode = "information";
    }

    /** Record consent only from the explicit acceptance action. */
    accept(): void {
        if (this.dialogMode !== "accept") return;
        this.state.locationBoundaryConsentState.next({decision: "accepted", revision: LOCATION_BOUNDARY_TERMS_REVISION});
        this.dialogMode = null;
    }

    /** Persist a refusal or disable so a reload does not repeat the initial prompt. */
    refuse(): void {
        this.state.locationBoundaryConsentState.next({decision: "disabled", revision: LOCATION_BOUNDARY_TERMS_REVISION});
        this.dialogMode = null;
    }

    /** Closing acceptance means refusal; closing information preserves the existing decision. */
    dismiss(): void {
        if (this.dialogMode === "accept") this.refuse();
        else this.dialogMode = null;
    }
}
