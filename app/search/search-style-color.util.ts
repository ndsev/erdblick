export type SearchStyleColorMode = "solid" | "gradient" | "categories";
export type SearchStyleFieldValueKind = "number" | "integer" | "string" | "boolean" | "enum" | "object" | "array" | "unknown";

export interface SearchStyleFieldOption {
    label: string;
    value: string;
    valueKind?: SearchStyleFieldValueKind;
    enumValues?: string[];
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
