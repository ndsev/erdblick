import {load} from "js-yaml";
import {beforeAll, describe, expect, it} from "vitest";

import {SearchStyleConfigurationV1} from "../shared/search-style-configuration-state";
import {coreLib, initializeLibrary, uint8ArrayToWasm} from "../integrations/wasm";
import {convertSearchStyleConfigurationToYaml} from "./search-style-sheet.converter";

describe("search style sheet converter", () => {
    beforeAll(async () => {
        await initializeLibrary();
    });

    const configuration: SearchStyleConfigurationV1 = {
        id: "search_style_01234567-89ab-cdef",
        revision: 4,
        name: "Road emphasis",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        rules: [
            {
                name: "fast roads",
                mapLayers: [{mapId: "Map A", layerId: "Roads"}],
                geometry: "line",
                filter: [{field: "speed", op: ">=", value: 80}],
                color: {mode: "solid", color: "#ff0000"},
                width: 7,
                opacity: 0.8
            },
            {
                name: "points from another source",
                mapLayers: [{mapId: "Map B", layerId: "Signs"}],
                geometry: "point",
                filter: [],
                color: {mode: "solid", color: "#00ff00"},
                pointRadius: 8
            },
            {
                name: "half-opacity labels",
                geometry: "label",
                filter: [],
                color: {mode: "solid", color: "#ffffff"},
                opacity: 0.5,
                labelExpression: "typeId",
                labelBackgroundColor: "#000000"
            }
        ]
    };

    it("produces deterministic, scope-free YAML from every rule", () => {
        const first = convertSearchStyleConfigurationToYaml(configuration);
        const second = convertSearchStyleConfigurationToYaml(configuration);
        const parsed = load(first.source) as any;

        expect(first).toEqual(second);
        expect(parsed.default).toBe(false);
        expect(parsed.version).toBe(2);
        expect(parsed).not.toHaveProperty("layer");
        expect(parsed.rules[0]).not.toHaveProperty("scope");
        expect(parsed.rules[0]["all-of"]).toHaveLength(3);
        expect(parsed.rules[0]["all-of"][0].geometry).toEqual(["line"]);
        expect(parsed.rules[0]["all-of"][2]["label-color"]).toBe("#ffffff");
        expect(parsed.rules[0]["all-of"][2]["label-background-color"]).toBe("#000000");
        expect(parsed.rules[0]["all-of"][2]["label-opacity"]).toBe(0.5);
        expect(first.source).not.toContain("Map A");
        expect(first.source).not.toContain("Map B");
        expect(first.source).not.toContain("mapLayers");
        expect(first.filename).toMatch(/^Road-emphasis-.*\.yaml$/);
    });

    it("produces a canonical sheet accepted by the native style parser", () => {
        const generated = convertSearchStyleConfigurationToYaml(configuration);
        const style = uint8ArrayToWasm(
            wasmBuffer => new coreLib.FeatureLayerStyle(wasmBuffer),
            new TextEncoder().encode(generated.source)
        );

        expect(style).toBeTruthy();
        expect(style.isValid(), JSON.stringify(style.validationReport())).toBe(true);
        expect(style.defaultEnabled()).toBe(false);
        style.delete();
    });

    it("rejects rule values that canonical conversion cannot preserve", () => {
        expect(() => convertSearchStyleConfigurationToYaml({
            ...configuration,
            rules: [{
                geometry: "line",
                filter: [{field: "speed", op: "approximately", value: 80}],
                color: {
                    mode: "categories",
                    field: "kind",
                    stops: [{value: {nested: true}, color: "#ffffff"}]
                }
            }]
        })).toThrow(/unsupported operator.*non-scalar value/i);
    });

    it("emits an explicitly custom condition as the expression itself", () => {
        const generated = convertSearchStyleConfigurationToYaml({
            ...configuration,
            rules: [{
                geometry: "line",
                filter: [{
                    field: "speed >= 80 and access != 'private'",
                    op: "=",
                    value: true,
                    customExpression: true
                }],
                color: {mode: "solid", color: "#ffffff"}
            }]
        });
        const parsed = load(generated.source) as any;

        expect(parsed.rules[0]["all-of"][0].filter).toBe(
            "(speed >= 80 and access != 'private')"
        );
    });
});
