export const DEFAULT_LOCATION_SEARCH_RESULT_LIMIT = 10;

export const MAX_LOCATION_SEARCH_RESULT_LIMIT = 50;

/** Clamps location-search hit limits from persisted state and preferences UI. */
export function clampLocationSearchResultLimit(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return DEFAULT_LOCATION_SEARCH_RESULT_LIMIT;
    }
    return Math.min(MAX_LOCATION_SEARCH_RESULT_LIMIT, Math.max(1, Math.trunc(numeric)));
}
