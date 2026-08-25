import {describe, expect, it} from "vitest";
import {inspectionHtmlPresentation} from "./inspection-html.presentation";

describe("inspectionHtmlPresentation", () => {
    const passThroughSanitizer = (html: string) => html;

    it("recognizes nested formatting and produces inert display HTML", () => {
        expect(inspectionHtmlPresentation(
            '<a href="https://example.test" target="_blank"><strong>Schema</strong></a>',
            passThroughSanitizer
        )).toEqual({
            html: "<a><strong>Schema</strong></a>",
            text: "Schema"
        });
    });

    it("does not mistake comparisons, incomplete markup, or custom tags for formatted values", () => {
        expect(inspectionHtmlPresentation("5 < 10 and x > 2", passThroughSanitizer)).toBeUndefined();
        expect(inspectionHtmlPresentation("prefix <strong", passThroughSanitizer)).toBeUndefined();
        expect(inspectionHtmlPresentation("<field-name>value</field-name>", passThroughSanitizer)).toBeUndefined();
    });

    it("removes resource-bearing content while preserving safe formatting", () => {
        expect(inspectionHtmlPresentation(
            '<img src="https://example.test/pixel"><b style="color:red" onclick="alert(1)">Safe</b>',
            passThroughSanitizer
        )).toEqual({
            html: "<b>Safe</b>",
            text: "Safe"
        });
    });

    it("keeps visible spacing between formatted blocks in the compact label", () => {
        expect(inspectionHtmlPresentation("First<br><strong>Second</strong>", passThroughSanitizer)?.text)
            .toBe("First Second");
    });

    it("rejects content removed completely by the sanitizer", () => {
        expect(inspectionHtmlPresentation("<b>unsafe</b>", () => null)).toBeUndefined();
    });
});
