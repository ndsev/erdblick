import {dump} from "js-yaml";
import {parseDocument} from "yaml";

import {
    DEFAULT_FEATURE_SEARCH_LABEL_BACKGROUND_COLOR,
    FeatureSearchColorMode,
    FeatureSearchGeometryKind,
    FeatureSearchRuleFilter,
    FeatureSearchStyleRule
} from "../shared/feature-search-state";
import {searchStyleColorProperties} from "./search-style-color.util";

const SUPPORTED_SEARCH_STYLE_OPERATORS = new Set(["=", "!=", "<", "<=", ">", ">=", "contains"]);
const ALL_GEOMETRY_TYPES = ["point", "line", "polygon", "mesh", "aabb", "gltf"];
const SEARCH_STYLE_VISIBILITY_OPTION_ID = "showSearchStyle";
const SEARCH_STYLE_VISIBILITY_FILTER = `${SEARCH_STYLE_VISIBILITY_OPTION_ID} == true`;
const SUPPORTED_RULE_KEYS = new Set([
    "geometry",
    "scope",
    "filter",
    "attribute-filter",
    "color",
    "color-scale",
    "width",
    "opacity",
    "label-text-expression",
    "label-color",
    "label-opacity",
    "label-scale",
    "label-outline-color",
    "label-outline-width",
    "label-background-color",
    "label-background-padding",
    "billboard",
    "depth-test"
]);

export type StyleSheetCategory = "base" | "search";
export type QuickStyleSupport = "full" | "partial";

export interface CanonicalSearchStyleSheet {
    styleId: string;
    filename: string;
    source: string;
}

export interface SearchStyleSaveOptions {
    name: string;
    defaultEnabled: boolean;
    layerIds: readonly string[];
}

export interface QuickStyleWarning {
    sourceIndex: number;
    path: string;
    code: string;
    message: string;
    effect: "preserved" | "rule-read-only" | "quick-disabled" | "omitted-from-search";
}

export type QuickStyleLayerAffinity =
    | {kind: "any"}
    | {kind: "exact"; layerIds: readonly string[]}
    | {kind: "custom"; expression: string};

export interface QuickStyleProjectedRule {
    sourceIndex: number;
    rule: FeatureSearchStyleRule;
    support: QuickStyleSupport;
    searchCompatible: boolean;
}

export interface QuickStyleProjection {
    name: string;
    layerAffinity: QuickStyleLayerAffinity;
    category: StyleSheetCategory;
    usesSearchStyleVisibilityOption: boolean;
    totalRuleCount: number;
    editableRules: QuickStyleProjectedRule[];
    readOnlyRuleIndices: number[];
    warnings: QuickStyleWarning[];
}

export interface QuickStyleMetadataPatch {
    name?: string;
    layerAffinity?: {kind: "any"} | {kind: "exact"; layerIds: readonly string[]};
}

export interface QuickStyleRuleUpdate {
    sourceIndex?: number;
    rule: FeatureSearchStyleRule;
}

export interface SearchStyleApplicationProjection {
    rules: FeatureSearchStyleRule[];
    omissions: QuickStyleWarning[];
    totalRuleCount: number;
}

/** Raised when canonical conversion or structural projection would lose data. */
export class SearchStyleConversionError extends Error {
    constructor(readonly issues: string[]) {
        super(issues.join(" "));
        this.name = "SearchStyleConversionError";
    }
}

/** Creates one deterministic, flat, ordinary stylesheet from detached search rules. */
export function convertSearchStyleRulesToYaml(
    options: SearchStyleSaveOptions,
    rules: readonly FeatureSearchStyleRule[]
): CanonicalSearchStyleSheet {
    const {name, defaultEnabled} = options;
    if (!name.trim()) {
        throw new SearchStyleConversionError(["A style name is required."]);
    }
    if (!rules.length) {
        throw new SearchStyleConversionError(["At least one high-fidelity rule is required."]);
    }
    assertCanonicalSearchStyleRules(rules);
    const layerIds = normalizedLayerAffinity(options.layerIds);
    const document: Record<string, unknown> = {
        name,
        category: "search",
        version: 2,
        default: defaultEnabled,
        options: [{
            label: searchStyleVisibilityOptionLabel(name),
            id: SEARCH_STYLE_VISIBILITY_OPTION_ID,
            type: "bool",
            default: true
        }],
        rules: rules.map(rule => addSearchStyleVisibilityGate(featureSearchRuleToStyleRule(rule)))
    };
    if (layerIds.length) {
        document["layer"] = canonicalLayerAffinityExpression(layerIds);
    }
    return {
        styleId: name,
        filename: canonicalSearchStyleFilename(name),
        source: dump(document, {
            noRefs: true,
            lineWidth: 120,
            sortKeys: false
        })
    };
}

/** Preserves exact layer IDs while producing deterministic affinity metadata. */
export function normalizedLayerAffinity(layerIds: readonly string[]): string[] {
    if (layerIds.some(layerId => layerId.length === 0)) {
        throw new SearchStyleConversionError(["Layer affinity cannot contain an empty layer ID."]);
    }
    return Array.from(new Set(layerIds)).sort();
}

/** Escapes one exact layer ID for the native ECMAScript regular-expression matcher. */
function escapeRegexLiteral(value: string): string {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Encodes exact layer IDs into the only regex form Quick treats as losslessly editable. */
export function canonicalLayerAffinityExpression(layerIds: readonly string[]): string {
    const normalized = normalizedLayerAffinity(layerIds);
    if (!normalized.length) {
        throw new SearchStyleConversionError(["At least one exact layer ID is required."]);
    }
    return `^(${normalized.map(escapeRegexLiteral).join("|")})$`;
}

/** Decodes only Erdblick's canonical exact-ID regex; arbitrary expressions remain custom. */
export function decodeCanonicalLayerAffinity(expression: string): string[] | undefined {
    if (!expression.startsWith("^(") || !expression.endsWith(")$")) {
        return undefined;
    }
    const body = expression.slice(2, -2);
    if (!body) {
        return undefined;
    }
    const values: string[] = [];
    let value = "";
    const escapable = new Set("\\^$.*+?()[]{}|");
    for (let index = 0; index < body.length; ++index) {
        const character = body[index];
        if (character === "|") {
            values.push(value);
            value = "";
            continue;
        }
        if (character !== "\\") {
            value += character;
            continue;
        }
        const escaped = body[++index];
        if (escaped === undefined || !escapable.has(escaped)) {
            return undefined;
        }
        value += escaped;
    }
    values.push(value);
    if (values.some(candidate => candidate.length === 0)) {
        return undefined;
    }
    try {
        return canonicalLayerAffinityExpression(values) === expression
            ? normalizedLayerAffinity(values)
            : undefined;
    } catch {
        return undefined;
    }
}

/** Returns a transport-safe filename without changing the stylesheet's exact YAML name. */
export function canonicalSearchStyleFilename(name: string): string {
    const sanitized = name
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100);
    const result = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized)
        ? `_${sanitized}`
        : sanitized;
    return `${result || "search-style"}.yaml`;
}

/** Converts one detached semantic rule to the native flat style-rule shape. */
export function featureSearchRuleToStyleRule(
    rule: FeatureSearchStyleRule,
    scope?: "feature" | "attribute"
): Record<string, unknown> {
    const label = hasOnlyGeometry(rule, "label");
    const point = hasOnlyGeometry(rule, "point");
    const opacity = clamp(Number(rule.opacity ?? 1), 0, 1);
    const width = Math.max(1, Number(
        label
            ? rule.width ?? 22
            : point
                ? rule.pointRadius ?? rule.width ?? 4
                : rule.width ?? 4
    ));
    const result: Record<string, unknown> = {
        geometry: geometryTypes(rule.geometry)
    };
    if (scope) {
        result["scope"] = scope;
    }
    const filter = conjunction(rule.filter);
    if (filter) {
        result[scope === "attribute" ? "attribute-filter" : "filter"] = filter;
    }
    Object.assign(result, searchStyleColorProperties(rule.color));
    result["width"] = width;
    result["opacity"] = label ? 0 : opacity;
    if (label && rule.labelExpression?.trim()) {
        result["label-text-expression"] = rule.labelExpression.trim();
        result["label-color"] = labelColor(rule.color);
        result["label-opacity"] = opacity;
        result["label-scale"] = Math.max(0.1, width / 14);
        result["label-outline-color"] = "#ffffff";
        result["label-outline-width"] = 2;
        result["label-background-color"] = rule.labelBackgroundColor
            ?? DEFAULT_FEATURE_SEARCH_LABEL_BACKGROUND_COLOR;
        result["label-background-padding"] = [2, 2];
        result["billboard"] = true;
        result["depth-test"] = false;
    }
    return result;
}

/** Projects all safely editable flat rules from an arbitrary stylesheet. */
export function projectStyleSourceToQuick(source: string): QuickStyleProjection {
    const parsed = parseStyleDocument(source);
    const root = parsed.root;
    const category = root["category"] === "search" ? "search" : "base";
    const rawRules = root["rules"];
    if (typeof root["name"] !== "string") {
        throw new SearchStyleConversionError(["The stylesheet name property must be a string."]);
    }
    const rawLayer = root["layer"];
    if (rawLayer !== undefined && typeof rawLayer !== "string") {
        throw new SearchStyleConversionError(["The stylesheet layer property must be a string."]);
    }
    const exactLayerIds = typeof rawLayer === "string"
        ? decodeCanonicalLayerAffinity(rawLayer)
        : undefined;
    const usesSearchStyleVisibilityOption = category === "search"
        && hasSearchStyleVisibilityOption(root["options"]);
    if (!Array.isArray(rawRules)) {
        throw new SearchStyleConversionError(["The stylesheet rules property must be a list."]);
    }

    const editableRules: QuickStyleProjectedRule[] = [];
    const readOnlyRuleIndices: number[] = [];
    const warnings: QuickStyleWarning[] = [];
    rawRules.forEach((rawRule, sourceIndex) => {
        const projected = projectRule(rawRule, sourceIndex, usesSearchStyleVisibilityOption);
        warnings.push(...projected.warnings);
        if (projected.rule) {
            editableRules.push({
                sourceIndex,
                rule: projected.rule,
                support: projected.warnings.length ? "partial" : "full",
                searchCompatible: projected.searchCompatible
            });
        } else {
            readOnlyRuleIndices.push(sourceIndex);
        }
    });
    return {
        name: root["name"],
        layerAffinity: rawLayer === undefined
            ? {kind: "any"}
            : exactLayerIds
                ? {kind: "exact", layerIds: exactLayerIds}
                : {kind: "custom", expression: rawLayer},
        category,
        usesSearchStyleVisibilityOption,
        totalRuleCount: rawRules.length,
        editableRules,
        readOnlyRuleIndices,
        warnings
    };
}

/** Patches root Quick metadata without regenerating or normalizing unrelated YAML. */
export function updateStyleSourceMetadata(
    source: string,
    patch: QuickStyleMetadataPatch
): string {
    const {document, root} = parseStyleDocument(source);
    if (patch.name !== undefined) {
        document.set("name", patch.name);
        const optionIndex = root["category"] === "search"
            ? searchStyleVisibilityOptionIndex(root["options"])
            : undefined;
        if (optionIndex !== undefined) {
            document.setIn(
                ["options", optionIndex, "label"],
                searchStyleVisibilityOptionLabel(patch.name)
            );
        }
    }
    if (patch.layerAffinity?.kind === "any") {
        document.delete("layer");
    } else if (patch.layerAffinity?.kind === "exact") {
        document.set("layer", canonicalLayerAffinityExpression(patch.layerAffinity.layerIds));
    }
    return document.toString({lineWidth: 120});
}

/** Creates the detached Feature Search copy and reports every rule that was omitted. */
export function projectStyleSourceForSearch(
    source: string,
    scope: "feature" | "attribute"
): SearchStyleApplicationProjection {
    const quick = projectStyleSourceToQuick(source);
    const omissions: QuickStyleWarning[] = [];
    const rules: FeatureSearchStyleRule[] = [];
    const root = parseStyleDocument(source).root;
    const rawRules = root["rules"] as unknown[];

    for (let sourceIndex = 0; sourceIndex < rawRules.length; ++sourceIndex) {
        const projected = quick.editableRules.find(candidate => candidate.sourceIndex === sourceIndex);
        const rawValue = rawRules[sourceIndex];
        const raw: Record<string, unknown> | undefined = isRecord(rawValue)
            ? rawValue
            : undefined;
        const declaredScope = raw?.["scope"];
        if (declaredScope !== undefined && declaredScope !== scope) {
            omissions.push(omission(
                sourceIndex,
                "scope-incompatible",
                `declares ${String(declaredScope)} scope; this search uses ${scope} scope.`
            ));
            continue;
        }
        if (!projected) {
            omissions.push(omission(sourceIndex, "quick-read-only", "cannot be represented by the current rules GUI."));
            continue;
        }
        if (!projected.searchCompatible) {
            const reasons = quick.warnings
                .filter(warning => warning.path === `rules[${sourceIndex}]`
                    || warning.path.startsWith(`rules[${sourceIndex}].`))
                .map(warning => warning.message)
                .join(" ");
            omissions.push(omission(
                sourceIndex,
                "unsupported-search-rule",
                reasons || "contains styling that the current search rules GUI cannot represent."
            ));
            continue;
        }
        rules.push(structuredClone(projected.rule));
    }
    return {rules, omissions, totalRuleCount: quick.totalRuleCount};
}

/**
 * Applies Quick changes to the YAML AST. Untouched rules, unsupported keys,
 * comments, root metadata, and document ordering remain authoritative.
 */
export function updateStyleSourceFromQuick(
    source: string,
    projection: QuickStyleProjection,
    updates: readonly QuickStyleRuleUpdate[]
): string {
    const {document, root} = parseStyleDocument(source);
    const rawRules = root["rules"];
    if (!Array.isArray(rawRules)) {
        throw new SearchStyleConversionError(["The stylesheet rules property must be a list."]);
    }

    const updateByIndex = new Map<number, FeatureSearchStyleRule>();
    const added: FeatureSearchStyleRule[] = [];
    for (const update of updates) {
        if (update.sourceIndex === undefined) {
            added.push(update.rule);
        } else {
            updateByIndex.set(update.sourceIndex, update.rule);
        }
    }

    for (const projected of projection.editableRules) {
        const updated = updateByIndex.get(projected.sourceIndex);
        if (!updated) {
            continue;
        }
        patchProjectedRule(
            document,
            rawRules[projected.sourceIndex],
            projected.sourceIndex,
            projected.rule,
            updated,
            projection.usesSearchStyleVisibilityOption
        );
    }

    const deletedIndices = projection.editableRules
        .map(projected => projected.sourceIndex)
        .filter(sourceIndex => !updateByIndex.has(sourceIndex))
        .sort((left, right) => right - left);
    for (const sourceIndex of deletedIndices) {
        document.deleteIn(["rules", sourceIndex]);
    }
    for (const rule of added) {
        assertCanonicalSearchStyleRules([rule]);
        const addedRule = featureSearchRuleToStyleRule(rule);
        document.addIn(
            ["rules"],
            projection.usesSearchStyleVisibilityOption
                ? addSearchStyleVisibilityGate(addedRule)
                : addedRule
        );
    }
    return document.toString({lineWidth: 120});
}

interface ParsedStyleDocument {
    document: ReturnType<typeof parseDocument>;
    root: Record<string, unknown>;
}

function parseStyleDocument(source: string): ParsedStyleDocument {
    const document = parseDocument(source, {
        keepSourceTokens: true,
        prettyErrors: true
    });
    if (document.errors.length) {
        throw new SearchStyleConversionError(document.errors.map(error => error.message));
    }
    const root = document.toJS({maxAliasCount: 100});
    if (!isRecord(root)) {
        throw new SearchStyleConversionError(["The stylesheet root must be a map."]);
    }
    return {document, root};
}

interface ProjectedRuleResult {
    rule?: FeatureSearchStyleRule;
    warnings: QuickStyleWarning[];
    searchCompatible: boolean;
}

function projectRule(
    rawValue: unknown,
    sourceIndex: number,
    usesSearchStyleVisibilityOption = false
): ProjectedRuleResult {
    const path = `rules[${sourceIndex}]`;
    if (!isRecord(rawValue)) {
        return readOnlyRule(sourceIndex, path, "rule-not-map", "is not a rule map.");
    }
    const raw = {...rawValue};
    if (usesSearchStyleVisibilityOption) {
        for (const filterKey of ["filter", "attribute-filter"] as const) {
            const stripped = removeSearchStyleVisibilityGate(raw[filterKey]);
            if (stripped === undefined) {
                delete raw[filterKey];
            } else {
                raw[filterKey] = stripped;
            }
        }
    }
    if ("first-of" in raw || "all-of" in raw) {
        const branch = "first-of" in raw ? "first-of" : "all-of";
        return readOnlyRule(sourceIndex, `${path}.${branch}`, "branch-rule", `uses ${branch}; nested rule trees are read-only in Quick.`);
    }
    if (raw["scope"] === "relation") {
        return readOnlyRule(sourceIndex, `${path}.scope`, "relation-scope", "uses relation scope, which is read-only in Quick.");
    }

    const label = typeof raw["label-text-expression"] === "string";
    if (label && !String(raw["label-text-expression"]).trim()) {
        return readOnlyRule(sourceIndex, `${path}.label-text-expression`, "empty-label-expression", "uses an empty label expression.");
    }
    const geometry = label ? ["label"] as FeatureSearchGeometryKind[] : geometryFromStyle(raw["geometry"]);
    if (!geometry) {
        return readOnlyRule(sourceIndex, `${path}.geometry`, "unsupported-geometry", "uses a geometry combination that Quick cannot represent.");
    }
    if ((raw["width"] !== undefined && !isFiniteNumber(raw["width"]))
        || (raw["opacity"] !== undefined && !isFiniteNumber(raw["opacity"]))
        || (raw["label-opacity"] !== undefined && !isFiniteNumber(raw["label-opacity"]))) {
        return readOnlyRule(sourceIndex, path, "dynamic-number", "uses a non-literal width or opacity.");
    }
    const point = geometry.length === 1 && geometry[0] === "point";
    const widthLimit = label ? 96 : point ? 128 : 32;
    if (isFiniteNumber(raw["width"]) && (raw["width"] < 1 || raw["width"] > widthLimit)) {
        return readOnlyRule(sourceIndex, `${path}.width`, "width-outside-quick-range", "uses a width outside the current Quick control range.");
    }
    for (const colorKey of ["label-color", "label-background-color"] as const) {
        if (raw[colorKey] !== undefined
            && (typeof raw[colorKey] !== "string" || !normalizeHexLiteral(raw[colorKey]))) {
            return readOnlyRule(sourceIndex, `${path}.${colorKey}`, "unsupported-color", "uses a color the current picker cannot represent.");
        }
    }
    if (raw["filter"] !== undefined && typeof raw["filter"] !== "string") {
        return readOnlyRule(sourceIndex, `${path}.filter`, "dynamic-filter", "uses a non-scalar feature filter.");
    }
    if (raw["attribute-filter"] !== undefined && typeof raw["attribute-filter"] !== "string") {
        return readOnlyRule(sourceIndex, `${path}.attribute-filter`, "dynamic-filter", "uses a non-scalar attribute filter.");
    }
    if (raw["filter"] !== undefined && raw["attribute-filter"] !== undefined) {
        return readOnlyRule(sourceIndex, path, "multiple-filters", "defines both filter and attribute-filter.");
    }

    const color = colorFromStyle(raw);
    if (!color) {
        return readOnlyRule(sourceIndex, path, "unsupported-color", "uses a dynamic or malformed color representation.");
    }
    const filterExpression = raw["attribute-filter"] ?? raw["filter"];
    const width = isFiniteNumber(raw["width"])
        ? raw["width"]
        : label ? 22 : 4;
    const opacitySource = label ? raw["label-opacity"] : raw["opacity"];
    const opacity = isFiniteNumber(opacitySource) ? opacitySource : 1;
    const rule: FeatureSearchStyleRule = {
        geometry,
        filter: typeof filterExpression === "string" && filterExpression.trim()
            ? [{
                field: filterExpression.trim(),
                op: "=",
                value: true,
                customExpression: true
            }]
            : [],
        color,
        width,
        ...(point ? {pointRadius: width} : {}),
        opacity,
        ...(label ? {
            labelExpression: String(raw["label-text-expression"]),
            labelCustomExpression: true,
            labelBackgroundColor: typeof raw["label-background-color"] === "string"
                ? normalizeHexLiteral(raw["label-background-color"])!
                : DEFAULT_FEATURE_SEARCH_LABEL_BACKGROUND_COLOR
        } : {})
    };

    const warnings: QuickStyleWarning[] = [];
    for (const key of Object.keys(raw)) {
        if (!SUPPORTED_RULE_KEYS.has(key)) {
            warnings.push(preservedWarning(sourceIndex, path, key));
        }
    }
    if (raw["scope"] !== undefined) {
        warnings.push({
            sourceIndex,
            path: `${path}.scope`,
            code: "scope-preserved",
            message: `${path}.scope is not editable in Quick and will be preserved.`,
            effect: "preserved"
        });
    }
    warnings.push(...labelCompatibilityWarnings(raw, sourceIndex, rule));
    return {
        rule,
        warnings,
        searchCompatible: warnings.every(warning => warning.code === "scope-preserved")
    };
}

function patchProjectedRule(
    document: ReturnType<typeof parseDocument>,
    rawValue: unknown,
    sourceIndex: number,
    original: FeatureSearchStyleRule,
    updated: FeatureSearchStyleRule,
    usesSearchStyleVisibilityOption: boolean
): void {
    const raw = isRecord(rawValue) ? rawValue : {};
    const scope = raw["scope"] === "attribute" ? "attribute" : "feature";
    const target = featureSearchRuleToStyleRule(updated, scope);
    delete target["scope"];
    if (usesSearchStyleVisibilityOption) {
        addSearchStyleVisibilityGate(target);
    }
    const path = (key: string) => ["rules", sourceIndex, key];
    const sync = (keys: string[]) => {
        for (const key of keys) {
            if (target[key] === undefined) {
                document.deleteIn(path(key));
            } else {
                document.setIn(path(key), target[key]);
            }
        }
    };

    if (!same(original.geometry, updated.geometry)) {
        sync(["geometry"]);
        if (hasOnlyGeometry(original, "label") || hasOnlyGeometry(updated, "label")) {
            sync([
                "opacity",
                "label-text-expression",
                "label-color",
                "label-opacity",
                "label-scale",
                "label-outline-color",
                "label-outline-width",
                "label-background-color",
                "label-background-padding",
                "billboard",
                "depth-test"
            ]);
        }
    }
    if (!same(original.filter, updated.filter)) {
        sync(["filter", "attribute-filter"]);
    }
    if (!same(original.color, updated.color)) {
        sync(["color", "color-scale"]);
        if (hasOnlyGeometry(updated, "label")) {
            sync(["label-color"]);
        }
    }
    if (styleWidth(original) !== styleWidth(updated)) {
        sync(["width"]);
        if (hasOnlyGeometry(updated, "label")) {
            sync(["label-scale"]);
        }
    }
    if (Number(original.opacity ?? 1) !== Number(updated.opacity ?? 1)) {
        sync(["opacity", "label-opacity"]);
    }
    if (original.labelExpression !== updated.labelExpression) {
        sync(["label-text-expression"]);
    }
    if (original.labelBackgroundColor !== updated.labelBackgroundColor) {
        sync(["label-background-color"]);
    }
}

/** Builds the user-facing label while keeping the option's internal ID stable. */
function searchStyleVisibilityOptionLabel(styleName: string): string {
    return `Show ${styleName}`;
}

/** Finds only the generated, local Boolean option whose filter gate Quick owns. */
function searchStyleVisibilityOptionIndex(value: unknown): number | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const index = value.findIndex(option =>
        isRecord(option)
        && option["id"] === SEARCH_STYLE_VISIBILITY_OPTION_ID
        && option["type"] === "bool");
    return index >= 0 ? index : undefined;
}

/** Recognizes only the generated, local Boolean option whose filter gate Quick owns. */
function hasSearchStyleVisibilityOption(value: unknown): boolean {
    return searchStyleVisibilityOptionIndex(value) !== undefined;
}

/** Makes a saved stylesheet option functional by applying it to one flat rule. */
function addSearchStyleVisibilityGate(rule: Record<string, unknown>): Record<string, unknown> {
    const filterKey = rule["scope"] === "attribute" || rule["attribute-filter"] !== undefined
        ? "attribute-filter"
        : "filter";
    const existingFilter = rule[filterKey];
    rule[filterKey] = typeof existingFilter === "string" && existingFilter.trim()
        ? `${SEARCH_STYLE_VISIBILITY_FILTER} and (${existingFilter})`
        : SEARCH_STYLE_VISIBILITY_FILTER;
    return rule;
}

/** Removes only the canonical generated gate before presenting a rule as detached/Quick data. */
function removeSearchStyleVisibilityGate(value: unknown): unknown {
    if (value === SEARCH_STYLE_VISIBILITY_FILTER) {
        return undefined;
    }
    if (typeof value !== "string") {
        return value;
    }
    const prefix = `${SEARCH_STYLE_VISIBILITY_FILTER} and (`;
    if (!value.startsWith(prefix)) {
        return value;
    }
    let depth = 1;
    let quote = "";
    for (let index = prefix.length; index < value.length; ++index) {
        const character = value[index];
        if (quote) {
            if (character === "\\") {
                ++index;
            } else if (character === quote) {
                quote = "";
            }
            continue;
        }
        if (character === "\"" || character === "'") {
            quote = character;
        } else if (character === "(") {
            ++depth;
        } else if (character === ")" && --depth === 0) {
            return index === value.length - 1
                ? value.slice(prefix.length, index)
                : value;
        }
    }
    return value;
}

function colorFromStyle(raw: Record<string, unknown>): FeatureSearchColorMode | undefined {
    if (raw["color-expression"] !== undefined) {
        return undefined;
    }
    if (raw["color-scale"] !== undefined) {
        if (!isRecord(raw["color-scale"])) {
            return undefined;
        }
        const scale = raw["color-scale"];
        const mode = scale["mode"];
        const expression = scale["expression"];
        const stops = scale["stops"];
        if ((mode !== "linear" && mode !== "categorical")
            || typeof expression !== "string"
            || !Array.isArray(stops)) {
            return undefined;
        }
        const parsedStops: Array<{value: unknown; color: string}> = [];
        for (const stop of stops) {
            if (!Array.isArray(stop)
                || stop.length !== 2
                || !isSearchStyleScalar(stop[0])
                || typeof stop[1] !== "string"
                || !normalizeHexLiteral(stop[1])
                || (mode === "linear" && !isFiniteNumber(stop[0]))) {
                return undefined;
            }
            parsedStops.push({value: stop[0], color: normalizeHexLiteral(stop[1])!});
        }
        const fallback = scale["fallback"];
        if (fallback !== undefined && (typeof fallback !== "string" || !normalizeHexLiteral(fallback))) {
            return undefined;
        }
        return {
            mode: mode === "linear" ? "gradient" : "categories",
            field: expression,
            customField: true,
            stops: parsedStops,
            ...(typeof fallback === "string" ? {fallbackColor: normalizeHexLiteral(fallback)!} : {})
        };
    }
    if (raw["color"] !== undefined
        && (typeof raw["color"] !== "string" || !normalizeHexLiteral(raw["color"]))) {
        return undefined;
    }
    const labelColorValue = typeof raw["label-color"] === "string"
        ? normalizeHexLiteral(raw["label-color"])
        : undefined;
    return {
        mode: "solid",
        color: typeof raw["color"] === "string"
            ? normalizeHexLiteral(raw["color"])!
            : labelColorValue ?? "#ffffff"
    };
}

function geometryFromStyle(value: unknown): FeatureSearchGeometryKind[] | undefined {
    if (value === undefined) {
        return ["any"];
    }
    if (value === "point" || value === "line") {
        return [value];
    }
    if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
        return undefined;
    }
    const actual = new Set(value);
    const matches = (expected: readonly string[]) =>
        actual.size === expected.length && expected.every(item => actual.has(item));
    if (matches(ALL_GEOMETRY_TYPES)) return ["any"];

    const geometries: FeatureSearchGeometryKind[] = [];
    if (actual.delete("point")) geometries.push("point");
    if (actual.delete("line")) geometries.push("line");
    const includes = (types: readonly string[]) => types.every(type => actual.has(type));
    const remove = (types: readonly string[]) => types.forEach(type => actual.delete(type));
    const surfaceTypes = ["polygon", "mesh", "aabb", "gltf"];
    if (includes(surfaceTypes)) {
        geometries.push("surface");
        remove(surfaceTypes);
    } else {
        const polygonTypes = ["polygon", "aabb"];
        const meshTypes = ["mesh", "gltf"];
        if (includes(polygonTypes)) {
            geometries.push("polygon");
            remove(polygonTypes);
        }
        if (includes(meshTypes)) {
            geometries.push("mesh");
            remove(meshTypes);
        }
    }
    return geometries.length > 0 && actual.size === 0 ? geometries : undefined;
}

function labelCompatibilityWarnings(
    raw: Record<string, unknown>,
    sourceIndex: number,
    rule: FeatureSearchStyleRule
): QuickStyleWarning[] {
    if (!hasOnlyGeometry(rule, "label")) {
        return [];
    }
    const path = `rules[${sourceIndex}]`;
    const expected = featureSearchRuleToStyleRule(rule);
    const warnings: QuickStyleWarning[] = [];
    for (const key of [
        "label-color",
        "label-scale",
        "label-outline-color",
        "label-outline-width",
        "label-background-padding",
        "billboard",
        "depth-test"
    ]) {
        if (raw[key] !== undefined && !same(raw[key], expected[key])) {
            warnings.push({
                sourceIndex,
                path: `${path}.${key}`,
                code: "custom-label-property",
                message: `${path}.${key} is outside the current Quick controls and will be preserved.`,
                effect: "preserved"
            });
        }
    }
    return warnings;
}

function readOnlyRule(
    sourceIndex: number,
    path: string,
    code: string,
    reason: string
): ProjectedRuleResult {
    return {
        warnings: [{
            sourceIndex,
            path,
            code,
            message: `${path} ${reason}`,
            effect: "rule-read-only"
        }],
        searchCompatible: false
    };
}

function preservedWarning(sourceIndex: number, path: string, key: string): QuickStyleWarning {
    return {
        sourceIndex,
        path: `${path}.${key}`,
        code: "unsupported-property",
        message: `${path}.${key} is not editable in Quick and will be preserved.`,
        effect: "preserved"
    };
}

function omission(sourceIndex: number, code: string, reason: string): QuickStyleWarning {
    const path = `rules[${sourceIndex}]`;
    return {
        sourceIndex,
        path,
        code,
        message: `${path} ${reason}`,
        effect: "omitted-from-search"
    };
}

function assertCanonicalSearchStyleRules(rules: readonly FeatureSearchStyleRule[]): void {
    const issues: string[] = [];
    rules.forEach((rule, ruleIndex) => {
        rule.filter.forEach((filter, filterIndex) => {
            const path = `Rule ${ruleIndex + 1}, filter ${filterIndex + 1}`;
            if (!filter.customExpression && !SUPPORTED_SEARCH_STYLE_OPERATORS.has(filter.op)) {
                issues.push(`${path} uses unsupported operator “${filter.op}”.`);
            }
            if (!filter.customExpression && !isSearchStyleScalar(filter.value)) {
                issues.push(`${path} has a non-scalar comparison value.`);
            }
        });
        for (const [property, value] of [["width", rule.width], ["pointRadius", rule.pointRadius], ["opacity", rule.opacity]] as const) {
            if (value !== undefined && !isFiniteNumber(value)) {
                issues.push(`Rule ${ruleIndex + 1} has a non-finite ${property}.`);
            }
        }
        if (rule.color.mode === "gradient") {
            rule.color.stops.forEach((stop, stopIndex) => {
                if (!isFiniteNumber(stop.value)) {
                    issues.push(`Rule ${ruleIndex + 1}, gradient stop ${stopIndex + 1} must have a finite numeric value.`);
                }
            });
        } else if (rule.color.mode === "categories") {
            rule.color.stops.forEach((stop, stopIndex) => {
                if (!isSearchStyleScalar(stop.value)) {
                    issues.push(`Rule ${ruleIndex + 1}, category stop ${stopIndex + 1} has a non-scalar value.`);
                }
            });
        }
    });
    if (issues.length) {
        throw new SearchStyleConversionError(issues);
    }
}

function conjunction(filters: readonly FeatureSearchRuleFilter[]): string {
    const activeFilters = filters.filter(filter => filter.field.trim());
    const expressions = activeFilters
        .map(filterExpression)
        .filter(Boolean);
    if (expressions.length === 1) {
        return expressions[0];
    }
    return expressions.map(expression => `(${expression})`).join(" and ");
}

function filterExpression(filter: FeatureSearchRuleFilter): string {
    const field = filter.field.trim();
    if (filter.customExpression) {
        return field;
    }
    const literal = simfilLiteral(filter.value);
    switch (filter.op) {
        case "=":
            return `${field} == ${literal}`;
        case "!=":
        case "<":
        case "<=":
        case ">":
        case ">=":
            return `${field} ${filter.op} ${literal}`;
        case "contains": {
            const escaped = String(filter.value ?? "")
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return `${field} == re(${JSON.stringify(`.*${escaped}.*`)})`;
        }
        default:
            return "false";
    }
}

function simfilLiteral(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (isFiniteNumber(value)) return String(value);
    return JSON.stringify(String(value ?? ""));
}

function geometryTypes(kinds: readonly FeatureSearchGeometryKind[]): string[] {
    const result = new Set<string>();
    for (const kind of kinds) {
        switch (kind) {
            case "point": result.add("point"); break;
            case "line": result.add("line"); break;
            case "surface": ["polygon", "mesh", "aabb", "gltf"].forEach(type => result.add(type)); break;
            case "polygon": ["polygon", "aabb"].forEach(type => result.add(type)); break;
            case "mesh": ["mesh", "gltf"].forEach(type => result.add(type)); break;
            case "label":
            case "any":
                return [...ALL_GEOMETRY_TYPES];
        }
    }
    return ALL_GEOMETRY_TYPES.filter(type => result.has(type));
}

function labelColor(color: FeatureSearchColorMode): string {
    if (color.mode === "solid") return color.color;
    return color.fallbackColor ?? color.stops[0]?.color ?? "#ffffff";
}

function styleWidth(rule: FeatureSearchStyleRule): number {
    return Number(hasOnlyGeometry(rule, "point") ? rule.pointRadius ?? rule.width ?? 4 : rule.width ?? 4);
}

function hasOnlyGeometry(rule: FeatureSearchStyleRule, geometry: FeatureSearchGeometryKind): boolean {
    return rule.geometry.length === 1 && rule.geometry[0] === geometry;
}

function isSearchStyleScalar(value: unknown): value is string | number | boolean | null {
    return value === null
        || typeof value === "string"
        || typeof value === "boolean"
        || isFiniteNumber(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function normalizeHexLiteral(value: string): string | undefined {
    const long = /^#([0-9a-f]{6})$/i.exec(value.trim());
    if (long) {
        return `#${long[1].toLowerCase()}`;
    }
    const short = /^#([0-9a-f]{3})$/i.exec(value.trim());
    if (!short) {
        return undefined;
    }
    const [red, green, blue] = short[1].toLowerCase().split("");
    return `#${red}${red}${green}${green}${blue}${blue}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function same(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}
