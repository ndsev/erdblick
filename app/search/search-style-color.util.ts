export type SearchStyleColorMode = "solid" | "gradient" | "categories";
export type SearchStyleFieldValueKind = "number" | "integer" | "string" | "boolean" | "enum" | "object" | "array" | "unknown";

export interface SearchStyleNumericRange {
    min: number;
    max: number;
}

export interface SearchStyleFieldOption {
    label: string;
    value: string;
    valueKind?: SearchStyleFieldValueKind;
    enumValues?: string[];
    numericRange?: SearchStyleNumericRange;
}

export interface SearchStyleGradientStopDraft {
    id: number;
    value: number | null;
    color: string;
}

export interface SearchStyleCategoryStopDraft {
    id: number;
    valueText: string;
    color: string;
    pending?: boolean;
}

export interface SearchStyleColorDraft {
    mode: SearchStyleColorMode;
    field: string;
    customField?: boolean;
    solidColor: string;
    gradientStops: SearchStyleGradientStopDraft[];
    categoryStops: SearchStyleCategoryStopDraft[];
    fallbackColor: string;
}

export interface SearchStyleGradientValueTag {
    id: number;
    label: string;
    offsetPercent: number;
    edge: "start" | "middle" | "end";
}

export interface SearchStyleAutoInitializationResult {
    draft: SearchStyleColorDraft;
    message: string;
    success: boolean;
}

export const DEFAULT_SEARCH_STYLE_SOLID_COLOR = "#ff1726";
export const EMPTY_GRADIENT_PREVIEW_COLOR = "#8f8f8f";

function normalizeHexString(value: string | null | undefined): string | undefined {
    const trimmed = (value ?? "").trim();
    const longHex = /^#([0-9a-f]{6})$/i.exec(trimmed);
    if (longHex) {
        return `#${longHex[1].toLowerCase()}`;
    }
    const shortHex = /^#([0-9a-f]{3})$/i.exec(trimmed);
    if (shortHex) {
        const [r, g, b] = shortHex[1].split("");
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return undefined;
}

export function normalizeHexColor(
    value: string | null | undefined,
    fallback = DEFAULT_SEARCH_STYLE_SOLID_COLOR
): string {
    return normalizeHexString(value)
        ?? normalizeHexString(fallback)
        ?? DEFAULT_SEARCH_STYLE_SOLID_COLOR;
}

export function defaultSearchStyleColorDraft(field: string): SearchStyleColorDraft {
    return {
        mode: "gradient",
        field,
        customField: false,
        solidColor: DEFAULT_SEARCH_STYLE_SOLID_COLOR,
        gradientStops: [],
        categoryStops: [],
        fallbackColor: DEFAULT_SEARCH_STYLE_SOLID_COLOR
    };
}

export function cloneSearchStyleColorDraft(draft: SearchStyleColorDraft): SearchStyleColorDraft {
    return {
        mode: draft.mode,
        field: draft.field,
        customField: !!draft.customField,
        solidColor: normalizeHexColor(draft.solidColor),
        gradientStops: draft.gradientStops.map(stop => ({
            id: stop.id,
            value: stop.value === null || !Number.isFinite(Number(stop.value)) ? null : Number(stop.value),
            color: normalizeHexColor(stop.color)
        })),
        categoryStops: draft.categoryStops.map(stop => ({
            id: stop.id,
            valueText: stop.valueText,
            color: normalizeHexColor(stop.color),
            pending: stop.pending
        })),
        fallbackColor: normalizeHexColor(draft.fallbackColor, draft.solidColor)
    };
}

export function gradientStopsToDraft(
    stops: Array<{value: unknown; color: string}>,
    nextId: () => number
): SearchStyleGradientStopDraft[] {
    return stops.map(stop => {
        const value = Number(stop.value);
        return {
            id: nextId(),
            value: Number.isFinite(value) ? value : null,
            color: normalizeHexColor(stop.color)
        };
    });
}

export function gradientCss(stops: Array<{color: string; offset?: number}>): string {
    if (stops.length === 0) {
        return EMPTY_GRADIENT_PREVIEW_COLOR;
    }
    if (stops.length === 1) {
        return normalizeHexColor(stops[0].color);
    }
    const denominator = Math.max(stops.length - 1, 1);
    const cssStops = stops
        .map((stop, index) => {
            const offset = stop.offset ?? index / denominator;
            const clampedOffset = Number.isFinite(offset) ? Math.min(1, Math.max(0, offset)) : 0;
            return `${normalizeHexColor(stop.color)} ${Math.round(clampedOffset * 10000) / 100}%`;
        })
        .join(", ");
    return `linear-gradient(90deg, ${cssStops})`;
}

export function serializableGradientStops(
    draft: SearchStyleColorDraft
): Array<{value: number; color: string}> | null {
    const stops: Array<{value: number; color: string}> = [];
    for (const stop of draft.gradientStops) {
        if (stop.value === null) {
            return null;
        }
        const value = Number(stop.value);
        if (!Number.isFinite(value)) {
            return null;
        }
        stops.push({
            value,
            color: normalizeHexColor(stop.color, draft.fallbackColor || draft.solidColor)
        });
    }
    return stops;
}

function gradientStopNumberValue(stop: SearchStyleGradientStopDraft): number | null {
    if (stop.value === null || stop.value === undefined) {
        return null;
    }
    const value = Number(stop.value);
    return Number.isFinite(value) ? value : null;
}

export function gradientStopsNeedSorting(draft: SearchStyleColorDraft): boolean {
    let previous: number | null = null;
    for (const stop of draft.gradientStops) {
        const value = gradientStopNumberValue(stop);
        if (value === null) {
            return false;
        }
        if (previous !== null && previous > value) {
            return true;
        }
        previous = value;
    }
    return false;
}

export function sortedGradientStopDrafts(
    stops: SearchStyleGradientStopDraft[]
): SearchStyleGradientStopDraft[] {
    return [...stops].sort((lhs, rhs) =>
        (gradientStopNumberValue(lhs) ?? Number.POSITIVE_INFINITY)
        - (gradientStopNumberValue(rhs) ?? Number.POSITIVE_INFINITY)
    );
}

export function gradientPreviewCss(draft: SearchStyleColorDraft): string {
    if (!draft.gradientStops.length) {
        return EMPTY_GRADIENT_PREVIEW_COLOR;
    }
    if (draft.gradientStops.length === 1) {
        return normalizeHexColor(draft.gradientStops[0].color, draft.fallbackColor || draft.solidColor);
    }
    const finiteStops = serializableGradientStops(draft);
    if (!finiteStops) {
        return gradientCss(draft.gradientStops.map(stop => ({color: stop.color})));
    }
    const sortedStops = [...finiteStops].sort((lhs, rhs) => lhs.value - rhs.value);
    const min = sortedStops[0].value;
    const max = sortedStops[sortedStops.length - 1].value;
    const span = max - min;
    return gradientCss(sortedStops.map((stop, index) => ({
        color: stop.color,
        offset: span === 0 ? index / Math.max(sortedStops.length - 1, 1) : (stop.value - min) / span
    })));
}

export function gradientValueTags(draft: SearchStyleColorDraft): SearchStyleGradientValueTag[] {
    const stops = draft.gradientStops
        .flatMap(stop => {
            if (stop.value === null || stop.value === undefined) {
                return [];
            }
            const value = Number(stop.value);
            return Number.isFinite(value)
                ? [{id: stop.id, value}]
                : [];
        })
        .sort((lhs, rhs) => lhs.value - rhs.value);
    if (stops.length === 0) {
        return [];
    }
    if (stops.length === 1) {
        return [{
            id: stops[0].id,
            label: String(stops[0].value),
            offsetPercent: 50,
            edge: "middle"
        }];
    }
    const min = stops[0].value;
    const max = stops[stops.length - 1].value;
    const span = max - min;
    return stops.map((stop, index) => {
        const offset = span === 0
            ? index / Math.max(stops.length - 1, 1)
            : (stop.value - min) / span;
        return {
            id: stop.id,
            label: String(stop.value),
            offsetPercent: Math.round(offset * 10000) / 100,
            edge: offset <= 0 ? "start" : offset >= 1 ? "end" : "middle"
        };
    });
}

export function isNumericStyleValueKind(kind: SearchStyleFieldValueKind | undefined): boolean {
    return kind === "number" || kind === "integer";
}

/** Returns a deterministic color for one enum value while avoiding collisions within the enum set. */
export function categoryColorForEnumValue(value: string, usedColors = new Set<string>()): string {
    const hash = stableStringHash(value);
    let hue = hash % 360;
    let saturation = 58 + ((hash >>> 8) % 18);
    let lightness = 44 + ((hash >>> 16) % 14);
    let color = hslToHex(hue, saturation, lightness);
    for (let attempt = 0; usedColors.has(color) && attempt < 360; ++attempt) {
        hue = (hue + 37) % 360;
        saturation = 58 + ((saturation + 7) % 18);
        lightness = 44 + ((lightness + 5) % 14);
        color = hslToHex(hue, saturation, lightness);
    }
    usedColors.add(color);
    return color;
}

/** Creates one category stop for each schema enum value. */
export function categoryStopsForEnumValues(
    enumValues: string[],
    nextId: () => number
): SearchStyleCategoryStopDraft[] {
    const usedColors = new Set<string>();
    return enumValues.map(value => ({
        id: nextId(),
        valueText: value,
        color: categoryColorForEnumValue(value, usedColors),
        pending: false
    }));
}

/** Creates category stops from observed values, using heat colors for sorted scalar buckets. */
export function categoryStopsForObservedValues(
    values: string[],
    valueKind: SearchStyleFieldValueKind | undefined,
    nextId: () => number
): SearchStyleCategoryStopDraft[] {
    const numeric = isNumericStyleValueKind(valueKind)
        && values.every(value => Number.isFinite(Number(value)));
    const sortedValues = [...values].sort((lhs, rhs) => {
        if (numeric) {
            return Number(lhs) - Number(rhs);
        }
        return lhs.localeCompare(rhs);
    });
    return sortedValues.map((value, index) => ({
        id: nextId(),
        valueText: value,
        color: gradientColorAt(index / Math.max(sortedValues.length - 1, 1)),
        pending: false
    }));
}

/** Creates at most eight numeric gradient stops with denser coverage in the lower half of the range. */
export function gradientStopsForNumericRange(
    range: SearchStyleNumericRange | undefined,
    nextId: () => number
): SearchStyleGradientStopDraft[] {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min > range.max) {
        return [];
    }
    if (range.min === range.max) {
        return [{id: nextId(), value: range.min, color: gradientColorAt(0.5)}];
    }

    const span = range.max - range.min;
    const roundingStep = span / 10;
    const offsets = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1];
    const values = offsets.reduce<number[]>((result, offset, index) => {
        const exactValue = index === offsets.length - 1
            ? range.max
            : range.min + span * offset;
        const value = index === 0 || index === offsets.length - 1
            ? exactValue
            : roundGradientValue(exactValue, roundingStep);
        if (result.length === 0 || result[result.length - 1] !== value) {
            result.push(value);
        }
        return result;
    }, []);

    return values.map((value, index) => ({
        id: nextId(),
        value,
        color: gradientColorAt(index / Math.max(values.length - 1, 1))
    }));
}

/** Creates observed-data gradients with linear value spacing across the measured domain. */
export function gradientStopsForObservedNumericRange(
    range: SearchStyleNumericRange | undefined,
    nextId: () => number
): SearchStyleGradientStopDraft[] {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min > range.max) {
        return [];
    }
    if (range.min === range.max) {
        return [{id: nextId(), value: range.min, color: gradientColorAt(0.5)}];
    }

    const stopCount = 8;
    const span = range.max - range.min;
    const roundingStep = span / (stopCount - 1);
    const values = Array.from({length: stopCount}, (_, index) => {
        if (index === 0) {
            return range.min;
        }
        if (index === stopCount - 1) {
            return range.max;
        }
        return roundGradientValue(range.min + span * (index / (stopCount - 1)), roundingStep);
    }).filter((value, index, array) => index === 0 || value !== array[index - 1]);

    return values.map((value, index) => {
        const offset = index / Math.max(values.length - 1, 1);
        return {
            id: nextId(),
            value,
            color: gradientColorAt(offset)
        };
    });
}

/** Auto-populates gradient/category stops for one selected schema field. */
export function autoInitializeSearchStyleColorDraft(
    draft: SearchStyleColorDraft,
    fieldOption: SearchStyleFieldOption | undefined,
    nextId: () => number
): SearchStyleAutoInitializationResult {
    if (draft.mode === "solid") {
        return {draft: cloneSearchStyleColorDraft(draft), message: "", success: true};
    }

    if (!fieldOption || draft.customField) {
        return {
            draft: cloneSearchStyleColorDraft({
                ...draft,
                gradientStops: draft.mode === "gradient" ? [] : draft.gradientStops,
                categoryStops: draft.mode === "categories" ? [] : draft.categoryStops
            }),
            message: "No schema metadata is available for automatic color initialization.",
            success: false
        };
    }

    if (draft.mode === "categories") {
        const enumValues = fieldOption.enumValues ?? [];
        if (fieldOption.valueKind === "enum" && enumValues.length > 0) {
            return {
                draft: cloneSearchStyleColorDraft({
                    ...draft,
                    categoryStops: categoryStopsForEnumValues(enumValues, nextId),
                    gradientStops: []
                }),
                message: "",
                success: true
            };
        }
        return {
            draft: cloneSearchStyleColorDraft({...draft, categoryStops: []}),
            message: "Automatic categories require a schema enum field.",
            success: false
        };
    }

    if (fieldOption.valueKind === "enum") {
        return {
            draft: cloneSearchStyleColorDraft({...draft, gradientStops: []}),
            message: "Enum fields can only be auto-initialized in Categories mode.",
            success: false
        };
    }
    if (!isNumericStyleValueKind(fieldOption.valueKind)) {
        return {
            draft: cloneSearchStyleColorDraft({...draft, gradientStops: []}),
            message: "Automatic gradients require a numeric schema field.",
            success: false
        };
    }

    const gradientStops = gradientStopsForNumericRange(fieldOption.numericRange, nextId);
    if (gradientStops.length === 0) {
        return {
            draft: cloneSearchStyleColorDraft({...draft, gradientStops: []}),
            message: "Automatic gradients require numeric min/max bounds in the schema.",
            success: false
        };
    }
    return {
        draft: cloneSearchStyleColorDraft({...draft, gradientStops, categoryStops: []}),
        message: "",
        success: true
    };
}

function stableStringHash(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; ++index) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function hslToHex(hue: number, saturationPercent: number, lightnessPercent: number): string {
    const saturation = saturationPercent / 100;
    const lightness = lightnessPercent / 100;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const segment = hue / 60;
    const x = chroma * (1 - Math.abs(segment % 2 - 1));
    const match = lightness - chroma / 2;
    const [red, green, blue] = segment < 1
        ? [chroma, x, 0]
        : segment < 2
            ? [x, chroma, 0]
            : segment < 3
                ? [0, chroma, x]
                : segment < 4
                    ? [0, x, chroma]
                    : segment < 5
                        ? [x, 0, chroma]
                        : [chroma, 0, x];
    return `#${[red, green, blue]
        .map(channel => Math.round((channel + match) * 255).toString(16).padStart(2, "0"))
        .join("")}`;
}

function gradientColorAt(offset: number): string {
    const clamped = Math.max(0, Math.min(1, offset));
    if (clamped <= 0.5) {
        return interpolateHexColor("#2149ff", "#d9ff32", clamped / 0.5);
    }
    return interpolateHexColor("#d9ff32", "#ff1726", (clamped - 0.5) / 0.5);
}

function interpolateHexColor(startColor: string, endColor: string, offset: number): string {
    const start = hexToRgb(startColor);
    const end = hexToRgb(endColor);
    return `#${start.map((channel, index) =>
        Math.round(channel + (end[index] - channel) * offset).toString(16).padStart(2, "0")
    ).join("")}`;
}

function hexToRgb(color: string): [number, number, number] {
    const normalized = normalizeHexColor(color);
    return [
        Number.parseInt(normalized.slice(1, 3), 16),
        Number.parseInt(normalized.slice(3, 5), 16),
        Number.parseInt(normalized.slice(5, 7), 16)
    ];
}

function roundGradientValue(value: number, step: number): number {
    const decimals = step >= 1 ? 0 : Math.ceil(Math.abs(Math.log10(step))) + 2;
    return Number(value.toFixed(Math.min(12, decimals)));
}

function serializableValue(valueText: string, valueKind: SearchStyleFieldValueKind | undefined): unknown {
    const trimmed = valueText.trim();
    if (isNumericStyleValueKind(valueKind)) {
        const numeric = Number(trimmed);
        return Number.isFinite(numeric) ? numeric : trimmed;
    }
    if (valueKind === "boolean") {
        const lower = trimmed.toLowerCase();
        if (lower === "true") {
            return true;
        }
        if (lower === "false") {
            return false;
        }
    }
    return trimmed;
}

export function serializableCategoryStops(
    draft: SearchStyleColorDraft,
    valueKind?: SearchStyleFieldValueKind
): Array<{value: unknown; color: string}> {
    return draft.categoryStops
        .map(stop => ({
            value: serializableValue(stop.valueText, valueKind),
            color: normalizeHexColor(stop.color, draft.fallbackColor || draft.solidColor)
        }));
}

export function isSerializableColorDraft(draft: SearchStyleColorDraft): boolean {
    return draft.mode !== "gradient" || serializableGradientStops(draft) !== null;
}
