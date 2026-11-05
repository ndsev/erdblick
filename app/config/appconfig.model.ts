/**
 * The application configuration envelope composes domain-owned value contracts.
 * Keep fetching, precedence and publication in AppConfigService; definitions and
 * validation of backgrounds, providers, styles and coordinates live with their
 * consumers. This module has no injectable state container.
 */
import { z } from "zod";
import {
    type BackgroundLayerConfig,
    type RawBackgroundLayerConfig,
    BACKGROUND_LAYER_SCHEMA,
    DEFAULT_BACKGROUND_LAYERS,
    DEFAULT_BACKGROUND_LAYER_ID
} from "../mapview/background-layer.model";
import { type MapPresetDefinition, type MapPresetConfigStatus } from "../mapstyle/map-preset.model";
import { type StyleConfigEntry, STYLE_CONFIG_ENTRY_SCHEMA } from "../mapstyle/mapstyle.model";
import type { SurveyConfig } from "../survey/survey.model";
import {
    type LocationSearchConfig,
    type RawLocationSearchConfig,
    LOCATION_SEARCH_SCHEMA,
    DEFAULT_LOCATION_SEARCH_CONFIG
} from "../geolocation/geolocation.model";
import type { ExternalViewerConfig } from "../navigation/external-viewer.model";
import { type CoordinatesConfig, normalizeCoordinatesConfig } from "../coordinates/coordinates.model";

/** Optional extension-module ids declared in `config.json`. */
export interface ExtensionModulesConfig {
    jumpTargets?: string;
    distribVersions?: string;
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

export const RAW_APP_CONFIG_SCHEMA = z.object({
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

export const DEFAULT_SERVER_CONFIG_STATUS: AppServerConfigStatus = {
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

export const DEFAULT_APP_CONFIG: AppConfig = {
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
    mapPresetConfig: { ...DEFAULT_SERVER_CONFIG_STATUS.mapPresets },
    coordinates: normalizeCoordinatesConfig(undefined, undefined),
    serverConfig: DEFAULT_SERVER_CONFIG_STATUS
};
