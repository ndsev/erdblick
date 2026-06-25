import {describe, expect, it} from "vitest";
import {
    defaultSearchStyleFieldOptionsForAnalysis,
    preferredSearchAutoStyleField,
    searchAutoStyleFieldOptions
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
    it("keeps single-scope attribute auto-rules inside the resolved attribute", () => {
        const warningSignEnum = option({
            value: "warningSign",
            attrName: "WARNING_SIGN",
            attrLayerName: "Routing",
            valueKind: "enum",
            enumValues: ["PEDESTRIAN_WAY"]
        });
        const pedestrianWayField = option({
            value: "pedestrianKind",
            attrName: "PEDESTRIAN_WAY",
            attrLayerName: "Routing"
        });

        expect(searchAutoStyleFieldOptions(
            [warningSignEnum, pedestrianWayField],
            readyAttributeAnalysis
        )).toEqual([pedestrianWayField]);
    });

    it("uses resolved attribute scopes for default style candidates", () => {
        const warningSignEnum = option({
            value: "warningSign",
            attrName: "WARNING_SIGN",
            valueKind: "enum",
            enumValues: ["PEDESTRIAN_WAY"]
        });
        const pedestrianWayField = option({
            value: "pedestrianKind",
            attrName: "PEDESTRIAN_WAY"
        });

        expect(defaultSearchStyleFieldOptionsForAnalysis(
            [warningSignEnum, pedestrianWayField],
            readyAttributeAnalysis
        )).toEqual([pedestrianWayField]);
    });

    it("prefers matched fields over enum matches within the same scope", () => {
        const enumField = option({
            value: "kind",
            attrName: "PEDESTRIAN_WAY",
            valueKind: "enum",
            enumValues: ["PEDESTRIAN_WAY"]
        });
        const namedField = option({
            value: "pedestrianWay",
            attrName: "PEDESTRIAN_WAY"
        });

        expect(preferredSearchAutoStyleField(
            [enumField, namedField],
            {
                ...readyAttributeAnalysis,
                matchedFieldNames: ["pedestrianWay"]
            }
        )).toBe(namedField);
    });

    it("still uses enum matches when no field name was matched", () => {
        const enumField = option({
            value: "transitionType",
            attrName: "PROHIBITED_TRANSITION",
            valueKind: "enum",
            enumValues: ["SPEED_LIMIT_END"]
        });
        const fallbackField = option({
            value: "note",
            attrName: "PROHIBITED_TRANSITION"
        });

        expect(preferredSearchAutoStyleField(
            [fallbackField, enumField],
            {
                status: "ready",
                concreteScope: "attribute",
                attributeScopes: [],
                matchedFieldNames: [],
                matchedEnumValues: ["SPEED_LIMIT_END"]
            }
        )).toBe(enumField);
    });
});
