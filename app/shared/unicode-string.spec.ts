import {describe, expect, it} from "vitest";
import {z} from "zod";
import {boundedUnicodeString, unicodePrefix} from "./unicode-string";

describe("Draft-07 Unicode string bounds", () => {
    it.each(["a", "é", "中", "😀"])("counts %s by code points, not UTF-16 units", point => {
        const schema = boundedUnicodeString(120);
        expect(schema.safeParse(point.repeat(120)).success).toBe(true);
        expect(schema.safeParse(point.repeat(121)).success).toBe(false);
        expect(unicodePrefix(point.repeat(121), 120)).toBe(point.repeat(120));
    });

    it("counts combining marks separately without normalizing text", () => {
        expect(boundedUnicodeString(1).safeParse("e\u0301").success).toBe(false);
        expect(boundedUnicodeString(2).parse("e\u0301")).toBe("e\u0301");
        expect(unicodePrefix("e\u0301", 1)).toBe("e");
    });

    it("preserves nonempty validation and does not coerce other values", () => {
        expect(boundedUnicodeString(1).parse("")).toBe("");
        expect(boundedUnicodeString(1, true).safeParse("").success).toBe(false);
        expect(boundedUnicodeString(1, true).parse("😀")).toBe("😀");
        for (const value of [1, null, undefined, ["a"]]) {
            expect(boundedUnicodeString(1).safeParse(value).success).toBe(false);
        }
    });

    it("never splits a surrogate pair at a mixed-text boundary", () => {
        const prefix = "a".repeat(119) + "😀";
        expect(unicodePrefix(prefix + "x", 120)).toBe(prefix);
        expect(unicodePrefix("😀", 0)).toBe("");
        expect(unicodePrefix("", 0)).toBe("");
    });

    it.each([false, true])("preserves exported schema bytes (nonempty=%s)", nonempty => {
        const previous = (nonempty ? z.string().min(1) : z.string()).max(120);
        expect(JSON.stringify(z.toJSONSchema(boundedUnicodeString(120, nonempty).optional(), {target: "draft-07"})))
            .toBe(JSON.stringify(z.toJSONSchema(previous.optional(), {target: "draft-07"})));
    });
});
