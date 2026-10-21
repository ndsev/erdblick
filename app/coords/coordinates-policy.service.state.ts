import {signalStoreFeature, withState} from "@ngrx/signals";
import {Boolish} from "../shared/app-state";
import {AppStateOptions, deepCopy} from "../shared/state-value";

export interface CoordinatesPolicyServiceValues {
    coordinatesEnabled: boolean;
    coordinatesLegalTermsAccepted: boolean;
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    coordinatesEnabled: {
        name: "coordinatesEnabled",
        defaultValue: true,
        schema: Boolish,
        snapshotPersist: false,
        configDefault: true
    } satisfies AppStateOptions<CoordinatesPolicyServiceValues["coordinatesEnabled"]>,

    coordinatesLegalTermsAccepted: {
        name: "coordinatesLegalTermsAccepted",
        defaultValue: false,
        schema: Boolish,
        snapshotPersist: false
    } satisfies AppStateOptions<CoordinatesPolicyServiceValues["coordinatesLegalTermsAccepted"]>
};

/** The application composes this feature; its owner binds codecs to these same declarations. */
export function withCoordinatesPolicy() {
    return signalStoreFeature(
        withState(() => {
            const initial: CoordinatesPolicyServiceValues = {
                coordinatesEnabled: deepCopy(ownerState.coordinatesEnabled.defaultValue),
                coordinatesLegalTermsAccepted: deepCopy(ownerState.coordinatesLegalTermsAccepted.defaultValue)
            };
            return {coordinatePolicy: initial};
        })
    );
}
