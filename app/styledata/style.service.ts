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

interface StyleConfigEntry {
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
    source: string,
    featureLayerStyle: FeatureLayerStyle,
    options: Array<FeatureStyleOptionWithStringType>,
    shortId: string,
    key?: string,
    type?: string,
    children?: Array<FeatureStyleOptionWithStringType>,
    expanded?: boolean,
    visible: boolean,
    url: string
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
 * Retrieves and stores YAML style plain data
 * Keeps track of activated styles and error messages
 */
@Injectable({providedIn: 'root'})
export class StyleService {

    stylesDialogVisible: boolean = false;

    styleHashes: Map<string, {id: string, sha256: string, isModified: boolean, isUpdated: boolean}> = new Map();
    styleUrls: StyleConfigEntry[] = [];
    styles: Map<string, ErdblickStyle> = new Map<string, ErdblickStyle>();
    erroredStyleIds: Map<string, string> = new Map<string, string>();

    selectedStyleIdForEditing: string = "";
    styleEditedSaveTriggered: Subject<boolean> = new Subject<boolean>();

    builtinStylesCount = 0;
    importedStylesCount = 0;

    private textEncoder: TextEncoder = new TextEncoder();
    styleRemovedForId: Subject<string> = new Subject<string>();
    styleAddedForId: Subject<string> = new Subject<string>();

    styleGroups: BehaviorSubject<(ErdblickStyleGroup|ErdblickStyle)[]> = new BehaviorSubject<(ErdblickStyleGroup|ErdblickStyle)[]>([]);

    constructor(
        private httpClient: HttpClient,
        private stateService: AppStateService,
        private infoMessageService: InfoMessageService
    ) {
        this.stateService.ready.pipe(filter(state => state)).subscribe((state) => {
            this.reapplyAllStyles();
        });
    }

    async initializeStyles(): Promise<void> {
        try {
            const data: any = await firstValueFrom(this.httpClient.get("config.json", {responseType: "json"}));
            if (!data || !data.styles) {
                throw new Error("Missing style configuration in config.json.");
            }

            this.styleUrls = [...data["styles"]] as [StyleConfigEntry];
            this.styleUrls.forEach((styleEntry: StyleConfigEntry) => {
                if (!styleEntry.url.startsWith("http") && !styleEntry.url.startsWith("bundle")) {
                    styleEntry.url = `bundle/styles/${styleEntry.url}`;
                }
            });

            const styleHashes = this.loadStyleHashes();
            const dataMap = await this.fetchStylesYamlSources(this.styleUrls);
            for (const [styleUrl, styleString] of dataMap) {
                const styleId = this.initializeStyle(styleString, styleUrl);
                if (!styleId) {
                    continue;
                }
                this.builtinStylesCount++;
                this.compareStyleHashes(this.styles.get(styleId)!, styleHashes);
            }
            this.loadModifiedBuiltinStyles();
        } catch (error) {
            console.error(`Error while initializing styles: ${error}`);
        }
        this.loadImportedStyles();

        if (this.styles.size) {
            this.reapplyStyles([...this.styles.keys()]);
        }
    }

    private initializeStyle(styleString: string, styleUrl: string, knownStyleId?: string, modified: boolean = false, imported: boolean = false) {
        if (!styleString) {
            this.erroredStyleIds.set(
                knownStyleId ?? "mising-style-id",
                `Got empty style source for ${styleUrl.length ? styleUrl : (knownStyleId ?? 'missing-style-identifier')}.`);
            return undefined;
        }

        const parsedStyleAndOptions = this.parseWasmStyle(styleString);
        if (!parsedStyleAndOptions) {
            return undefined;
        }

        const [wasmStyle, options] = parsedStyleAndOptions;
        const styleId = wasmStyle.name();
        const existingStyle = this.styles.get(styleId);

        // Delete any existing style stored under the style's (potentially new) name.
        // This is an error in case we are renaming through the style editor,
        // in this case knownStyleId is set.
        if (existingStyle) {
            if (knownStyleId && styleId !== knownStyleId) {
                this.infoMessageService.showError(`Illegal attempt to rename ${knownStyleId} to ${styleId}, which already exists.`)
                return undefined;
            }
            this.deleteStyle(existingStyle.id);
        }

        // Delete the previous version of the style, regardless of whether it was renamed or not,
        // as it will be re-created below.
        if (knownStyleId && this.styles.has(knownStyleId)) {
            this.deleteStyle(knownStyleId);
        }

        const isVisible = this.stateService.getStyleVisibility(knownStyleId ?? styleId, wasmStyle.defaultEnabled());
        this.styles.set(styleId, {
            id: styleId,
            modified: modified,
            imported: imported,
            source: styleString,
            featureLayerStyle: wasmStyle,
            options: options,
            shortId: shortId4(styleId),
            key: `${this.styles.size}`,
            type: "Style",
            children: [],
            visible: isVisible,
            url: styleUrl
        });

        // Ensure that if the style was renamed, its visibility is retained.
        this.stateService.setStyleVisibility(styleId, isVisible);

        return styleId;
    }

    async fetchStylesYamlSources(styles: Array<StyleConfigEntry>) {
        const requests = styles.map((style, index) =>
            this.httpClient.get(style.url, { responseType: 'text' }).pipe(
                map(data => ({ index, data, styleUrl: style.url })),
                catchError(error => {
                    console.error('Error fetching style', style.url, error);
                    // Return an observable that emits a value, preserving the index and ID, with an empty data string on error.
                    return of({ index, data: "", styleUrl: style.url });
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
            orderedMap.set(styleUrl, data);
        });
        // Return the map with the fetched styles in their original order.
        return orderedMap;
    }

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
            if (!result.has(styleId)) {
                return;
            }
            const styleString = result.get(styleId)!;
            const newStyleId = this.initializeStyle(styleString, style.url, styleId);
            if (!newStyleId) {
                return;
            }
            this.reapplyStyle(newStyleId);
        } catch (error) {
            console.error('Style retrieval failed:', error);
        }
    }

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

        const styleId = this.initializeStyle(styleData, "", "", false, true);
        if (!styleId) {
            return false;
        }
        ++this.importedStylesCount;
        this.saveImportedStyles();
        this.reapplyStyle(styleId);
        return true;
    }

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
                        const restoredId = this.initializeStyle(source, builtinUrl!, styleId, false, false);
                        if (restoredId) {
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

    setStyleSource(styleId: string, styleSource: string, modified: boolean = true): string|undefined {
        if (!this.styles.has(styleId)) {
            return styleId;
        }
        const style = this.styles.get(styleId)!;
        const newStyleId = this.initializeStyle(styleSource, style.url ?? '', styleId, modified, style.imported);
        if (!newStyleId) {
            return undefined;
        }

        if (style.imported) {
            this.saveImportedStyles();
        } else {
            this.saveModifiedBuiltinStyles();
        }
        this.reapplyStyle(newStyleId);
        return newStyleId;
    }

    saveModifiedBuiltinStyles() {
        // Omit the 'parent' field which is injected by prime-ng,
        // so we do not get cyclic object errors.
        localStorage.setItem('builtinStyleData', JSON.stringify(
            [...this.styles].filter(([_, value]) => !value.imported && value.modified),
            (key, value) => key === 'parent' ? undefined : value
        ));
    }

    saveImportedStyles() {
        // Omit the 'parent' field which is injected by prime-ng,
        // so we do not get cyclic object errors.
        localStorage.setItem('importedStyleData', JSON.stringify(
            [...this.styles].filter(([_, value]) => value.imported),
            (key, value) => key === 'parent' ? undefined : value
        ));
    }

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

    loadModifiedBuiltinStyles() {
        const modifiedBuiltinStyleData = localStorage.getItem('builtinStyleData');
        if (modifiedBuiltinStyleData) {
            for (let [styleId, style] of JSON.parse(modifiedBuiltinStyleData)) {
                // A modified style will only be applied if there is a matching builtin style by the URL.
                const matchingBuiltinStyle = this.styles.values().filter(style => style.url === style.url).toArray();
                if (!matchingBuiltinStyle.length) {
                    continue;
                }
                if (!this.initializeStyle(style.source, style.url, matchingBuiltinStyle[0].id, true, style.imported)) {
                    continue;
                }
                const hash = this.styleHashes.get(style.url);
                if (hash) {
                    this.styleHashes.set(style.url, {
                        id: style.id,
                        sha256: hash.sha256,
                        isModified: true,
                        isUpdated: hash.isUpdated
                    });
                }
            }
        }
    }

    clearStorageForImportedStyles() {
        localStorage.removeItem('importedStyleData');
    }

    clearStorageForBuiltinStyles() {
        localStorage.removeItem('builtinStyleData');
    }

    parseWasmStyle(styleString: string) {
        const styleUint8Array = this.textEncoder.encode(styleString);
        const yamlStyleNameRegex = /^\s*name\s*:\s*(?:(["'])(.*?)\1|([^\r\n#]+))/m;
        const yamlStyleNameMatch = styleString.match(yamlStyleNameRegex);
        const yamlStyleName = yamlStyleNameMatch ? (yamlStyleNameMatch[2] ?? yamlStyleNameMatch[3]).trim() : "failed-to-parse-name-from-yaml";

        const result = uint8ArrayToWasm(
            (wasmBuffer: any) => {
                const featureLayerStyle = new coreLib.FeatureLayerStyle(wasmBuffer);
                if (featureLayerStyle) {
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
                    return [featureLayerStyle, options];
                }
                return undefined;
            },
            styleUint8Array);

        if (result) {
            return result as [FeatureLayerStyle, FeatureStyleOptionWithStringType[]]
        }

        console.error(`Encountered Uint8Array parsing issue in style "${yamlStyleName}" for the following YAML data:\n${styleString}`)
        this.erroredStyleIds.set(yamlStyleName, "YAML Parse Error");
        return undefined;
    }

    reloadStyle(styleId: string) {
        if (this.styles.has(styleId)) {
            this.syncStyleYamlData(styleId);
        }
    }

    reapplyStyle(styleId: string) {
        if (!this.styles.has(styleId)) {
            return;
        }
        const style = this.styles.get(styleId)!;
        this.styleGroups.next(this.computeStyleGroups());
        this.styleRemovedForId.next(styleId);
        if (style.visible) {
            this.styleAddedForId.next(styleId);
        }
    }

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

    computeStyleGroups(): (ErdblickStyle|ErdblickStyleGroup)[] {
        const groups = new Map<string, ErdblickStyleGroup>();
        const ungrouped: Array<ErdblickStyle> = [];

        let keyCounter = 0;
        const nextKey = () => (keyCounter++).toString();

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

    reapplyStyles(styleIds: Array<string>) {
        styleIds.forEach(styleId => this.reapplyStyle(styleId));
    }

    reapplyAllStyles() {
        this.reapplyStyles([...this.styles.keys()]);
    }

    toggleStyle(styleId: string, enabled: boolean|undefined = undefined, delayRepaint: boolean = false) {
        if (!this.styles.has(styleId)) {
            return;
        }
        const style = this.styles.get(styleId)!;
        style.visible = enabled !== undefined ? enabled : !style.visible;
        if (delayRepaint) {
            this.reapplyStyle(styleId);
        }
        this.stateService.setStyleVisibility(styleId, style.visible);
    }

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

    private compareStyleHashes(style: ErdblickStyle, styleHashes: Map<string, string>) {
        const styleHash = sipHash64Hex(style.source);
        this.styleHashes.set(style.url, {
            id: style.id,
            sha256: styleHash,
            isModified: false,
            isUpdated: styleHash !== styleHashes.get(style.url)
        });
    }

    updateStyleHashes() {
        localStorage.removeItem('styleHashes');
        const pairs = Array.from(this.styleHashes, ([styleUrl, status]) => [styleUrl, status.sha256]);
        localStorage.setItem('styleHashes', JSON.stringify(pairs));
        this.styleHashes.clear();
    }
}
