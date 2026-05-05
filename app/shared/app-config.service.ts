import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {BehaviorSubject, Observable, firstValueFrom} from "rxjs";
import {z} from "zod";

/** Default background-layer id used when no config-driven override is available. */
/**
 * Stable internal id for the built-in bundled background.
 *
 * The user-facing name now says "Blue Marble", but the persisted id stays
 * `world-overview` so existing URLs and local state keep resolving cleanly.
 */
export const DEFAULT_BACKGROUND_LAYER_ID = "world-overview";

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

/** Raw config shape before defaults are applied. */
export interface RawAppConfig {
    extensionModules?: ExtensionModulesConfig;
    surveys?: unknown[];
    styles?: Array<StyleConfigEntry | string>;
    additionalStyles?: Array<StyleConfigEntry | string>;
    state?: Record<string, unknown> | null;
    backgroundLayers?: RawBackgroundLayerConfig[];
    defaultBackgroundLayerId?: string | null;
}

/** `/config` payload consumed from mapget/mapviewer. */
export interface ServerConfigResponse {
    model?: Record<string, unknown>;
    schema?: Record<string, unknown>;
    readOnly?: boolean;
    datasourceConfigUnavailable?: boolean;
    datasourceConfigUnavailableReason?: string | null;
    erdblick?: Partial<RawAppConfig>;
}

/** Server-config diagnostics exposed to runtime services. */
export interface AppServerConfigStatus {
    available: boolean;
    datasourceConfigUnavailable: boolean;
    datasourceConfigUnavailableReason: string | null;
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
    defaultBackgroundLayerId: z.string().nullable().optional()
}).passthrough();

const DEFAULT_BACKGROUND_LAYERS: BackgroundLayerConfig[] = [
    {
        id: DEFAULT_BACKGROUND_LAYER_ID,
        name: "Blue Marble",
        type: "xyz",
        urlTemplate: "bundle/images/backgrounds/world-overview/{z}/{x}/{y}.jpg",
        attribution: "NASA Blue Marble: Next Generation (July 2004)",
        defaultOpacity: 100,
        minZoom: 0,
        maxZoom: 5,
        tileSize: 256
    },
    {
        id: "osm",
        name: "OpenStreetMap",
        type: "xyz",
        urlTemplate: "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: "© OpenStreetMap contributors",
        defaultOpacity: 6,
        minZoom: 0,
        maxZoom: 19,
        tileSize: 256
    }
];

const DEFAULT_SERVER_CONFIG_STATUS: AppServerConfigStatus = {
    available: false,
    datasourceConfigUnavailable: false,
    datasourceConfigUnavailableReason: null
};

const DEFAULT_APP_CONFIG: AppConfig = {
    extensionModules: {},
    surveys: [],
    styles: [],
    state: null,
    configStateHash: "00000000",
    backgroundLayers: DEFAULT_BACKGROUND_LAYERS,
    defaultBackgroundLayerId: DEFAULT_BACKGROUND_LAYER_ID,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

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

    /** Loads `config.json` once and caches the normalized result for the rest of the session. */
    async load(): Promise<AppConfig> {
        if (this.loadPromise !== null) {
            return this.loadPromise;
        }

        this.loadPromise = this.loadInternal();
        return this.loadPromise;
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

    private async loadInternal(): Promise<AppConfig> {
        const staticRawConfig = await this.loadStaticConfig();
        const serverResult = await this.loadServerConfig();
        const mergedRawConfig = this.mergeServerErdblickConfig(staticRawConfig, serverResult.erdblickConfig);
        const normalized = this.normalizeConfig(mergedRawConfig, serverResult.serverConfig);
        this.configSubject.next(normalized);
        return normalized;
    }

    private async loadStaticConfig(): Promise<RawAppConfig> {
        try {
            const rawConfig = await firstValueFrom(this.httpClient.get("config.json", {responseType: "json"}));
            return this.parseRawConfig(rawConfig, "config.json");
        } catch (error) {
            console.error("[AppConfigService] Failed to load config.json", error);
            return {};
        }
    }

    private async loadServerConfig(): Promise<{
        serverConfig: AppServerConfigStatus;
        erdblickConfig: Partial<RawAppConfig>;
    }> {
        const serverConfig: AppServerConfigStatus = {...DEFAULT_SERVER_CONFIG_STATUS};
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

            if (!serverConfig.datasourceConfigUnavailable
                && payload.erdblick
                && isPlainObject(payload.erdblick)) {
                erdblickConfig = this.parseRawConfig(payload.erdblick, "/config.erdblick");
            }
        } catch (error) {
            console.warn("[AppConfigService] Failed to load /config; continuing with static config.json", error);
        }

        return {serverConfig, erdblickConfig};
    }

    private parseRawConfig(rawConfig: unknown, sourceLabel: string): RawAppConfig {
        const parsed = RAW_APP_CONFIG_SCHEMA.safeParse(rawConfig);
        if (!parsed.success) {
            console.error(`[AppConfigService] Invalid ${sourceLabel}; ignoring payload`, parsed.error);
            return {};
        }
        return parsed.data;
    }

    private mergeServerErdblickConfig(
        staticConfig: RawAppConfig,
        serverErdblickConfig: Partial<RawAppConfig>
    ): RawAppConfig {
        const merged: RawAppConfig = {
            ...staticConfig,
            extensionModules: {...(staticConfig.extensionModules ?? {})},
            styles: staticConfig.styles ? [...staticConfig.styles] : undefined,
            additionalStyles: staticConfig.additionalStyles ? [...staticConfig.additionalStyles] : undefined,
            surveys: staticConfig.surveys ? [...staticConfig.surveys] : undefined,
            state: staticConfig.state ? {...staticConfig.state} : staticConfig.state ?? null,
            backgroundLayers: staticConfig.backgroundLayers ? [...staticConfig.backgroundLayers] : undefined
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
        if (typeof serverErdblickConfig.defaultBackgroundLayerId === "string"
            && serverErdblickConfig.defaultBackgroundLayerId.trim().length > 0) {
            merged.defaultBackgroundLayerId = serverErdblickConfig.defaultBackgroundLayerId.trim();
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
        const state = this.normalizeState(rawConfig.state);

        const rawBackgroundLayers = rawConfig.backgroundLayers?.length
            ? rawConfig.backgroundLayers
            : DEFAULT_BACKGROUND_LAYERS;
        const backgroundLayers = rawBackgroundLayers.map(layer => this.normalizeBackgroundLayer(layer));
        const defaultBackgroundLayerId = this.resolveDefaultBackgroundLayerId(
            rawConfig.defaultBackgroundLayerId ?? null,
            backgroundLayers
        );

        return {
            extensionModules,
            surveys,
            styles,
            state,
            configStateHash: this.hashConfigState(state),
            backgroundLayers,
            defaultBackgroundLayerId,
            serverConfig: {...serverConfig}
        };
    }

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
        const maxZoom = layer.maxZoom ?? (layer.type === "xyz" ? 19 : 22);

        if (layer.type === "xyz") {
            return {
                ...layer,
                defaultOpacity,
                minZoom,
                maxZoom,
                tileSize: layer.tileSize ?? 256
            };
        }

        return {
            ...layer,
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

    /** Chooses a valid default background id or falls back to the first available layer. */
    private resolveDefaultBackgroundLayerId(requestedDefaultId: string | null, backgroundLayers: BackgroundLayerConfig[]): string | null {
        if (backgroundLayers.length === 0) {
            return null;
        }
        if (requestedDefaultId && backgroundLayers.some(layer => layer.id === requestedDefaultId)) {
            return requestedDefaultId;
        }
        return backgroundLayers[0].id;
    }

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
