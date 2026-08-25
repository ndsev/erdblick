import "@angular/compiler";
import {describe, expect, it} from "vitest";

import {AppModule} from "../app.module";
import {FeatureSearchComponent} from "./feature.search.component";
import {SearchStyleRuleDraftCodec} from "./search-style-rule-editor.model";

void AppModule;

describe("Feature Search automatic rule geometry", () => {
    it("uses one 20 px point rule and one 5 px non-point rule", () => {
        const component = Object.create(FeatureSearchComponent.prototype) as any;
        const codec = new SearchStyleRuleDraftCodec();
        component.nextStyleRuleId = 1;
        component.autoStyleFieldOptions = () => [];
        component.createStyleRule = (id: number) => codec.createRule(id);
        const session = {
            pointColor: "#123456",
            definition: {pinColor: "#654321"},
            schemaAnalysis: {}
        };

        const rules = component.createAutoStyleRules(session);

        expect(rules).toHaveLength(2);
        expect(rules[0]).toMatchObject({
            name: "Auto: solid (points)",
            visualization: ["point"],
            pointRadius: 20
        });
        expect(rules[1]).toMatchObject({
            name: "Auto: solid (lines/surfaces)",
            visualization: ["line", "surface"],
            lineWidth: 5
        });
    });
});
