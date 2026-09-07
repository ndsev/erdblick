import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";

import {AppModule} from "../app.module";
import {
    searchAutoStyleFieldOptions,
    searchAutoStyleFieldOptionsArePortable
} from "./feature-search-auto-style.util";
import {FeatureSearchComponent} from "./feature.search.component";
import {SearchStyleRuleDraftCodec} from "./search-style-rule-editor.model";

void AppModule;

describe("Feature Search automatic rule geometry", () => {
    it("merges a Classic warning-sign field across attribute layers into one portable option", () => {
        const component = Object.create(FeatureSearchComponent.prototype) as any;
        component.styleAttributeOptions = [];
        component.styleScalarAttributeOptions = [];
        component.styleAttributeOptionsLoading = true;
        component.isStyleFieldCandidateActive = () => true;
        component.shouldRefreshAutoStyleRule = () => false;
        const session = {
            definition: {searchStyleRules: [{}]}
        };

        component.applyStyleAttributeOptions(session, [{
            path: "warningSign",
            mapId: "Classic",
            layerId: "NDS.Classic-Routing",
            attrName: "WARNING_SIGN",
            attrLayerName: "Guidance",
            featureType: "Link",
            valueKind: "enum",
            enumValues: ["DANGER"]
        }, {
            path: "warningSign",
            mapId: "Classic",
            layerId: "NDS.Classic-Lane",
            attrName: "WARNING_SIGN",
            attrLayerName: "Lane",
            featureType: "Lane",
            valueKind: "enum",
            enumValues: ["OTHER_DANGER"]
        }], false);

        expect(component.styleScalarAttributeOptions).toHaveLength(1);
        const warningSign = component.styleScalarAttributeOptions[0];
        expect(warningSign).toMatchObject({
            label: "warningSign (2 scopes)",
            value: "warningSign",
            attrName: "WARNING_SIGN",
            attrLayerName: undefined,
            featureType: undefined,
            enumValues: ["DANGER", "OTHER_DANGER"],
            mapLayers: [{
                mapId: "Classic",
                layerId: "NDS.Classic-Lane"
            }, {
                mapId: "Classic",
                layerId: "NDS.Classic-Routing"
            }]
        });

        const analysis = {
            status: "ready" as const,
            concreteScope: "attribute" as const,
            attributeScopes: [{
                attrName: "WARNING_SIGN",
                attrLayerName: "Guidance",
                featureType: "Link",
                mapId: "Classic",
                layerId: "NDS.Classic-Routing"
            }, {
                attrName: "WARNING_SIGN",
                attrLayerName: "Lane",
                featureType: "Lane",
                mapId: "Classic",
                layerId: "NDS.Classic-Lane"
            }],
            matchedFieldNames: ["warningSign"],
            matchedEnumValues: []
        };
        const selected = searchAutoStyleFieldOptions(component.styleScalarAttributeOptions, analysis);

        expect(selected).toEqual([warningSign]);
        expect(searchAutoStyleFieldOptionsArePortable(selected, analysis)).toBe(true);
    });

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

    it("creates solid fallback rules when broad-query rewriting is suppressed", () => {
        const component = Object.create(FeatureSearchComponent.prototype) as any;
        component.styleAttributeOptionsRefreshTimer = null;
        component.styleAttributeOptions = [{value: "warningSign"}];
        component.styleScalarAttributeOptions = [{value: "warningSign"}];
        component.selectedSearchMapLayerSignature = () => "Classic/Routing";
        component.shouldAttemptAutoStyleRule = () => true;
        component.shouldRefreshAutoStyleRule = () => false;
        component.tryCreateAutoStyleRule = vi.fn(() => true);
        const session = {
            id: "warning-signs",
            definition: {
                query: "**.warningSign",
                scope: "auto",
                selectedMapLayers: [],
                searchStyleRules: []
            },
            schemaAnalysis: {
                status: "ready",
                rewriteSuppressed: true,
                rewriteSuppressionReason: "too many Classic attribute scopes"
            }
        };

        expect(component.refreshStyleAttributeOptionsIfNeeded(session)).toBe(false);
        expect(component.styleAttributeOptions).toEqual([]);
        expect(component.styleScalarAttributeOptions).toEqual([]);
        expect(component.tryCreateAutoStyleRule).toHaveBeenCalledWith(session);
    });

    it("creates solid fallback rules while schema style fields are still loading", () => {
        const component = Object.create(FeatureSearchComponent.prototype) as any;
        let fallbackCreated = false;
        component.resultPanelIndex = "results";
        component.styleAttributeOptionsRefreshTimer = null;
        component.styleAttributeOptionsLoading = false;
        component.styleAttributeOptions = [];
        component.styleScalarAttributeOptions = [];
        component.styleAttributeOptionsSessionSignature = "";
        component.attributeScopeSyncSignature = () => "Guidance.WARNING_SIGN";
        component.selectedSearchMapLayerSignature = () => "Classic/Routing";
        component.visibleMapLayerSignature = () => "Classic/Routing";
        component.shouldAttemptAutoStyleRule = () => !fallbackCreated;
        component.shouldRefreshAutoStyleRule = () => fallbackCreated;
        component.tryCreateAutoStyleRule = vi.fn(() => {
            fallbackCreated = true;
            return true;
        });
        component.scheduleStyleAttributeOptionsRefresh = vi.fn();
        const session = {
            id: "warning-signs",
            definition: {
                query: "**.warningSign",
                scope: "auto",
                selectedMapLayers: [],
                searchStyleRules: []
            },
            schemaAnalysis: {
                status: "ready",
                rewriteSuppressed: false,
                normalizedQuery: "warningSign",
                concreteScope: "attribute",
                attributeScopes: []
            }
        };

        expect(component.refreshStyleAttributeOptionsIfNeeded(session)).toBe(true);
        expect(component.tryCreateAutoStyleRule).toHaveBeenCalledWith(session);
        expect(component.scheduleStyleAttributeOptionsRefresh).toHaveBeenCalledWith(session.id, true);
    });
});
