import {describe, expect, it} from "vitest";
import {
    autoInitializeSearchStyleColorDraft,
    categoryStopsForEnumValues,
    defaultSearchStyleColorDraft,
    DEFAULT_SEARCH_STYLE_SOLID_COLOR,
    EMPTY_GRADIENT_PREVIEW_COLOR,
    gradientCss,
    gradientPreviewCss,
    gradientStopsForNumericRange,
    gradientStopsNeedSorting,
    gradientStopsToDraft,
    gradientValueTags,
    normalizeHexColor,
    serializableCategoryStops,
    serializableGradientStops,
    sortedGradientStopDrafts
} from "./search-style-color.util";

describe("search style color helpers", () => {
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

    it("keeps invalid gradient drafts out of persisted output", () => {
        const draft = defaultSearchStyleColorDraft("speed");
        draft.gradientStops = [
            {id: 1, value: 0, color: "#2149ff"},
            {id: 2, value: null, color: "#ff1726"}
        ];
        expect(serializableGradientStops(draft)).toBeNull();
    });

    it("auto-generates decade-stepped numeric gradients from schema ranges", () => {
        let nextId = 1;
        const stops = gradientStopsForNumericRange({min: 0, max: 255}, () => nextId++);

        expect(stops.map(stop => stop.value).slice(0, 4)).toEqual([0, 10, 20, 30]);
        expect(stops.at(-2)?.value).toBe(250);
        expect(stops.at(-1)?.value).toBe(255);
        expect(stops.every(stop => /^#[0-9a-f]{6}$/.test(stop.color))).toBe(true);
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
