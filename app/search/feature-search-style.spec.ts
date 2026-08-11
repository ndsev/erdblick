import {describe, expect, it} from "vitest";

import type {FilterChannelDefinition} from "../mapdata/filter-subscription.model";
import {
    buildFeatureSearchFilterChannels,
    FEATURE_SEARCH_RESULT_CHANNEL_PREFIX
} from "./feature-search-style";

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
