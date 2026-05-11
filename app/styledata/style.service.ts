import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {
    of,
    forkJoin,
    map,
    firstValueFrom,
    BehaviorSubject,
    catchError, Subject
} from "rxjs";
import {FileUpload} from "primeng/fileupload";
import {FeatureLayerStyle, FeatureStyleOptionType} from "../../build/libs/core/erdblick-core";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {AppStateService} from "../shared/appstate.service";
import {filter} from "rxjs/operators";
import {shortId4, sipHash64Hex} from "./hash";
import {InfoMessageService} from "../shared/info.service";
import {AppConfigService, StyleConfigEntry} from "../shared/app-config.service";
import {StyleValidationReportService} from "./style-validation-report.service";
import {
    StyleSourceKind,
    StyleSourceRef,
    StyleValidationIssue,
    StyleValidationReport
} from "./style-validation.model";

/** Original server-provided builtin style source kept for resets and comparisons. */
interface BuiltinStyleBaseline {
    id: string,
    source: string
}

export interface OverriddenBaseStyleBaseline extends BuiltinStyleBaseline {
    url: string
}

export interface StyleLifecycleState {
    id: string,
    sha256: string,
    isModified: boolean,
    isUpdated: boolean
}

export interface UpdatedModifiedStyleEntry {
    id: string,
    url: string
}

export type FeatureStyleOptionWithStringType = {
    label: string,
    id: string,
    type: FeatureStyleOptionType | string,
    defaultValue: any,
    description: string,
    internal: boolean
};

export interface ErdblickStyle {
    id: string,
    modified: boolean,
    imported: boolean,
    additional: boolean,
    source: string,
    featureLayerStyle: FeatureLayerStyle,
    options: Array<FeatureStyleOptionWithStringType>,
    shortId: string,
    key?: string,
    type?: string,
    children?: Array<FeatureStyleOptionWithStringType>,
    expanded?: boolean,
    visible: boolean,
    url: string,
    sourceRef: StyleSourceRef,
    overridesBaseStyle?: OverriddenBaseStyleBaseline
}

export interface ErdblickStyleGroup extends Record<string, any> {
    key: string;
    id: string;
    type: string;
    children: Array<ErdblickStyleGroup | ErdblickStyle>;
    visible: boolean,
    expanded: boolean
}

/**
 * Central style repository for builtin and imported YAML styles.
 *
 * It owns style parsing, lifecycle tracking, storage of local modifications,
 * grouping for the styles tree, and reapplication of visible styles.
 */
@Injectable({providedIn: 'root'})
export class StyleService {
    styleHashes: Map<string, StyleLifecycleState> = new Map();
    styleUrls: StyleConfigEntry[] = [];
    styles: Map<string, ErdblickStyle> = new Map<string, ErdblickStyle>();
    erroredStyleIds: Map<string, string> = new Map<string, string>();
    lastValidationReport?: StyleValidationReport;
    styleEditedSaveTriggered: Subject<boolean> = new Subject<boolean>();

    builtinStylesCount = 0;
    importedStylesCount = 0;

    private textEncoder: TextEncoder = new TextEncoder();
    styleRemovedForId: Subject<string> = new Subject<string>();
    styleAddedForId: Subject<string> = new Subject<string>();

    styleGroups: BehaviorSubject<(ErdblickStyleGroup|ErdblickStyle)[]> = new BehaviorSubject<(ErdblickStyleGroup|ErdblickStyle)[]>([]);
    private readonly builtinStyleBaselines = new Map<string, BuiltinStyleBaseline>();

    constructor(private httpClient: HttpClient,
                private stateService: AppStateService,
                private infoMessageService: InfoMessageService,
                private configService: AppConfigService,
                private styleValidationReportService: StyleValidationReportService = new StyleValidationReportService()) {
        this.stateService.ready.pipe(filter(state => state)).subscribe((state) => {
            this.reapplyAllStyles();
        });
    }

    /** Loads builtin styles from config, restores local modifications, and reapplies visible styles. */
    async initializeStyles(): Promise<void> {
        try {
            const configuredStyles = Array.isArray(this.configService.snapshot.styles)
                ? [...this.configService.snapshot.styles] as StyleConfigEntry[]
                : [];
            this.styleUrls = [];

            if (!configuredStyles.length) {
                console.warn("No style configuration found in config.json. Skipping builtin style initialization.");
            } else {
                this.styleUrls = configuredStyles.map((entry: StyleConfigEntry) => this.normalizeConfiguredStyleUrl(entry));

                const styleHashes = this.loadStyleHashes();
                const baseStyles = this.styleUrls.filter(entry => entry.additional !== true);
                const additionalStyles = this.styleUrls.filter(entry => entry.additional === true);
                await this.loadConfiguredStyleSources(baseStyles, styleHashes);
                await this.loadConfiguredStyleSources(additionalStyles, styleHashes);
                this.loadModifiedBuiltinStyles();
            }
        } catch (error) {
            console.error(`Error while initializing styles: ${error}`);
        }
        this.loadImportedStyles();

        if (this.styles.size) {
            this.reapplyStyles([...this.styles.keys()]);
        }
    }

    /** Normalizes a configured style URL against the config path. */
    private normalizeConfiguredStyleUrl(entry: StyleConfigEntry): StyleConfigEntry {
        const normalized: StyleConfigEntry = {...entry};
        if (!normalized.url.startsWith("http")
            && !normalized.url.startsWith("bundle")
            && !normalized.url.startsWith("/")) {
            normalized.url = `bundle/styles/${normalized.url}`;
        }
        return normalized;
    }

    /** Loads all styles declared by application configuration. */
    private async loadConfiguredStyleSources(styleEntries: StyleConfigEntry[], styleHashes: Map<string, string>) {
        const dataMap = await this.fetchStylesYamlSources(styleEntries);
        for (const styleEntry of styleEntries) {
            const styleString = dataMap.get(styleEntry.url);
            if (styleString === undefined) {
                continue;
            }
            const styleId = this.initializeStyle(
                styleString,
                styleEntry.url,
                undefined,
                false,
                false,
                styleEntry.additional === true);
            if (!styleId) {
                continue;
            }
            const style = this.styles.get(styleId);
            if (style) {
                style.sourceRef.configId = styleEntry.id;
            }
            this.builtinStylesCount++;
            this.registerBuiltinServerSource(styleEntry.url, styleId, styleString, styleHashes);
            this.synchronizeLifecycleForStyle(this.styles.get(styleId));
        }
    }

    /** Parses and registers one style source, optionally replacing an existing style id. */
    private initializeStyle(
        styleString: string,
        styleUrl: string,
        knownStyleId?: string,
        modified: boolean = false,
        imported: boolean = false,
        additional: boolean = false) {
        if (!styleString) {
            const sourceRef: StyleSourceRef = {
                styleName: knownStyleId,
                url: styleUrl || undefined,
                sourceKind: this.styleSourceKind(modified, imported, additional)
            };
            this.styleValidationReportService.recordReport(
                this.createClientValidationFailureReport(
                    styleString,
                    sourceRef,
                    `Got empty style source for ${styleUrl.length ? styleUrl : (knownStyleId ?? 'missing-style-identifier')}.`),
                sourceRef);
            this.erroredStyleIds.set(
                knownStyleId ?? "mising-style-id",
                `Got empty style source for ${styleUrl.length ? styleUrl : (knownStyleId ?? 'missing-style-identifier')}.`);
            return undefined;
        }

        const sourceRef = this.createStyleSourceRef(
            styleString,
            styleUrl,
            knownStyleId,
            modified,
            imported,
            additional);
        this.styleValidationReportService.clearForSource(sourceRef);

        const parsedStyleAndOptions = this.parseWasmStyle(styleString, sourceRef);
        if (!parsedStyleAndOptions) {
            return undefined;
        }

        const [wasmStyle, options, report] = parsedStyleAndOptions;
        const styleId = wasmStyle.name();
        sourceRef.styleName = styleId;
        if (report) {
            this.styleValidationReportService.recordReport(report, sourceRef);
        }
        const existingStyle = this.styles.get(styleId);
        const previousKnownStyle = knownStyleId ? this.styles.get(knownStyleId) : undefined;
        const overridesBaseStyle = additional
            ? this.resolveOverriddenBaseStyle(existingStyle ?? previousKnownStyle)
            : undefined;

        if (existingStyle) {
            if (knownStyleId && styleId !== knownStyleId) {
                this.infoMessageService.showError(`Illegal attempt to rename ${knownStyleId} to ${styleId}, which already exists.`)
                wasmStyle.delete?.();
                return undefined;
            }
            this.removeActiveStyleEntry(existingStyle.id);
        }

        if (knownStyleId && knownStyleId !== styleId && this.styles.has(knownStyleId)) {
            this.removeActiveStyleEntry(knownStyleId);
        }

        const isVisible = this.stateService.getStyleVisibility(knownStyleId ?? styleId, wasmStyle.defaultEnabled());
        this.styles.set(styleId, {
            id: styleId,
            modified: modified,
            imported: imported,
            additional: additional,
            source: styleString,
            featureLayerStyle: wasmStyle,
            options: options,
            shortId: shortId4(styleId),
            key: `${this.styles.size}`,
            type: "Style",
            children: [],
            visible: isVisible,
            url: styleUrl,
            sourceRef,
            overridesBaseStyle
        });

        // Ensure that if the style was renamed, its visibility is retained.
        if (this.stateService.ready.getValue()) {
            this.stateService.setStyleVisibility(styleId, isVisible);
        }

        return styleId;
    }

    /** Resolves the base style hidden by an override style. */
    private resolveOverriddenBaseStyle(style?: ErdblickStyle): OverriddenBaseStyleBaseline | undefined {
        if (!style || style.imported) {
            return undefined;
        }
        if (style.additional) {
            return style.overridesBaseStyle;
        }
        return {
            id: style.id,
            url: style.url,
            source: style.source
        };
    }

    /** Removes a style entry from the active style maps. */
    private removeActiveStyleEntry(styleId: string) {
        const style = this.styles.get(styleId);
        if (!style) {
            return;
        }
        style.featureLayerStyle?.delete();
        this.styleRemovedForId.next(styleId);
        this.styles.delete(styleId);
    }

    /** Fetches raw YAML sources for the configured style URLs while preserving input order. */
    async fetchStylesYamlSources(styles: Array<StyleConfigEntry>) {
        if (!styles.length) {
            return new Map<string, string>();
        }
        const requests = styles.map((style, index) =>
            this.httpClient.get(style.url, { responseType: 'text' }).pipe(
                map(data => ({ index, data, styleUrl: style.url })),
                catchError(error => {
                    console.error('Error fetching style', style.url, error);
                    const sourceRef: StyleSourceRef = {
                        configId: style.id,
                        url: style.url,
                        sourceKind: style.additional === true ? 'additional' : 'base'
                    };
                    this.styleValidationReportService.clearForSource(sourceRef);
                    this.styleValidationReportService.recordReport(this.createFetchFailureReport(style, error));
                    // Preserve the index without converting fetch failures into empty style sources.
                    return of({ index, data: undefined as string | undefined, styleUrl: style.url });
                })
            )
        );
        // Use await with firstValueFrom to wait for all HTTP requests to complete.
        // The results array will maintain the order of the original requests.
        const results = await firstValueFrom(forkJoin(requests));
        // Sort the results by index to ensure they are in the same order as the input array.
        // Although forkJoin preserves order, this is a safeguard.
        results.sort((a, b) => a.index - b.index);
        // Initialize an ordered map to hold the results.
        const orderedMap = new Map<string, string>();
        results.forEach(({ data, styleUrl }) => {
            if (data !== undefined) {
                orderedMap.set(styleUrl, data);
            }
        });
        // Return the map with the fetched styles in their original order.
        return orderedMap;
    }

    /** Reloads one builtin style from its configured URL and reapplies it. */
    async syncStyleYamlData(styleId: string) {
        if (!this.styles.has(styleId)) {
           return;
        }
        const style = this.styles.get(styleId)!;
        if (!style.url) {
            return;
        }

        try {
            const result= await this.fetchStylesYamlSources([{id: style.id, url: style.url}]);
            if (!result.has(style.url)) {
                return;
            }
            const styleString = result.get(style.url)!;
            const newStyleId = this.initializeStyle(styleString, style.url, styleId, false, false, style.additional === true);
            if (!newStyleId) {
                return;
            }
            this.registerBuiltinServerSource(style.url, newStyleId, styleString);
            this.synchronizeLifecycleForStyle(this.styles.get(newStyleId));
            this.reapplyStyle(newStyleId);
            this.saveModifiedBuiltinStyles();
        } catch (error) {
            console.error('Style retrieval failed:', error);
        }
    }

    /** Exports the given style source as a downloadable YAML file. */
    exportStyleYamlFile(styleId: string): boolean {
        const content = this.styles.get(styleId);
        if (!content || !content.source) {
            console.error('No content found or invalid content structure.');
            return false;
        }

        try {
            // Ensure content.source is a string or convert to string if needed
            const blobContent = content.source;
            // Create a blob from the content
            const blob = new Blob([blobContent], { type: 'application/x-yaml;charset=utf-8' });
            // Create a URL for the blob
            const url = window.URL.createObjectURL(blob);
            // Check if URL creation was successful
            if (!url) {
                console.error('Failed to create object URL for the blob.');
                return false;
            }
            // Create a temporary anchor tag to trigger the download.
            const a = document.createElement('a');
            a.href = url;
            a.download = `${styleId}.yaml`;
            // Trigger the download.
            const event = new MouseEvent('click', {
                view: window,
                bubbles: true,
                cancelable: true,
            });
            a.dispatchEvent(event);

            // Revoke the blob URL to free up resources.
            window.URL.revokeObjectURL(url);
        } catch (e) {
            console.error('Error while exporting YAML file:', e);
            return false;
        }
        return true;
    }

    /** Imports a YAML file, registers it as an imported style, and reapplies it. */
    async importStyleYamlFile(event: any, file: File, fileUploader: FileUpload | undefined): Promise<boolean> {
        // Prevent the default upload behavior Dummy XHR, as we handle the file ourselves
        event.xhr = new XMLHttpRequest();
        const fileReader = new FileReader();
        const loadFilePromise = new Promise<string|ArrayBuffer|null>((resolve, reject) => {
            fileReader.onload = () => resolve(fileReader.result);
            fileReader.onerror = (error) => reject(error);
            fileReader.readAsText(file);
        });

        const uploadedContent = await loadFilePromise;
        if (fileUploader !== undefined) {
            fileUploader.clear();
        }
        if (!uploadedContent) {
            return false;
        }

        let styleData: string;
        if (uploadedContent instanceof ArrayBuffer) {
            const decoder = new TextDecoder('utf-8');
            styleData = decoder.decode(uploadedContent);
        } else {
            styleData = uploadedContent as string; // Casting as string since it's either string or ArrayBuffer
        }

        const sourceRef = this.createStyleSourceRef(styleData, "", file.name, false, true, false);
        const report = this.validateStyleSource(styleData, sourceRef);
        if (!report.valid) {
            return false;
        }

        const styleId = this.initializeStyle(styleData, "", "", false, true);
        if (!styleId) {
            return false;
        }
        ++this.importedStylesCount;
        this.saveImportedStyles();
        this.reapplyStyle(styleId);
        return true;
    }

    /** Deletes an imported style and restores a matching builtin style when one exists. */
    deleteStyle(styleId: string, force: boolean = false) {
        // Implement deletion with safety for imported styles and restoration of built-ins.
        const style = this.styles.get(styleId);
        if (!style || !style.imported) {
            return;
        }

        // When deleting an imported style: optionally export if modified, then restore matching built-in if available.
        try {
            if (style.modified && !force) {
                const proceed = window.confirm(`Imported style ${style.id} was modified. Export before deleting?`);
                if (proceed) {
                    // Ignore return value; even if export fails, continue with deletion.
                    this.exportStyleYamlFile(styleId);
                }
            }
        } catch (e) {
            // In case running outside browser or confirm not available, ignore.
        }

        // Delete the imported style entry and notify listeners.
        style.featureLayerStyle?.delete();
        this.styleRemovedForId.next(styleId);
        this.styles.delete(styleId);
        this.importedStylesCount--;
        this.saveImportedStyles();

        // Try to restore corresponding built-in style (same id) using recorded styleHashes (url -> {id,...}).
        for (const url of this.styleUrls) {
            if (url.id === styleId) {
                const builtinUrl = url.url;
                this.fetchStylesYamlSources([{id: styleId, url: builtinUrl} as any]).then(map => {
                    const source = map.get(builtinUrl!);
                    if (source) {
                        const restoredId = this.initializeStyle(source, builtinUrl!, styleId, false, false, url.additional === true);
                        if (restoredId) {
                            this.registerBuiltinServerSource(builtinUrl, restoredId, source);
                            this.synchronizeLifecycleForStyle(this.styles.get(restoredId));
                            this.reapplyStyle(restoredId);
                        }
                    }
                }).catch(err => {
                    console.error('Failed to restore built-in style after deletion:', err);
                });
                break;
            }
        }
    }

    /** Replaces the source of an existing style and updates its lifecycle bookkeeping. */
    setStyleSource(styleId: string, styleSource: string, modified: boolean = true): string|undefined {
        if (!this.styles.has(styleId)) {
            return styleId;
        }
        const style = this.styles.get(styleId)!;
        const newStyleId = this.initializeStyle(styleSource, style.url ?? '', styleId, modified, style.imported, style.additional === true);
        if (!newStyleId) {
            return undefined;
        }
        this.synchronizeLifecycleForStyle(this.styles.get(newStyleId));

        if (style.imported) {
            this.saveImportedStyles();
        } else {
            this.saveModifiedBuiltinStyles();
        }
        this.reapplyStyle(newStyleId);
        return newStyleId;
    }

    /** Restores a modified builtin style to its recorded baseline source. */
    resetModifiedBuiltinStyle(styleIdOrUrl: string): string | undefined {
        const style = this.resolveBuiltinStyle(styleIdOrUrl);
        if (!style) {
            return undefined;
        }
        const baseline = this.builtinStyleBaselines.get(style.url);
        if (!baseline) {
            return undefined;
        }
        const restoredStyleId = this.initializeStyle(baseline.source, style.url, style.id, false, false, style.additional === true);
        if (!restoredStyleId) {
            return undefined;
        }
        const baselineHash = sipHash64Hex(baseline.source);
        const existingLifecycle = this.styleHashes.get(style.url);
        this.styleHashes.set(style.url, {
            id: restoredStyleId,
            sha256: baselineHash,
            isModified: false,
            isUpdated: existingLifecycle?.isUpdated ?? baselineHash !== this.loadStyleHashes().get(style.url)
        });
        this.saveModifiedBuiltinStyles();
        this.reapplyStyle(restoredStyleId);
        return restoredStyleId;
    }

    /** Returns the original builtin source for a style id or builtin URL. */
    getBuiltinBaselineSource(styleIdOrUrl: string): string | undefined {
        const style = this.resolveBuiltinStyle(styleIdOrUrl);
        if (style && this.builtinStyleBaselines.has(style.url)) {
            return this.builtinStyleBaselines.get(style.url)!.source;
        }
        if (this.builtinStyleBaselines.has(styleIdOrUrl)) {
            return this.builtinStyleBaselines.get(styleIdOrUrl)!.source;
        }
        return undefined;
    }

    /** Returns the source URL of the base style replaced by an override. */
    getOverriddenBaseStyleSource(styleId: string): string | undefined {
        return this.styles.get(styleId)?.overridesBaseStyle?.source;
    }

    /** Lists builtin styles that were modified locally and updated on the server. */
    getUpdatedModifiedStyles(): UpdatedModifiedStyleEntry[] {
        return [...this.styleHashes.entries()]
            .filter(([, state]) => state.isUpdated && state.isModified)
            .map(([url, state]) => ({id: state.id, url}));
    }

    /** Persists modified builtin styles to local storage. */
    saveModifiedBuiltinStyles() {
        // Omit the 'parent' field which is injected by prime-ng,
        // so we do not get cyclic object errors.
        localStorage.setItem('builtinStyleData', JSON.stringify(
            [...this.styles].filter(([_, value]) => !value.imported && value.modified),
            (key, value) => key === 'parent' ? undefined : value
        ));
    }

    /** Persists imported styles to local storage. */
    saveImportedStyles() {
        // Omit the 'parent' field which is injected by prime-ng,
        // so we do not get cyclic object errors.
        localStorage.setItem('importedStyleData', JSON.stringify(
            [...this.styles].filter(([_, value]) => value.imported),
            (key, value) => key === 'parent' ? undefined : value
        ));
    }

    /** Restores imported styles from local storage. */
    loadImportedStyles() {
        const importedStyleData = localStorage.getItem('importedStyleData');
        if (importedStyleData) {
            for (let [_, style] of JSON.parse(importedStyleData)) {
                if (!this.initializeStyle(style.source, "", style.id, false, true)) {
                    continue;
                }
                this.importedStylesCount++;
            }
        }
    }

    /** Restores locally modified builtin styles from local storage. */
    loadModifiedBuiltinStyles() {
        const modifiedBuiltinStyleData = localStorage.getItem('builtinStyleData');
        if (modifiedBuiltinStyleData) {
            for (const [, style] of JSON.parse(modifiedBuiltinStyleData)) {
                // A modified style will only be applied if there is a matching builtin style by the URL.
                const matchingBuiltinStyle = Array.from(this.styles.values()).find(
                    builtinStyle => builtinStyle.url === style.url
                );
                if (!matchingBuiltinStyle) {
                    continue;
                }
                const newStyleId = this.initializeStyle(
                    style.source,
                    style.url,
                    matchingBuiltinStyle.id,
                    true,
                    style.imported,
                    matchingBuiltinStyle.additional === true);
                if (!newStyleId) {
                    continue;
                }
                this.synchronizeLifecycleForStyle(this.styles.get(newStyleId));
            }
        }
    }

    /** Clears persisted imported styles. */
    clearStorageForImportedStyles() {
        localStorage.removeItem('importedStyleData');
    }

    /** Clears persisted builtin-style modifications. */
    clearStorageForBuiltinStyles() {
        localStorage.removeItem('builtinStyleData');
    }

    /** Validates style source text and records the resulting report. */
    validateStyleSource(
        styleString: string,
        sourceRef: StyleSourceRef
    ): StyleValidationReport {
        const parsed = this.parseWasmStyle(styleString, sourceRef);
        if (!parsed) {
            this.styleValidationReportService.clearForSource(sourceRef);
            const report = this.createClientValidationFailureReport(styleString, sourceRef, 'Style source could not be parsed.');
            this.styleValidationReportService.recordReport(report, sourceRef);
            this.lastValidationReport = report;
            return report;
        }
        const [style, , report] = parsed;
        style.delete?.();
        const normalized = report ?? this.createSuccessReport(styleString, sourceRef, style.name());
        this.styleValidationReportService.recordReport(normalized, sourceRef);
        this.lastValidationReport = normalized;
        return normalized;
    }

    /** Parses one YAML style source through the WASM core and extracts its option metadata. */
    parseWasmStyle(styleString: string, sourceRef?: StyleSourceRef) {
        const styleUint8Array = this.textEncoder.encode(styleString);
        const yamlStyleNameRegex = /^\s*name\s*:\s*(?:(["'])(.*?)\1|([^\r\n#]+))/m;
        const yamlStyleNameMatch = styleString.match(yamlStyleNameRegex);
        const yamlStyleName = yamlStyleNameMatch ? (yamlStyleNameMatch[2] ?? yamlStyleNameMatch[3]).trim() : "failed-to-parse-name-from-yaml";
        const fallbackSourceRef = sourceRef ?? {
            styleName: yamlStyleName,
            sourceKind: 'base',
            sourceHash: sipHash64Hex(styleString)
        } as StyleSourceRef;

        const result = uint8ArrayToWasm(
            (wasmBuffer: any) => {
                const featureLayerStyle = new coreLib.FeatureLayerStyle(wasmBuffer);
                if (featureLayerStyle) {
                    const report = this.readWasmValidationReport(featureLayerStyle, fallbackSourceRef, styleString);
                    if (!report.loadable || ((featureLayerStyle as any).isValid && !(featureLayerStyle as any).isValid())) {
                        featureLayerStyle.delete?.();
                        return [undefined, [], report];
                    }
                    // Transport FeatureStyleOptions from WASM array to JS.
                    const options: FeatureStyleOptionWithStringType[] = [];
                    const wasmOptions = featureLayerStyle.options();
                    for (let i = 0; i < wasmOptions.size(); ++i) {
                        const option = wasmOptions.get(i) as FeatureStyleOptionWithStringType;
                        // We need to convert the value type to a string, so it is understood by prime-ng p-tree.
                        if (option.type === coreLib.FeatureStyleOptionType.Bool) {
                            option.type = "Bool";
                        }
                        if (option.type === coreLib.FeatureStyleOptionType.Color) {
                            option.type = "Color";
                        }
                        if (option.type === coreLib.FeatureStyleOptionType.String) {
                            option.type = "String";
                        }
                        options.push(option);
                    }
                    wasmOptions.delete();
                    return [featureLayerStyle, options, report];
                }
                return undefined;
            },
            styleUint8Array);

        if (result) {
            const [featureLayerStyle, options, report] = result as [
                FeatureLayerStyle | undefined,
                FeatureStyleOptionWithStringType[],
                StyleValidationReport | undefined
            ];
            if (featureLayerStyle) {
                return [featureLayerStyle, options, report] as [
                    FeatureLayerStyle,
                    FeatureStyleOptionWithStringType[],
                    StyleValidationReport
                ];
            }
            this.erroredStyleIds.set(
                report?.source.styleName ?? yamlStyleName,
                report?.issues[0]?.message ?? 'Style validation failed');
            if (report) {
                this.styleValidationReportService.recordReport(report, fallbackSourceRef);
            }
            return undefined;
        }

        console.error(`Encountered Uint8Array parsing issue in style "${yamlStyleName}" for the following YAML data:\n${styleString}`)
        this.erroredStyleIds.set(yamlStyleName, "YAML Parse Error");
        this.styleValidationReportService.recordReport(
            this.createClientValidationFailureReport(styleString, fallbackSourceRef, 'Style source could not be parsed by WASM.'));
        return undefined;
    }

    /** Creates a validation source reference for an editor-backed style. */
    createEditorSourceRef(styleId: string, styleSource: string): StyleSourceRef {
        const existing = this.styles.get(styleId);
        return {
            ...(existing?.sourceRef ?? {}),
            styleName: styleId,
            url: existing?.url || existing?.sourceRef?.url,
            sourceKind: 'editor',
            sourceHash: sipHash64Hex(styleSource)
        };
    }

    /** Reads a validation report produced by the WASM style parser. */
    private readWasmValidationReport(
        featureLayerStyle: FeatureLayerStyle,
        sourceRef: StyleSourceRef,
        styleString: string
    ): StyleValidationReport {
        const wasmStyle = featureLayerStyle as any;
        if (typeof wasmStyle.validationReport !== 'function') {
            const styleName = typeof wasmStyle.name === 'function' ? wasmStyle.name() : sourceRef.styleName;
            return this.createSuccessReport(styleString, {...sourceRef, styleName}, styleName);
        }
        const rawReport = wasmStyle.validationReport() as Partial<StyleValidationReport>;
        const styleName = typeof wasmStyle.name === 'function' ? wasmStyle.name() : sourceRef.styleName;
        return this.normalizeValidationReport(rawReport, {
            ...sourceRef,
            styleName: styleName || sourceRef.styleName,
            sourceHash: sourceRef.sourceHash ?? sipHash64Hex(styleString)
        });
    }

    /** Normalizes a raw WASM validation report. */
    private normalizeValidationReport(
        rawReport: Partial<StyleValidationReport> | undefined,
        sourceRef: StyleSourceRef
    ): StyleValidationReport {
        const issues = Array.isArray(rawReport?.issues) ? rawReport!.issues : [];
        const normalizedIssues = issues.map((issue, index) => this.normalizeValidationIssue(issue, sourceRef, index));
        const hasError = normalizedIssues.some(issue => issue.severity === 'error');
        const failedWholeStyleSheet = rawReport?.failedWholeStyleSheet === true;
        const loadable = rawReport?.loadable ?? !failedWholeStyleSheet;
        return {
            source: {...sourceRef},
            valid: rawReport?.valid ?? !hasError,
            loadable,
            loadedRuleCount: Math.max(0, Number(rawReport?.loadedRuleCount ?? 0)),
            skippedRuleCount: Math.max(0, Number(rawReport?.skippedRuleCount ?? 0)),
            failedWholeStyleSheet,
            issues: normalizedIssues
        };
    }

    /** Normalizes a raw validation issue. */
    private normalizeValidationIssue(
        issue: Partial<StyleValidationIssue>,
        sourceRef: StyleSourceRef,
        index: number
    ): StyleValidationIssue {
        return {
            id: issue.id || `${sourceRef.sourceHash ?? sourceRef.url ?? 'style'}-${Date.now()}-${index}`,
            at: Number(issue.at ?? Date.now()),
            severity: issue.severity ?? 'error',
            phase: issue.phase ?? 'schema',
            impact: issue.impact ?? 'stylesheet-failed',
            source: {...(issue.source ?? {}), ...sourceRef},
            message: issue.message ?? 'Style validation failed.',
            detail: issue.detail,
            ruleIndex: issue.ruleIndex,
            rulePath: issue.rulePath,
            property: issue.property,
            expression: issue.expression,
            location: issue.location,
            runtimeContext: issue.runtimeContext
        };
    }

    /** Creates an empty successful validation report. */
    private createSuccessReport(
        styleString: string,
        sourceRef: StyleSourceRef,
        styleName?: string
    ): StyleValidationReport {
        return {
            source: {
                ...sourceRef,
                styleName: styleName ?? sourceRef.styleName,
                sourceHash: sourceRef.sourceHash ?? sipHash64Hex(styleString)
            },
            valid: true,
            loadable: true,
            loadedRuleCount: 0,
            skippedRuleCount: 0,
            failedWholeStyleSheet: false,
            issues: []
        };
    }

    /** Creates a validation report for client-side failures. */
    private createClientValidationFailureReport(
        styleString: string,
        sourceRef: StyleSourceRef,
        message: string
    ): StyleValidationReport {
        const source = {
            ...sourceRef,
            sourceHash: sourceRef.sourceHash ?? sipHash64Hex(styleString)
        };
        return {
            source,
            valid: false,
            loadable: false,
            loadedRuleCount: 0,
            skippedRuleCount: 0,
            failedWholeStyleSheet: true,
            issues: [{
                id: `${source.sourceHash ?? 'style'}-${Date.now()}-client-parse`,
                at: Date.now(),
                severity: 'error',
                phase: 'schema',
                impact: 'stylesheet-failed',
                source,
                message
            }]
        };
    }

    /** Creates a validation report for failed style fetches. */
    private createFetchFailureReport(style: StyleConfigEntry, error: unknown): StyleValidationReport {
        const source: StyleSourceRef = {
            configId: style.id,
            url: style.url,
            sourceKind: style.additional === true ? 'additional' : 'base'
        };
        const message = error instanceof Error ? error.message : String(error);
        return {
            source,
            valid: false,
            loadable: false,
            loadedRuleCount: 0,
            skippedRuleCount: 0,
            failedWholeStyleSheet: true,
            issues: [{
                id: `${style.url}-${Date.now()}-fetch`,
                at: Date.now(),
                severity: 'error',
                phase: 'fetch',
                impact: 'stylesheet-failed',
                source,
                message: `Could not fetch style ${style.url}.`,
                detail: message
            }]
        };
    }

    /** Creates a validation source reference for a style URL. */
    private createStyleSourceRef(
        styleString: string,
        styleUrl: string,
        knownStyleId: string | undefined,
        modified: boolean,
        imported: boolean,
        additional: boolean
    ): StyleSourceRef {
        return {
            styleName: knownStyleId,
            url: styleUrl || undefined,
            sourceKind: this.styleSourceKind(modified, imported, additional),
            sourceHash: sipHash64Hex(styleString)
        };
    }

    /** Returns the validation source kind for a style entry. */
    private styleSourceKind(modified: boolean, imported: boolean, additional: boolean): StyleSourceKind {
        if (imported) {
            return 'imported';
        }
        if (modified) {
            return 'modified-builtin';
        }
        if (additional) {
            return 'additional';
        }
        return 'base';
    }

    /** Reloads one builtin style from its configured server URL. */
    reloadStyle(styleId: string) {
        if (this.styles.has(styleId)) {
            this.syncStyleYamlData(styleId);
        }
    }

    /** Reapplies a style by removing and re-adding it to downstream consumers when visible. */
    reapplyStyle(styleId: string) {
        if (!this.styles.has(styleId)) {
            return;
        }
        const style = this.styles.get(styleId)!;
        style.visible = this.stateService.getStyleVisibility(styleId, style.featureLayerStyle.defaultEnabled());
        this.styleGroups.next(this.computeStyleGroups());
        this.styleRemovedForId.next(styleId);
        if (style.visible) {
            this.styleAddedForId.next(styleId);
        }
    }

    /** Populates the tree-node fields PrimeNG expects for one style leaf. */
    private setStylesIdChildren(style: ErdblickStyle) {
        style.key = style.id;
        style.children = [];
        style.expanded = false;
        style.type = "Style";
        for (let option of style.options) {
            style.children.push(option);
        }
        return style;
    }

    /** Rebuilds the grouped styles tree shown in the styles dialog. */
    computeStyleGroups(): (ErdblickStyle|ErdblickStyleGroup)[] {
        const groups = new Map<string, ErdblickStyleGroup>();
        const ungrouped: Array<ErdblickStyle> = [];

        let keyCounter = 0;
        /** Returns the next unique group key for the style tree. */
        const nextKey = () => (keyCounter++).toString();

        /** Returns the style group for a path, creating missing groups as needed. */
        const getOrCreateGroupByPath = (path: string): ErdblickStyleGroup => {
            const segments = path.split('/');
            const top = segments[0];
            let current: ErdblickStyleGroup;
            if (groups.has(top)) {
                current = groups.get(top)!;
            } else {
                current = {
                    key: top,
                    id: top,
                    type: "Group",
                    children: [],
                    visible: false,
                    expanded: true
                };
                groups.set(top, current);
            }
            let acc = top;
            for (let i = 1; i < segments.length; ++i) {
                acc = `${acc}/${segments[i]}`;
                let found: ErdblickStyleGroup | null = null;
                for (const child of current.children) {
                    if ((child as any).type === "Group" && (child as ErdblickStyleGroup).id === acc) {
                        found = child as ErdblickStyleGroup;
                        break;
                    }
                }
                if (!found) {
                    found = {
                        key: acc,
                        id: acc,
                        type: "Group",
                        children: [],
                        visible: false,
                        expanded: true
                    };
                    current.children.push(found);
                }
                current = found;
            }
            return current;
        };

        for (const [styleId, style] of this.styles) {
            if (styleId.includes('/')) {
                const parentPath = styleId.split('/').slice(0, -1).join('/');
                const currentGroup = getOrCreateGroupByPath(parentPath);
                const styleNode = this.setStylesIdChildren(style);
                currentGroup.children.push(styleNode);
            } else {
                ungrouped.push(this.setStylesIdChildren(style));
            }
        }

        // compute derived visibility for groups
        /** Computes aggregate visibility for a style group. */
        const computeGroupVisibility = (group: ErdblickStyleGroup): boolean => {
            let anyVisible = false;
            for (const child of group.children) {
                if ((child as any).type === "Group") {
                    anyVisible = computeGroupVisibility(child as ErdblickStyleGroup) || anyVisible;
                } else {
                    const styleChild = child as ErdblickStyle;
                    anyVisible = styleChild.visible || anyVisible;
                }
            }
            group.visible = anyVisible;
            return anyVisible;
        };

        for (const [_, top] of groups) {
            computeGroupVisibility(top);
        }

        return [...groups.values(), ...ungrouped];
    }

    /** Reapplies several styles by id. */
    reapplyStyles(styleIds: Array<string>) {
        styleIds.forEach(styleId => this.reapplyStyle(styleId));
    }

    /** Reapplies every registered style. */
    reapplyAllStyles() {
        this.reapplyStyles([...this.styles.keys()]);
    }

    /** Toggles one style's visibility and optionally reapplies it immediately. */
    toggleStyle(styleId: string, enabled: boolean|undefined = undefined, delayRepaint: boolean = false) {
        if (!this.styles.has(styleId)) {
            return;
        }
        const style = this.styles.get(styleId)!;
        style.visible = enabled !== undefined ? enabled : !style.visible;
        this.stateService.setStyleVisibility(styleId, style.visible);
        if (delayRepaint) {
            this.reapplyStyle(styleId);
        }
    }

    /** Loads the persisted builtin-style hash map from local storage. */
    private loadStyleHashes(): Map<string, string> {
        const styleHashes = new Map<string, string>();
        const savedStyleHashes = localStorage.getItem('styleHashes');
        if (savedStyleHashes) {
            for (let [styleId, styleHash] of JSON.parse(savedStyleHashes)) {
                styleHashes.set(styleId, styleHash);
            }
        }
        return styleHashes;
    }

    /** Persists the current server-style hashes and clears the "updated" flags. */
    updateStyleHashes() {
        localStorage.removeItem('styleHashes');
        const pairs = Array.from(this.styleHashes, ([styleUrl, status]) => [styleUrl, status.sha256]);
        localStorage.setItem('styleHashes', JSON.stringify(pairs));
        for (const [styleUrl, status] of this.styleHashes.entries()) {
            this.styleHashes.set(styleUrl, {
                id: status.id,
                sha256: status.sha256,
                isModified: status.isModified,
                isUpdated: false
            });
        }
    }

    /** Records the server baseline and lifecycle state for one builtin style. */
    private registerBuiltinServerSource(
        styleUrl: string,
        styleId: string,
        styleSource: string,
        persistedHashes?: Map<string, string>
    ) {
        if (!this.isBuiltinUrl(styleUrl)) {
            return;
        }
        this.builtinStyleBaselines.set(styleUrl, {
            id: styleId,
            source: styleSource
        });
        const styleHash = sipHash64Hex(styleSource);
        const persistedStyleHashes = persistedHashes ?? this.loadStyleHashes();
        const existing = this.styleHashes.get(styleUrl);
        this.styleHashes.set(styleUrl, {
            id: styleId,
            sha256: styleHash,
            isModified: existing?.isModified ?? false,
            isUpdated: styleHash !== persistedStyleHashes.get(styleUrl)
        });
    }

    /** Syncs lifecycle bookkeeping after a builtin style instance was recreated. */
    private synchronizeLifecycleForStyle(style?: ErdblickStyle) {
        if (!style || style.imported || !this.isBuiltinUrl(style.url)) {
            return;
        }
        const existing = this.styleHashes.get(style.url);
        this.styleHashes.set(style.url, {
            id: style.id,
            sha256: existing?.sha256 ?? sipHash64Hex(style.source),
            isModified: style.modified,
            isUpdated: existing?.isUpdated ?? false
        });
    }

    /** Returns whether a URL belongs to the configured builtin-style set. */
    private isBuiltinUrl(styleUrl: string): boolean {
        return this.styleUrls.some(entry => entry.url === styleUrl);
    }

    /** Resolves a builtin style from either its current id or its builtin URL. */
    private resolveBuiltinStyle(styleIdOrUrl: string): ErdblickStyle | undefined {
        const exactStyle = this.styles.get(styleIdOrUrl);
        if (exactStyle && !exactStyle.imported && this.isBuiltinUrl(exactStyle.url)) {
            return exactStyle;
        }
        const matchedByUrl = Array.from(this.styles.values()).find(
            style => !style.imported && style.url === styleIdOrUrl && this.isBuiltinUrl(style.url)
        );
        return matchedByUrl;
    }
}
