import {beforeAll, describe, expect, it} from "vitest";

import type {FilterChannelDefinition} from "../mapdata/filter-subscription.model";
import {
    buildFeatureSearchFilterChannels,
    compileFeatureSearchStyle,
    FEATURE_SEARCH_RESULT_CHANNEL_PREFIX
} from "./feature-search-style";

import {coreLib, initializeLibrary, uint8ArrayToWasmOrThrow} from "../integrations/wasm";
import {createFeatureSearchStateEntry} from "../shared/feature-search-state";
import type {TileLayerParser} from "../../build/libs/core/erdblick-core";

function channel(overrides: Partial<FilterChannelDefinition>): FilterChannelDefinition {
    return {
        channelId: "style-rule:0",
        scope: "feature",
        rewrite: true,
        featureTypes: ["Road", "Lane"],
        featureFields: ["styleField"],
        entryFields: [],
        geometryTypes: 2,
        geometryName: "*",
        ...overrides
    };
}

describe("feature search flat style channels", () => {
    it("preserves native render channels and appends one result-only channel", () => {
        const native = [
            channel({
                channelId: "style-rule:0",
                featureFilter: "styleFeature",
                entryFilter: "styleEntry"
            }),
            channel({channelId: "style-rule:1", geometryTypes: 4})
        ];
        const planned = buildFeatureSearchFilterChannels(
            native,
            "feature",
            "searchQuery",
            ["Road"],
            ["name", "speed"],
            "search-1",
            "Map/Layer"
        );

        expect(planned.resultChannelOrdinal).toBe(2);
        expect(planned.channels.map(item => item.channelId)).toEqual([
            "style-rule:0",
            "style-rule:1",
            `${FEATURE_SEARCH_RESULT_CHANNEL_PREFIX}search-1:Map/Layer`
        ]);
        expect(planned.channels[0]).toMatchObject({
            rewrite: false,
            featureTypes: ["Road"],
            featureFilter: "styleFeature",
            entryFilter: "(styleEntry) and (searchQuery)"
        });
        expect(planned.channels[2]).toMatchObject({
            scope: "feature",
            featureTypes: ["Road"],
            featureFields: ["name", "speed"],
            entryFields: [],
            geometryTypes: 0xffffffff,
            entryFilter: "searchQuery"
        });
        expect(native[0].rewrite).toBe(true);
        expect(native[0].featureTypes).toEqual(["Road", "Lane"]);
    });

    it("uses ordinal zero for results when there are no rendering rules", () => {
        const planned = buildFeatureSearchFilterChannels(
            [],
            "attribute",
            "attributeQuery",
            ["Road"],
            ["$name"],
            "search-2",
            "Map/Layer"
        );

        expect(planned.resultChannelOrdinal).toBe(0);
        expect(planned.channels).toHaveLength(1);
        expect(planned.channels[0]).toMatchObject({
            scope: "attribute",
            featureFields: [],
            entryFields: ["$name"]
        });
    });

    it("does not turn a disjoint feature-type intersection into an unrestricted channel", () => {
        const planned = buildFeatureSearchFilterChannels(
            [channel({featureTypes: ["Lane"], featureFilter: "nativeFilter"})],
            "feature",
            "searchQuery",
            ["Road"],
            [],
            "search-3",
            "Map/Layer"
        );

        expect(planned.channels[0]).toMatchObject({
            featureTypes: [],
            featureFilter: "(nativeFilter) and (false)"
        });
    });
});


describe("feature search native style compilation", () => {
    beforeAll(async () => { await initializeLibrary(); });

    it.each([true, false])("accepts valid native channels for two coloured rules (shared=%s)", shared => {
        const parser = new coreLib.TileLayerParser() as TileLayerParser;
        const metadata = [{
            mapId: "Map", sourceId: "Map", stringPoolId: "Map",
            maxParallelJobs: 1, addOn: false,
            layers: {Lane: {
                layerId: "Lane", type: "Features", canRead: true, canWrite: false,
                coverage: [], featureTypes: [{name: "Lane", uniqueIdCompositions: [[
                    {partId: "laneId", datatype: "U32"}
                ]]}], zoomLevels: [13],
                version: {major: 1, minor: 0, patch: 0}
            }}
        }];
        try {
            uint8ArrayToWasmOrThrow(buffer => parser.setDataSourceInfo(buffer),
                new TextEncoder().encode(JSON.stringify(metadata)));
            const definition = {
                ...createFeatureSearchStateEntry({
                    query: "laneId in [76,99]",
                    searchStyleRules: [
                        {geometry: ["line"], filter: [{field: "laneId", op: "=", value: 76}],
                            color: {mode: "solid", color: "#0088ff"}},
                        {geometry: ["line"], filter: [{field: "laneId", op: "==", value: shared ? 76 : 99}],
                            color: {mode: "solid", color: "#ff8800"}}
                    ]
                }),
                concreteScope: "feature" as const,
                backendQuery: "laneId in [76,99]",
                resultFields: ["laneId"]
            };
            const compiled = compileFeatureSearchStyle(definition,
                {mapId: "Map", layerId: "Lane", key: "Map/Lane"},
                {planStyleFilter: (style, mapId, layerId, highlightMode, lod) =>
                    parser.planStyleFilter(style, mapId, layerId, highlightMode, lod)}, ["Lane"]);
            try {
                expect(compiled.filterPlan.valid).toBe(true);
                const renderChannels = shared ? 1 : 2;
                expect(compiled.filterPlan.channels).toHaveLength(renderChannels + 1);
                if (shared) expect(compiled.filterPlan.channels[0].channelId).toBe("style-rules:0,1");
                expect(compiled.filterPlan.channels[renderChannels].channelId)
                    .toBe(`${FEATURE_SEARCH_RESULT_CHANNEL_PREFIX}${definition.id}:Map/Lane`);
                expect(compiled.resultChannelOrdinal).toBe(renderChannels);
                expect(compiled.source).toContain("laneId == 76");
                expect(compiled.source).toContain(`laneId == ${shared ? 76 : 99}`);
                expect(compiled.source).toContain("#0088ff");
                expect(compiled.source).toContain("#ff8800");
            } finally {
                compiled.style.featureLayerStyle?.delete();
            }
        } finally {
            parser.delete();
        }
    });
});
