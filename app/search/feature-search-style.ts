import type {FeatureLayerStyle} from "../../build/libs/core/erdblick-core";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import type {ErdblickStyle} from "../styledata/style.service";
import type {FeatureSearchStyleRule} from "../shared/feature-search-state";
import type {FeatureSearchResolvedDefinition} from "../mapdata/feature-search-runtime-state.model";
import type {MapgetLayer} from "../mapdata/mapget-layer.model";
import type {MapInfoService} from "../mapdata/map-info.service";
import type {FilterChannelDefinition} from "../mapdata/filter-subscription.model";
import type {StyleFilterPlan} from "../mapdata/styled-mapget-layer.model";
import {featureSearchRuleToStyleRule} from "./search-style-sheet.converter";

const ALL_GEOMETRY_TYPES = 0xffffffff;
export const FEATURE_SEARCH_RESULT_CHANNEL_PREFIX = "search-results:";

export interface CompiledFeatureSearchStyle {
    source: string;
    style: ErdblickStyle;
    filterPlan: StyleFilterPlan;
    resultChannelOrdinal: number;
    resultFields: string[];
}

export interface FeatureSearchFilterChannels {
    channels: FilterChannelDefinition[];
    resultChannelOrdinal: number;
}

/**
 * Compiles flat GUI rules into their native rendering channels and appends one
 * non-rendered channel used only for duplicate-free result-list ingestion.
 */
export function compileFeatureSearchStyle(
    definition: FeatureSearchResolvedDefinition,
    mapgetLayer: MapgetLayer,
    mapInfo: MapInfoService,
    featureTypes: readonly string[]
): CompiledFeatureSearchStyle {
    const hasRenderRules = definition.searchStyleRules.length > 0;
    const runtimeRules = hasRenderRules
        ? definition.searchStyleRules.map(rule =>
            featureSearchRuleToStyleRule(rule, definition.concreteScope))
        : [featureSearchRuleToStyleRule(invisiblePlaceholderRule(), definition.concreteScope)];
    const sourceObject = {
        name: `Search/${definition.id}/${mapgetLayer.mapId}/${mapgetLayer.layerId}`,
        category: "search",
        version: 2,
        default: false,
        rules: runtimeRules
    };
    const source = JSON.stringify(sourceObject);
    const featureLayerStyle = uint8ArrayToWasm(
        wasmBuffer => new coreLib.FeatureLayerStyle(wasmBuffer),
        new TextEncoder().encode(source)
    ) as FeatureLayerStyle;
    if (!featureLayerStyle?.isValid()) {
        const report = featureLayerStyle?.validationReport?.();
        featureLayerStyle?.delete?.();
        throw new Error(`Generated search stylesheet is invalid: ${JSON.stringify(report ?? {})}`);
    }

    const nativePlan = mapInfo.planStyleFilter(
        featureLayerStyle,
        mapgetLayer.mapId,
        mapgetLayer.layerId,
        coreLib.HighlightMode.NO_HIGHLIGHT.value,
        coreLib.RuleFidelity.ANY.value
    ) as StyleFilterPlan;
    if (!nativePlan.valid || nativePlan.channels.length !== runtimeRules.length) {
        featureLayerStyle.delete?.();
        throw new Error(
            `Generated flat search stylesheet produced ${nativePlan.channels.length} channel(s) for `
            + `${runtimeRules.length} rule(s): ${JSON.stringify(nativePlan.issues)}`
        );
    }

    const resultFields = [...new Set(definition.resultFields.map(field => field.trim()).filter(Boolean))];
    const channelPlan = buildFeatureSearchFilterChannels(
        hasRenderRules ? nativePlan.channels : [],
        definition.concreteScope,
        definition.backendQuery,
        featureTypes,
        resultFields,
        definition.id,
        mapgetLayer.key
    );
    const filterPlan: StyleFilterPlan = {
        valid: true,
        channels: channelPlan.channels,
        issues: []
    };

    const style: ErdblickStyle = {
        id: `search:${definition.id}:${mapgetLayer.key}`,
        modified: false,
        imported: false,
        additional: true,
        category: "search",
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
        filterPlan,
        resultChannelOrdinal: channelPlan.resultChannelOrdinal,
        resultFields
    };
}

/** Pure channel composition used by the runtime and regression tests. */
export function buildFeatureSearchFilterChannels(
    nativeRenderChannels: readonly FilterChannelDefinition[],
    scope: "feature" | "attribute",
    backendQuery: string,
    featureTypes: readonly string[],
    resultFields: readonly string[],
    searchId: string,
    presentationKey: string
): FeatureSearchFilterChannels {
    const renderChannels = nativeRenderChannels.map(channel =>
        prepareRenderChannel(channel, backendQuery, featureTypes));
    const resultChannel = createResultChannel(
        scope,
        backendQuery,
        featureTypes,
        resultFields,
        searchId,
        presentationKey
    );
    return {
        channels: [...renderChannels, resultChannel],
        resultChannelOrdinal: renderChannels.length
    };
}

function prepareRenderChannel(
    source: FilterChannelDefinition,
    backendQuery: string,
    selectedFeatureTypes: readonly string[]
): FilterChannelDefinition {
    const channel = structuredClone(source);
    channel.rewrite = false;
    const nativeFeatureTypes = channel.featureTypes;
    channel.featureTypes = intersectFeatureTypes(nativeFeatureTypes, selectedFeatureTypes);
    // An empty mapget featureTypes list means "all", not "none". Preserve a
    // genuinely empty intersection with an explicit impossible predicate.
    if (nativeFeatureTypes.length > 0
        && selectedFeatureTypes.length > 0
        && channel.featureTypes.length === 0) {
        channel.featureFilter = conjunction(channel.featureFilter, "false");
    }
    channel.entryFilter = conjunction(channel.entryFilter, backendQuery);
    return channel;
}

function createResultChannel(
    scope: "feature" | "attribute",
    backendQuery: string,
    featureTypes: readonly string[],
    resultFields: readonly string[],
    searchId: string,
    presentationKey: string
): FilterChannelDefinition {
    return {
        channelId: `${FEATURE_SEARCH_RESULT_CHANNEL_PREFIX}${searchId}:${presentationKey}`,
        scope,
        rewrite: false,
        featureTypes: [...featureTypes],
        featureFields: scope === "feature" ? [...resultFields] : [],
        entryFields: scope === "attribute" ? [...resultFields] : [],
        geometryTypes: ALL_GEOMETRY_TYPES,
        geometryName: "*",
        entryFilter: backendQuery
    };
}

function intersectFeatureTypes(
    nativeTypes: readonly string[],
    selectedTypes: readonly string[]
): string[] {
    if (!selectedTypes.length) {
        return [...nativeTypes];
    }
    if (!nativeTypes.length) {
        return [...selectedTypes];
    }
    const selected = new Set(selectedTypes);
    return nativeTypes.filter(type => selected.has(type));
}

function conjunction(left: string | undefined, right: string | undefined): string | undefined {
    const lhs = left?.trim();
    const rhs = right?.trim();
    if (!lhs) return rhs || undefined;
    if (!rhs || rhs === lhs) return lhs;
    return `(${lhs}) and (${rhs})`;
}

function invisiblePlaceholderRule(): FeatureSearchStyleRule {
    return {
        geometry: "any",
        filter: [{field: "false", op: "=", value: true, customExpression: true}],
        color: {mode: "solid", color: "#000000"},
        opacity: 0
    };
}
