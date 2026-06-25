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
    matchedFieldNames: string[];
    matchedEnumValues: string[];
}

/** Selects the schema field that best represents the current search query in generated styles. */
export function preferredSearchAutoStyleField(
    options: FeatureSearchAutoStyleOption[],
    analysis: FeatureSearchAutoStyleAnalysis | undefined
): FeatureSearchAutoStyleOption | undefined {
    const nativeScalarOptions = options.filter(option => !option.value.startsWith("$"));
    const matchedFieldNames = new Set(analysis?.matchedFieldNames ?? []);
    const matchedEnumValues = new Set(analysis?.matchedEnumValues ?? []);
    const fieldMatches = nativeScalarOptions.filter(option =>
        optionMatchesAnalyzedFieldNames(option, matchedFieldNames));
    const enumMatches = nativeScalarOptions.filter(option =>
        optionMatchesAnalyzedEnumValues(option, matchedEnumValues));

    return fieldMatches.find(option => !!option.attrName)
        ?? fieldMatches[0]
        ?? enumMatches.find(option => !!option.attrName)
        ?? enumMatches[0]
        ?? preferredUnmentionedAutoStyleField(nativeScalarOptions, analysis);
}

/** Generates the field list for automatic search-result rules, one field per resolved attribute scope. */
export function searchAutoStyleFieldOptions(
    options: FeatureSearchAutoStyleOption[],
    analysis: FeatureSearchAutoStyleAnalysis
): FeatureSearchAutoStyleOption[] {
    if (analysis.status !== "ready") {
        return [];
    }

    const nativeOptions = options.filter(option => !option.value.startsWith("$"));
    if (analysis.concreteScope !== "attribute") {
        const fieldOption = preferredSearchAutoStyleField(
            nativeOptions.filter(option => !option.attrName),
            analysis);
        return fieldOption ? [fieldOption] : [];
    }

    const attributeOptions = nativeOptions.filter(option => !!option.attrName);
    const uniqueScopes = uniqueSearchAutoStyleAttributeScopes(analysis.attributeScopes);
    if (uniqueScopes.length === 0) {
        const fieldOption = preferredSearchAutoStyleField(attributeOptions, analysis);
        return fieldOption ? [fieldOption] : [];
    }

    const result: FeatureSearchAutoStyleOption[] = [];
    const seen = new Set<string>();
    for (const scope of uniqueScopes) {
        const scopeOptions = attributeOptions.filter(option => searchStyleOptionMatchesAttributeScope(option, scope));
        const fieldOption = preferredSearchAutoStyleField(scopeOptions, analysis) ?? scopeOptions[0];
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

/** Restricts default-style candidates to the resolved concrete search scope. */
export function defaultSearchStyleFieldOptionsForAnalysis(
    options: FeatureSearchAutoStyleOption[],
    analysis: FeatureSearchAutoStyleAnalysis | undefined
): FeatureSearchAutoStyleOption[] {
    const nativeOptions = options.filter(option => !option.value.startsWith("$"));
    if (analysis?.status !== "ready") {
        return nativeOptions;
    }
    if (analysis.concreteScope === "feature") {
        return nativeOptions.filter(option => !option.attrName);
    }

    const attributeOptions = nativeOptions.filter(option => !!option.attrName);
    const uniqueScopes = uniqueSearchAutoStyleAttributeScopes(analysis.attributeScopes);
    if (uniqueScopes.length === 0) {
        return attributeOptions;
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

/** Chooses a safe fallback when the query did not mention a concrete style field. */
function preferredUnmentionedAutoStyleField(
    nativeScalarOptions: FeatureSearchAutoStyleOption[],
    analysis: FeatureSearchAutoStyleAnalysis | undefined
): FeatureSearchAutoStyleOption | undefined {
    const typeIdOption = nativeScalarOptions.find(option => option.value === "typeId");
    if (typeIdOption && analysis?.concreteScope !== "attribute") {
        return typeIdOption;
    }
    return nativeScalarOptions.find(option => !!option.attrName)
        ?? typeIdOption
        ?? nativeScalarOptions[0];
}

/** Matches an option's leaf field against schema-analysis terms such as `length`. */
function optionMatchesAnalyzedFieldNames(option: FeatureSearchAutoStyleOption, fieldNames: Set<string>): boolean {
    if (fieldNames.size === 0) {
        return false;
    }
    return styleFieldLeafNames(option.value)
        .some(leafName => fieldNames.has(leafName));
}

/** Matches enum queries such as `SPEED_LIMIT_END` to their concrete enum field. */
function optionMatchesAnalyzedEnumValues(option: FeatureSearchAutoStyleOption, enumValues: Set<string>): boolean {
    return enumValues.size > 0 && (option.enumValues ?? []).some(value => enumValues.has(value));
}

/** Extracts path leaf candidates from dot and bracket notation used by GeoJSON-style fields. */
function styleFieldLeafNames(field: string): string[] {
    const names: string[] = [];
    const simpleLeaf = field.split(".").at(-1);
    if (simpleLeaf) {
        names.push(simpleLeaf);
    }
    const bracketMatches = field.matchAll(/\["([^"]+)"\]/g);
    for (const match of bracketMatches) {
        if (match[1]) {
            names.push(match[1]);
        }
    }
    return names;
}
