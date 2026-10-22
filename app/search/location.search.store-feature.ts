import {patchAppState, withPersistedState} from "../shared/persisted-state";
import {signalStoreFeature, withMethods} from "@ngrx/signals";
import {z} from "zod";
import {AppStateOptions} from "../shared/state-value";
import {
    clampLocationSearchResultLimit,
    DEFAULT_LOCATION_SEARCH_RESULT_LIMIT,
    MAX_LOCATION_SEARCH_RESULT_LIMIT
} from "./location-search-limits";

export interface LocationSearchValues {
    locationSearchResultLimit: number;
}

/** Saved limits use the existing key and the same bounds as location-provider requests. */
export const ownerState = {
    locationSearchResultLimit: {
        name: "locationSearchResultLimit",
        defaultValue: DEFAULT_LOCATION_SEARCH_RESULT_LIMIT,
        schema: z.coerce.number().int().min(1).max(MAX_LOCATION_SEARCH_RESULT_LIMIT),
        toStorage: (value: number) => clampLocationSearchResultLimit(value),
        fromStorage: (payload: unknown): number => clampLocationSearchResultLimit(payload)
    } satisfies AppStateOptions<LocationSearchValues["locationSearchResultLimit"]>
};

/**
 * The location omnibar reads locationSearchResultLimit() before each provider
 * query. Preferences can edit that limit without constructing an HTTP client or
 * keeping a second observable copy in LocationSearchService.
 */
export function withLocationSearch() {
    return signalStoreFeature(
        withPersistedState<"location", LocationSearchValues>("location", ownerState),
        withMethods(store => ({
            setLocationSearchResultLimit(value: number): void {
                const locationSearchResultLimit = clampLocationSearchResultLimit(value);
                patchAppState(store, {
                    location: {...store.location(), locationSearchResultLimit}
                });
            }
        }))
    );
}
