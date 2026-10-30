/** Converts native RGB hex syntax for a browser picker without changing the authored color text. */
export function stylePickerColor(value: unknown): string {
    const text = String(value).replace(/^(?:#|0x)/i, "");
    if (/^[\da-f]{6}$/i.test(text)) return `#${text}`;
    if (/^[\da-f]{3}$/i.test(text)) return `#${[...text].map(c => c + c).join("")}`;
    return "#000000";
}
