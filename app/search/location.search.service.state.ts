import {signalStoreFeature, withState} from "@ngrx/signals";
import {z} from "zod";
import {AppStateOptions, deepCopy} from "../shared/state-value";
import {
    clampLocationSearchResultLimit,
    DEFAULT_LOCATION_SEARCH_RESULT_LIMIT,
    MAX_LOCATION_SEARCH_RESULT_LIMIT
} from "./location-search-limits";

export interface LocationSearchServiceValues {
    locationSearchResultLimit: number;
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    locationSearchResultLimit: {
        name: "locationSearchResultLimit",
        defaultValue: DEFAULT_LOCATION_SEARCH_RESULT_LIMIT,
        schema: z.coerce.number().int().min(1).max(MAX_LOCATION_SEARCH_RESULT_LIMIT),
        toStorage: (value: number) => clampLocationSearchResultLimit(value),
        fromStorage: (payload: any): number => clampLocationSearchResultLimit(payload)
    } satisfies AppStateOptions<LocationSearchServiceValues["locationSearchResultLimit"]>
};

/** The application composes this feature; its owner binds codecs to these same declarations. */
export function withLocationSearch() {
    return signalStoreFeature(
        withState(() => {
            const initial: LocationSearchServiceValues = {
                locationSearchResultLimit: deepCopy(ownerState.locationSearchResultLimit.defaultValue)
            };
            return {location: initial};
        })
    );
}
