export const DEFAULT_FEATURE_SEARCH_GROUPING = [1];

export const FEATURE_SEARCH_GROUPING_OPTION_IDS = new Set([1, 2, 3, 4]);

/** Normalizes feature search grouping values from persisted state. */
export function normalizeFeatureSearchGrouping(value: unknown): number[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const result: number[] = [];
    for (const item of value) {
        const numeric = Number(item);
        if (
            !Number.isInteger(numeric) ||
            !FEATURE_SEARCH_GROUPING_OPTION_IDS.has(numeric) ||
            result.includes(numeric)
        ) {
            continue;
        }
        result.push(numeric);
    }
    return result;
}
