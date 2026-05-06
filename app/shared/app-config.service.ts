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

/** Normalized application config consumed by the Angular services. */
export interface AppConfig {
    extensionModules: ExtensionModulesConfig;
    surveys: SurveyConfig[];
    styles: StyleConfigEntry[];
    backgroundLayers: BackgroundLayerConfig[];
    defaultBackgroundLayerId: string | null;
}

const STYLE_CONFIG_ENTRY_SCHEMA = z.object({
    id: z.string().optional(),
    url: z.string().min(1)
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

const APP_CONFIG_SCHEMA = z.object({
    extensionModules: z.object({
        jumpTargets: z.string().optional(),
        distribVersions: z.string().optional()
    }).partial().optional(),
    surveys: z.array(SURVEY_CONFIG_SCHEMA).optional(),
    styles: z.array(STYLE_CONFIG_ENTRY_SCHEMA).optional(),
    backgroundLayers: z.array(z.union([
        XYZ_BACKGROUND_LAYER_SCHEMA,
        WMS_BACKGROUND_LAYER_SCHEMA
    ])).optional(),
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

const DEFAULT_APP_CONFIG: AppConfig = {
    extensionModules: {},
    surveys: [],
    styles: [],
    backgroundLayers: DEFAULT_BACKGROUND_LAYERS,
    defaultBackgroundLayerId: DEFAULT_BACKGROUND_LAYER_ID
};

/** Clamps persisted and config-driven background opacity to the supported percentage range. */
export function clampBackgroundOpacity(value: number): number {
    if (!Number.isFinite(value)) {
        return 100;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
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

        this.loadPromise = firstValueFrom(this.httpClient.get("config.json", {responseType: "json"}))
            .then(rawConfig => {
                const normalized = this.normalizeConfig(rawConfig);
                this.configSubject.next(normalized);
                return normalized;
            })
            .catch(error => {
                console.error("[AppConfigService] Failed to load config.json", error);
                this.configSubject.next(DEFAULT_APP_CONFIG);
                return DEFAULT_APP_CONFIG;
            });

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

    /** Parses the raw JSON payload and fills in the defaults erdblick expects at runtime. */
    private normalizeConfig(rawConfig: unknown): AppConfig {
        const parsed = APP_CONFIG_SCHEMA.safeParse(rawConfig);
        if (!parsed.success) {
            console.error("[AppConfigService] Invalid config.json; falling back to defaults", parsed.error);
            return DEFAULT_APP_CONFIG;
        }

        const rawBackgroundLayers = parsed.data.backgroundLayers?.length
            ? parsed.data.backgroundLayers
            : DEFAULT_BACKGROUND_LAYERS;
        const backgroundLayers = rawBackgroundLayers.map(layer => this.normalizeBackgroundLayer(layer));
        const defaultBackgroundLayerId = this.resolveDefaultBackgroundLayerId(
            parsed.data.defaultBackgroundLayerId ?? null,
            backgroundLayers
        );

        return {
            extensionModules: parsed.data.extensionModules ?? {},
            surveys: parsed.data.surveys ?? [],
            styles: parsed.data.styles ?? [],
            backgroundLayers,
            defaultBackgroundLayerId
        };
    }

    /** Applies per-layer defaults so rendering code can avoid scattered `undefined` handling. */
    private normalizeBackgroundLayer(layer: z.infer<typeof XYZ_BACKGROUND_LAYER_SCHEMA> | z.infer<typeof WMS_BACKGROUND_LAYER_SCHEMA>): BackgroundLayerConfig {
        const defaultOpacity = clampBackgroundOpacity(layer.defaultOpacity ?? (layer.type === "xyz" ? 100 : 100));
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
}
