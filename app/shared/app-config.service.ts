import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {BehaviorSubject, Observable, firstValueFrom} from "rxjs";
import {z} from "zod";
import * as jsyaml from "js-yaml";
import {
    MapPresetDefinition,
    MapPresetIssue,
    parseMapPresetDefinitions
} from "../styledata/map-preset.model";

/** Background layer id used when neither URL nor stored state selects a layer. */
export const DEFAULT_BACKGROUND_LAYER_ID = "osm";

/** Default background opacity chosen for the shipped OSM layer so map data stays dominant. */
export const DEFAULT_BACKGROUND_OPACITY = 6;

/** Highest XYZ zoom requested when a custom background does not declare its own maxZoom. */
export const DEFAULT_XYZ_BACKGROUND_MAX_ZOOM = 22;

/** Highest WMS zoom requested when a custom background does not declare its own maxZoom. */
export const DEFAULT_WMS_BACKGROUND_MAX_ZOOM = 22;

/** Tooltip shown for WMS backgrounds to make the known deck.gl limitations explicit. */
export const WMS_BACKGROUND_EXPERIMENTAL_TOOLTIP =
    "WMS backgrounds use deck.gl's experimental WMSLayer. They are intended for 2D use first and may lag or render incorrectly in pitched 3D views.";

/** One built-in style bundle entry declared in `config.json`. */
export interface StyleConfigEntry {
    id?: string;
    url: string;
    additional?: boolean;
}

/** Optional extension-module ids declared in `config.json`. */
export interface ExtensionModulesConfig {
    jumpTargets?: string;
    distribVersions?: string;
}

/** One config-driven survey banner entry. */
export interface SurveyConfig {
    id: string;
    link: string;
    linkHtml: string;
    start?: string;
    end?: string;
    emoji?: string;
    background?: string;
}

/** Common metadata shared by every raster background source. */
export interface BackgroundLayerBaseConfig {
    id: string;
    name: string;
    attribution?: string;
    headers: Record<string, string>;
    defaultOpacity: number;
    minZoom: number;
    maxZoom: number;
}

/** XYZ raster-tile background configuration. */
export interface XyzBackgroundLayerConfig extends BackgroundLayerBaseConfig {
    type: "xyz";
    urlTemplate: string | string[];
    tileSize: number;
    extent?: [number, number, number, number];
}

/** WMS background configuration backed by deck.gl's experimental `WMSLayer`. */
export interface WmsBackgroundLayerConfig extends BackgroundLayerBaseConfig {
    type: "wms";
    url: string;
    layers: string[];
    version: "1.3.0" | "1.1.1";
    crs: "EPSG:3857" | "EPSG:4326";
    format: "image/png";
    transparent: boolean;
    vendorParameters: Record<string, string | number | boolean>;
}

/** Discriminated union of every currently supported background-layer type. */
export type BackgroundLayerConfig = XyzBackgroundLayerConfig | WmsBackgroundLayerConfig;

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

/** Normalized coordinate-panel defaults and optional legal text. */
export interface CoordinatesConfig {
    enabledByDefault: boolean;
    legalTermsUrl: string | null;
    legalTerms: string | null;
    legalTermsError: string | null;
}

/** One configured external map viewer shared by the context menu and search palette. */
export interface ExternalViewerConfig {
    id: string;
    name: string;
    urlTemplate: string;
}

/** Raw config shape before defaults are applied. */
export interface RawAppConfig {
    extensionModules?: ExtensionModulesConfig;
    surveys?: unknown[];
    styles?: Array<StyleConfigEntry | string>;
    additionalStyles?: Array<StyleConfigEntry | string>;
    state?: Record<string, unknown> | null;
    backgroundLayers?: RawBackgroundLayerConfig[];
    defaultBackgroundLayerId?: string | null;
    locationSearch?: RawLocationSearchConfig;
    externalViewers?: unknown[];
    mapPresets?: unknown[];
    /** Internal parser marker preserving present-but-malformed static/server input. */
    _mapPresetsInvalid?: boolean;
    "coordinates-enabled"?: boolean;
    "coordinates-legal-terms"?: string;
}

/** `/config` payload consumed from mapget/mapviewer. */
export interface ServerConfigResponse {
    model?: Record<string, unknown>;
    schema?: Record<string, unknown>;
    readOnly?: boolean;
    datasourceConfigUnavailable?: boolean;
    datasourceConfigUnavailableReason?: string | null;
    capabilities?: unknown;
    erdblick?: Partial<RawAppConfig>;
    erdblickRuntime?: {
        staticConfigUrl?: string;
        mode?: string;
        styleEditing?: {
            enabled?: boolean;
            directory?: string;
        };
    };
}

/** Server-config diagnostics exposed to runtime services. */
export interface AppServerConfigStatus {
    available: boolean;
    datasourceConfigUnavailable: boolean;
    datasourceConfigUnavailableReason: string | null;
    cacheReset: boolean;
    styleEditingEnabled: boolean;
    styleEditingDirectory: string | null;
    mapPresets: MapPresetConfigStatus;
}

/** Effective map-preset source, validation, and narrow write capability. */
export interface MapPresetConfigStatus {
    configured: boolean;
    valid: boolean;
    write: boolean;
    endpoint: string | null;
    method: string | null;
    path: string | null;
    revision: string | null;
    ephemeral: boolean;
    issues: MapPresetIssue[];
}

/** Normalized application config consumed by the Angular services. */
export interface AppConfig {
    extensionModules: ExtensionModulesConfig;
    surveys: SurveyConfig[];
    styles: StyleConfigEntry[];
    state: Record<string, unknown> | null;
    configStateHash: string;
    backgroundLayers: BackgroundLayerConfig[];
    defaultBackgroundLayerId: string | null;
    locationSearch: LocationSearchConfig;
    externalViewers: ExternalViewerConfig[];
    mapPresets: MapPresetDefinition[];
    mapPresetConfig: MapPresetConfigStatus;
    coordinates: CoordinatesConfig;
    serverConfig: AppServerConfigStatus;
}

const STYLE_CONFIG_ENTRY_SCHEMA = z.object({
    id: z.string().optional(),
    url: z.string().min(1),
    additional: z.boolean().optional()
});

const SURVEY_CONFIG_SCHEMA = z.object({
    id: z.string().min(1),
    link: z.string().min(1),
    linkHtml: z.string().min(1),
    start: z.string().optional(),
    end: z.string().optional(),
    emoji: z.string().optional(),
    background: z.string().optional()
});

const BACKGROUND_LAYER_BASE_SCHEMA = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    attribution: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    defaultOpacity: z.coerce.number().optional(),
    minZoom: z.coerce.number().int().optional(),
    maxZoom: z.coerce.number().int().optional()
});

const XYZ_BACKGROUND_LAYER_SCHEMA = BACKGROUND_LAYER_BASE_SCHEMA.extend({
    type: z.literal("xyz"),
    urlTemplate: z.union([
        z.string().min(1),
        z.array(z.string().min(1)).min(1)
    ]),
    tileSize: z.coerce.number().int().positive().optional(),
    extent: z.tuple([
        z.coerce.number(),
        z.coerce.number(),
        z.coerce.number(),
        z.coerce.number()
    ]).optional()
});

const WMS_BACKGROUND_LAYER_SCHEMA = BACKGROUND_LAYER_BASE_SCHEMA.extend({
    type: z.literal("wms"),
    url: z.string().min(1),
    layers: z.array(z.string().min(1)).min(1),
    version: z.enum(["1.3.0", "1.1.1"]).optional(),
    crs: z.enum(["EPSG:3857", "EPSG:4326"]).optional(),
    format: z.literal("image/png").optional(),
    transparent: z.boolean().optional(),
    vendorParameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
});

const BACKGROUND_LAYER_SCHEMA = z.union([
    XYZ_BACKGROUND_LAYER_SCHEMA,
    WMS_BACKGROUND_LAYER_SCHEMA
]);

type RawBackgroundLayerConfig = z.infer<typeof BACKGROUND_LAYER_SCHEMA>;

const LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA = z.union([
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

const LOCATION_SEARCH_ADAPTER_SCHEMA = z.object({
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

const LOCATION_SEARCH_SCHEMA = z.object({
    providers: z.array(LOCATION_SEARCH_PROVIDER_SCHEMA).optional(),
    minCharacters: z.coerce.number().int().optional(),
    debounceMs: z.coerce.number().int().optional()
});

const EXTERNAL_VIEWER_SCHEMA = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    urlTemplate: z.string().min(1)
});

const COORDINATES_LEGAL_TERMS_SCHEMA = z.object({
    "legal-terms": z.string().refine(value => value.trim().length > 0)
});

type RawLocationSearchConfig = z.infer<typeof LOCATION_SEARCH_SCHEMA>;
type RawLocationSearchAdapterConfig = z.infer<typeof LOCATION_SEARCH_ADAPTER_SCHEMA>;
type RawLocationSearchFieldSelector = z.infer<typeof LOCATION_SEARCH_FIELD_SELECTOR_SCHEMA>;

const RAW_APP_CONFIG_SCHEMA = z.object({
    extensionModules: z.object({
        jumpTargets: z.string().optional(),
        distribVersions: z.string().optional()
    }).partial().optional(),
    surveys: z.array(z.unknown()).optional(),
    styles: z.array(z.union([STYLE_CONFIG_ENTRY_SCHEMA, z.string().min(1)])).optional(),
    additionalStyles: z.array(z.union([STYLE_CONFIG_ENTRY_SCHEMA, z.string().min(1)])).optional(),
    state: z.record(z.string(), z.unknown()).nullable().optional(),
    backgroundLayers: z.array(BACKGROUND_LAYER_SCHEMA).optional(),
    defaultBackgroundLayerId: z.string().nullable().optional(),
    locationSearch: LOCATION_SEARCH_SCHEMA.optional(),
    externalViewers: z.array(z.unknown()).optional(),
    mapPresets: z.array(z.unknown()).max(200).optional().catch(undefined),
    "coordinates-enabled": z.boolean().optional(),
    "coordinates-legal-terms": z.string().min(1).optional()
}).passthrough();

const DEFAULT_BACKGROUND_LAYERS: BackgroundLayerConfig[] = [
    {
        id: "osm",
        name: "OpenStreetMap",
        type: "xyz",
        urlTemplate: "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: "© OpenStreetMap contributors",
        headers: {},
        defaultOpacity: DEFAULT_BACKGROUND_OPACITY,
        minZoom: 0,
        maxZoom: 19,
        tileSize: 256
    }
];

const DEFAULT_SERVER_CONFIG_STATUS: AppServerConfigStatus = {
    available: false,
    datasourceConfigUnavailable: false,
    datasourceConfigUnavailableReason: null,
    cacheReset: false,
    styleEditingEnabled: false,
    styleEditingDirectory: null,
    mapPresets: {
        configured: false,
        valid: true,
        write: false,
        endpoint: null,
        method: null,
        path: null,
        revision: null,
        ephemeral: false,
        issues: []
    }
};

const DEFAULT_LOCATION_SEARCH_CONFIG: LocationSearchConfig = {
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

const DEFAULT_APP_CONFIG: AppConfig = {
    extensionModules: {},
    surveys: [],
    styles: [],
    state: null,
    configStateHash: "00000000",
    backgroundLayers: DEFAULT_BACKGROUND_LAYERS,
    defaultBackgroundLayerId: DEFAULT_BACKGROUND_LAYER_ID,
    locationSearch: DEFAULT_LOCATION_SEARCH_CONFIG,
    externalViewers: [],
    mapPresets: [],
    mapPresetConfig: {...DEFAULT_SERVER_CONFIG_STATUS.mapPresets},
    coordinates: {
        enabledByDefault: true,
        legalTermsUrl: null,
        legalTerms: null,
        legalTermsError: null
    },
    serverConfig: DEFAULT_SERVER_CONFIG_STATUS
};

/** Clamps persisted and config-driven background opacity to the supported percentage range. */
export function clampBackgroundOpacity(value: number): number {
    if (!Number.isFinite(value)) {
        return 100;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
}

/** Server and frontend allow-list for HTML fragments allowed in survey banners. */
export function isAllowedSurveyLinkHtml(linkHtml: string): boolean {
    if (!linkHtml || linkHtml.length > 1024) {
        return false;
    }

    const lowered = linkHtml.toLowerCase();
    if (lowered.includes("javascript:") || lowered.includes("data:")) {
        return false;
    }

    const allowedOpenTags = new Set(["b", "strong", "i", "em", "small", "br"]);
    const allowedCloseTags = new Set(["b", "strong", "i", "em", "small"]);

    let cursor = 0;
    while (cursor < linkHtml.length) {
        const open = linkHtml.indexOf("<", cursor);
        if (open === -1) {
            break;
        }
        const close = linkHtml.indexOf(">", open + 1);
        if (close === -1) {
            return false;
        }

        let token = linkHtml.slice(open + 1, close).trim().toLowerCase();
        if (!token.length) {
            return false;
        }
        if (token.includes("=") || token.startsWith("!") || token.startsWith("?")) {
            return false;
        }

        if (token.startsWith("/")) {
            token = token.slice(1).trim();
            if (!token.length || /\s/.test(token) || !allowedCloseTags.has(token)) {
                return false;
            }
        } else {
            let selfClosing = false;
            if (token.endsWith("/")) {
                selfClosing = true;
                token = token.slice(0, -1).trim();
            }
            if (!token.length || /\s/.test(token) || !allowedOpenTags.has(token)) {
                return false;
            }
            if (selfClosing && token !== "br") {
                return false;
            }
        }

        cursor = close + 1;
    }

    return true;
}

/** Returns whether a value is a non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Returns whether a config value should participate in merging. */
function isMeaningfulValue(value: unknown): boolean {
    if (value === null || value === undefined) {
        return false;
    }
    if (typeof value === "string") {
        return value.trim().length > 0;
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (typeof value === "boolean") {
        return true;
    }
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (isPlainObject(value)) {
        return Object.values(value).some(entry => isMeaningfulValue(entry));
    }
    return false;
}

/** Merges meaningful object values while preserving existing defaults. */
function mergeMeaningfulObjectValues(
    base: Record<string, unknown>,
    override: Record<string, unknown>
): Record<string, unknown> {
    const merged: Record<string, unknown> = {...base};
    for (const [key, value] of Object.entries(override)) {
        if (!isMeaningfulValue(value)) {
            continue;
        }
        merged[key] = value;
    }
    return merged;
}

/** Loads and normalizes `config.json` once, then exposes it as a shared application service. */
@Injectable({providedIn: 'root'})
export class AppConfigService {
    private readonly configSubject = new BehaviorSubject<AppConfig>(DEFAULT_APP_CONFIG);
    private loadPromise: Promise<AppConfig> | null = null;
    private staticRawConfig: RawAppConfig = {};

    /** Creates the shared config loader used by styles, plugins, and background-layer UI. */
    constructor(private readonly httpClient: HttpClient) {
    }

    /** Returns the latest normalized config value, starting with the built-in fallback defaults. */
    get snapshot(): AppConfig {
        return this.configSubject.getValue();
    }

    /** Streams normalized config updates to any late subscribers that need them reactively. */
    get config$(): Observable<AppConfig> {
        return this.configSubject.asObservable();
    }

    /** Loads `/static-config/config.json` once and caches the normalized result for the rest of the session. */
    async load(): Promise<AppConfig> {
        if (this.loadPromise !== null) {
            return this.loadPromise;
        }

        this.loadPromise = this.loadInternal();
        return this.loadPromise;
    }

    /** Refetches server-owned map-preset state after a conflict or ambiguous write outcome. */
    async refreshMapPresetConfig(): Promise<AppConfig | null> {
        const serverResult = await this.loadServerConfig();
        if (!serverResult.serverConfig.available) {
            return null;
        }
        const merged = this.mergeServerErdblickConfig(
            this.staticRawConfig,
            serverResult.erdblickConfig,
            serverResult.serverConfig);
        const normalized = this.normalizeConfig(merged, serverResult.serverConfig);
        const previous = this.snapshot;
        const refreshed: AppConfig = {
            ...previous,
            mapPresets: normalized.mapPresets,
            mapPresetConfig: normalized.mapPresetConfig,
            serverConfig: normalized.serverConfig
        };
        this.configSubject.next(refreshed);
        return refreshed;
    }

    /** Commits a canonical successful PATCH response to the shared config snapshot. */
    applyCanonicalMapPresets(definitions: unknown, revision: string): boolean {
        const parsed = parseMapPresetDefinitions(definitions);
        if (parsed.issues.length || !Array.isArray(definitions)
            || parsed.presets.length !== definitions.length) {
            return false;
        }
        const previous = this.snapshot;
        const mapPresetConfig: MapPresetConfigStatus = {
            ...previous.mapPresetConfig,
            configured: true,
            valid: true,
            write: true,
            revision,
            issues: []
        };
        this.configSubject.next({
            ...previous,
            mapPresets: parsed.presets,
            mapPresetConfig,
            serverConfig: {
                ...previous.serverConfig,
                mapPresets: {
                    ...previous.serverConfig.mapPresets,
                    configured: true,
                    valid: true,
                    write: true,
                    revision,
                    issues: []
                }
            }
        });
        return true;
    }

    /** Returns the configured extension-module file name for one optional plugin slot. */
    getExtensionModuleId(moduleName: keyof ExtensionModulesConfig): string | null {
        return this.snapshot.extensionModules[moduleName] ?? null;
    }

    /** Returns the normalized background-layer list currently exposed to the UI. */
    getBackgroundLayers(): BackgroundLayerConfig[] {
        return [...this.snapshot.backgroundLayers];
    }

    /** Returns the configured default background-layer id after validity checks. */
    getDefaultBackgroundLayerId(): string | null {
        return this.snapshot.defaultBackgroundLayerId;
    }

    /** Loads static and server configuration into the resolved app config. */
    private async loadInternal(): Promise<AppConfig> {
        const staticRawConfig = await this.loadStaticConfig();
        this.staticRawConfig = staticRawConfig;
        const serverResult = await this.loadServerConfig();
        const mergedRawConfig = this.mergeServerErdblickConfig(
            staticRawConfig,
            serverResult.erdblickConfig,
            serverResult.serverConfig);
        const normalized = this.normalizeConfig(mergedRawConfig, serverResult.serverConfig);
        const resolved = await this.loadCoordinatesLegalTerms(normalized);
        this.configSubject.next(resolved);
        return resolved;
    }

    /** Loads the bundled static application configuration. */
    private async loadStaticConfig(): Promise<RawAppConfig> {
        try {
            const rawConfig = await firstValueFrom(this.httpClient.get("/static-config/config.json", {responseType: "json"}));
            return this.parseRawConfig(rawConfig, "/static-config/config.json");
        } catch (error) {
            console.error("[AppConfigService] Failed to load /static-config/config.json", error);
            return {};
        }
    }

    /** Loads server-provided configuration overrides. */
    private async loadServerConfig(): Promise<{
        serverConfig: AppServerConfigStatus;
        erdblickConfig: Partial<RawAppConfig>;
    }> {
        const serverConfig: AppServerConfigStatus = {
            ...DEFAULT_SERVER_CONFIG_STATUS,
            mapPresets: {...DEFAULT_SERVER_CONFIG_STATUS.mapPresets, issues: []}
        };
        let erdblickConfig: Partial<RawAppConfig> = {};

        try {
            const response = await firstValueFrom(
                this.httpClient.get<ServerConfigResponse>("/config", {
                    observe: "response"
                })
            );
            if (response.status !== 200) {
                return {serverConfig, erdblickConfig};
            }

            serverConfig.available = true;
            const payload = response.body ?? {};
            serverConfig.datasourceConfigUnavailable = payload.datasourceConfigUnavailable === true;
            serverConfig.datasourceConfigUnavailableReason =
                typeof payload.datasourceConfigUnavailableReason === "string"
                    ? payload.datasourceConfigUnavailableReason
                    : null;
            serverConfig.cacheReset =
                isPlainObject(payload.capabilities) &&
                payload.capabilities["cacheReset"] === true;

            const capabilities = isPlainObject(payload.capabilities)
                ? payload.capabilities["mapPresets"]
                : undefined;
            if (isPlainObject(capabilities)) {
                const endpoint = typeof capabilities["endpoint"] === "string"
                    ? capabilities["endpoint"]
                    : null;
                const method = typeof capabilities["method"] === "string"
                    ? capabilities["method"]
                    : null;
                const path = typeof capabilities["path"] === "string"
                    ? capabilities["path"]
                    : null;
                const revision = typeof capabilities["revision"] === "string"
                    ? capabilities["revision"]
                    : null;
                serverConfig.mapPresets = {
                    configured: capabilities["configured"] === true,
                    valid: capabilities["valid"] !== false,
                    write: capabilities["write"] === true
                        && endpoint === "/config"
                        && method === "PATCH"
                        && path === "/erdblick/mapPresets"
                        && !!revision,
                    endpoint,
                    method,
                    path,
                    revision,
                    ephemeral: capabilities["ephemeral"] === true,
                    issues: Array.isArray(capabilities["issues"])
                        ? capabilities["issues"]
                            .filter((issue): issue is string => typeof issue === "string")
                            .slice(0, 20)
                            .map(message => ({message}))
                        : []
                };
            }

            const styleEditing = payload.erdblickRuntime?.styleEditing;
            serverConfig.styleEditingEnabled = styleEditing?.enabled === true;
            serverConfig.styleEditingDirectory = serverConfig.styleEditingEnabled
                && typeof styleEditing?.directory === "string"
                && styleEditing.directory.trim().length > 0
                ? styleEditing.directory.trim()
                : null;

            if (payload.erdblick && isPlainObject(payload.erdblick)) {
                if (!isPlainObject(capabilities)
                    && Object.prototype.hasOwnProperty.call(payload.erdblick, "mapPresets")) {
                    serverConfig.mapPresets.configured = true;
                }
                erdblickConfig = this.parseRawConfig(payload.erdblick, "/config.erdblick");
                if (serverConfig.mapPresets.configured && !Array.isArray(erdblickConfig.mapPresets)) {
                    // A malformed present server value is authoritative and blocks static fallback.
                    erdblickConfig.mapPresets = [];
                    serverConfig.mapPresets.valid = false;
                }
            }
        } catch (error) {
            console.warn("[AppConfigService] Failed to load /config; continuing with static config.json", error);
        }

        return {serverConfig, erdblickConfig};
    }

    /** Parses raw configuration text into an object. */
    private parseRawConfig(rawConfig: unknown, sourceLabel: string): RawAppConfig {
        const mapPresetsPresent = isPlainObject(rawConfig)
            && Object.prototype.hasOwnProperty.call(rawConfig, "mapPresets");
        const parsed = RAW_APP_CONFIG_SCHEMA.safeParse(rawConfig);
        if (!parsed.success) {
            console.error(`[AppConfigService] Invalid ${sourceLabel}; ignoring payload`, parsed.error);
            return {};
        }
        if (mapPresetsPresent && !Array.isArray(parsed.data.mapPresets)) {
            return {...parsed.data, mapPresets: [], _mapPresetsInvalid: true};
        }
        return parsed.data;
    }

    /** Merges server erdblick settings into the active config. */
    private mergeServerErdblickConfig(
        staticConfig: RawAppConfig,
        serverErdblickConfig: Partial<RawAppConfig>,
        serverConfig: AppServerConfigStatus
    ): RawAppConfig {
        const merged: RawAppConfig = {
            ...staticConfig,
            extensionModules: {...(staticConfig.extensionModules ?? {})},
            styles: staticConfig.styles ? [...staticConfig.styles] : undefined,
            additionalStyles: staticConfig.additionalStyles ? [...staticConfig.additionalStyles] : undefined,
            surveys: staticConfig.surveys ? [...staticConfig.surveys] : undefined,
            state: staticConfig.state ? {...staticConfig.state} : staticConfig.state ?? null,
            backgroundLayers: staticConfig.backgroundLayers ? [...staticConfig.backgroundLayers] : undefined,
            externalViewers: staticConfig.externalViewers ? [...staticConfig.externalViewers] : undefined,
            mapPresets: staticConfig.mapPresets ? [...staticConfig.mapPresets] : undefined,
            _mapPresetsInvalid: staticConfig._mapPresetsInvalid,
            locationSearch: staticConfig.locationSearch
                ? {
                    ...staticConfig.locationSearch,
                    providers: staticConfig.locationSearch.providers
                        ? [...staticConfig.locationSearch.providers]
                        : undefined
                }
                : undefined
        };

        if (Array.isArray(serverErdblickConfig.styles) && serverErdblickConfig.styles.length > 0) {
            merged.styles = [...serverErdblickConfig.styles];
        }
        if (Array.isArray(serverErdblickConfig.additionalStyles) && serverErdblickConfig.additionalStyles.length > 0) {
            merged.additionalStyles = [
                ...(merged.additionalStyles ?? []),
                ...serverErdblickConfig.additionalStyles
            ];
        }
        if (Array.isArray(serverErdblickConfig.surveys) && serverErdblickConfig.surveys.length > 0) {
            merged.surveys = [...serverErdblickConfig.surveys];
        }
        if (Array.isArray(serverErdblickConfig.backgroundLayers) && serverErdblickConfig.backgroundLayers.length > 0) {
            merged.backgroundLayers = [...serverErdblickConfig.backgroundLayers];
        }
        if (Array.isArray(serverErdblickConfig.externalViewers)) {
            merged.externalViewers = [...serverErdblickConfig.externalViewers];
        }
        if (Array.isArray(serverErdblickConfig.mapPresets)) {
            // Presence replaces the static list; an explicit empty array deliberately clears it.
            merged.mapPresets = [...serverErdblickConfig.mapPresets];
            merged._mapPresetsInvalid = serverErdblickConfig._mapPresetsInvalid;
        } else if (!serverConfig.mapPresets.valid) {
            // An invalid authoritative server section must not reveal a static fallback catalog.
            merged.mapPresets = [];
            merged._mapPresetsInvalid = false;
        } else if (!serverConfig.mapPresets.configured && serverConfig.mapPresets.write) {
            const parsedStaticPresets = parseMapPresetDefinitions(staticConfig.mapPresets ?? []);
            const hasValidStaticCatalog = Array.isArray(staticConfig.mapPresets)
                && !staticConfig._mapPresetsInvalid
                && parsedStaticPresets.issues.length === 0
                && parsedStaticPresets.presets.length === staticConfig.mapPresets.length;
            if (!hasValidStaticCatalog) {
                // With no valid inherited catalog, expose a writable empty value for first-time setup.
                merged.mapPresets = [];
                merged._mapPresetsInvalid = false;
            }
        }
        if (serverErdblickConfig.locationSearch && isPlainObject(serverErdblickConfig.locationSearch)) {
            const mergedLocationSearch: RawLocationSearchConfig = {
                ...(merged.locationSearch ?? {}),
                providers: merged.locationSearch?.providers
                    ? [...merged.locationSearch.providers]
                    : undefined
            };
            const serverLocationSearch = serverErdblickConfig.locationSearch;
            if (Array.isArray(serverLocationSearch.providers) && serverLocationSearch.providers.length > 0) {
                mergedLocationSearch.providers = [...serverLocationSearch.providers];
            }
            if (serverLocationSearch.minCharacters !== undefined && Number.isFinite(serverLocationSearch.minCharacters)) {
                mergedLocationSearch.minCharacters = serverLocationSearch.minCharacters;
            }
            if (serverLocationSearch.debounceMs !== undefined && Number.isFinite(serverLocationSearch.debounceMs)) {
                mergedLocationSearch.debounceMs = serverLocationSearch.debounceMs;
            }
            merged.locationSearch = mergedLocationSearch;
        }
        if (typeof serverErdblickConfig.defaultBackgroundLayerId === "string"
            && serverErdblickConfig.defaultBackgroundLayerId.trim().length > 0) {
            merged.defaultBackgroundLayerId = serverErdblickConfig.defaultBackgroundLayerId.trim();
        }
        if (typeof serverErdblickConfig["coordinates-enabled"] === "boolean") {
            merged["coordinates-enabled"] = serverErdblickConfig["coordinates-enabled"];
        }
        if (typeof serverErdblickConfig["coordinates-legal-terms"] === "string"
            && serverErdblickConfig["coordinates-legal-terms"].trim()) {
            merged["coordinates-legal-terms"] = serverErdblickConfig["coordinates-legal-terms"].trim();
        }

        const mergedModules: ExtensionModulesConfig = {...(merged.extensionModules ?? {})};
        if (serverErdblickConfig.extensionModules && isPlainObject(serverErdblickConfig.extensionModules)) {
            for (const key of ["jumpTargets", "distribVersions"] as const) {
                const value = serverErdblickConfig.extensionModules[key];
                if (typeof value === "string" && value.trim().length > 0) {
                    mergedModules[key] = value.trim();
                }
            }
        }
        merged.extensionModules = mergedModules;

        if (serverErdblickConfig.state && isPlainObject(serverErdblickConfig.state)) {
            const baseState = isPlainObject(merged.state) ? merged.state : {};
            merged.state = mergeMeaningfulObjectValues(baseState, serverErdblickConfig.state);
        }

        return merged;
    }

    /** Parses the raw JSON payload and fills in the defaults erdblick expects at runtime. */
    private normalizeConfig(rawConfig: RawAppConfig, serverConfig: AppServerConfigStatus): AppConfig {
        const styles = [
            ...this.normalizeStyles(rawConfig.styles, false),
            ...this.normalizeStyles(rawConfig.additionalStyles, true)
        ];
        const surveys = this.normalizeSurveys(rawConfig.surveys);
        const extensionModules = this.normalizeExtensionModules(rawConfig.extensionModules);
        const legalTermsUrl = rawConfig["coordinates-legal-terms"]?.trim() || null;
        const enabledByDefault = legalTermsUrl ? false : rawConfig["coordinates-enabled"] ?? true;
        const mapPresetsConfigured = rawConfig.mapPresets !== undefined;
        const parsedMapPresets = parseMapPresetDefinitions(rawConfig.mapPresets ?? []);
        const localPresetIssues = rawConfig._mapPresetsInvalid
            ? [{message: "mapPresets must be a list with at most 200 entries."}, ...parsedMapPresets.issues]
            : parsedMapPresets.issues;
        const normalizedState = this.normalizeState(rawConfig.state) ?? {};
        // Catalog definitions stopped being AppState in 2026.5. Ignore stale config/storage input.
        delete normalizedState["mapPresets"];
        const state = {...normalizedState, coordinatesEnabled: enabledByDefault};
        const serverPresetStatus = serverConfig.mapPresets;
        const mapPresetConfig: MapPresetConfigStatus = {
            configured: mapPresetsConfigured,
            valid: localPresetIssues.length === 0
                && serverPresetStatus.valid,
            write: localPresetIssues.length === 0
                && serverPresetStatus.valid
                && serverPresetStatus.write,
            endpoint: serverPresetStatus.endpoint,
            method: serverPresetStatus.method,
            path: serverPresetStatus.path,
            revision: serverPresetStatus.revision,
            ephemeral: serverPresetStatus.ephemeral,
            issues: [...serverPresetStatus.issues, ...localPresetIssues]
        };

        const rawBackgroundLayers = rawConfig.backgroundLayers?.length
            ? rawConfig.backgroundLayers
            // Keep a minimal, non-Blue-Marble fallback available when config.json omits the section.
            : DEFAULT_BACKGROUND_LAYERS;
        const backgroundLayers = rawBackgroundLayers.map(layer => this.normalizeBackgroundLayer(layer));
        const defaultBackgroundLayerId = this.resolveDefaultBackgroundLayerId(
            rawConfig.defaultBackgroundLayerId ?? null,
            backgroundLayers
        );
        const locationSearch = this.normalizeLocationSearch(rawConfig.locationSearch);
        const externalViewers = this.normalizeExternalViewers(rawConfig.externalViewers);
        return {
            extensionModules,
            surveys,
            styles,
            state,
            configStateHash: this.hashConfigState(state),
            backgroundLayers,
            defaultBackgroundLayerId,
            locationSearch,
            externalViewers,
            mapPresets: parsedMapPresets.presets,
            mapPresetConfig,
            coordinates: {
                enabledByDefault,
                legalTermsUrl,
                legalTerms: null,
                legalTermsError: null
            },
            serverConfig: {
                ...serverConfig,
                mapPresets: {...serverConfig.mapPresets, issues: [...serverConfig.mapPresets.issues]}
            }
        };
    }

    /** Loads and validates the configured JSON/YAML coordinate legal-terms document. */
    private async loadCoordinatesLegalTerms(config: AppConfig): Promise<AppConfig> {
        const url = config.coordinates.legalTermsUrl;
        if (!url) {
            return config;
        }
        try {
            const source = await firstValueFrom(this.httpClient.get(url, {responseType: "text"}));
            const parsed = COORDINATES_LEGAL_TERMS_SCHEMA.safeParse(jsyaml.load(source));
            if (!parsed.success) {
                throw new Error("Expected a non-empty legal-terms string.");
            }
            return {
                ...config,
                coordinates: {
                    ...config.coordinates,
                    legalTerms: parsed.data["legal-terms"]
                }
            };
        } catch (error) {
            console.error(`[AppConfigService] Failed to load coordinate legal terms from ${url}`, error);
            return {
                ...config,
                coordinates: {
                    ...config.coordinates,
                    legalTermsError: `Could not load coordinate legal terms from ${url}.`
                }
            };
        }
    }

    /** Normalizes configured style entries. */
    private normalizeStyles(styles: RawAppConfig["styles"], additional: boolean): StyleConfigEntry[] {
        if (!Array.isArray(styles)) {
            return [];
        }

        const normalized: StyleConfigEntry[] = [];
        for (const entry of styles) {
            const parsed = STYLE_CONFIG_ENTRY_SCHEMA.safeParse(
                typeof entry === "string" ? {url: entry} : entry
            );
            if (!parsed.success) {
                continue;
            }
            normalized.push({
                ...parsed.data,
                additional
            });
        }
        return normalized;
    }

    /** Normalizes configured survey links. */
    private normalizeSurveys(rawSurveys: unknown[] | undefined): SurveyConfig[] {
        if (!Array.isArray(rawSurveys)) {
            return [];
        }

        const surveys: SurveyConfig[] = [];
        for (const rawSurvey of rawSurveys) {
            const parsed = SURVEY_CONFIG_SCHEMA.safeParse(rawSurvey);
            if (!parsed.success) {
                continue;
            }
            if (!isAllowedSurveyLinkHtml(parsed.data.linkHtml)) {
                continue;
            }
            surveys.push(parsed.data);
        }
        return surveys;
    }

    /** Normalizes configured extension module entries. */
    private normalizeExtensionModules(extensionModules: ExtensionModulesConfig | undefined): ExtensionModulesConfig {
        const normalized: ExtensionModulesConfig = {};
        if (!extensionModules) {
            return normalized;
        }
        for (const key of ["jumpTargets", "distribVersions"] as const) {
            const value = extensionModules[key];
            if (typeof value === "string" && value.trim().length > 0) {
                normalized[key] = value.trim();
            }
        }
        return normalized;
    }

    /** Normalizes configured default application state. */
    private normalizeState(state: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
        if (!state || !isPlainObject(state)) {
            return null;
        }
        if (!isMeaningfulValue(state)) {
            return null;
        }
        return {...state};
    }

    /** Applies per-layer defaults so rendering code can avoid scattered `undefined` handling. */
    private normalizeBackgroundLayer(layer: RawBackgroundLayerConfig): BackgroundLayerConfig {
        const defaultOpacity = clampBackgroundOpacity(layer.defaultOpacity ?? 100);
        const minZoom = layer.minZoom ?? 0;
        const maxZoom = layer.maxZoom ?? (
            layer.type === "xyz"
                ? DEFAULT_XYZ_BACKGROUND_MAX_ZOOM
                : DEFAULT_WMS_BACKGROUND_MAX_ZOOM
        );

        if (layer.type === "xyz") {
            return {
                ...layer,
                headers: layer.headers ?? {},
                defaultOpacity,
                minZoom,
                maxZoom,
                tileSize: layer.tileSize ?? 256
            };
        }

        return {
            ...layer,
            headers: layer.headers ?? {},
            defaultOpacity,
            minZoom,
            maxZoom,
            version: layer.version ?? "1.3.0",
            crs: layer.crs ?? "EPSG:3857",
            format: layer.format ?? "image/png",
            transparent: layer.transparent ?? false,
            vendorParameters: layer.vendorParameters ?? {}
        };
    }

    /** Validates external-viewer templates once so runtime actions only substitute coordinates. */
    private normalizeExternalViewers(rawViewers: unknown[] | undefined): ExternalViewerConfig[] {
        if (!rawViewers) {
            return [];
        }
        const viewers: ExternalViewerConfig[] = [];
        const seenIds = new Set<string>();
        rawViewers.forEach((rawViewer, index) => {
            const parsed = EXTERNAL_VIEWER_SCHEMA.safeParse(rawViewer);
            if (!parsed.success) {
                console.warn(`[AppConfigService] Ignoring invalid externalViewers entry ${index + 1}.`);
                return;
            }
            const viewer = {
                id: parsed.data.id.trim(),
                name: parsed.data.name.trim(),
                urlTemplate: parsed.data.urlTemplate.trim()
            };
            const sampleUrl = viewer.urlTemplate
                .replaceAll("{lat}", "0")
                .replaceAll("{lon}", "0");
            let protocol = "";
            try {
                protocol = new URL(sampleUrl).protocol;
            } catch {
                // The warning below also covers malformed and relative templates.
            }
            if (!viewer.id
                || !viewer.name
                || !viewer.urlTemplate.includes("{lat}")
                || !viewer.urlTemplate.includes("{lon}")
                || (protocol !== "http:" && protocol !== "https:")
                || seenIds.has(viewer.id)) {
                console.warn(
                    `[AppConfigService] Ignoring external viewer '${viewer.id || index + 1}': ` +
                    "expected a unique id and an HTTP(S) URL template containing {lat} and {lon}."
                );
                return;
            }
            seenIds.add(viewer.id);
            viewers.push(viewer);
        });
        return viewers;
    }

    /** Normalizes configured location-search providers and behavior knobs. */
    private normalizeLocationSearch(locationSearch: RawLocationSearchConfig | undefined): LocationSearchConfig {
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
            const adapter = this.normalizeLocationSearchAdapter(provider.adapter);
            const queryParam = provider.queryParam?.trim();
            const limitParam = provider.limitParam?.trim();
            const params = provider.params ?? {};
            providers.push({
                id,
                name,
                url,
                headers: provider.headers ?? {},
                ...(Object.keys(params).length > 0 ? {params} : {}),
                ...(queryParam ? {queryParam} : {}),
                ...(limitParam ? {limitParam} : {}),
                ...(provider.attribution?.trim() ? {attribution: provider.attribution.trim()} : {}),
                ...(adapter ? {adapter} : {}),
                enabled: provider.enabled ?? true
            });
        }

        return {
            providers: providers.length ? providers : [...DEFAULT_LOCATION_SEARCH_CONFIG.providers],
            minCharacters: this.clampInteger(locationSearch?.minCharacters, 1, 64, DEFAULT_LOCATION_SEARCH_CONFIG.minCharacters),
            debounceMs: this.clampInteger(locationSearch?.debounceMs, 0, 2000, DEFAULT_LOCATION_SEARCH_CONFIG.debounceMs)
        };
    }

    /** Normalizes a declarative provider adapter without allowing arbitrary executable mapping logic. */
    private normalizeLocationSearchAdapter(adapter: RawLocationSearchAdapterConfig | undefined): LocationSearchAdapterConfig | undefined {
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

        const fields = this.normalizeLocationSearchAdapterFields(adapter.fields);
        if (fields && Object.keys(fields).length > 0) {
            result.fields = fields;
        }

        return Object.keys(result).length > 0 ? result : undefined;
    }

    /** Normalizes field selectors used by a location-search adapter. */
    private normalizeLocationSearchAdapterFields(
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
            const selector = this.normalizeLocationSearchFieldSelector(fields[fieldName]);
            if (selector !== undefined) {
                result[fieldName] = selector;
            }
        }

        return result;
    }

    /** Normalizes one path, constant, or template selector from config. */
    private normalizeLocationSearchFieldSelector(
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
    private clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return fallback;
        }
        return Math.max(min, Math.min(max, Math.round(numeric)));
    }

    /** Chooses a valid default background id or falls back to the first available layer. */
    private resolveDefaultBackgroundLayerId(requestedDefaultId: string | null, backgroundLayers: BackgroundLayerConfig[]): string | null {
        if (backgroundLayers.length === 0) {
            return null;
        }
        if (requestedDefaultId && backgroundLayers.some(layer => layer.id === requestedDefaultId)) {
            return requestedDefaultId;
        }
        // Falling back to the first configured layer keeps persisted state valid even when a
        // previously configured default disappears from a newer config.json.
        return backgroundLayers[0].id;
    }

    /** Computes a stable hash for configured state. */
    private hashConfigState(state: Record<string, unknown> | null): string {
        const serialized = this.stableSerialize(state ?? {});
        // FNV-1a 32-bit
        let hash = 0x811c9dc5;
        for (let i = 0; i < serialized.length; i++) {
            hash ^= serialized.charCodeAt(i);
            hash = (hash * 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, "0");
    }

    /** Serializes config state with deterministic key ordering. */
    private stableSerialize(value: unknown): string {
        if (value === null) {
            return "null";
        }
        if (value === undefined) {
            return "undefined";
        }
        if (typeof value === "string") {
            return JSON.stringify(value);
        }
        if (typeof value === "number" || typeof value === "boolean") {
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) {
            return `[${value.map(entry => this.stableSerialize(entry)).join(",")}]`;
        }
        if (isPlainObject(value)) {
            const keys = Object.keys(value).sort();
            return `{${keys.map(key => `${JSON.stringify(key)}:${this.stableSerialize(value[key])}`).join(",")}}`;
        }
        return JSON.stringify(value);
    }
}
