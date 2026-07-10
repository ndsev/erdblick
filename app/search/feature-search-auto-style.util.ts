import type {FeatureSearchAttributeScopeCandidate} from "../mapdata/map-runtime.model";
import type {SearchStyleFieldOption} from "./search-style-color.util";

export interface FeatureSearchAutoStyleOption extends SearchStyleFieldOption {
    mapId?: string;
    layerId?: string;
    attrName?: string;
    attrLayerName?: string;
    featureType?: string;
}

export interface FeatureSearchAutoStyleAnalysis {
    status: "pending" | "ready" | "error";
    concreteScope: "feature" | "attribute";
    attributeScopes: FeatureSearchAttributeScopeCandidate[];
    rewriteSuppressed?: boolean;
    matchedFieldNames: string[];
    matchedEnumValues: string[];
}

/** Returns whether the query is the default unfiltered predicate used for scoped searches. */
export function isDefaultTrueSearchExpression(query: string | undefined): boolean {
    return (query ?? "").trim().toLowerCase() === "true";
}

/** Selects the first scalar field from the first resolved attribute scope. */
export function preferredSearchAutoStyleField(
    options: FeatureSearchAutoStyleOption[],
    analysis: FeatureSearchAutoStyleAnalysis | undefined
): FeatureSearchAutoStyleOption | undefined {
    return searchAutoStyleFieldOptions(options, analysis)[0];
}

/** Generates automatic search-result rules: one first scalar field per resolved attribute scope. */
export function searchAutoStyleFieldOptions(
    options: FeatureSearchAutoStyleOption[],
    analysis: FeatureSearchAutoStyleAnalysis | undefined
): FeatureSearchAutoStyleOption[] {
    if (analysis?.status !== "ready" || analysis.rewriteSuppressed || analysis.concreteScope !== "attribute") {
        return [];
    }

    const attributeOptions = options.filter(option => isNativeAttributeScalar(option));
    const uniqueScopes = uniqueSearchAutoStyleAttributeScopes(analysis.attributeScopes);
    if (uniqueScopes.length === 0) {
        return [];
    }

    const result: FeatureSearchAutoStyleOption[] = [];
    const seen = new Set<string>();
    for (const scope of uniqueScopes) {
        const fieldOption = attributeOptions.find(option => searchStyleOptionMatchesAttributeScope(option, scope));
        if (!fieldOption) {
            continue;
        }
        const key = searchAutoStyleFieldOptionKey(fieldOption);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(fieldOption);
        }
    }
    return result;
}

/** Restricts default-style candidates to resolved attribute scopes, without guessing from leaf names. */
export function defaultSearchStyleFieldOptionsForAnalysis(
    options: FeatureSearchAutoStyleOption[],
    analysis: FeatureSearchAutoStyleAnalysis | undefined
): FeatureSearchAutoStyleOption[] {
    const nativeOptions = options.filter(option => !option.value.startsWith("$"));
    if (analysis?.status !== "ready") {
        return nativeOptions;
    }
    if (analysis.rewriteSuppressed) {
        return [];
    }
    if (analysis.concreteScope === "feature") {
        return nativeOptions.filter(option => !option.attrName);
    }

    const attributeOptions = nativeOptions.filter(option => !!option.attrName);
    const uniqueScopes = uniqueSearchAutoStyleAttributeScopes(analysis.attributeScopes);
    if (uniqueScopes.length === 0) {
        return [];
    }
    return attributeOptions.filter(option =>
        uniqueScopes.some(scope => searchStyleOptionMatchesAttributeScope(option, scope)));
}

/** Dedupe attribute scopes across maps/layers while preserving distinct attribute names. */
export function uniqueSearchAutoStyleAttributeScopes(
    scopes: FeatureSearchAttributeScopeCandidate[]
): FeatureSearchAttributeScopeCandidate[] {
    const result: FeatureSearchAttributeScopeCandidate[] = [];
    const seen = new Set<string>();
    for (const scope of scopes) {
        const key = scope.attrName;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(scope);
        }
    }
    return result;
}

/** Matches a style-field option to an inferred attribute scope. */
export function searchStyleOptionMatchesAttributeScope(
    option: FeatureSearchAutoStyleOption,
    scope: FeatureSearchAttributeScopeCandidate
): boolean {
    return option.attrName === scope.attrName;
}

/** Builds a stable dedupe key for generated automatic style fields. */
export function searchAutoStyleFieldOptionKey(option: FeatureSearchAutoStyleOption): string {
    return [
        option.attrName ?? "",
        option.value
    ].join("\n");
}

/** Automatic attribute styling only consumes real scalar attribute fields. */
function isNativeAttributeScalar(option: FeatureSearchAutoStyleOption): boolean {
    return !!option.attrName && !option.value.startsWith("$") && option.valueKind !== "object" && option.valueKind !== "array";
}
