/**
 * The saved limit on displayed place-search results. The codec preserves the
 * existing config/storage key and clamps incoming values. Network requests
 * and result selection remain in the location-search controllers.
 */
import { Injectable } from "@angular/core";
import { z } from "zod";
import { AppStateService } from "../appstate/appstate.service";
import { Boolish } from "../appstate/appstate.model";
import {
    locationBoundaryConsentAccepted,
    locationBoundaryConsentSchema,
    type LocationBoundaryConsent
} from "./location-policy.model";
import {
    clampLocationSearchResultLimit,
    DEFAULT_LOCATION_SEARCH_RESULT_LIMIT,
    MAX_LOCATION_SEARCH_RESULT_LIMIT
} from "./geolocation.model";

@Injectable({ providedIn: "root" })
export class GeolocationState {
    constructor(private readonly persistence: AppStateService) {}

    readonly locationSearchEnabledState = this.persistence.registerState<boolean>({
        name: "locationSearchEnabled", defaultValue: true, schema: Boolish,
        snapshotPersist: false, configDefault: false
    });

    readonly locationBoundaryConsentState = this.persistence.registerState<LocationBoundaryConsent>({
        name: "locationBoundaryConsent", defaultValue: {decision: "unseen", revision: ""},
        schema: locationBoundaryConsentSchema, snapshotPersist: false, configDefault: false
    });

    get locationSearchEnabled(): boolean { return this.locationSearchEnabledState.value; }
    get locationBoundariesEnabled(): boolean {
        return this.locationSearchEnabled && locationBoundaryConsentAccepted(this.locationBoundaryConsentState.value);
    }

    /** Publish consent and availability together after a complete preference edit. */
    readonly locationPolicyChanges = this.persistence.observe(
        () => ({enabled: this.locationSearchEnabled, boundaries: this.locationBoundariesEnabled}),
        (left, right) => left.enabled === right.enabled && left.boundaries === right.boundaries
    );

    readonly locationSearchResultLimitState = this.persistence.registerState<number>({
        name: "locationSearchResultLimit",
        defaultValue: DEFAULT_LOCATION_SEARCH_RESULT_LIMIT,
        schema: z.coerce.number().int().min(1).max(MAX_LOCATION_SEARCH_RESULT_LIMIT),
        toStorage: (value: number) => clampLocationSearchResultLimit(value),
        fromStorage: (payload: any): number => clampLocationSearchResultLimit(payload)
    });

    get locationSearchResultLimit() {
        return this.locationSearchResultLimitState.getValue();
    }

    set locationSearchResultLimit(val: number) {
        this.locationSearchResultLimitState.next(clampLocationSearchResultLimit(val));
    }
}
