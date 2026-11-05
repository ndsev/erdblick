import {Injectable} from "@angular/core";
import {GeolocationState} from "./geolocation.state";
import {LOCATION_BOUNDARY_TERMS_REVISION, locationBoundaryConsentAccepted} from "./location-policy.model";

/** Owns local location preferences and explicit boundary consent. */
@Injectable({providedIn: "root"})
export class LocationPolicyService {
    dialogMode: "accept" | "information" | null = null;
    pendingSearchEnabled = true;
    pendingBoundariesEnabled = false;
    private initialized = false;

    constructor(public readonly state: GeolocationState) {}

    /** Prompt after local persistence has loaded, including previously accepted older terms. */
    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;
        const consent = this.state.locationBoundaryConsentState.getValue();
        if (consent.decision === "unseen" ||
            (consent.decision === "accepted" && !locationBoundaryConsentAccepted(consent))) {
            this.showDialog("accept");
        }
    }

    get boundariesAccepted(): boolean {
        return locationBoundaryConsentAccepted(this.state.locationBoundaryConsentState.getValue());
    }

    /** Disabling clears consent; every later enable requires a new explicit decision. */
    requestBoundaries(enabled: boolean): void {
        if (!enabled) this.refuse();
        else if (this.state.locationSearchEnabled) this.showDialog("accept", true);
    }

    /** Change search availability independently of the stored boundary preference. */
    setSearchEnabled(enabled: boolean): void {
        this.state.locationSearchEnabledState.next(enabled);
    }

    /** Opening terms only prepares a draft; changing preferences requires Apply. */
    showDisclaimer(): void {
        if (this.dialogMode === null) this.showDialog("information");
    }

    /** Commit both choices together; Apply with boundaries selected records consent. */
    apply(): void {
        if (this.dialogMode === null) return;
        this.state.setLocationPreferences(this.pendingSearchEnabled, {
            decision: this.pendingBoundariesEnabled ? "accepted" : "disabled",
            revision: LOCATION_BOUNDARY_TERMS_REVISION
        });
        this.dialogMode = null;
    }

    /** Persist a refusal or disable so a reload does not repeat the initial prompt. */
    private refuse(): void {
        this.state.locationBoundaryConsentState.next({decision: "disabled", revision: LOCATION_BOUNDARY_TERMS_REVISION});
        this.dialogMode = null;
    }

    /** Closing acceptance means refusal; closing information preserves the existing decision. */
    dismiss(): void {
        if (this.dialogMode === "accept") this.refuse();
        else this.dialogMode = null;
    }

    /** Reset the draft on each opening so dismissed edits cannot leak into the next prompt. */
    private showDialog(mode: "accept" | "information", boundariesEnabled = this.boundariesAccepted): void {
        this.pendingSearchEnabled = this.state.locationSearchEnabled;
        this.pendingBoundariesEnabled = boundariesEnabled;
        this.dialogMode = mode;
    }
}
