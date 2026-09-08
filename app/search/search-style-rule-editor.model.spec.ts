import {describe, expect, it} from "vitest";

import type {FeatureSearchStyleRule} from "../shared/feature-search-state";
import {SearchStyleRuleDraftCodec} from "./search-style-rule-editor.model";

describe("SearchStyleRuleDraftCodec", () => {
    it.each(["gradient", "categories"] as const)("round-trips and toggles %s fallback", mode => {
        const codec = new SearchStyleRuleDraftCodec();
        const rule: FeatureSearchStyleRule = {geometry: ["line"], filter: [], width: 2, opacity: 1,
            color: {mode, field: "speed", stops: [{value: 10, color: "#123456"}]}};
        const drafts = codec.toDrafts([rule]);
        expect(drafts[0].color.fallbackEnabled).toBe(false);
        expect(codec.fromDrafts(drafts)[0].color).not.toHaveProperty("fallbackColor");
        drafts[0].color.fallbackEnabled = true;
        drafts[0].color.fallbackColor = "#654321";
        expect(codec.fromDrafts(drafts)[0].color).toHaveProperty("fallbackColor", "#654321");
        drafts[0].color.fallbackEnabled = false;
        expect(codec.fromDrafts(drafts)[0].color).not.toHaveProperty("fallbackColor");
    });
    it("round-trips high-fidelity geometry, point radius and expression intent", () => {
        const codec = new SearchStyleRuleDraftCodec();
        const rules: FeatureSearchStyleRule[] = [{
            geometry: ["line", "mesh"],
            filter: [{
                field: "speed * 2 > 10",
                op: "=",
                value: true,
                customExpression: true
            }],
            color: {
                mode: "categories" as const,
                field: "kind ?? 'unknown'",
                customField: true,
                stops: [{value: "road", color: "#abcdef"}]
            },
            width: 3,
            pointRadius: 11,
            opacity: 0.35
        }];

        const roundTrip = codec.fromDrafts(codec.toDrafts(rules));

        expect(roundTrip[0]).toMatchObject({
            geometry: ["line", "mesh"],
            width: 3,
            pointRadius: 11,
            opacity: 0.35
        });
        expect(roundTrip[0].filter[0].customExpression).toBe(true);
        expect(roundTrip[0].color).toMatchObject({customField: true});
    });

    it("does not invent a point radius for a rule that never stored one", () => {
        const codec = new SearchStyleRuleDraftCodec();
        const roundTrip = codec.fromDrafts(codec.toDrafts([{
            geometry: ["line"],
            filter: [],
            color: {mode: "solid", color: "#123456"},
            width: 4,
            opacity: 1
        }]));

        expect(roundTrip[0]).not.toHaveProperty("pointRadius");
    });
});
