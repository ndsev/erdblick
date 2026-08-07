import {Injectable} from "@angular/core";
import {BehaviorSubject, Observable} from "rxjs";
import * as jsyaml from "js-yaml";
import {AppConfigService} from "../shared/app-config.service";
import {deepEquals} from "../shared/app-state";
import {AppStateService} from "../shared/appstate.service";
import {
    LayerPresetDefinition,
    LayerPresetRef
} from "./layer-preset.model";
import {
    MapPresetDefinition,
    MapPresetIssue,
    MapPresetParseResult,
    parseMapPresetDefinitions
} from "./map-preset.model";
import {StyleService} from "./style.service";

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

/** Operates the typed map-preset AppState and resolves embedded layer presets. */
@Injectable({providedIn: "root"})
export class MapPresetService {
    private readonly issuesSubject = new BehaviorSubject<MapPresetIssue[]>([]);
    private configuredResult: MapPresetParseResult = {presets: [], issues: []};
    private effectiveIssues: MapPresetIssue[] = [];

    readonly presets$: Observable<MapPresetDefinition[]>;
    readonly issues$ = this.issuesSubject.asObservable();

    constructor(
        private readonly configService: AppConfigService,
        private readonly stateService: AppStateService,
        private readonly styleService: StyleService
    ) {
        this.presets$ = this.stateService.mapPresetsState.asObservable();
    }

    /** Captures the inline config baseline after AppState config/storage hydration has completed. */
    initialize(): void {
        const configuredSource = this.configService.snapshot.state?.["mapPresets"] ?? [];
        const parsed = parseMapPresetDefinitions(configuredSource);
        this.configuredResult = {
            presets: parsed.presets.map(preset => this.copyPreset(preset)),
            issues: [...parsed.issues]
        };
        this.effectiveIssues = this.hasLocalOverride ? [] : [...this.configuredResult.issues];
        this.issuesSubject.next(this.effectiveIssues);

        // Retire storage from both the external-document design and the split-state prototype.
        localStorage.removeItem("stylePresetAvailability");
        localStorage.removeItem("stylePresetOverrideSource");
        localStorage.removeItem("mapPresetAvailability");
        localStorage.removeItem("mapPresetDefinitionsOverride");
    }

    get presets(): MapPresetDefinition[] {
        return this.stateService.mapPresets;
    }

    get source(): string {
        return this.serializeDefinitions(this.presets);
    }

    get hasLocalOverride(): boolean {
        return !deepEquals(this.presets, this.configuredResult.presets);
    }

    presetById(presetId: string): MapPresetDefinition | undefined {
        return this.presets.find(preset => preset.id === presetId);
    }

    isAvailable(preset: MapPresetDefinition): boolean {
        return preset.enabled;
    }

    setAvailable(presetId: string, available: boolean): void {
        const preset = this.presetById(presetId);
        if (!preset || preset.enabled === available) {
            return;
        }
        this.stateService.mapPresets = this.presets.map(current => ({
            ...this.copyPreset(current),
            enabled: current.id === presetId ? available : current.enabled
        }));
        this.effectiveIssues = this.hasLocalOverride ? [] : [...this.configuredResult.issues];
        this.issuesSubject.next(this.effectiveIssues);
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

    ownsOption(preset: ResolvedLayerPreset, option: LayerPresetOptionCandidate): boolean {
        return preset.styleId === option.styleId
            && preset.values.some(value => value.optionId === option.id);
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
    applyDefinitions(definitions: unknown): boolean {
        const result = parseMapPresetDefinitions(definitions);
        if (result.issues.length) {
            this.issuesSubject.next(result.issues);
            return false;
        }
        const stored = result.presets.map(preset => this.copyPreset(preset));
        this.stateService.mapPresets = stored;
        this.effectiveIssues = [];
        this.issuesSubject.next([]);
        return true;
    }

    /** Parses a GUI raw-editor buffer as a YAML list, never as an external document URL. */
    applyOverrideSource(source: string): boolean {
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

    addPreset(preset: MapPresetDefinition): boolean {
        return this.applyDefinitions([...this.presets.map(current => this.copyPreset(current)), preset]);
    }

    resetToConfigured(): void {
        this.stateService.mapPresets = this.configuredResult.presets;
        this.effectiveIssues = [...this.configuredResult.issues];
        this.issuesSubject.next(this.effectiveIssues);
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
}
