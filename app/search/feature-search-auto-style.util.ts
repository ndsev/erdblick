import {searchStyleFieldCandidates, type FeatureSearchStyleFieldInventory} from "./search.model";
import type {FeatureSearchRuleFilter, FeatureSearchStyleRule} from "./search-definition.model";
import {autoInitializeSearchStyleColorDraft, defaultSearchStyleColorDraft} from "./search-style-color.util";
import {SearchStyleRuleDraftCodec} from "./search-style-rule-editor.model";
import type { FeatureSearchAttributeScopeCandidate } from "./search.model";
import type {FeatureSearchMapLayerRef} from "./search-definition.model";
import type {SearchStyleFieldOption} from "./search-style-color.util";
import {searchStyleFilterExpression} from "./search-style-sheet.converter";
import {schemaScalarMeaning} from "../mapdata/schema-type.model";

/**
 * Temporary proof used only while combining freshly prepared rules. Persisted
 * rules keep their exact accepted types, not a second copy of schema metadata.
 */
interface PreparedAutoStyleRule extends FeatureSearchStyleRule {
    valueMeaning?: string;
    /** Generated enum colors depend only on the string label, not its catalog/version. */
    symbolicCategories?: boolean;
}

export interface FeatureSearchAutoStyleOption extends SearchStyleFieldOption {
    mapId?: string;
    layerId?: string;
    attrName?: string;
    attrLayerName?: string;
    featureType?: string;
    mapLayers?: FeatureSearchMapLayerRef[];
    /** This expression is the scalar selected by the owner's native attribute shorthand. */
    primaryValue?: boolean;
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
        if (bestRank === undefined || bestRank > 3) {
            continue;
        }
        // Heterogeneous schemas can expose the same semantic value at
        // different paths. Keep every equally good path and let its explicit
        // source-layer applicability select the correct generated rule.
        for (const {option, rank, index} of ranked) {
            if (rank !== bestRank) {
                break;
            }
            if (bestRank > 3 && index !== ranked[0].index) {
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

/**
 * Checks that source-specific candidate paths can be guarded with portable
 * attribute/feature semantics before they become persisted search rules.
 */
export function searchAutoStyleFieldOptionsArePortable(
    options: readonly FeatureSearchAutoStyleOption[],
    analysis: FeatureSearchAutoStyleAnalysis | undefined
): boolean {
    if (!options.length
        || analysis?.status !== "ready"
        || analysis.concreteScope !== "attribute") {
        return false;
    }
    const scopes = analysis.attributeScopes;
    const covers = (
        option: FeatureSearchAutoStyleOption,
        scope: FeatureSearchAttributeScopeCandidate
    ) => optionContexts(option).some(context =>
        context.mapId === scope.mapId && context.layerId === scope.layerId);

    // Every resolved scope needs a selected field that actually exists in its
    // source context; otherwise a generic solid rule is safer.
    if (scopes.some(scope => !options.some(option =>
        option.attrName === scope.attrName && covers(option, scope)))) {
        return false;
    }

    // A rule may safely miss another source context only if its feature type
    // guard proves that the rule cannot run there.
    return options.every(option => scopes
        .filter(scope => scope.attrName === option.attrName && !covers(option, scope))
        .every(scope => !!option.featureType
            && !!scope.featureType
            && option.featureType !== scope.featureType));
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
    return !!option.attrName && !option.incompatibleTypes && !option.value.startsWith("$")
        && option.valueKind !== "object" && option.valueKind !== "array";
}

/**
 * Prefer the field named by the query/schema before falling back to useful
 * schema types. Attribute names such as WARNING_SIGN naturally map to leaf
 * fields such as warningSign. Otherwise use the native attribute scalar before
 * choosing a type-based fallback: validity enums and source addresses must not
 * displace the speed value of a SPEED_LIMIT_METRIC attribute. Explicit query
 * fields and enum values still take precedence over that default.
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
    if (option.primaryValue) {
        return 3;
    }
    if (option.valueKind === "enum") {
        return 4;
    }
    if (option.valueKind === "number" || option.valueKind === "integer") {
        return 5;
    }
    return 6;
}

function normalizedSemanticName(value: string): string {
    return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function optionContexts(option: FeatureSearchAutoStyleOption): FeatureSearchMapLayerRef[] {
    if (option.mapLayers?.length) {
        return option.mapLayers;
    }
    return option.mapId && option.layerId
        ? [{mapId: option.mapId, layerId: option.layerId}]
        : [];
}

/**
 * Choose the initial visualization while preparing a confirmed search. The
 * component only edits the resulting persisted rules; opening a tab or
 * receiving data does not replace their field or color mode. Keep the exact
 * owner filters here until all selected sources have contributed: a different
 * source may need a different scale at the same attribute path.
 */
export function preparedSearchAutoStyleRules(
    inventory: FeatureSearchStyleFieldInventory | undefined,
    analysis: FeatureSearchAutoStyleAnalysis,
    color: string,
    applicability: NonNullable<FeatureSearchStyleRule["applicability"]>
): PreparedAutoStyleRule[] {
    const options: FeatureSearchAutoStyleOption[] = inventory ? searchStyleFieldCandidates(inventory).flatMap(field =>
        field.contexts.filter(context => context.mapId === applicability.mapId && context.layerId === applicability.layerId)
            .map(context => ({
            label: field.path, value: field.path, ...context,
            valueKind: field.valueKind, enumValues: field.enumValues,
            numericRange: field.numericRange, schemaType: field.schemaType,
            primaryValue: context.primaryValuePath === field.path,
            mapLayers: [{mapId: context.mapId, layerId: context.layerId}]
        }))) : [];
    // Cover every exact owner, including owners for which there is no useful
    // scalar. Deduplicating by attribute name before this step can silently
    // drop a second feature type or a different field/type in another layer.
    const owners = [...new Map(analysis.attributeScopes.map(owner => [JSON.stringify(owner), owner])).values()];
    const groups: PreparedAutoStyleRule[][] = [];
    let nextId = 0;
    for (const owner of owners.length ? owners : [undefined]) {
        const localOptions = options.filter(option => owner &&
            option.mapId === owner.mapId && option.layerId === owner.layerId &&
            option.featureType === owner.featureType && option.attrLayerName === owner.attrLayerName &&
            option.attrName === owner.attrName);
        const fields = owner ? searchAutoStyleFieldOptions(localOptions, {...analysis, attributeScopes: [owner]}) : [];
        const rules: PreparedAutoStyleRule[] = [];
        for (const field of fields.length ? fields : [undefined]) {
            // The codec binds a field's exact schema type. Supplying only this
            // candidate avoids rebinding an equal path to another owner's type.
            const codec = new SearchStyleRuleDraftCodec(field ? [field] : []);
            let draft = {...defaultSearchStyleColorDraft(field?.value ?? ""), solidColor: color, fallbackColor: color};
            draft.mode = field?.valueKind === "enum" || field?.valueKind === "boolean" ? "categories"
                : field?.valueKind === "number" || field?.valueKind === "integer" ? "gradient" : "solid";
            const initialized = autoInitializeSearchStyleColorDraft(draft, field, () => ++nextId);
            draft = initialized.success ? initialized.draft : {...draft, mode: "solid"};

            rules.push(...codec.fromDrafts(([['point'], ['line', 'surface']] as const).map(geometry => ({
                id: ++nextId,
                name: field ? `Auto: ${field.attrName}.${field.value}` : "Auto: solid",
                autoGenerated: true,
                applicability,
                filters: owner ? [
                    {id: ++nextId, attributeField: "$name", operator: "=", filterValue: owner.attrName},
                    {id: ++nextId, attributeField: "$feature.typeId", operator: "=", filterValue: owner.featureType},
                    {id: ++nextId, attributeField: "$layer", operator: "=", filterValue: owner.attrLayerName}
                ] : [],
                visualization: [...geometry],
                lineWidth: 5,
                pointRadius: 20,
                opacity: 60,
                labelExpression: "",
                labelBackgroundColor: "#111827",
                color: draft
            }))).map(rule => ({...rule,
                valueMeaning: field?.schemaType && rule.color.mode !== "solid"
                    ? JSON.stringify([field.valueKind, schemaScalarMeaning(field.schemaType)]) : undefined,
                symbolicCategories: field?.valueKind === "enum" && !!field.schemaType &&
                    schemaScalarMeaning(field.schemaType) === "symbolic-categories"
            })));
        }
        groups.push(rules);
    }
    return groups.flat();
}

/**
 * Merge equal automatic appearances and keep only conditions needed to
 * distinguish them within the prepared search. For example, Road and Lane
 * can share `$name == "MOVABLE_WARNING_SIGN"`; their map, feature type and
 * attribute-layer names add nothing when WARNING_SIGN is the only competitor.
 * If every context uses the same appearance, the search already supplies all
 * membership restrictions and the rule needs no additional filter.
 *
 * These are freshly generated equality selectors, not arbitrary user Simfil.
 * Edited rules do not enter this helper. Equivalent source types share one
 * scale with several accepted identities. Symbolic category catalogs can grow
 * independently: union their labels, whose generated colors are deterministic.
 * Numeric units, ranges and special values still need to agree.
 */
export function combinePreparedSearchAutoStyles(
    groups: readonly PreparedAutoStyleRule[][]
): FeatureSearchStyleRule[] {
    const allRules = groups.flat();
    const mixedScopes = new Set(allRules.map(rule => rule.applicability?.scope)).size > 1;
    // Feature and attribute predicates evaluate at different roots. Preserve
    // per-source applicability when a search uses both; within one scope the
    // request already routes the rules to its selected map/layer coverage.
    const partitions = mixedScopes ? groups : [allRules];
    return partitions.flatMap(partition => {
        const rows = partition.map(rule => {
            const source = rule.applicability;
            const prefix = source?.scope === "attribute" ? "$feature." : "";
            const selectors: FeatureSearchRuleFilter[] = [
                ...(source ? [
                    {field: `${prefix}mapId`, op: "=" as const, value: source.mapId},
                    {field: `${prefix}layerId`, op: "=" as const, value: source.layerId}
                ] : []),
                ...rule.filter
            ];
            return {
                rule,
                selectors,
                context: new Map(selectors.map(selector => [selector.field, selector.value])),
                contextKey: JSON.stringify(selectors),
                appearance: JSON.stringify({
                    ...rule,
                    color: rule.color.mode !== "solid" && rule.valueMeaning
                        ? {...rule.color, schemaTypes: undefined,
                            ...(rule.symbolicCategories ? {stops: undefined} : {})} : rule.color,
                    name: undefined,
                    filter: undefined,
                    applicability: undefined
                }),
                // Prefer attribute names over deployment-specific routing and
                // owner layout when either would distinguish the same styles.
                removalOrder: [`${prefix}mapId`, `${prefix}layerId`, "$feature.typeId", "$layer", "$name"]
            };
        });

        const matching = new Map<string, typeof rows>();
        for (const row of rows) {
            const appearance = matching.get(row.appearance) ?? [];
            appearance.push(row);
            matching.set(row.appearance, appearance);
        }
        return [...matching.values()].map(appearance => {
            const first = appearance[0].rule;
            let color = first.color.mode !== "solid" && first.valueMeaning
                ? {...first.color, schemaTypes: [...new Map(appearance.flatMap(({rule}) =>
                    rule.color.mode === "solid" ? [] : (rule.color.schemaTypes ?? []).map(type =>
                        [`${type.schemaId}:${type.typeId}`, type] as const))).values()]}
                : first.color;
            if (color.mode === "categories" && first.symbolicCategories) {
                // These stops were generated together, never edited by a user.
                // Equal labels have equal colors even when one schema adds or
                // removes other labels. Keep all known entries in the editor.
                const stops = new Map(appearance.flatMap(({rule}) =>
                    rule.color.mode === "categories" ? rule.color.stops.map(stop => [stop.value, stop] as const) : []));
                color = {...color, stops: [...stops.values()].sort((a, b) => String(a.value).localeCompare(String(b.value)))};
            }
            const owners = new Set(appearance.map(row => row.contextKey));
            const competitors = rows.filter(row =>
                !owners.has(row.contextKey) &&
                row.rule.geometry.some(kind => first.geometry.includes(kind)));
            const alternatives = new Map<string, FeatureSearchRuleFilter[]>();
            for (const row of appearance) {
                let selectors = row.selectors;
                for (const field of row.removalOrder) {
                    const reduced = selectors.filter(selector => selector.field !== field);
                    // Dropping a condition is safe only if it admits no context
                    // that requires a different field, scale or solid fallback.
                    if (!competitors.some(other => reduced.every(selector =>
                        other.context.get(selector.field) === selector.value))) {
                        selectors = reduced;
                    }
                }
                alternatives.set(searchStyleFilterExpression(selectors), selectors);
            }

            // Keep a single conjunction as ordinary editable filter rows.
            // Only genuinely distinct alternatives need a custom OR expression.
            let filter: FeatureSearchRuleFilter[] = [];
            if (!alternatives.has("")) {
                filter = alternatives.size === 1 ? [...alternatives.values()][0] : [{
                    field: [...alternatives.keys()].join(" or "),
                    op: "=",
                    value: true,
                    customExpression: true
                }];
            }
            const {valueMeaning: _proof, symbolicCategories: _symbols, ...persisted} = first;
            return {
                ...persisted,
                color,
                name: filter.length ? first.name
                    : `Auto: ${first.color.mode === "solid" ? "solid" : first.color.field}`,
                applicability: mixedScopes ? first.applicability : undefined,
                filter
            };
        });
    });
}
