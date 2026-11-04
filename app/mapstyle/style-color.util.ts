let pickerColorContext: CanvasRenderingContext2D | null | undefined;

/** Converts RGB hex and named colors for a browser picker without changing the authored source. */
export function stylePickerColor(value: unknown): string {
    const source = String(value).trim();
    const text = source.replace(/^(?:#|0x)/i, "");
    if (/^[\da-f]{6}$/i.test(text)) return `#${text}`;
    if (/^[\da-f]{3}$/i.test(text)) return `#${[...text].map(c => c + c).join("")}`;
    if (/^[a-z]+$/i.test(source) && typeof document !== "undefined") {
        // Reuse the browser's named-color parser for the swatch; native validation
        // still owns which authored colors are valid. No duplicate color catalog.
        if (pickerColorContext === undefined) {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            pickerColorContext = canvas.getContext("2d");
        }
        if (pickerColorContext) {
            pickerColorContext.fillStyle = "#000000";
            pickerColorContext.fillStyle = source;
            const color = pickerColorContext.fillStyle;
            if (/^#[\da-f]{6}$/i.test(color)) return color;
        }
    }
    return "#000000";
}
