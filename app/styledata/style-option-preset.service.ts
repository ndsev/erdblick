import {HttpClient} from "@angular/common/http";
import {Injectable} from "@angular/core";
import {BehaviorSubject, firstValueFrom, skip, Subscription} from "rxjs";
import * as jsyaml from "js-yaml";
import {z} from "zod";
import {AppConfigService} from "../shared/app-config.service";
import {AppStateService} from "../shared/appstate.service";
import {FeatureStyleOptionWithStringType, StyleService} from "./style.service";

export const STYLE_OPTION_PRESET_DOCUMENT_VERSION = 1;
export const NO_STYLE_OPTION_PRESET_ID = "";

/** One explicit Boolean style-option value owned by a preset. */
export interface StyleOptionPresetValue {
    styleId: string;
    optionId: string;
    value: boolean;
}

/** One validated, selectable style-option preset. */
export interface StyleOptionPresetDefinition {
    id: string;
    name: string;
    enabled: boolean;
    layerAffinity?: string;
    values: StyleOptionPresetValue[];
}

/** Canonical YAML document represented by the raw editor and GUI additions. */
export interface StyleOptionPresetDocument {
    version: 1;
    presets: StyleOptionPresetDefinition[];
}

/** User-facing validation problem for a configured or locally edited preset document. */
export interface StyleOptionPresetIssue {
    message: string;
    presetId?: string;
    valueIndex?: number;
}

/** Minimal style-option identity required to resolve layer eligibility and ownership. */
export interface StyleOptionPresetCandidate {
    styleId: string;
    id: string;
}

/** Style metadata required while resolving preset option references. */
export interface StyleOptionPresetStyleMetadata {
    options: FeatureStyleOptionWithStringType[];
}

/** Result of parsing and resolving a preset document against loaded style metadata. */
export interface StyleOptionPresetParseResult {
    document: StyleOptionPresetDocument;
    issues: StyleOptionPresetIssue[];
}

const PRESET_VALUE_SCHEMA = z.object({
    styleId: z.string().trim().min(1),
    optionId: z.string().trim().min(1),
    value: z.boolean()
}).strict();

const PRESET_SCHEMA = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    enabled: z.boolean().optional(),
    layerAffinity: z.string().trim().min(1).optional(),
    values: z.array(PRESET_VALUE_SCHEMA).min(1).max(500)
}).strict();

const PRESET_DOCUMENT_ROOT_SCHEMA = z.object({
    version: z.number().int(),
    presets: z.array(z.unknown()).max(200)
}).strict();

/** Returns whether one WASM style option is the Boolean option type supported by presets. */
export function isBooleanStyleOption(option: FeatureStyleOptionWithStringType): boolean {
    return String(option.type).toLocaleLowerCase() === "bool";
}

/** Converts a Zod issue path to a compact user-facing location. */
function presetSchemaIssueMessage(issue: {path: readonly PropertyKey[]; message: string}): string {
    const location = issue.path.length ? `${issue.path.map(part => String(part)).join(".")}: ` : "";
    return `${location}${issue.message}`;
}

/**
 * Parses preset YAML and resolves every option reference against the loaded styles.
 * Invalid preset entries are omitted so startup configuration can retain independent valid entries.
 */
export function parseStyleOptionPresetSource(
    source: string,
    styles: ReadonlyMap<string, StyleOptionPresetStyleMetadata>,
    knownLayerIds: readonly string[] = [],
    styleAppliesToLayer: (styleId: string, layerId: string) => boolean = () => true
): StyleOptionPresetParseResult {
    const issues: StyleOptionPresetIssue[] = [];
    const emptyDocument: StyleOptionPresetDocument = {
        version: STYLE_OPTION_PRESET_DOCUMENT_VERSION,
        presets: []
    };
    if (new TextEncoder().encode(source).byteLength > 1024 * 1024) {
        return {
            document: emptyDocument,
            issues: [{message: "Preset source exceeds the 1 MiB limit."}]
        };
    }

    let loaded: unknown;
    try {
        loaded = jsyaml.load(source);
    } catch (error) {
        return {
            document: emptyDocument,
            issues: [{
                message: error instanceof Error ? error.message : "Could not parse preset YAML."
            }]
        };
    }

    const root = PRESET_DOCUMENT_ROOT_SCHEMA.safeParse(loaded);
    if (!root.success) {
        return {
            document: emptyDocument,
            issues: root.error.issues.map(issue => ({message: presetSchemaIssueMessage(issue)}))
        };
    }
    if (root.data.version !== STYLE_OPTION_PRESET_DOCUMENT_VERSION) {
        return {
            document: emptyDocument,
            issues: [{
                message: `Unsupported preset document version ${root.data.version}; expected ${STYLE_OPTION_PRESET_DOCUMENT_VERSION}.`
            }]
        };
    }

    const presets: StyleOptionPresetDefinition[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const [presetIndex, rawPreset] of root.data.presets.entries()) {
        const parsed = PRESET_SCHEMA.safeParse(rawPreset);
        if (!parsed.success) {
            issues.push(...parsed.error.issues.map(issue => ({
                message: `presets.${presetIndex}.${presetSchemaIssueMessage(issue)}`
            })));
            continue;
        }

        const preset = parsed.data;
        let valid = true;
        if (ids.has(preset.id)) {
            issues.push({presetId: preset.id, message: `Duplicate preset id '${preset.id}'.`});
            valid = false;
        }
        if (names.has(preset.name)) {
            issues.push({presetId: preset.id, message: `Duplicate preset name '${preset.name}'.`});
            valid = false;
        }
        let affinity: RegExp | undefined;
        if (preset.layerAffinity) {
            try {
                affinity = new RegExp(preset.layerAffinity);
            } catch {
                issues.push({
                    presetId: preset.id,
                    message: `Invalid layer affinity regular expression '${preset.layerAffinity}'.`
                });
                valid = false;
            }
        }

        const references = new Set<string>();
        for (const [valueIndex, value] of preset.values.entries()) {
            const reference = `${value.styleId}\u0000${value.optionId}`;
            if (references.has(reference)) {
                issues.push({
                    presetId: preset.id,
                    valueIndex,
                    message: `Duplicate option reference '${value.styleId}/${value.optionId}'.`
                });
                valid = false;
                continue;
            }
            references.add(reference);

            const style = styles.get(value.styleId);
            const option = style?.options.find(candidate => candidate.id === value.optionId);
            if (!style) {
                issues.push({
                    presetId: preset.id,
                    valueIndex,
                    message: `Unknown style '${value.styleId}'.`
                });
                valid = false;
            } else if (!option) {
                issues.push({
                    presetId: preset.id,
                    valueIndex,
                    message: `Unknown option '${value.optionId}' in style '${value.styleId}'.`
                });
                valid = false;
            } else if (option.internal || !isBooleanStyleOption(option)) {
                issues.push({
                    presetId: preset.id,
                    valueIndex,
                    message: `Option '${value.styleId}/${value.optionId}' is not an editable Boolean option.`
                });
                valid = false;
            }
        }
        if (valid && knownLayerIds.length && !knownLayerIds.some(layerId =>
            (!affinity || affinity.test(layerId))
            && preset.values.every(value => styleAppliesToLayer(value.styleId, layerId)))) {
            issues.push({
                presetId: preset.id,
                message: "Preset affinity and style references do not apply to any known feature layer."
            });
            valid = false;
        }

        ids.add(preset.id);
        names.add(preset.name);
        if (valid) {
            presets.push({
                id: preset.id,
                name: preset.name,
                enabled: preset.enabled ?? true,
                ...(preset.layerAffinity ? {layerAffinity: preset.layerAffinity} : {}),
                values: preset.values.map(value => ({...value}))
            });
        }
    }

    return {
        document: {
            version: STYLE_OPTION_PRESET_DOCUMENT_VERSION,
            presets
        },
        issues
    };
}

/** Loads, validates, persists, and resolves named style-option presets. */
@Injectable({providedIn: "root"})
export class StyleOptionPresetService {
    private readonly presetsSubject = new BehaviorSubject<StyleOptionPresetDefinition[]>([]);
    private readonly issuesSubject = new BehaviorSubject<StyleOptionPresetIssue[]>([]);
    private readonly subscriptions: Subscription[] = [];
    private configuredSource = this.serializeDocument({
        version: STYLE_OPTION_PRESET_DOCUMENT_VERSION,
        presets: []
    });
    private configuredResult: StyleOptionPresetParseResult = {
        document: {version: STYLE_OPTION_PRESET_DOCUMENT_VERSION, presets: []},
        issues: []
    };
    private configuredLoadIssues: StyleOptionPresetIssue[] = [];
    private effectiveResult = this.configuredResult;
    private effectiveSource = this.configuredSource;
    private knownLayerIds: string[] = [];
    private initialized = false;

    readonly presets$ = this.presetsSubject.asObservable();
    readonly issues$ = this.issuesSubject.asObservable();

    /** Connects preset availability and stylesheet lifecycle changes to the effective definitions. */
    constructor(
        private readonly httpClient: HttpClient,
        private readonly configService: AppConfigService,
        private readonly stateService: AppStateService,
        private readonly styleService: StyleService
    ) {
        this.subscriptions.push(
            this.stateService.stylePresetAvailabilityState.pipe(skip(1)).subscribe(() => {
                this.presetsSubject.next([...this.presetsSubject.getValue()]);
            }),
            this.styleService.styleGroups.pipe(skip(1)).subscribe(() => {
                if (this.initialized) {
                    this.revalidateEffectiveSource();
                }
            })
        );
    }

    /** Loads the configured baseline and then restores a valid browser-local override. */
    async initialize(): Promise<void> {
        const url = this.configService.snapshot.styleOptionPresets;
        if (url) {
            try {
                this.configuredSource = await firstValueFrom(
                    this.httpClient.get(url, {responseType: "text"}));
            } catch (error) {
                this.configuredSource = this.serializeDocument({
                    version: STYLE_OPTION_PRESET_DOCUMENT_VERSION,
                    presets: []
                });
                this.configuredLoadIssues = [{
                    message: `Could not load style-option presets from '${url}': ${
                        error instanceof Error ? error.message : String(error)}`
                }];
            }
        }
        this.configuredResult = this.parseConfiguredSource();
        this.initialized = true;
        this.activateStoredOverrideOrConfiguredSource();
    }

    /** Returns the current validated definitions, including unavailable management entries. */
    get presets(): StyleOptionPresetDefinition[] {
        return this.presetsSubject.getValue();
    }

    /** Returns the current effective YAML shown when the raw editor opens. */
    get source(): string {
        return this.effectiveSource;
    }

    /** Returns the immutable startup baseline used by Reset to Configured. */
    get baselineSource(): string {
        return this.configuredSource;
    }

    /** Returns whether the effective document comes from browser-local state. */
    get hasLocalOverride(): boolean {
        return this.stateService.stylePresetOverrideSource !== null;
    }

    /** Revalidates definitions when a datasource catalog exposes a different set of feature layers. */
    setKnownLayerIds(layerIds: readonly string[]): void {
        const nextLayerIds = [...new Set(layerIds)].sort((lhs, rhs) => lhs.localeCompare(rhs));
        if (nextLayerIds.join("\u0000") === this.knownLayerIds.join("\u0000")) {
            return;
        }
        this.knownLayerIds = nextLayerIds;
        if (this.initialized) {
            this.revalidateEffectiveSource();
        }
    }

    /** Resolves one preset by stable ID. */
    presetById(presetId: string): StyleOptionPresetDefinition | undefined {
        return this.presets.find(preset => preset.id === presetId);
    }

    /** Resolves configured availability plus an optional local availability override. */
    isAvailable(preset: StyleOptionPresetDefinition): boolean {
        const overrides = this.stateService.stylePresetAvailability;
        return Object.prototype.hasOwnProperty.call(overrides, preset.id)
            ? overrides[preset.id]
            : preset.enabled;
    }

    /** Stores a user availability override, removing redundant values that match configuration. */
    setAvailable(presetId: string, available: boolean): void {
        const preset = this.presetById(presetId);
        if (!preset) {
            return;
        }
        const overrides = {...this.stateService.stylePresetAvailability};
        if (available === preset.enabled) {
            delete overrides[presetId];
        } else {
            overrides[presetId] = available;
        }
        this.stateService.stylePresetAvailability = overrides;
    }

    /** Returns enabled presets whose affinity and complete option set apply to one concrete layer. */
    presetsForLayer(
        layerId: string,
        options: readonly StyleOptionPresetCandidate[]
    ): StyleOptionPresetDefinition[] {
        const references = new Set(options.map(option => `${option.styleId}\u0000${option.id}`));
        return this.presets.filter(preset => {
            if (!this.isAvailable(preset)) {
                return false;
            }
            if (preset.layerAffinity && !new RegExp(preset.layerAffinity).test(layerId)) {
                return false;
            }
            return preset.values.every(value =>
                references.has(`${value.styleId}\u0000${value.optionId}`));
        });
    }

    /** Returns whether a preset owns one concrete style option. */
    ownsOption(
        preset: StyleOptionPresetDefinition,
        option: StyleOptionPresetCandidate
    ): boolean {
        return preset.values.some(value =>
            value.styleId === option.styleId && value.optionId === option.id);
    }

    /** Checks that every preset-owned option currently has its explicit value in one view. */
    matchesPresetValues(
        preset: StyleOptionPresetDefinition,
        options: ReadonlyArray<StyleOptionPresetCandidate & {
            value: Array<boolean | number | string>;
        }>,
        viewIndex: number
    ): boolean {
        return preset.values.every(value => {
            const option = options.find(candidate =>
                candidate.styleId === value.styleId && candidate.id === value.optionId);
            return option?.value[viewIndex] === value.value;
        });
    }

    /** Validates and atomically activates a raw local override. */
    applyOverrideSource(source: string): boolean {
        const result = this.parseSource(source);
        if (result.issues.length) {
            this.issuesSubject.next(result.issues);
            return false;
        }
        this.stateService.stylePresetOverrideSource = source;
        this.activate(source, result);
        return true;
    }

    /** Restores diagnostics for the active document after an invalid raw buffer is discarded. */
    restoreEffectiveIssues(): void {
        this.issuesSubject.next(this.effectiveResult.issues);
    }

    /** Adds one GUI-defined preset by writing a normalized local override document. */
    addPreset(preset: StyleOptionPresetDefinition): boolean {
        const source = this.serializeDocument({
            version: STYLE_OPTION_PRESET_DOCUMENT_VERSION,
            presets: [...this.presets.map(current => ({
                ...current,
                values: current.values.map(value => ({...value}))
            })), preset]
        });
        return this.applyOverrideSource(source);
    }

    /** Removes the local override and restores the configured baseline document. */
    resetToConfigured(): void {
        this.stateService.stylePresetOverrideSource = null;
        this.activate(this.configuredSource, this.configuredResult);
    }

    /** Serializes a canonical preset document to stable, human-readable YAML. */
    serializeDocument(document: StyleOptionPresetDocument): string {
        return jsyaml.dump(document, {
            noRefs: true,
            lineWidth: 120,
            sortKeys: false
        });
    }

    /** Revalidates the retained raw source after stylesheet additions, removals, or edits. */
    private revalidateEffectiveSource(): void {
        this.configuredResult = this.parseConfiguredSource();
        this.activateStoredOverrideOrConfiguredSource();
    }

    /** Selects a valid stored override or falls back to the latest configured baseline. */
    private activateStoredOverrideOrConfiguredSource(): void {
        const override = this.stateService.stylePresetOverrideSource;
        if (override !== null) {
            const overrideResult = this.parseSource(override);
            if (!overrideResult.issues.length) {
                this.activate(override, overrideResult);
                return;
            }
            this.activate(this.configuredSource, {
                document: this.configuredResult.document,
                issues: [
                    ...this.configuredResult.issues,
                    ...overrideResult.issues.map(issue => ({
                        ...issue,
                        message: `Local override: ${issue.message}`
                    }))
                ]
            });
            return;
        }
        this.activate(this.configuredSource, this.configuredResult);
    }

    /** Resolves one source against current style metadata and the concrete catalog layer set. */
    private parseSource(source: string): StyleOptionPresetParseResult {
        return parseStyleOptionPresetSource(
            source,
            this.styleService.styles,
            this.knownLayerIds,
            (styleId, layerId) =>
                this.styleService.styles.get(styleId)?.featureLayerStyle.hasLayerAffinity(layerId) === true
        );
    }

    /** Parses the configured baseline while retaining an earlier transport failure diagnostic. */
    private parseConfiguredSource(): StyleOptionPresetParseResult {
        const result = this.parseSource(this.configuredSource);
        return {
            document: result.document,
            issues: [...this.configuredLoadIssues, ...result.issues]
        };
    }

    /** Publishes one validated effective document and prunes obsolete availability overrides. */
    private activate(source: string, result: StyleOptionPresetParseResult): void {
        this.effectiveSource = source;
        this.effectiveResult = result;
        const validIds = new Set(result.document.presets.map(preset => preset.id));
        const currentAvailability = this.stateService.stylePresetAvailability;
        const nextAvailability = Object.fromEntries(
            Object.entries(currentAvailability).filter(([presetId]) => validIds.has(presetId)));
        if (Object.keys(nextAvailability).length !== Object.keys(currentAvailability).length) {
            this.stateService.stylePresetAvailability = nextAvailability;
        }
        this.issuesSubject.next(result.issues);
        this.presetsSubject.next(result.document.presets);
    }
}
