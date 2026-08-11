import {describe, expect, it} from "vitest";

import {SearchStyleRuleEditorComponent} from "./search-style-rule-editor.component";
import {SearchStyleRuleDraftCodec} from "./search-style-rule-editor.model";

describe("SearchStyleRuleEditorComponent", () => {
    it("interleaves Advanced-only placeholders in authoritative YAML order", () => {
        const component = new SearchStyleRuleEditorComponent();
        const codec = new SearchStyleRuleDraftCodec();
        const first = codec.createRule();
        const third = codec.createRule();
        component.drafts = [first, third];
        component.sourceRuleIndices = {
            [first.id]: 0,
            [third.id]: 2
        };
        component.readOnlyRuleIndices = [1];

        const items = (component as any).displayItems();

        expect(items.map((item: any) => [item.sourceIndex, item.rule?.id])).toEqual([
            [0, first.id],
            [1, undefined],
            [2, third.id]
        ]);
    });
});
