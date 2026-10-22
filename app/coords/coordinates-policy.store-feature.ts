import {patchAppState, withPersistedState} from "../shared/persisted-state";
import {signalStoreFeature, withMethods} from "@ngrx/signals";
import {AppStateOptions, Boolish} from "../shared/state-value";

export interface CoordinatePolicyValues {
    coordinatesEnabled: boolean;
    coordinatesLegalTermsAccepted: boolean;
}

/** Consent stays local to this browser and is never copied into a presentation snapshot. */
export const ownerState = {
    coordinatesEnabled: {
        name: "coordinatesEnabled",
        defaultValue: true,
        schema: Boolish,
        snapshotPersist: false,
        configDefault: true
    } satisfies AppStateOptions<CoordinatePolicyValues["coordinatesEnabled"]>,

    coordinatesLegalTermsAccepted: {
        name: "coordinatesLegalTermsAccepted",
        defaultValue: false,
        schema: Boolish,
        snapshotPersist: false
    } satisfies AppStateOptions<CoordinatePolicyValues["coordinatesLegalTermsAccepted"]>
};

/**
 * These signals remember the requested readout state and local consent.
 * CoordinatesPolicyService combines them with the loaded legal document before
 * allowing the coordinate panel to display values.
 */
export function withCoordinatesPolicy() {
    return signalStoreFeature(
        withPersistedState<"coordinatePolicy", CoordinatePolicyValues>("coordinatePolicy", ownerState),
        withMethods(store => ({
            /** Consent and the requested readout state change together after the policy dialog is answered. */
            setCoordinatesConsent(accepted: boolean): void {
                patchAppState(store, {
                    coordinatePolicy: {
                        ...store.coordinatePolicy(),
                        coordinatesEnabled: accepted,
                        coordinatesLegalTermsAccepted: accepted
                    }
                });
            },
            /** Record a preference toggle after the runtime policy has checked the legal gate. */
            setCoordinatesEnabled(value: boolean): void {
                patchAppState(store, {
                    coordinatePolicy: {...store.coordinatePolicy(), coordinatesEnabled: value}
                });
            },
            setCoordinatesLegalTermsAccepted(value: boolean): void {
                patchAppState(store, {
                    coordinatePolicy: {...store.coordinatePolicy(), coordinatesLegalTermsAccepted: value}
                });
            }
        }))
    );
}
