/**
 * Geolocation provider input, validated runtime configuration and result limits.
 * AppConfigService composes these pure definitions at startup; the geolocation
 * controller uses the same normalized providers for omnibar place lookup.
 */
import { z } from "zod";

/** Limits for persisted location-result preferences and provider requests. */
export const DEFAULT_LOCATION_SEARCH_RESULT_LIMIT = 10;

export const MAX_LOCATION_SEARCH_RESULT_LIMIT = 50;

/** Clamps location-search hit limits from persisted state and preferences UI. */
export function clampLocationSearchResultLimit(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return DEFAULT_LOCATION_SEARCH_RESULT_LIMIT;
    }
    return Math.min(MAX_LOCATION_SEARCH_RESULT_LIMIT, Math.max(1, Math.trunc(numeric)));
}

export type LocationSearchFieldSelector = string | number | boolean | {
    path?: string;
    value?: string | number | boolean;
    template?: string;
};

export interface LocationSearchAdapterFieldsConfig {
    id?: LocationSearchFieldSelector;
    name?: LocationSearchFieldSelector;
    lonLat?: LocationSearchFieldSelector;
    longitude?: LocationSearchFieldSelector;
    latitude?: LocationSearchFieldSelector;
    aabb?: LocationSearchFieldSelector;
    source?: LocationSearchFieldSelector;
    countryCode?: LocationSearchFieldSelector;
    population?: LocationSearchFieldSelector;
}

export interface LocationSearchBBoxAdapterConfig {
    path: string;
    format: "aabb" | "westSouthEastNorth" | "southNorthWestEast";
}

export interface LocationSearchAdapterConfig {
    itemsPath?: string;
    fields?: LocationSearchAdapterFieldsConfig;
    lonLatOrder?: "lonLat" | "latLon";
    bbox?: LocationSearchBBoxAdapterConfig;
}

/** One normalized location-search provider. */
export interface LocationSearchProviderConfig {
    id: string;
    name: string;
    url: string;
    headers: Record<string, string>;
    params?: Record<string, string | number | boolean>;
    queryParam?: string;
    limitParam?: string;
    attribution?: string;
    adapter?: LocationSearchAdapterConfig;
    enabled: boolean;
}

/** Location-search configuration consumed by the search palette. */
export interface LocationSearchConfig {
    providers: LocationSearchProviderConfig[];
    minCharacters: number;
    debounceMs: number;
}

/** Validators for deployment-provided geolocation adapters and provider defaults. */
export const LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA = z.union([
    z.string().min(1),
    z.number(),
    z.boolean(),
    z.object({
        path: z.string().min(1).optional(),
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        template: z.string().min(1).optional()
    }).refine(value => value.path !== undefined || value.value !== undefined || value.template !== undefined)
]);

const LOCATION_SEARCH_ADAPTER_FIELDS_SCHEMA = z.object({
    id: LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA.optional(),
    name: LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA.optional(),
    lonLat: LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA.optional(),
    longitude: LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA.optional(),
    latitude: LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA.optional(),
    aabb: LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA.optional(),
    source: LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA.optional(),
    countryCode: LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA.optional(),
    population: LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA.optional()
});

export const LOCATION_SEARCH_ADAPTER_SCHEMA = z.object({
    itemsPath: z.string().min(1).optional(),
    fields: LOCATION_SEARCH_ADAPTER_FIELDS_SCHEMA.optional(),
    lonLatOrder: z.enum(["lonLat", "latLon"]).optional(),
    bbox: z.object({
        path: z.string().min(1),
        format: z.enum(["aabb", "westSouthEastNorth", "southNorthWestEast"])
    }).optional()
});

const LOCATION_SEARCH_PROVIDER_SCHEMA = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    queryParam: z.string().min(1).optional(),
    limitParam: z.string().min(1).optional(),
    attribution: z.string().optional(),
    adapter: LOCATION_SEARCH_ADAPTER_SCHEMA.optional(),
    enabled: z.boolean().optional()
});

export const LOCATION_SEARCH_SCHEMA = z.object({
    providers: z.array(LOCATION_SEARCH_PROVIDER_SCHEMA).optional(),
    minCharacters: z.coerce.number().int().optional(),
    debounceMs: z.coerce.number().int().optional()
});

export type RawLocationSearchConfig = z.infer<typeof LOCATION_SEARCH_SCHEMA>;

export type RawLocationSearchAdapterConfig = z.infer<typeof LOCATION_SEARCH_ADAPTER_SCHEMA>;

export type RawLocationSearchFieldSelector = z.infer<typeof LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA>;

export const DEFAULT_LOCATION_SEARCH_CONFIG: LocationSearchConfig = {
    providers: [
        {
            id: "mapget-offline",
            name: "Place",
            url: "/location",
            headers: {},
            enabled: true
        }
    ],
    minCharacters: 2,
    debounceMs: 150
};

/** Normalizes configured location-search providers and behavior knobs. */
export function normalizeLocationSearch(locationSearch: RawLocationSearchConfig | undefined): LocationSearchConfig {
    const rawProviders = Array.isArray(locationSearch?.providers) && locationSearch.providers.length > 0
        ? locationSearch.providers
        : DEFAULT_LOCATION_SEARCH_CONFIG.providers;
    const providers: LocationSearchProviderConfig[] = [];
    const seenProviderIds = new Set<string>();
    for (const provider of rawProviders) {
        const id = provider.id.trim();
        if (!id || seenProviderIds.has(id)) {
            continue;
        }
        const name = provider.name.trim();
        const url = provider.url.trim();
        if (!name || !url) {
            continue;
        }
        seenProviderIds.add(id);
        const adapter = normalizeLocationSearchAdapter(provider.adapter);
        const queryParam = provider.queryParam?.trim();
        const limitParam = provider.limitParam?.trim();
        const params = provider.params ?? {};
        providers.push({
            id,
            name,
            url,
            headers: provider.headers ?? {},
            ...(Object.keys(params).length > 0 ? { params } : {}),
            ...(queryParam ? { queryParam } : {}),
            ...(limitParam ? { limitParam } : {}),
            ...(provider.attribution?.trim() ? { attribution: provider.attribution.trim() } : {}),
            ...(adapter ? { adapter } : {}),
            enabled: provider.enabled ?? true
        });
    }

    return {
        providers: providers.length ? providers : [...DEFAULT_LOCATION_SEARCH_CONFIG.providers],
        minCharacters: clampInteger(locationSearch?.minCharacters, 1, 64, DEFAULT_LOCATION_SEARCH_CONFIG.minCharacters),
        debounceMs: clampInteger(locationSearch?.debounceMs, 0, 2000, DEFAULT_LOCATION_SEARCH_CONFIG.debounceMs)
    };
}

/** Normalizes a declarative provider adapter without allowing arbitrary executable mapping logic. */
function normalizeLocationSearchAdapter(adapter: RawLocationSearchAdapterConfig | undefined): LocationSearchAdapterConfig | undefined {
    if (!adapter) {
        return undefined;
    }

    const result: LocationSearchAdapterConfig = {};
    if (typeof adapter.itemsPath === "string" && adapter.itemsPath.trim()) {
        result.itemsPath = adapter.itemsPath.trim();
    }
    if (adapter.lonLatOrder) {
        result.lonLatOrder = adapter.lonLatOrder;
    }
    if (adapter.bbox?.path?.trim()) {
        result.bbox = {
            path: adapter.bbox.path.trim(),
            format: adapter.bbox.format
        };
    }

    const fields = normalizeLocationSearchAdapterFields(adapter.fields);
    if (fields && Object.keys(fields).length > 0) {
        result.fields = fields;
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

/** Normalizes field selectors used by a location-search adapter. */
function normalizeLocationSearchAdapterFields(
    fields: RawLocationSearchAdapterConfig["fields"] | undefined): LocationSearchAdapterFieldsConfig | undefined {
    if (!fields) {
        return undefined;
    }

    const result: LocationSearchAdapterFieldsConfig = {};
    const fieldNames: Array<keyof LocationSearchAdapterFieldsConfig> = [
        "id",
        "name",
        "lonLat",
        "longitude",
        "latitude",
        "aabb",
        "source",
        "countryCode",
        "population"
    ];

    for (const fieldName of fieldNames) {
        const selector = normalizeLocationSearchFieldSelector(fields[fieldName]);
        if (selector !== undefined) {
            result[fieldName] = selector;
        }
    }

    return result;
}

/** Normalizes one path, constant, or template selector from config. */
function normalizeLocationSearchFieldSelector(
    selector: RawLocationSearchFieldSelector | undefined): LocationSearchFieldSelector | undefined {
    if (typeof selector === "string") {
        const trimmed = selector.trim();
        return trimmed ? trimmed : undefined;
    }
    if (typeof selector === "number") {
        return Number.isFinite(selector) ? selector : undefined;
    }
    if (typeof selector === "boolean") {
        return selector;
    }
    if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
        return undefined;
    }

    const result: Exclude<LocationSearchFieldSelector, string | number | boolean> = {};
    if (typeof selector.path === "string" && selector.path.trim()) {
        result.path = selector.path.trim();
    }
    if (typeof selector.template === "string" && selector.template.trim()) {
        result.template = selector.template.trim();
    }
    if (selector.value !== undefined) {
        if (typeof selector.value === "string") {
            const trimmed = selector.value.trim();
            if (trimmed) {
                result.value = trimmed;
            }
        } else if (typeof selector.value === "boolean" || (typeof selector.value === "number" && Number.isFinite(selector.value))) {
            result.value = selector.value;
        }
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

/** Clamps numeric config values into a stable integer range. */
function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.round(numeric)));
}
