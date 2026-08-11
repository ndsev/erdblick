import {describe, expect, it} from "vitest";
import {
    defaultSearchStyleFieldOptionsForAnalysis,
    preferredSearchAutoStyleField,
    searchAutoStyleFieldOptions,
    searchAutoStyleFieldOptionsArePortable
} from "./feature-search-auto-style.util";
import type {
    FeatureSearchAutoStyleAnalysis,
    FeatureSearchAutoStyleOption
} from "./feature-search-auto-style.util";

const pedestrianWayScope = {
    attrName: "PEDESTRIAN_WAY",
    attrLayerName: "Routing",
    featureType: "Link",
    mapId: "Classic",
    layerId: "Routing"
};

const readyAttributeAnalysis: FeatureSearchAutoStyleAnalysis = {
    status: "ready",
    concreteScope: "attribute",
    attributeScopes: [pedestrianWayScope],
    matchedFieldNames: [],
    matchedEnumValues: ["PEDESTRIAN_WAY"]
};

const option = (partial: Partial<FeatureSearchAutoStyleOption>): FeatureSearchAutoStyleOption => ({
    label: partial.value ?? "field",
    value: partial.value ?? "field",
    valueKind: partial.valueKind ?? "string",
    enumValues: partial.enumValues ?? [],
    ...partial
});

describe("feature search auto-style helpers", () => {
    it("generates one ranked scalar field per resolved attribute scope", () => {
        const warningSignField = option({
            value: "warningSign",
            attrName: "WARNING_SIGN",
            attrLayerName: "Routing"
        });
        const pedestrianWayFirstField = option({
            value: "pedestrianKind",
            attrName: "PEDESTRIAN_WAY",
            attrLayerName: "Routing"
        });
        const pedestrianWaySecondField = option({
            value: "pedestrianSubtype",
            attrName: "PEDESTRIAN_WAY",
            attrLayerName: "Routing"
        });

        expect(searchAutoStyleFieldOptions(
            [warningSignField, pedestrianWayFirstField, pedestrianWaySecondField],
            readyAttributeAnalysis
        )).toEqual([pedestrianWayFirstField]);
    });

    it("prefers an attribute-named enum field for WARNING_SIGN", () => {
        const analysis: FeatureSearchAutoStyleAnalysis = {
            status: "ready",
            concreteScope: "attribute",
            attributeScopes: [{
                attrName: "WARNING_SIGN",
                attrLayerName: "Routing",
                featureType: "Link",
                mapId: "Classic",
                layerId: "Routing"
            }],
            matchedFieldNames: [],
            matchedEnumValues: []
        };
        const arbitraryFirstField = option({
            value: "attributeValue.additionalText",
            attrName: "WARNING_SIGN",
            valueKind: "string"
        });
        const warningSignField = option({
            value: "attributeValue.warningSign",
            attrName: "WARNING_SIGN",
            valueKind: "enum",
            enumValues: ["DANGER"]
        });

        expect(preferredSearchAutoStyleField(
            [arbitraryFirstField, warningSignField],
            analysis
        )).toBe(warningSignField);
    });

    it("keeps equally semantic field paths from heterogeneous WARNING_SIGN schemas", () => {
        const analysis: FeatureSearchAutoStyleAnalysis = {
            status: "ready",
            concreteScope: "attribute",
            attributeScopes: [{
                attrName: "WARNING_SIGN",
                attrLayerName: "Routing",
                featureType: "Link",
                mapId: "Classic",
                layerId: "Routing"
            }, {
                attrName: "WARNING_SIGN",
                attrLayerName: "RoadRules",
                featureType: "Road",
                mapId: "Live",
                layerId: "Road"
            }],
            matchedFieldNames: [],
            matchedEnumValues: []
        };
        const classic = option({
            value: "warningSign",
            attrName: "WARNING_SIGN",
            valueKind: "enum",
            mapLayers: [{mapId: "Classic", layerId: "Routing"}]
        });
        const live = option({
            value: "attributeValue.warningSign",
            attrName: "WARNING_SIGN",
            valueKind: "enum",
            mapLayers: [{mapId: "Live", layerId: "Road"}]
        });

        expect(searchAutoStyleFieldOptions([classic, live], analysis))
            .toEqual([classic, live]);
        expect(searchAutoStyleFieldOptionsArePortable([classic, live], analysis)).toBe(false);
    });

    it("allows heterogeneous paths when portable feature-type guards separate them", () => {
        const analysis: FeatureSearchAutoStyleAnalysis = {
            status: "ready",
            concreteScope: "attribute",
            attributeScopes: [{
                attrName: "WARNING_SIGN",
                featureType: "Link",
                mapId: "Classic",
                layerId: "Routing"
            }, {
                attrName: "WARNING_SIGN",
                featureType: "Road",
                mapId: "Live",
                layerId: "Road"
            }],
            matchedFieldNames: [],
            matchedEnumValues: []
        };
        const classic = option({
            value: "warningSign",
            attrName: "WARNING_SIGN",
            featureType: "Link",
            mapLayers: [{mapId: "Classic", layerId: "Routing"}]
        });
        const live = option({
            value: "attributeValue.warningSign",
            attrName: "WARNING_SIGN",
            featureType: "Road",
            mapLayers: [{mapId: "Live", layerId: "Road"}]
        });

        expect(searchAutoStyleFieldOptionsArePortable([classic, live], analysis)).toBe(true);
    });

    it("rejects an automatic field set that leaves a resolved source scope uncovered", () => {
        const analysis: FeatureSearchAutoStyleAnalysis = {
            ...readyAttributeAnalysis,
            attributeScopes: [pedestrianWayScope, {
                ...pedestrianWayScope,
                mapId: "Live",
                layerId: "Road"
            }]
        };
        const classicOnly = option({
            value: "pedestrianKind",
            attrName: "PEDESTRIAN_WAY",
            featureType: "Link",
            mapLayers: [{mapId: "Classic", layerId: "Routing"}]
        });

        expect(searchAutoStyleFieldOptionsArePortable([classicOnly], analysis)).toBe(false);
    });

    it("uses resolved attribute scopes for default style candidates", () => {
        const warningSignField = option({
            value: "warningSign",
            attrName: "WARNING_SIGN"
        });
        const pedestrianWayField = option({
            value: "pedestrianKind",
            attrName: "PEDESTRIAN_WAY"
        });

        expect(defaultSearchStyleFieldOptionsForAnalysis(
            [warningSignField, pedestrianWayField],
            readyAttributeAnalysis
        )).toEqual([pedestrianWayField]);
    });

    it("does not guess automatic style fields for feature-scope searches", () => {
        const roadReasonType = option({
            value: "attributes.layer.RoadRulesLayer.SPEED_LIMIT_METRIC.properties.reason.type",
            featureType: "Road"
        });
        const laneRegulationType = option({
            value: "attributes.layer.LaneRulesLayer.LANE_RIGHT_OF_WAY_REGULATION.attributeValue.laneRightOfWayRegulation.type",
            featureType: "Lane"
        });
        const analysis: FeatureSearchAutoStyleAnalysis = {
            status: "ready",
            concreteScope: "feature",
            attributeScopes: [],
            matchedFieldNames: ["type"],
            matchedEnumValues: []
        };

        expect(searchAutoStyleFieldOptions([laneRegulationType, roadReasonType], analysis)).toEqual([]);
        expect(preferredSearchAutoStyleField([laneRegulationType, roadReasonType], analysis)).toBeUndefined();
    });

    it("does not guess automatic style fields without a resolved attribute scope", () => {
        const enumField = option({
            value: "transitionType",
            attrName: "PROHIBITED_TRANSITION",
            valueKind: "enum",
            enumValues: ["SPEED_LIMIT_END"]
        });
        const analysis: FeatureSearchAutoStyleAnalysis = {
            status: "ready",
            concreteScope: "attribute",
            attributeScopes: [],
            matchedFieldNames: [],
            matchedEnumValues: ["SPEED_LIMIT_END"]
        };

        expect(preferredSearchAutoStyleField([enumField], analysis)).toBeUndefined();
        expect(searchAutoStyleFieldOptions([enumField], analysis)).toEqual([]);
    });

    it("suppresses schema-field auto-styling when query rewriting was suppressed", () => {
        const broadEnumField = option({
            value: "propertyTypeCode",
            attrName: "ATTRIBUTE_PROPERTY",
            valueKind: "enum",
            enumValues: ["WEEKDAY_IN_MONTH"]
        });
        const analysis = {
            ...readyAttributeAnalysis,
            rewriteSuppressed: true
        };

        expect(searchAutoStyleFieldOptions([broadEnumField], analysis)).toEqual([]);
        expect(defaultSearchStyleFieldOptionsForAnalysis([broadEnumField], analysis)).toEqual([]);
    });
});
