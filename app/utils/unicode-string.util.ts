import {z} from "zod";

/** Take a code-point prefix; maxLength must be a nonnegative integer. Preserve surrogate pairs. */
export function unicodePrefix(value: string, maxLength: number): string {
    let end = 0;
    let count = 0;
    for (const point of value) {
        if (count++ === maxLength) return value.slice(0, end);
        end += point.length;
    }
    return value;
}

/** Matches Draft-07 maxLength, unlike Zod's UTF-16-unit .max(); nonempty has identical semantics in both. */
export function boundedUnicodeString(maxLength: number, nonempty = false): z.ZodString {
    const schema = nonempty ? z.string().min(1) : z.string();
    return schema.refine(value => unicodePrefix(value, maxLength) === value,
        `Expected at most ${maxLength} Unicode code points`).meta({maxLength});
}
