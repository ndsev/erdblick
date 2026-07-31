import type {FeatureSearchAttributeScopeCandidate} from "../mapdata/map-runtime.model";
import type {FeatureSearchMapLayerRef} from "../shared/feature-search-state";
import type {SearchStyleFieldOption} from "./search-style-color.util";

export interface FeatureSearchAutoStyleOption extends SearchStyleFieldOption {
    mapId?: string;
    layerId?: string;
    attrName?: string;
    attrLayerName?: string;
    featureType?: string;
    mapLayers?: FeatureSearchMapLayerRef[];
}

export interface FeatureSearchAutoStyleAnalysis {
    status: "pending" | "ready" | "error";
    concreteScope: "feature" | "attribute";
    attributeScopes: FeatureSearchAttributeScopeCandidate[];
    rewriteSuppressed?: boolean;
    matchedFieldNames: string[];
    matchedEnumValues: string[];
}

/** Selects the most semantically relevant scalar field from the first resolved attribute scope. */
export function preferredSearchAutoStyleField(
    options: FeatureSearchAutoStyleOption[],
    analysis: FeatureSearchAutoStyleAnalysis | undefined
): FeatureSearchAutoStyleOption | undefined {
    return searchAutoStyleFieldOptions(options, analysis)[0];
}

/** Generates automatic search-result rules: one ranked scalar field per resolved attribute scope. */
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
        const ranked = attributeOptions
            .filter(option => searchStyleOptionMatchesAttributeScope(option, scope))
            .map((option, index) => ({
                option,
                index,
                rank: searchAutoStyleFieldRank(option, scope, analysis)
            }))
            .sort((left, right) =>
                left.rank - right.rank || left.index - right.index);
        const bestRank = ranked[0]?.rank;
        if (bestRank === undefined) {
            continue;
        }
        // Heterogeneous schemas can expose the same semantic value at
        // different paths. Keep every equally good path and let its explicit
        // source-layer applicability select the correct generated rule.
        for (const {option, rank, index} of ranked) {
            if (rank !== bestRank) {
                break;
            }
            if (bestRank > 1 && index !== ranked[0].index) {
                continue;
            }
            const key = searchAutoStyleFieldOptionKey(option);
            if (!seen.has(key)) {
                seen.add(key);
                result.push(option);
            }
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

/**
 * Prefer the field named by the query/schema before falling back to useful
 * schema types. Attribute names such as WARNING_SIGN naturally map to leaf
 * fields such as warningSign; an enum field then gives the editor a populated
 * categorical scale instead of an arbitrary solid rule.
 */
function searchAutoStyleFieldRank(
    option: FeatureSearchAutoStyleOption,
    scope: FeatureSearchAttributeScopeCandidate,
    analysis: FeatureSearchAutoStyleAnalysis
): number {
    const leaf = option.value.split(".").at(-1) ?? option.value;
    const normalizedLeaf = normalizedSemanticName(leaf);
    if (normalizedLeaf &&
        normalizedLeaf === normalizedSemanticName(scope.attrName)) {
        return 0;
    }
    if (analysis.matchedFieldNames.some(name =>
        normalizedSemanticName(name) === normalizedLeaf)) {
        return 1;
    }
    const matchedEnums = new Set(analysis.matchedEnumValues);
    if (option.enumValues?.some(value => matchedEnums.has(value))) {
        return 2;
    }
    if (option.valueKind === "enum") {
        return 3;
    }
    if (option.valueKind === "number" || option.valueKind === "integer") {
        return 4;
    }
    return 5;
}

function normalizedSemanticName(value: string): string {
    return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}
