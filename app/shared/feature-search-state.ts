import {z} from "zod";

export type FeatureSearchScope = "attribute" | "feature" | "auto";

export interface FeatureSearchRuleFilter {
    field: string;
    op: string;
    value?: unknown;
}

export interface FeatureSearchColorStop {
    color: string;
    value: unknown;
}

export type FeatureSearchGeometryKind = "any" | "point" | "line" | "polygon" | "mesh";

export type FeatureSearchColorMode =
    | {mode: "solid"; color: string}
    | {mode: "gradient"; field: string; stops: FeatureSearchColorStop[]; fallbackColor?: string}
    | {mode: "categories"; field: string; stops: FeatureSearchColorStop[]; fallbackColor?: string};

export interface FeatureSearchStyleRule {
    geometry: FeatureSearchGeometryKind;
    filter: FeatureSearchRuleFilter[];
    color: FeatureSearchColorMode;
    width?: number;
    pointRadius?: number;
    opacity?: number;
}

export interface FeatureSearchRenderStrategy {
    showLowFiDots: boolean;
    showBucketLabels: boolean;
    showHighFiGeometry: boolean;
    showHighFiResultDots: boolean;
    highFidelityMaxVisibleTiles: number;
}

export interface FeatureSearchStateEntry {
    id: string;
    query: string;
    scope: FeatureSearchScope;
    autoUpdate: boolean;
    paused: boolean;
    showResultsOnMap: boolean;
    pinColor: string;
    searchStyleRules: FeatureSearchStyleRule[];
    renderStrategy: FeatureSearchRenderStrategy;
}

export type FeatureSearchStatePatch = Partial<Omit<FeatureSearchStateEntry, "id">>;

export const FeatureSearchStateSchema = z.array(z.unknown());

const DEFAULT_PIN_COLOR = "#ea4336";
const VALID_SCOPES = new Set<FeatureSearchScope>(["attribute", "feature", "auto"]);
const MAX_FEATURE_SEARCHES = 50;
const MAX_STYLE_RULES_PER_SEARCH = 50;
const MAX_FILTERS_PER_RULE = 25;
const MAX_COLOR_STOPS_PER_RULE = 25;
const VALID_GEOMETRIES = new Set<FeatureSearchGeometryKind>(["any", "point", "line", "polygon", "mesh"]);
const VALID_COLOR_MODES = new Set(["solid", "gradient", "categories"]);
const MIN_HIGH_FIDELITY_VISIBLE_TILES = 1;
const MAX_HIGH_FIDELITY_VISIBLE_TILES = 64 * 1024;

export const DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY: FeatureSearchRenderStrategy = {
    showLowFiDots: true,
    showBucketLabels: true,
    showHighFiGeometry: true,
    showHighFiResultDots: false,
    highFidelityMaxVisibleTiles: 512
};

function createFeatureSearchId(): string {
    return `feature_search_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeHexColor(value: unknown, fallback = DEFAULT_PIN_COLOR): string {
    if (typeof value !== "string") {
        return fallback;
    }
    const trimmed = value.trim();
    const longHex = /^#([0-9a-f]{6})$/i.exec(trimmed);
    if (longHex) {
        return `#${longHex[1].toLowerCase()}`;
    }
    const shortHex = /^#([0-9a-f]{3})$/i.exec(trimmed);
    if (shortHex) {
        const [r, g, b] = shortHex[1].split("");
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return value === 1 ? true : value === 0 ? false : fallback;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1") {
            return true;
        }
        if (normalized === "false" || normalized === "0") {
            return false;
        }
    }
    return fallback;
}

function normalizeScope(value: unknown): FeatureSearchScope {
    return typeof value === "string" && VALID_SCOPES.has(value as FeatureSearchScope)
        ? value as FeatureSearchScope
        : "auto";
}

function normalizeString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeGeometry(value: unknown): FeatureSearchGeometryKind {
    if (typeof value !== "string") {
        return "any";
    }
    const normalized = value.trim();
    if (VALID_GEOMETRIES.has(normalized as FeatureSearchGeometryKind)) {
        return normalized as FeatureSearchGeometryKind;
    }
    if (normalized === "anyGeom") {
        return "any";
    }
    if (normalized === "text") {
        return "point";
    }
    return "any";
}

function normalizeRuleFilters(value: unknown): FeatureSearchRuleFilter[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.slice(0, MAX_FILTERS_PER_RULE).flatMap(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            return [];
        }
        const raw = item as Record<string, unknown>;
        const field = normalizeString(raw["field"]);
        const op = normalizeString(raw["op"]);
        if (!field || !op) {
            return [];
        }
        return [{
            field,
            op,
            ...("value" in raw ? {value: raw["value"]} : {})
        }];
    });
}

function normalizeColorStops(value: unknown): FeatureSearchColorStop[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.slice(0, MAX_COLOR_STOPS_PER_RULE).flatMap(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            return [];
        }
        const raw = item as Record<string, unknown>;
        const color = normalizeHexColor(raw["color"], "");
        if (!color) {
            return [];
        }
        return [{
            color,
            value: raw["value"]
        }];
    });
}

function normalizeSearchColorMode(raw: Record<string, unknown>): FeatureSearchColorMode {
    const nested = raw["color"];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        const color = nested as Record<string, unknown>;
        const mode = normalizeString(color["mode"]) ?? "solid";
        if (mode === "solid") {
            return {
                mode: "solid",
                color: normalizeHexColor(color["color"], DEFAULT_PIN_COLOR)
            };
        }
        if (mode === "gradient" || mode === "categories") {
            return {
                mode,
                field: normalizeString(color["field"]) ?? "",
                stops: normalizeColorStops(color["stops"]),
                ...(normalizeString(color["fallbackColor"])
                    ? {fallbackColor: normalizeHexColor(color["fallbackColor"], DEFAULT_PIN_COLOR)}
                    : {})
            };
        }
        if (!VALID_COLOR_MODES.has(mode)) {
            return {mode: "solid", color: DEFAULT_PIN_COLOR};
        }
    }

    const legacyExpression = normalizeString(raw["dataExpression"]) ?? "";
    const legacySolidColor = normalizeString(raw["solidColor"]);
    if (legacySolidColor) {
        return {mode: "solid", color: normalizeHexColor(legacySolidColor)};
    }
    const legacyGradient = normalizeColorStops(raw["gradient"]);
    if (legacyGradient.length) {
        return {mode: "gradient", field: legacyExpression, stops: legacyGradient};
    }
    const legacyColorMap = normalizeColorStops(raw["colorMap"]);
    if (legacyColorMap.length) {
        return {mode: "categories", field: legacyExpression, stops: legacyColorMap};
    }
    return {mode: "solid", color: DEFAULT_PIN_COLOR};
}

function normalizePositiveNumber(value: unknown, min = 0): number | undefined {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue >= min ? numberValue : undefined;
}

export function normalizeFeatureSearchRenderStrategy(value: unknown): FeatureSearchRenderStrategy {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {...DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY};
    }
    const raw = value as Record<string, unknown>;
    const highFidelityMaxVisibleTiles = normalizePositiveNumber(
        raw["highFidelityMaxVisibleTiles"],
        MIN_HIGH_FIDELITY_VISIBLE_TILES
    );
    return {
        showLowFiDots: normalizeBoolean(
            raw["showLowFiDots"],
            DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY.showLowFiDots
        ),
        showBucketLabels: normalizeBoolean(
            raw["showBucketLabels"],
            DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY.showBucketLabels
        ),
        showHighFiGeometry: normalizeBoolean(
            raw["showHighFiGeometry"],
            DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY.showHighFiGeometry
        ),
        showHighFiResultDots: normalizeBoolean(
            raw["showHighFiResultDots"],
            DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY.showHighFiResultDots
        ),
        highFidelityMaxVisibleTiles: Math.min(
            MAX_HIGH_FIDELITY_VISIBLE_TILES,
            Math.max(
                MIN_HIGH_FIDELITY_VISIBLE_TILES,
                Math.floor(highFidelityMaxVisibleTiles
                    ?? DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY.highFidelityMaxVisibleTiles)
            )
        )
    };
}

function normalizeStyleRule(value: unknown): FeatureSearchStyleRule | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const raw = value as Record<string, unknown>;
    const width = normalizePositiveNumber(raw["width"]);
    const pointRadius = normalizePositiveNumber(raw["pointRadius"]);
    const opacity = normalizePositiveNumber(raw["opacity"]);
    return {
        geometry: normalizeGeometry(raw["geometry"] ?? raw["type"]),
        filter: normalizeRuleFilters(raw["filter"]),
        color: normalizeSearchColorMode(raw),
        ...(width !== undefined ? {width} : {}),
        ...(pointRadius !== undefined ? {pointRadius} : {}),
        ...(opacity !== undefined ? {opacity: Math.min(opacity, 1)} : {})
    };
}

export function normalizeFeatureSearchStateEntry(value: unknown): FeatureSearchStateEntry | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const raw = value as Record<string, unknown>;
    const query = normalizeString(raw["query"]);
    if (!query) {
        return null;
    }
    const id = normalizeString(raw["id"]) ?? createFeatureSearchId();
    const styleRules = Array.isArray(raw["searchStyleRules"])
        ? raw["searchStyleRules"]
            .slice(0, MAX_STYLE_RULES_PER_SEARCH)
            .map(normalizeStyleRule)
            .filter((rule): rule is FeatureSearchStyleRule => !!rule)
        : [];
    return {
        id,
        query,
        scope: normalizeScope(raw["scope"]),
        autoUpdate: normalizeBoolean(raw["autoUpdate"], false),
        paused: normalizeBoolean(raw["paused"], false),
        showResultsOnMap: normalizeBoolean(raw["showResultsOnMap"], true),
        pinColor: normalizeHexColor(raw["pinColor"]),
        searchStyleRules: styleRules,
        renderStrategy: normalizeFeatureSearchRenderStrategy(raw["renderStrategy"])
    };
}

export function normalizeFeatureSearchState(value: unknown): FeatureSearchStateEntry[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const seenIds = new Set<string>();
    const result: FeatureSearchStateEntry[] = [];
    for (const rawEntry of value.slice(0, MAX_FEATURE_SEARCHES)) {
        const entry = normalizeFeatureSearchStateEntry(rawEntry);
        if (!entry) {
            continue;
        }
        while (seenIds.has(entry.id)) {
            entry.id = createFeatureSearchId();
        }
        seenIds.add(entry.id);
        result.push(entry);
    }
    return result;
}

export function createFeatureSearchStateEntry(value: {query: string} & Partial<FeatureSearchStateEntry>): FeatureSearchStateEntry {
    return normalizeFeatureSearchStateEntry({
        id: createFeatureSearchId(),
        scope: "auto",
        autoUpdate: false,
        paused: false,
        showResultsOnMap: true,
        pinColor: DEFAULT_PIN_COLOR,
        searchStyleRules: [],
        renderStrategy: DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY,
        ...value
    })!;
}

export function serializeFeatureSearchState(value: FeatureSearchStateEntry[]): FeatureSearchStateEntry[] {
    return normalizeFeatureSearchState(value);
}
