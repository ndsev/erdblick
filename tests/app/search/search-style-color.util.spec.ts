import {describe, expect, it} from "vitest";
import type {SchemaScalarDomain} from "../../../app/mapdata/schema-domain.model";
import {
    autoInitializeSearchStyleColorDraft,
    categoryStopsForEnumValues,
    defaultSearchStyleColorDraft,
    DEFAULT_SEARCH_STYLE_SOLID_COLOR,
    EMPTY_GRADIENT_PREVIEW_COLOR,
    gradientCss,
    gradientPreviewCss,
    gradientStopsForObservedNumericRange,
    gradientStopsForNumericRange,
    gradientStopsNeedSorting,
    gradientStopsToDraft,
    gradientValueTags,
    normalizeHexColor,
    searchStyleColorProperties,
    serializableCategoryStops,
    serializableGradientStops,
    sortedGradientStopDrafts
} from "../../../app/search/search-style-color.util";

/** Two legitimate source domains deliberately disagree about raw speed zero. */
function speedDomain(classic = false): SchemaScalarDomain {
    return {
        schemaId: classic ? "classic" : "live", domainId: 3, typeName: "Speed",
        numeric: {encoding: "uint8", unit: classic ? "" : "km/h", minimum: 0, maximum: 255,
            ordinaryRanges: [{min: classic ? 0 : 1, max: 253}], scale: 1, offset: 0, complete: true},
        namedValues: [
            ...(!classic ? [{name: "UNDEFINED", value: 0, meaning: "unknown" as const}] : []),
            {name: "VARIABLE", value: 254, meaning: "variable" as const},
            {name: "UNLIMITED", value: 255, meaning: "unbounded" as const}
        ].map(value => ({...value, valueType: "integer", role: "special", deprecated: false, removed: false}))
    };
}

describe("search style color helpers", () => {
    it.each([false, true])("keeps ordinary speed and named special colors separate (Classic: %s)", classic => {
        let id = 0;
        const domain = speedDomain(classic);
        const result = autoInitializeSearchStyleColorDraft(defaultSearchStyleColorDraft("speed"), {
            label: "Speed", value: "speed", valueKind: "integer", domain,
            numericRange: {min: classic ? 0 : 1, max: 253}
        }, () => ++id);
        expect(result.success).toBe(true);
        expect(result.draft.gradientStops.map(stop => stop.value)).toEqual([classic ? 0 : 1, 50, 100, 150, 200, 250, 253]);
        expect(result.draft.specialStops?.map(stop => stop.value)).toEqual(classic ? [254, 255] : [0, 254, 255]);
        expect(result.draft.domain).toEqual({schemaId: domain.schemaId, domainId: 3});
        const properties = searchStyleColorProperties({mode: "gradient", field: "speed",
            stops: serializableGradientStops(result.draft)!, domain: result.draft.domain,
            specials: result.draft.specialStops!.map(stop => ({value: stop.value, color: stop.color}))});
        expect(properties["color-scale"]).toMatchObject({domain: result.draft.domain,
            specials: result.draft.specialStops!.map(stop => [stop.value, stop.color])});
    });

    it("chooses round measurement steps while storing the original encoding", () => {
        let id = 0;
        const numeric = {...speedDomain().numeric!, unit: "m", scale: 0.1, offset: 0.5};
        const stops = gradientStopsForNumericRange({min: 1, max: 100}, () => ++id, numeric);
        expect(stops.map(stop => stop.value)).toEqual([1, 15, 35, 55, 75, 95, 100]);
    });

    it("refuses mixed meanings without modifying a manually edited scale", () => {
        const draft = defaultSearchStyleColorDraft("speed");
        draft.gradientStops = [{id: 1, value: 80, color: "#123456"}];
        const result = autoInitializeSearchStyleColorDraft(draft,
            {label: "Speed", value: "speed", incompatibleDomains: true}, () => 2);
        expect(result.success).toBe(false);
        expect(result.draft.gradientStops).toEqual(draft.gradientStops);
    });

    it("offers boolean flag colors without enumerating mask combinations", () => {
        const draft = {...defaultSearchStyleColorDraft('hasFlag(access, "CAR")'), mode: "categories" as const};
        let id = 0;
        const result = autoInitializeSearchStyleColorDraft(draft,
            {label: "Car", value: draft.field, valueKind: "boolean"}, () => ++id);
        expect(result.success).toBe(true);
        expect(serializableCategoryStops(result.draft).map(stop => stop.value)).toEqual([false, true]);
        expect(result.draft.domain).toBeUndefined();
    });
    it.each(["gradient", "categories"] as const)("omits a disabled %s fallback from generated YAML properties", mode => {
        const properties = searchStyleColorProperties({mode, field: "speed",
            stops: [{value: 10, color: "#123456"}]});
        expect(properties["color-scale"]).not.toHaveProperty("fallback");
    });
    it("uses the fallback while a color scale has no usable stops", () => {
        expect(searchStyleColorProperties({
            mode: "categories",
            field: "warningSign",
            stops: [],
            fallbackColor: "#123456"
        })).toEqual({color: "#123456"});

        expect(searchStyleColorProperties({
            mode: "gradient",
            field: "speed",
            stops: [{value: "not-a-number", color: "#ffffff"}],
            fallbackColor: "#654321"
        })).toEqual({color: "#654321"});
    });

    it("normalizes linear stops into deterministic validator-safe order", () => {
        expect(searchStyleColorProperties({
            mode: "gradient",
            field: "speed",
            stops: [
                {value: 80, color: "#800000"},
                {value: 20, color: "#200000"},
                {value: 80, color: "#ff0000"}
            ],
            fallbackColor: "#000000"
        })).toEqual({
            "color-scale": {
                mode: "linear",
                expression: "speed",
                stops: [
                    [20, "#200000"],
                    [80, "#ff0000"]
                ],
                fallback: "#000000"
            }
        });
    });

    it("normalizes hex colors and basic gradient CSS", () => {
        expect(normalizeHexColor("#F17")).toBe("#ff1177");
        expect(normalizeHexColor("not-a-color")).toBe(DEFAULT_SEARCH_STYLE_SOLID_COLOR);
        expect(gradientCss([{color: "#2149ff"}, {color: "#ff1726"}]))
            .toBe("linear-gradient(90deg, #2149ff 0%, #ff1726 100%)");
    });

    it("creates an empty default gradient draft with no categories", () => {
        const draft = defaultSearchStyleColorDraft("speed");
        expect(draft.mode).toBe("gradient");
        expect(draft.solidColor).toBe(DEFAULT_SEARCH_STYLE_SOLID_COLOR);
        expect(draft.categoryStops).toEqual([]);
        expect(draft.gradientStops).toEqual([]);
    });

    it("preserves arbitrary loaded gradient stops", () => {
        let nextId = 1;
        const stops = gradientStopsToDraft([
            {value: 5, color: "#2149ff"},
            {value: 25, color: "#16b8ff"},
            {value: 50, color: "#d9ff32"},
            {value: 75, color: "#ff9d00"}
        ], () => nextId++);

        expect(stops.map(stop => stop.value)).toEqual([5, 25, 50, 75]);
        expect(stops.map(stop => stop.color)).toEqual(["#2149ff", "#16b8ff", "#d9ff32", "#ff9d00"]);
    });

    it("maps gradient preview stops from lowest value to 0% and highest to 100%", () => {
        const draft = defaultSearchStyleColorDraft("speed");
        draft.gradientStops = [
            {id: 1, value: 10, color: "#2149ff"},
            {id: 2, value: 20, color: "#d9ff32"},
            {id: 3, value: 30, color: "#ff1726"}
        ];

        expect(gradientPreviewCss(draft))
            .toBe("linear-gradient(90deg, #2149ff 0%, #d9ff32 50%, #ff1726 100%)");
        expect(gradientValueTags(draft)).toEqual([
            {id: 1, label: "10", offsetPercent: 0, edge: "start"},
            {id: 2, label: "20", offsetPercent: 50, edge: "middle"},
            {id: 3, label: "30", offsetPercent: 100, edge: "end"}
        ]);
    });

    it("preserves gradient row order until explicit sorting", () => {
        const draft = defaultSearchStyleColorDraft("speed");
        draft.gradientStops = [
            {id: 1, value: 20, color: "#d9ff32"},
            {id: 2, value: 10, color: "#2149ff"},
            {id: 3, value: 30, color: "#ff1726"}
        ];

        expect(serializableGradientStops(draft)).toEqual([
            {value: 20, color: "#d9ff32"},
            {value: 10, color: "#2149ff"},
            {value: 30, color: "#ff1726"}
        ]);
        expect(gradientStopsNeedSorting(draft)).toBe(true);
        expect(sortedGradientStopDrafts(draft.gradientStops).map(stop => stop.value)).toEqual([10, 20, 30]);
    });

    it("renders empty and one-stop gradient previews explicitly", () => {
        const draft = defaultSearchStyleColorDraft("speed");
        expect(gradientPreviewCss(draft)).toBe(EMPTY_GRADIENT_PREVIEW_COLOR);

        draft.gradientStops = [{id: 1, value: null, color: "#2149ff"}];
        expect(gradientPreviewCss(draft)).toBe("#2149ff");
        expect(gradientValueTags(draft)).toEqual([]);

        draft.gradientStops = [{id: 1, value: 15, color: "#2149ff"}];
        expect(gradientValueTags(draft)).toEqual([
            {id: 1, label: "15", offsetPercent: 50, edge: "middle"}
        ]);
    });

    it("keeps category values as text and preserves empty rows", () => {
        const draft = defaultSearchStyleColorDraft("kind");
        draft.mode = "categories";
        draft.categoryStops = [
            {id: 1, valueText: "", color: "#2149ff", pending: true},
            {id: 2, valueText: "primary", color: "#ff1726"},
            {id: 3, valueText: "42", color: "#16b8ff"}
        ];

        expect(serializableCategoryStops(draft)).toEqual([
            {value: "", color: "#2149ff"},
            {value: "primary", color: "#ff1726"},
            {value: "42", color: "#16b8ff"}
        ]);
    });

    it("preserves numeric category keys learned for a custom expression", () => {
        const draft = defaultSearchStyleColorDraft(
            "count(attributes.layer.Lane.*)"
        );
        draft.mode = "categories";
        draft.customField = true;
        draft.categoryValueKind = "number";
        draft.categoryStops = [
            {id: 1, valueText: "1", color: "#2149ff"},
            {id: 2, valueText: "2", color: "#ff1726"}
        ];

        expect(serializableCategoryStops(draft)).toEqual([
            {value: 1, color: "#2149ff"},
            {value: 2, color: "#ff1726"}
        ]);
    });

    it("keeps invalid gradient drafts out of persisted output", () => {
        const draft = defaultSearchStyleColorDraft("speed");
        draft.gradientStops = [
            {id: 1, value: 0, color: "#2149ff"},
            {id: 2, value: null, color: "#ff1726"}
        ];
        expect(serializableGradientStops(draft)).toBeNull();
    });

    it("uses round thresholds and exact endpoints for numeric gradients", () => {
        let nextId = 1;
        const stops = gradientStopsForNumericRange({min: 0, max: 255}, () => nextId++);

        expect(stops.map(stop => stop.value)).toEqual([0, 50, 100, 150, 200, 250, 255]);
        expect(stops.length).toBe(7);
        expect(stops.at(-1)?.value).toBe(255);
        expect(stops.every(stop => /^#[0-9a-f]{6}$/.test(stop.color))).toBe(true);
    });

    it("generates observed-data gradients across the whole measured domain", () => {
        let nextId = 1;
        const stops = gradientStopsForObservedNumericRange({min: 20, max: 90}, () => nextId++);

        expect(stops.map(stop => stop.value)).toEqual([20, 40, 60, 80, 90]);
        expect(stops[0].color).toBe("#2149ff");
        expect(stops.at(-1)?.color).toBe("#ff1726");
        expect(new Set(stops.map(stop => stop.color)).size).toBe(stops.length);
    });

    it("auto-generates deterministic unique category colors for enum values", () => {
        let nextId = 1;
        const stops = categoryStopsForEnumValues(["A", "B", "C"], () => nextId++);
        let secondNextId = 1;
        const repeatedStops = categoryStopsForEnumValues(["A", "B", "C"], () => secondNextId++);

        expect(stops.map(stop => stop.valueText)).toEqual(["A", "B", "C"]);
        expect(new Set(stops.map(stop => stop.color)).size).toBe(3);
        expect(stops.map(stop => stop.color)).toEqual(repeatedStops.map(stop => stop.color));
    });

    it("auto-initializes categories and reports incompatible gradient fields", () => {
        let nextId = 1;
        const categoryDraft = defaultSearchStyleColorDraft("warningSign");
        categoryDraft.mode = "categories";
        const categories = autoInitializeSearchStyleColorDraft(categoryDraft, {
            label: "warningSign",
            value: "warningSign",
            valueKind: "enum",
            enumValues: ["SPEED_LIMIT", "SPEED_LIMIT_END"]
        }, () => nextId++);

        expect(categories.success).toBe(true);
        expect(categories.draft.categoryStops.map(stop => stop.valueText))
            .toEqual(["SPEED_LIMIT", "SPEED_LIMIT_END"]);

        const gradientDraft = defaultSearchStyleColorDraft("warningSign");
        const gradient = autoInitializeSearchStyleColorDraft(gradientDraft, {
            label: "warningSign",
            value: "warningSign",
            valueKind: "enum",
            enumValues: ["SPEED_LIMIT"]
        }, () => nextId++);

        expect(gradient.success).toBe(false);
        expect(gradient.message).toContain("Enum fields");
        expect(gradient.draft.gradientStops).toEqual([]);
    });
});
