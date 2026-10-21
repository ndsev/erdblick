import {z} from "zod";
import {FeatureSearchStateEntry} from "../shared/feature-search-state";
import {DEFAULT_FEATURE_SEARCH_GROUPING, normalizeFeatureSearchGrouping} from "./feature-search-grouping";

import {signalStoreFeature, withState} from "@ngrx/signals";
import {AppStateOptions, deepCopy} from "../shared/state-value";

export interface FeatureSearchServiceValues {
    featureSearchGrouping: number[];
    featureSearch: StoredFeatureSearch[];
}

/** Only this shape is stored; indices are computed from the current ordered views. */
export type StoredFeatureSearch = Omit<FeatureSearchStateEntry, "selectedViewIndices" | "selectedViewIds"> & {
    selectedViewIds: string[];
};

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    featureSearchGrouping: {
        name: "featureSearchGrouping",
        defaultValue: [...DEFAULT_FEATURE_SEARCH_GROUPING],
        schema: z.array(z.coerce.number()),
        toStorage: (value: number[]) => normalizeFeatureSearchGrouping(value),
        fromStorage: (payload: any): number[] => normalizeFeatureSearchGrouping(payload),
        snapshotPersist: false
    } satisfies AppStateOptions<FeatureSearchServiceValues["featureSearchGrouping"]>
};

/** The application composes this feature; its owner binds codecs to these same declarations. */
export function withFeatureSearch() {
    return signalStoreFeature(
        withState(() => {
            const initial: FeatureSearchServiceValues = {
                featureSearchGrouping: deepCopy(ownerState.featureSearchGrouping.defaultValue),
                featureSearch: []
            };
            return {searches: initial};
        })
    );
}
