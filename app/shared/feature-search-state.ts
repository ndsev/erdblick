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

export interface FeatureSearchStyleRule {
    filter: FeatureSearchRuleFilter[];
    type: string;
    width?: number;
    dataExpression?: string;
    solidColor?: string;
    gradient: FeatureSearchColorStop[];
    colorMap: FeatureSearchColorStop[];
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
}

export type FeatureSearchStatePatch = Partial<Omit<FeatureSearchStateEntry, "id">>;

export const FeatureSearchStateSchema = z.array(z.unknown());

const DEFAULT_PIN_COLOR = "#ea4336";
const VALID_SCOPES = new Set<FeatureSearchScope>(["attribute", "feature", "auto"]);
const MAX_FEATURE_SEARCHES = 50;
const MAX_STYLE_RULES_PER_SEARCH = 50;
const MAX_FILTERS_PER_RULE = 25;
const MAX_COLOR_STOPS_PER_RULE = 25;

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

function normalizeStyleRule(value: unknown): FeatureSearchStyleRule | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const raw = value as Record<string, unknown>;
    const type = normalizeString(raw["type"]) ?? "anyGeom";
    const width = Number(raw["width"]);
    const dataExpression = normalizeString(raw["dataExpression"]);
    const solidColor = normalizeString(raw["solidColor"]);
    return {
        filter: normalizeRuleFilters(raw["filter"]),
        type,
        ...(Number.isFinite(width) && width >= 0 ? {width} : {}),
        ...(dataExpression ? {dataExpression} : {}),
        ...(solidColor ? {solidColor} : {}),
        gradient: normalizeColorStops(raw["gradient"]),
        colorMap: normalizeColorStops(raw["colorMap"])
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
        searchStyleRules: styleRules
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
        ...value
    })!;
}

export function serializeFeatureSearchState(value: FeatureSearchStateEntry[]): FeatureSearchStateEntry[] {
    return normalizeFeatureSearchState(value);
}
