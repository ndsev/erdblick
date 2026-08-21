import {Injectable} from "@angular/core";
import {HttpClient, HttpErrorResponse, HttpHeaders} from "@angular/common/http";
import {BehaviorSubject, Observable, firstValueFrom} from "rxjs";
import * as jsyaml from "js-yaml";
import {AppConfigService} from "../shared/app-config.service";
import {
    LayerPresetDefinition,
    LayerPresetRef
} from "./layer-preset.model";
import {
    MapPresetDefinition,
    MapPresetIssue,
    parseMapPresetDefinitions
} from "./map-preset.model";
import {StyleService} from "./style.service";

const MAP_PRESETS_CONFIGURATION_DISABLED_MESSAGE =
    "Configuring map presets is not allowed. Modify the server configuration to allow access";
const STATIC_MAP_PRESETS_READ_ONLY_MESSAGE =
    "Using static configuration. Modify the configuration to update map presets";

export const NO_PRESET_ID = "";
/** One embedded layer preset resolved together with its owning active style. */
export interface ResolvedLayerPreset extends LayerPresetDefinition {
    styleId: string;
    ref: LayerPresetRef;
    key: string;
}

/** Minimal option identity and value needed to resolve and compare presets. */
export interface LayerPresetOptionCandidate {
    styleId: string;
    id: string;
    value?: Array<boolean | number | string>;
}

/** Stable transient key for dropdowns; persisted state uses the structured reference. */
export function layerPresetRefKey(ref: LayerPresetRef): string {
    return JSON.stringify([ref.styleId, ref.presetId]);
}

interface MapPresetWriteResponse {
    path?: unknown;
    value?: unknown;
    revision?: unknown;
}

/** Owns the config-backed map-preset catalog and resolves embedded layer presets. */
@Injectable({providedIn: "root"})
export class MapPresetService {
    private readonly presetsSubject = new BehaviorSubject<MapPresetDefinition[]>([]);
    private readonly issuesSubject = new BehaviorSubject<MapPresetIssue[]>([]);
    private readonly writePendingSubject = new BehaviorSubject(false);
    private effectiveIssues: MapPresetIssue[] = [];

    readonly presets$: Observable<MapPresetDefinition[]> = this.presetsSubject.asObservable();
    readonly issues$ = this.issuesSubject.asObservable();
    readonly writePending$ = this.writePendingSubject.asObservable();

    constructor(
        private readonly configService: AppConfigService,
        private readonly httpClient: HttpClient,
        private readonly styleService: StyleService
    ) {}

    /** Seeds the runtime catalog from config and retires obsolete browser-owned definitions. */
    initialize(): void {
        this.adoptConfigSnapshot();

        // Retire storage from the external-document, split-state, and AppState prototypes.
        localStorage.removeItem("stylePresetAvailability");
        localStorage.removeItem("stylePresetOverrideSource");
        localStorage.removeItem("mapPresetAvailability");
        localStorage.removeItem("mapPresetDefinitionsOverride");
        localStorage.removeItem("mapPresets");
    }

    get presets(): MapPresetDefinition[] {
        return this.presetsSubject.getValue();
    }

    get source(): string {
        return this.serializeDefinitions(this.presets);
    }

    get configured(): boolean {
        return this.configService.snapshot.mapPresetConfig.configured;
    }

    get canWrite(): boolean {
        return this.configured && this.configService.snapshot.mapPresetConfig.write && !this.writePending;
    }

    get writePending(): boolean {
        return this.writePendingSubject.getValue();
    }

    /** Explains an empty catalog according to whether MapViewer manages it server-side. */
    get emptyCatalogMessage(): string {
        if (this.configService.snapshot.mapPresetConfig.write) {
            return "No map presets configured.";
        }
        return this.hasServerMapPresetContract
            ? MAP_PRESETS_CONFIGURATION_DISABLED_MESSAGE
            : "No map presets configured. Please, add map presets in the configuration";
    }

    /** Explains why a populated catalog cannot be edited in this deployment. */
    get readOnlyCatalogMessage(): string | null {
        if (this.presets.length === 0 || this.configService.snapshot.mapPresetConfig.write) {
            return null;
        }
        return this.hasServerMapPresetContract
            ? MAP_PRESETS_CONFIGURATION_DISABLED_MESSAGE
            : STATIC_MAP_PRESETS_READ_ONLY_MESSAGE;
    }

    get readOnlyReason(): string | null {
        const status = this.configService.snapshot.mapPresetConfig;
        if (!status.valid) {
            if (this.configService.snapshot.serverConfig.mapPresets.valid) {
                return "The static map-preset configuration is invalid; repair config.json before editing.";
            }
            return "The server map-preset configuration is invalid; repair the YAML before editing.";
        }
        if (status.ephemeral) {
            return "This launcher uses a temporary config, so map presets are read-only.";
        }
        if (!this.configured) {
            return this.emptyCatalogMessage;
        }
        if (!status.write) {
            if (!this.configService.snapshot.serverConfig.mapPresets.configured) {
                return "These map presets come from the static Erdblick configuration and are read-only.";
            }
            if (status.endpoint && status.method && status.path && status.revision) {
                return "Map presets are read-only because configuration writes are disabled.";
            }
            return "Server map-preset editing is unavailable in this deployment.";
        }
        return null;
    }

    presetById(presetId: string): MapPresetDefinition | undefined {
        return this.presets.find(preset => preset.id === presetId);
    }

    isAvailable(preset: MapPresetDefinition): boolean {
        return preset.enabled;
    }

    async setAvailable(presetId: string, available: boolean): Promise<boolean> {
        const preset = this.presetById(presetId);
        if (!preset || preset.enabled === available) {
            return preset !== undefined;
        }
        return this.persistDefinitions(this.presets.map(current => ({
            ...this.copyPreset(current),
            enabled: current.id === presetId ? available : current.enabled
        })));
    }

    /** Returns complete embedded presets that can be applied to one concrete layer. */
    presetsForLayer(
        layerId: string,
        options: readonly LayerPresetOptionCandidate[]
    ): ResolvedLayerPreset[] {
        const references = new Set(options.map(option => `${option.styleId}\u0000${option.id}`));
        const result: ResolvedLayerPreset[] = [];
        for (const style of this.styleService.styles.values()) {
            if (!style.visible || style.featureLayerStyle?.hasLayerAffinity(layerId) !== true) {
                continue;
            }
            for (const preset of style.presets ?? []) {
                if (!preset.values.every(value => references.has(`${style.id}\u0000${value.optionId}`))) {
                    continue;
                }
                const ref = {styleId: style.id, presetId: preset.id};
                result.push({...preset, styleId: style.id, ref, key: layerPresetRefKey(ref)});
            }
        }
        return result;
    }

    /** Resolves one qualified reference among the currently eligible layer presets. */
    resolveLayerPreset(
        layerId: string,
        ref: LayerPresetRef,
        options: readonly LayerPresetOptionCandidate[]
    ): ResolvedLayerPreset | undefined {
        return this.presetsForLayer(layerId, options).find(preset =>
            preset.styleId === ref.styleId && preset.id === ref.presetId);
    }

    matchesPresetValues(
        preset: ResolvedLayerPreset,
        options: readonly LayerPresetOptionCandidate[],
        viewIndex: number
    ): boolean {
        return preset.values.every(value => {
            const option = options.find(candidate =>
                candidate.styleId === preset.styleId && candidate.id === value.optionId);
            return option?.value?.[viewIndex] === value.value;
        });
    }

    /** Transactionally activates a complete GUI/raw-editor definitions list. */
    async applyDefinitions(definitions: unknown): Promise<boolean> {
        const result = parseMapPresetDefinitions(definitions);
        if (result.issues.length || !Array.isArray(definitions)
            || result.presets.length !== definitions.length) {
            this.issuesSubject.next(result.issues);
            return false;
        }
        return this.persistDefinitions(result.presets);
    }

    /** Parses a GUI raw-editor buffer as a YAML list, never as an external document URL. */
    async applyOverrideSource(source: string): Promise<boolean> {
        let parsed: unknown;
        try {
            parsed = jsyaml.load(source);
        } catch (error) {
            this.issuesSubject.next([{
                message: error instanceof Error ? error.message : "Could not parse map-preset YAML."
            }]);
            return false;
        }
        return this.applyDefinitions(parsed);
    }

    async addPreset(preset: MapPresetDefinition): Promise<boolean> {
        return this.applyDefinitions([...this.presets.map(current => this.copyPreset(current)), preset]);
    }

    restoreEffectiveIssues(): void {
        this.issuesSubject.next(this.effectiveIssues);
    }

    serializeDefinitions(presets: readonly MapPresetDefinition[]): string {
        return jsyaml.dump(presets.map(preset => this.copyPreset(preset)), {
            noRefs: true,
            lineWidth: 120,
            sortKeys: false
        });
    }

    private copyPreset(preset: MapPresetDefinition): MapPresetDefinition {
        return {...preset, layerPresets: preset.layerPresets.map(component => ({...component}))};
    }

    /** Identifies the narrow MapViewer-owned field contract without inventing a legacy endpoint. */
    private get hasServerMapPresetContract(): boolean {
        const status = this.configService.snapshot.serverConfig.mapPresets;
        return status.endpoint === "/config"
            && status.method === "PATCH"
            && status.path === "/erdblick/mapPresets";
    }

    /** Adopts only catalog values that have passed the shared AppConfig boundary. */
    private adoptConfigSnapshot(): void {
        const config = this.configService.snapshot;
        this.presetsSubject.next(config.mapPresetConfig.configured
            ? config.mapPresets.map(preset => this.copyPreset(preset))
            : []);
        this.effectiveIssues = config.mapPresetConfig.issues.map(issue => ({...issue}));
        this.issuesSubject.next(this.effectiveIssues);
    }

    /** Writes one complete catalog under the current config revision. */
    private async persistDefinitions(definitions: readonly MapPresetDefinition[]): Promise<boolean> {
        const status = this.configService.snapshot.mapPresetConfig;
        const parsed = parseMapPresetDefinitions(definitions);
        if (parsed.issues.length || parsed.presets.length !== definitions.length) {
            this.issuesSubject.next(parsed.issues.length
                ? parsed.issues
                : [{message: "The complete map-preset catalog is invalid."}]);
            return false;
        }
        if (!this.configured || this.writePending || !status.write
            || status.endpoint !== "/config"
            || status.method !== "PATCH"
            || status.path !== "/erdblick/mapPresets"
            || !status.revision) {
            this.issuesSubject.next([{
                message: this.writePending
                    ? "A map-preset update is already in progress."
                    : this.readOnlyReason ?? "Map-preset write capability is incomplete."
            }]);
            return false;
        }

        this.writePendingSubject.next(true);
        try {
            const response = await firstValueFrom(this.httpClient.patch<MapPresetWriteResponse>(
                status.endpoint,
                {
                    path: status.path,
                    value: parsed.presets.map(preset => this.copyPreset(preset))
                },
                {
                    headers: new HttpHeaders({"If-Match": `"${status.revision}"`}),
                    observe: "response"
                }
            ));
            const body = response.body;
            const revision = typeof body?.revision === "string"
                ? body.revision
                : response.headers.get("ETag")?.replace(/^(?:W\/)?"|"$/g, "") ?? "";
            if (!body || body.path !== status.path || !Array.isArray(body.value) || !revision
                || !this.configService.applyCanonicalMapPresets(body.value, revision)) {
                throw new Error("The server returned an invalid canonical map-preset response.");
            }
            this.adoptConfigSnapshot();
            return true;
        } catch (error) {
            const isConflict = error instanceof HttpErrorResponse && error.status === 412;
            const refreshed = await this.configService.refreshMapPresetConfig();
            if (refreshed) {
                this.adoptConfigSnapshot();
            }
            const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
            this.issuesSubject.next([{
                message: isConflict
                    ? "Map presets changed on the server. The latest catalog was reloaded; review and retry."
                    : `Could not save map presets; the server catalog was refetched.${detail}`
            }]);
            return false;
        } finally {
            this.writePendingSubject.next(false);
        }
    }
}
