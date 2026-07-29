import type {FeatureLayerStyle} from "../../build/libs/core/erdblick-core";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import type {
    ErdblickStyle
} from "../styledata/style.service";
import type {
    FeatureSearchColorMode,
    FeatureSearchGeometryKind,
    FeatureSearchRuleFilter,
    FeatureSearchStyleRule
} from "../shared/feature-search-state";
import type {
    FeatureSearchResolvedDefinition
} from "../mapdata/feature-search-runtime-state.model";
import type {MapgetLayer} from "../mapdata/mapget-layer.model";
import type {MapInfoService} from "../mapdata/map-info.service";
import type {
    FilterChannelDefinition
} from "../mapdata/filter-subscription.model";
import type {
    StyleFilterPlan
} from "../mapdata/styled-mapget-layer.model";

export interface CompiledFeatureSearchStyle {
    source: string;
    style: ErdblickStyle;
    filterPlan: StyleFilterPlan;
    channelOrdinal: 0;
    resultFields: string[];
}

/** Compile the search editor's purpose-built state into one ordinary style channel. */
export function compileFeatureSearchStyle(
    definition: FeatureSearchResolvedDefinition,
    mapgetLayer: MapgetLayer,
    mapInfo: MapInfoService,
    featureTypes: readonly string[]
): CompiledFeatureSearchStyle {
    const sourceObject = {
        name: `Search/${definition.id}/${mapgetLayer.mapId}/${mapgetLayer.layerId}`,
        version: 2,
        rules: [syntheticSearchRule(
            definition.searchStyleRules,
            definition.concreteScope)]
    };
    const source = JSON.stringify(sourceObject);
    const featureLayerStyle = uint8ArrayToWasm(
        wasmBuffer => new coreLib.FeatureLayerStyle(wasmBuffer),
        new TextEncoder().encode(source)
    ) as FeatureLayerStyle;
    if (!featureLayerStyle?.isValid()) {
        const report = featureLayerStyle?.validationReport?.();
        featureLayerStyle?.delete?.();
        throw new Error(
            `Generated search stylesheet is invalid: ${JSON.stringify(report ?? {})}`
        );
    }

    const nativePlan = mapInfo.planStyleFilter(
        featureLayerStyle,
        mapgetLayer.mapId,
        mapgetLayer.layerId,
        coreLib.HighlightMode.NO_HIGHLIGHT.value,
        coreLib.RuleFidelity.ANY.value
    ) as StyleFilterPlan;
    if (!nativePlan.valid || nativePlan.channels.length !== 1) {
        featureLayerStyle.delete?.();
        throw new Error(
            `Generated search stylesheet did not produce exactly one channel: ${JSON.stringify(nativePlan.issues)}`
        );
    }

    const resultFields = [...new Set(definition.resultFields.map(field => field.trim()).filter(Boolean))];
    const channel = structuredClone(nativePlan.channels[0]) as FilterChannelDefinition;
    channel.channelId = "search-style:0";
    channel.scope = definition.concreteScope;
    channel.rewrite = false;
    channel.featureTypes = [...featureTypes];
    channel.entryFilter = definition.backendQuery;
    delete channel.featureFilter;
    const targetFields = definition.concreteScope === "feature"
        ? channel.featureFields
        : channel.entryFields;
    for (const field of resultFields) {
        if (!targetFields.includes(field)) {
            targetFields.push(field);
        }
    }

    const style: ErdblickStyle = {
        id: `search:${definition.id}:${mapgetLayer.key}`,
        modified: false,
        imported: false,
        additional: true,
        source,
        featureLayerStyle,
        options: [],
        shortId: "search",
        visible: true,
        url: "",
        sourceRef: {
            styleName: `Search/${definition.id}`,
            sourceKind: "editor"
        }
    };
    return {
        source,
        style,
        filterPlan: {
            valid: true,
            channels: [channel],
            issues: []
        },
        channelOrdinal: 0,
        resultFields
    };
}

function syntheticSearchRule(
    rules: readonly FeatureSearchStyleRule[],
    scope: "feature" | "attribute"
): Record<string, unknown> {
    const base: Record<string, unknown> = {
        scope,
        geometry: allGeometryTypes()
    };
    if (!rules.length) {
        // Keep the list channel complete while rendering no map contribution.
        base[scope === "attribute" ? "attribute-filter" : "filter"] = "false";
        base["color"] = "#000000";
        return base;
    }
    base["all-of"] = rules.map(rule => searchRule(rule, scope));
    return base;
}

function searchRule(
    rule: FeatureSearchStyleRule,
    scope: "feature" | "attribute"
): Record<string, unknown> {
    const label = rule.geometry === "label";
    const result: Record<string, unknown> = {
        geometry: geometryTypes(rule.geometry),
        width: label
            ? Math.max(1, Number(rule.width ?? 22))
            : Math.max(1, Number(
                rule.geometry === "point"
                    ? rule.pointRadius ?? rule.width ?? 4
                    : rule.width ?? 4)),
        opacity: label ? 0 : clamp(Number(rule.opacity ?? 1), 0, 1)
    };
    const filter = conjunction(rule.filter);
    if (filter) {
        result[scope === "attribute" ? "attribute-filter" : "filter"] = filter;
    }
    applyColor(result, rule.color);
    if (label && rule.labelExpression?.trim()) {
        result["label-text-expression"] = rule.labelExpression.trim();
        result["label-color"] = labelColor(rule.color);
        result["label-scale"] = Math.max(0.1, Number(rule.width ?? 22) / 14);
        result["label-outline-color"] = "#ffffffdc";
        result["label-outline-width"] = 2;
        result["label-background-color"] =
            rule.labelBackgroundColor ?? "#111827";
        result["label-background-padding"] = [2, 2];
        result["billboard"] = true;
        result["depth-test"] = false;
    }
    return result;
}

function applyColor(
    target: Record<string, unknown>,
    color: FeatureSearchColorMode
): void {
    if (color.mode === "solid") {
        target["color"] = color.color;
        return;
    }
    target["color-scale"] = {
        mode: color.mode === "gradient" ? "linear" : "categorical",
        expression: color.field,
        stops: color.stops.map(stop => [stop.value, stop.color]),
        ...(color.fallbackColor ? {fallback: color.fallbackColor} : {})
    };
}

function labelColor(color: FeatureSearchColorMode): string {
    if (color.mode === "solid") {
        return color.color;
    }
    return color.fallbackColor
        ?? color.stops[0]?.color
        ?? "#ffffff";
}

function conjunction(filters: readonly FeatureSearchRuleFilter[]): string {
    return filters
        .filter(filter => filter.field.trim())
        .map(filterExpression)
        .filter(Boolean)
        .map(expression => `(${expression})`)
        .join(" and ");
}

/** Build SIMFIL without interpolating unescaped string/regex literals. */
function filterExpression(filter: FeatureSearchRuleFilter): string {
    const field = filter.field.trim();
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
    if (value === null) {
        return "null";
    }
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return JSON.stringify(String(value ?? ""));
}

function geometryTypes(kind: FeatureSearchGeometryKind): string[] {
    switch (kind) {
        case "point":
            return ["point"];
        case "line":
            return ["line"];
        case "surface":
            return ["polygon", "mesh", "aabb", "gltf"];
        case "polygon":
            return ["polygon", "aabb"];
        case "mesh":
            return ["mesh", "gltf"];
        case "label":
        case "any":
            return allGeometryTypes();
    }
}

function allGeometryTypes(): string[] {
    return ["point", "line", "polygon", "mesh", "aabb", "gltf"];
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Number.isFinite(value)
        ? Math.min(maximum, Math.max(minimum, value))
        : minimum;
}
