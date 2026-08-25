import "@angular/compiler";
import {describe, expect, it} from "vitest";

import {
    searchStyleRuleDisplayItems,
    SearchStyleRuleDraftCodec
} from "./search-style-rule-editor.model";
import {SearchStyleRuleEditorComponent} from "./search-style-rule-editor.component";

describe("SearchStyleRuleEditorComponent", () => {
    it("uses OnPush change detection to prune the idle editor tree", () => {
        expect((SearchStyleRuleEditorComponent as any).ɵcmp.onPush).toBe(true);
    });

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

    it("opens every Quick rule by default without reopening a user-collapsed rule", () => {
        const codec = new SearchStyleRuleDraftCodec();
        const first = codec.createRule();
        const second = codec.createRule();
        const component = new SearchStyleRuleEditorComponent() as any;
        component.expandRulesByDefault = true;
        component.expansionContext = "style-a";
        component.drafts = [first, second];

        component.ngOnChanges({
            drafts: {},
            expandRulesByDefault: {},
            expansionContext: {}
        });
        expect(component.accordionValue).toEqual([String(first.id), String(second.id)]);

        component.accordionValue = [String(second.id)];
        component.drafts = [structuredClone(first), structuredClone(second)];
        component.ngOnChanges({drafts: {}});
        expect(component.accordionValue).toEqual([String(second.id)]);

        component.expansionContext = "style-b";
        component.ngOnChanges({expansionContext: {}});
        expect(component.accordionValue).toEqual([String(first.id), String(second.id)]);
    });

    it("supports combined geometry groups while keeping Any and Label exclusive", () => {
        const codec = new SearchStyleRuleDraftCodec();
        const rule = codec.createRule();
        const component = new SearchStyleRuleEditorComponent() as any;

        component.setVisualization(rule, ["any", "line"]);
        expect(rule.visualization).toEqual(["line"]);
        component.setVisualization(rule, ["line", "surface"]);
        expect(rule.visualization).toEqual(["line", "surface"]);
        component.setVisualization(rule, ["line", "surface", "label"]);
        expect(rule.visualization).toEqual(["label"]);
        component.setVisualization(rule, ["point"]);
        expect(component.sizeValue(rule)).toBe(20);
        expect(component.sizeLabel(rule)).toBe("Radius");
    });
});
