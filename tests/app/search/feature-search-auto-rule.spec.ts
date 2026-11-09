import "@angular/compiler";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";

import {AppModule} from "../../../app/app.module";
import {
    combinePreparedSearchAutoStyles,
    preparedSearchAutoStyleRules,
    searchAutoStyleFieldOptions,
    searchAutoStyleFieldOptionsArePortable
} from "../../../app/search/feature-search-auto-style.util";
import {SearchComponent} from "../../../app/search/search.component";
import type {FeatureSearchStyleFieldInventory} from "../../../app/search/search.model";

void AppModule;

describe("Feature Search automatic rule geometry", () => {
    it("keeps four warning-sign rules when adding a map with an older symbolic catalog", () => {
        const groups = ["Germany", "Large Map", "Munich"].flatMap((mapId, version) =>
            ["Road", "Lane"].map(layerId => {
                const enumValues = version === 2 ? ["ANIMALS"] : ["ANIMALS", "NEW_SIGN"];
                const contexts = ["WARNING_SIGN", "MOVABLE_WARNING_SIGN"].map(attrName => ({
                    mapId, layerId, featureType: layerId, attrName, attrLayerName: `${layerId}RulesLayer`,
                    primaryValuePath: `attributeValue.${attrName === "WARNING_SIGN" ? "warningSign" : "movableWarningSign"}`
                }));
                const inventory: FeatureSearchStyleFieldInventory = {
                    contexts, types: [{valueKind: "enum", enumValues, schemaType: {
                        schemaId: `catalog-${version}`, typeId: 1, typeName: `SignsVersion${version}`,
                        namedValues: enumValues.map((name, index) => ({name, value: name, rawValue: version + index,
                            valueType: "string", role: "constant", meaning: "ordinary", deprecated: false, removed: false}))
                    }}], fields: contexts.map((context, index) => ({path: context.primaryValuePath,
                        metadata: 0, contexts: [index]})), branches: [], complete: true, incompleteReason: ""
                };
                const rules = preparedSearchAutoStyleRules(inventory, {
                    status: "ready", concreteScope: "attribute", attributeScopes: contexts,
                    matchedFieldNames: [], matchedEnumValues: ["ANIMALS"]
                }, "#123456", {mapId, layerId, scope: "attribute"});
                return rules;
            }));
        const before = combinePreparedSearchAutoStyles(groups.slice(0, 4));
        const after = combinePreparedSearchAutoStyles(groups);
        expect(before).toHaveLength(4);
        expect(after).toHaveLength(4);
        for (const rule of after) {
            expect(rule.applicability).toBeUndefined();
            expect(rule.filter).toEqual([{field: "$name", op: "=", value:
                rule.color.mode !== "solid" && rule.color.field.endsWith("movableWarningSign")
                    ? "MOVABLE_WARNING_SIGN" : "WARNING_SIGN"}]);
            expect(rule.color.mode).toBe("categories");
            if (rule.color.mode !== "categories") throw new Error("Expected a category scale");
            const color = rule.color;
            expect(color.stops.map(stop => stop.value)).toEqual(["ANIMALS", "NEW_SIGN"]);
            expect(color.schemaTypes).toHaveLength(3);
            const previous = before.find(candidate => candidate.color.mode === "categories" &&
                candidate.color.field === color.field && candidate.geometry[0] === rule.geometry[0]);
            expect(color.stops).toEqual(previous?.color.mode === "categories" ? previous.color.stops : []);
            expect(Object.hasOwn(rule, "valueMeaning")).toBe(false);
            expect(Object.hasOwn(rule, "symbolicCategories")).toBe(false);
        }
    });

    it.each([false, true])("shares two speed rules across schema versions only when units agree (different units: %s)", differentUnits => {
        const groups = ["Munich", "San Francisco", "Large Map"].map((mapId, index) => {
            const context = {mapId, layerId: "Lane", featureType: "Lane", attrName: "SPEED_LIMIT_METRIC",
                attrLayerName: "LaneRules", primaryValuePath: "attributeValue.speedLimitKmh"};
            const inventory: FeatureSearchStyleFieldInventory = {
                contexts: [context],
                types: [{valueKind: "integer", enumValues: [], numericRange: {min: 1, max: 253},
                    schemaType: {schemaId: `graph-${index}`, typeId: index + 1, typeName: `Speed-${index}`,
                        numeric: {encoding: "uint8", unit: differentUnits && index === 2 ? "mph" : "km/h",
                            minimum: 0, maximum: 255, ordinaryRanges: [{min: 1, max: 253}],
                            scale: 1, offset: 0, complete: true},
                        namedValues: [{name: "UNLIMITED", value: 255, valueType: "integer", role: "special",
                            meaning: "unbounded", deprecated: false, removed: false}]}}],
                fields: [{path: context.primaryValuePath, metadata: 0, contexts: [0]}],
                branches: [], complete: true, incompleteReason: ""
            };
            return preparedSearchAutoStyleRules(inventory, {
                status: "ready", concreteScope: "attribute", attributeScopes: [context],
                matchedFieldNames: ["SPEED_LIMIT_METRIC"], matchedEnumValues: []
            }, "#123456", {mapId, layerId: "Lane", scope: "attribute"});
        });
        const rules = combinePreparedSearchAutoStyles(groups);
        expect(rules).toHaveLength(differentUnits ? 4 : 2);
        expect(rules.every(rule => !Object.hasOwn(rule, "valueMeaning"))).toBe(true);
        if (!differentUnits) {
            expect(rules.map(rule => rule.geometry)).toEqual([["point"], ["line", "surface"]]);
            for (const rule of rules) {
                expect(rule.filter).toEqual([]);
                expect(rule.applicability).toBeUndefined();
                expect(rule.color).toMatchObject({mode: "gradient", schemaTypes: [
                    {schemaId: "graph-0", typeId: 1}, {schemaId: "graph-1", typeId: 2}, {schemaId: "graph-2", typeId: 3}
                ]});
            }
        }
    });

    it("offers a shared expression once while preserving attribute owners for automatic rules", () => {
        const component = Object.create(SearchComponent.prototype) as any;
        const session = {definition: {searchStyleRules: [{}]}};
        const inventory = {
            contexts: ["SPEED_LIMIT_METRIC", "SPEED_LIMIT_IMPERIAL"].map(attrName => ({
                mapId: "Map", layerId: "Lane", featureType: "Lane", attrName,
                primaryValuePath: "attributeValue.speed"
            })),
            types: [{valueKind: "integer", enumValues: [], numericRange: {min: 0, max: 255}}],
            fields: ["_sourceData.*.address", "attributeValue.speed"].map(path => ({
                path, metadata: 0, contexts: [0, 1]
            })),
            branches: [], complete: true, incompleteReason: ""
        };
        component.applyStyleAttributeOptions(session, inventory, false);
        expect(component.styleScalarAttributeOptions.map((option: {value: string}) => option.value))
            .toEqual(["_sourceData.*.address", "attributeValue.speed"]);
        expect(component.styleScalarAttributeOptions.every((option: {attrName?: string}) => !option.attrName)).toBe(true);
        expect(component.styleAttributeOptions).toHaveLength(4);
        const selected = searchAutoStyleFieldOptions(component.styleAttributeOptions, {
            status: "ready", concreteScope: "attribute", attributeScopes: inventory.contexts.map(context => ({
                ...context, attrLayerName: "Rules"
            })), matchedFieldNames: [], matchedEnumValues: []
        });
        expect(selected.map(option => [option.attrName, option.value])).toEqual([
            ["SPEED_LIMIT_METRIC", "attributeValue.speed"],
            ["SPEED_LIMIT_IMPERIAL", "attributeValue.speed"]
        ]);
    });

    it("keeps ambiguous meanings explicit and reuses the picker until its context changes", () => {
        const component = Object.create(SearchComponent.prototype) as any;
        const session = {definition: {searchStyleRules: [{}]}};
        const inventory = {
            contexts: [{mapId: "Map", layerId: "Road", featureType: "Road"},
                {mapId: "Map", layerId: "Road", featureType: "Building"}],
            types: [7, 8].map(typeId => ({valueKind: "integer", enumValues: [],
                numericRange: {min: 1, max: 10},
                schemaType: {schemaId: "artifact", typeId, typeName: "Width", namedValues: [],
                    numeric: {encoding: "uint8", unit: typeId === 7 ? "m" : "cm", scale: 1, offset: 0,
                        ordinaryRanges: [{min: 1, max: 10}], complete: true}}})),
            fields: [{path: "attributes.width", metadata: 0, contexts: [0]},
                {path: "attributes.width", metadata: 1, contexts: [1]}],
            branches: [], complete: true, incompleteReason: ""
        };
        component.applyStyleAttributeOptions(session, inventory, false);
        const ambiguous = component.styleScalarAttributeOptions;
        expect(ambiguous).toHaveLength(1);
        expect(ambiguous[0]).toMatchObject({incompatibleTypes: true, valueKind: "unknown"});
        expect(ambiguous[0].schemaType).toBeUndefined();
        expect(ambiguous[0].numericRange).toBeUndefined();
        expect(ambiguous[0].label).toBe("attributes.width");
        component.applyStyleAttributeOptions(session, inventory, false);
        expect(component.styleScalarAttributeOptions).toBe(ambiguous);

        component.applyStyleAttributeOptions(session, {...inventory, fields: inventory.fields.slice(0, 1)}, false);
        expect(component.styleScalarAttributeOptions[0].schemaType).toEqual(inventory.types[0].schemaType);
    });

    it("merges a Classic warning-sign field across attribute layers into one portable option", () => {
        const component = Object.create(SearchComponent.prototype) as any;
        component.styleAttributeOptions = [];
        component.styleScalarAttributeOptions = [];
        component.styleAttributeOptionsLoading = true;
        component.shouldRefreshAutoStyleRule = () => false;
        const session = {
            definition: {searchStyleRules: [{}]}
        };

        component.applyStyleAttributeOptions(session, {
            contexts: [{mapId: "Classic", layerId: "NDS.Classic-Routing", attrName: "WARNING_SIGN",
                attrLayerName: "Guidance", featureType: "Link"},
                {mapId: "Classic", layerId: "NDS.Classic-Lane", attrName: "WARNING_SIGN",
                    attrLayerName: "Lane", featureType: "Lane"}],
            types: [{valueKind: "enum", enumValues: ["DANGER", "OTHER_DANGER"]}],
            fields: [{path: "warningSign", metadata: 0, contexts: [0, 1]}],
            branches: [], complete: true, incompleteReason: ""
        }, false);

        expect(component.styleScalarAttributeOptions).toHaveLength(1);
        const warningSign = component.styleScalarAttributeOptions[0];
        expect(warningSign).toMatchObject({
            label: "warningSign",
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

    it("prepares the point and non-point geometry defaults before execution", () => {
        const rules = preparedSearchAutoStyleRules(undefined, {
            status: "ready", concreteScope: "feature", attributeScopes: [],
            matchedFieldNames: [], matchedEnumValues: []
        }, "#123456", {mapId: "Map", layerId: "Road", scope: "feature"});
        expect(rules).toHaveLength(2);
        expect(rules[0]).toMatchObject({geometry: ["point"], pointRadius: 20, color: {mode: "solid", color: "#123456"}});
        expect(rules[1]).toMatchObject({geometry: ["line", "surface"], width: 5});
        expect(rules.every(rule => rule.applicability?.mapId === "Map")).toBe(true);
    });

    it("shares symbolic categories across owners whose enum wire ordinals differ", () => {
        const contexts = ["Road", "Intersection"].map(featureType => ({
            mapId: "Map", layerId: "Road", featureType, attrName: "WARNING_SIGN", attrLayerName: "Rules"
        }));
        const inventory: FeatureSearchStyleFieldInventory = {
            contexts,
            types: [11, 22].map(typeId => ({valueKind: "enum", enumValues: ["SPEED_LIMIT", "ANIMALS"],
                schemaType: {schemaId: "test-schema", typeId, typeName: "WarningSign", namedValues: [{name: "ANIMALS", value: "ANIMALS",
                    valueType: "string", role: "constant", meaning: "ordinary", rawValue: typeId, deprecated: false, removed: false}]}})),
            fields: contexts.map((_, index) => ({path: "warningSign", metadata: index, contexts: [index]})),
            branches: [], complete: true, incompleteReason: ""
        };
        const rules = combinePreparedSearchAutoStyles([preparedSearchAutoStyleRules(inventory, {
            status: "ready", concreteScope: "attribute", attributeScopes: contexts,
            matchedFieldNames: [], matchedEnumValues: ["SPEED_LIMIT"]
        }, "#123456", {mapId: "Map", layerId: "Road", scope: "attribute"})]);
        expect(rules).toHaveLength(2);
        for (const rule of rules) {
            expect(rule.color).toMatchObject({schemaTypes: [{schemaId: "test-schema", typeId: 11}, {schemaId: "test-schema", typeId: 22}]});
            expect(rule.filter).toEqual([]);
        }
    });

    it("offers the union of symbolic categories when editing a field shared by schema versions", () => {
        const component = Object.create(SearchComponent.prototype) as any;
        const contexts = ["Old", "New"].map(mapId => ({mapId, layerId: "Road",
            featureType: "Road", attrName: "WARNING_SIGN", attrLayerName: "Rules"}));
        const inventory: FeatureSearchStyleFieldInventory = {
            contexts, types: [["ANIMALS"], ["ANIMALS", "NEW_SIGN"]].map((enumValues, typeId) => ({
                valueKind: "enum", enumValues, schemaType: {schemaId: "catalog", typeId,
                    typeName: `Signs${typeId}`, namedValues: enumValues.map(name => ({name, value: name,
                        valueType: "string", role: "constant", meaning: "ordinary", deprecated: false, removed: false}))}
            })), fields: contexts.map((_, index) => ({path: "warningSign", metadata: index, contexts: [index]})),
            branches: [], complete: true, incompleteReason: ""
        };
        component.applyStyleAttributeOptions({definition: {searchStyleRules: [{}]}}, inventory, false);
        expect(component.styleScalarAttributeOptions).toHaveLength(1);
        expect(component.styleScalarAttributeOptions[0]).toMatchObject({valueKind: "enum",
            enumValues: ["ANIMALS", "NEW_SIGN"], schemaTypes: [
                {schemaId: "catalog", typeId: 0}, {schemaId: "catalog", typeId: 1}
            ]});
    });

    it("keeps a solid fallback for an owner whose schema has no usable scalar", () => {
        const contexts = ["WARNING_SIGN", "MOVABLE_WARNING_SIGN"].map(attrName => ({
            mapId: "Map", layerId: "Road", featureType: "Road", attrName, attrLayerName: "Rules"
        }));
        const inventory: FeatureSearchStyleFieldInventory = {
            contexts, types: [{valueKind: "enum", enumValues: ["SPEED_LIMIT"], schemaType: undefined}],
            fields: [{path: "warningSign", metadata: 0, contexts: [0]}],
            branches: [], complete: true, incompleteReason: ""
        };
        const rules = combinePreparedSearchAutoStyles([preparedSearchAutoStyleRules(inventory, {
            status: "ready", concreteScope: "attribute", attributeScopes: contexts,
            matchedFieldNames: [], matchedEnumValues: ["SPEED_LIMIT"]
        }, "#123456", {mapId: "Map", layerId: "Road", scope: "attribute"})]);
        expect(rules).toHaveLength(4);
        expect(rules[2].color).toEqual({mode: "solid", color: "#123456"});
        expect(rules[2].filter).toEqual([{field: "$name", op: "=", value: "MOVABLE_WARNING_SIGN"}]);
    });

    it("does not initialize or replace styles while receiving results", () => {
        const component = Object.create(SearchComponent.prototype) as any;
        component.resultPanelIndex = "results";
        component.scheduleStyleAttributeOptionsRefresh = vi.fn();
        expect(component.refreshStyleAttributeOptionsIfNeeded({schemaAnalysis: {status: "ready"}})).toBe(false);
        expect(component.scheduleStyleAttributeOptionsRefresh).not.toHaveBeenCalled();
    });
});
