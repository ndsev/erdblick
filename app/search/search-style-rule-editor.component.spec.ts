import {describe, expect, it} from "vitest";

import {
    searchStyleRuleDisplayItems,
    SearchStyleRuleDraftCodec
} from "./search-style-rule-editor.model";

describe("SearchStyleRuleEditorComponent", () => {
    it("interleaves Advanced-only placeholders in authoritative YAML order", () => {
        const codec = new SearchStyleRuleDraftCodec();
        const first = codec.createRule();
        const third = codec.createRule();
        const sourceRuleIndices = {
            [first.id]: 0,
            [third.id]: 2
        };
        const items = searchStyleRuleDisplayItems(
            [first, third],
            sourceRuleIndices,
            [1]
        );

        expect(items.map(item => [item.sourceIndex, item.rule?.id])).toEqual([
            [0, first.id],
            [1, undefined],
            [2, third.id]
        ]);
    });
});
