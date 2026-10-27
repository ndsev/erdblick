/**
 * Loads deployment configuration, merges server overrides and publishes one
 * normalized snapshot. Domain schemas remain pure imports: loading config does
 * not construct map renderers, transport, preferences or action controllers.
 */
import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import * as jsyaml from "js-yaml";
import { BehaviorSubject, firstValueFrom, Observable } from "rxjs";
import { parseMapPresetDefinitions, type MapPresetConfigStatus } from "../mapstyle/map-preset";
import { normalizeStyles } from "../mapstyle/mapstyle.model";
import { normalizeSurveys } from "../survey/survey.model";
import { normalizeExternalViewers } from "../navigation/external-viewer.model";
import { normalizeLocationSearch, type RawLocationSearchConfig } from "../geolocation/geolocation.model";
import { COORDINATES_LEGAL_TERMS_SCHEMA, normalizeCoordinatesConfig } from "../coordinates/coordinates.model";
import {
    normalizeBackgroundLayer,
    resolveDefaultBackgroundLayerId,
    DEFAULT_BACKGROUND_LAYERS
} from "../mapview/background-layer.model";
import {
    type AppConfig,
    type AppServerConfigStatus,
    type ExtensionModulesConfig,
    type RawAppConfig,
    type ServerConfigResponse,
    DEFAULT_APP_CONFIG,
    DEFAULT_SERVER_CONFIG_STATUS,
    RAW_APP_CONFIG_SCHEMA
} from "./appconfig.model";

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
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (!isMeaningfulValue(value)) {
            continue;
        }
        merged[key] = value;
    }
    return merged;
}

/** Loads and normalizes `config.json` once, then exposes it as a shared application service. */
@Injectable({ providedIn: 'root' })
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
            const rawConfig = await firstValueFrom(this.httpClient.get("/static-config/config.json", { responseType: "json" }));
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
            mapPresets: { ...DEFAULT_SERVER_CONFIG_STATUS.mapPresets, issues: [] }
        };
        let erdblickConfig: Partial<RawAppConfig> = {};

        try {
            const response = await firstValueFrom(
                this.httpClient.get<ServerConfigResponse>("/config", {
                    observe: "response"
                })
            );
            if (response.status !== 200) {
                return { serverConfig, erdblickConfig };
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
                            .map(message => ({ message }))
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

        return { serverConfig, erdblickConfig };
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
            return { ...parsed.data, mapPresets: [], _mapPresetsInvalid: true };
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
            extensionModules: { ...(staticConfig.extensionModules ?? {}) },
            styles: staticConfig.styles ? [...staticConfig.styles] : undefined,
            additionalStyles: staticConfig.additionalStyles ? [...staticConfig.additionalStyles] : undefined,
            surveys: staticConfig.surveys ? [...staticConfig.surveys] : undefined,
            state: staticConfig.state ? { ...staticConfig.state } : staticConfig.state ?? null,
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

        const mergedModules: ExtensionModulesConfig = { ...(merged.extensionModules ?? {}) };
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
            ...normalizeStyles(rawConfig.styles, false),
            ...normalizeStyles(rawConfig.additionalStyles, true)
        ];
        const surveys = normalizeSurveys(rawConfig.surveys);
        const extensionModules = this.normalizeExtensionModules(rawConfig.extensionModules);
        const coordinates = normalizeCoordinatesConfig(
            rawConfig["coordinates-enabled"], rawConfig["coordinates-legal-terms"]
        );
        const mapPresetsConfigured = rawConfig.mapPresets !== undefined;
        const parsedMapPresets = parseMapPresetDefinitions(rawConfig.mapPresets ?? []);
        const localPresetIssues = rawConfig._mapPresetsInvalid
            ? [{ message: "mapPresets must be a list with at most 200 entries." }, ...parsedMapPresets.issues]
            : parsedMapPresets.issues;
        const normalizedState = this.normalizeState(rawConfig.state) ?? {};
        // Catalog definitions stopped being AppState in 2026.5. Ignore stale config/storage input.
        delete normalizedState["mapPresets"];
        const state = { ...normalizedState, coordinatesEnabled: coordinates.enabledByDefault };
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
        const backgroundLayers = rawBackgroundLayers.map(layer => normalizeBackgroundLayer(layer));
        const defaultBackgroundLayerId = resolveDefaultBackgroundLayerId(
            rawConfig.defaultBackgroundLayerId ?? null,
            backgroundLayers
        );
        const locationSearch = normalizeLocationSearch(rawConfig.locationSearch);
        const externalViewers = normalizeExternalViewers(rawConfig.externalViewers);
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
            coordinates,
            serverConfig: {
                ...serverConfig,
                mapPresets: { ...serverConfig.mapPresets, issues: [...serverConfig.mapPresets.issues] }
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
            const source = await firstValueFrom(this.httpClient.get(url, { responseType: "text" }));
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
        return { ...state };
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
