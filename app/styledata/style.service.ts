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
import {AppStateService, StyleParameters} from "../shared/appstate.service";

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
    styleId?: string,
    key?: string
};

export interface ErdblickStyle {
    id: string,
    modified: boolean,
    imported: boolean,
    params: StyleParameters,
    source: string,
    featureLayerStyle: FeatureLayerStyle | null,
    options: Array<FeatureStyleOptionWithStringType>,
    key?: string,
    type?: string,
    children?: Array<FeatureStyleOptionWithStringType>,
    expanded?: boolean
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

    styleHashes: Map<string, {sha256: string, isNew: boolean, isChanged: boolean}> = new Map<string, {sha256: string; isNew: boolean, isChanged: boolean}>();
    styles: Map<string, ErdblickStyle> = new Map<string, ErdblickStyle>();
    private erdblickBuiltinStyles: Array<StyleConfigEntry> = [];
    erroredStyleIds: Map<string, string> = new Map<string, string>();

    selectedStyleIdForEditing: string = "";
    styleEditedSaveTriggered: Subject<boolean> = new Subject<boolean>();

    builtinStylesCount = 0;
    importedStylesCount = 0;

    private textEncoder: TextEncoder = new TextEncoder();
    styleRemovedForId: Subject<string> = new Subject<string>();
    styleAddedForId: Subject<string> = new Subject<string>();

    styleGroups: BehaviorSubject<(ErdblickStyleGroup|ErdblickStyle)[]> = new BehaviorSubject<(ErdblickStyleGroup|ErdblickStyle)[]>([]);

    constructor(private httpClient: HttpClient, private parameterService: AppStateService)
    {
        this.parameterService.parameters.subscribe(_ => {
            // This subscription exists specifically to catch the values of the query parameters.
            if (this.parameterService.initialQueryParamsSet) {
                return;
            }
            for (let [styleId, style] of this.styles) {
                style.params = this.parameterService.styleConfig(styleId);
            }
            this.reapplyAllStyles();
        })
    }

    async initializeStyles(): Promise<void> {
        try {
            const data: any = await firstValueFrom(this.httpClient.get("config.json", {responseType: "json"}));
            if (!data || !data.styles) {
                throw new Error("Missing style configuration in config.json.");
            }

            let styleUrls = [...data["styles"]] as [StyleConfigEntry];
            styleUrls.forEach((styleEntry: StyleConfigEntry) => {
                if (!styleEntry.url.startsWith("http") && !styleEntry.url.startsWith("bundle")) {
                    styleEntry.url = `bundle/styles/${styleEntry.url}`;
                }
            });

            const styleHashes = this.loadStyleHashes();
            const dataMap = await this.fetchStylesYamlSources(styleUrls);
            dataMap.forEach((styleString, styleId) => {
                if (!styleString) {
                    this.erroredStyleIds.set(styleId, "Wrong URL / No data");
                    console.error(`Wrong URL or no data available for style: ${styleId}`);
                    return;
                }

                this.styles.set(styleId, {
                    id: styleId,
                    modified: false,
                    imported: false,
                    params: this.parameterService.styleConfig(styleId),
                    source: styleString,
                    featureLayerStyle: null,
                    options: [],
                    key: `${this.styles.size}`,
                    type: "Style",
                    children: []
                });
                this.builtinStylesCount++;
                styleUrls.forEach(styleUrl => {
                    if (styleUrl.id == styleId) this.erdblickBuiltinStyles.push(styleUrl);
                });
                this.compareStyleHashes(this.styles.get(styleId)!, styleHashes);
            });
            this.loadModifiedBuiltinStyles();
        } catch (error) {
            console.error(`Error while initializing styles: ${error}`);
        }
        this.loadImportedStyles();
        this.parameterService.setInitialStyles(this.styles);
    }

    async fetchStylesYamlSources(styles: Array<StyleConfigEntry>) {
        const requests = styles.map((style, index) =>
            this.httpClient.get(style.url, { responseType: 'text' }).pipe(
                map(data => ({ index, data, styleId: style.id })),
                catchError(error => {
                    console.error('Error fetching style', style.id, error);
                    // Return an observable that emits a value, preserving the index and ID, with an empty data string on error.
                    return of({ index, data: "", styleId: style.id });
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
        results.forEach(({ data, styleId }) => {
            orderedMap.set(styleId, data);
        });
        // Return the map with the fetched styles in their original order.
        return orderedMap;
    }

    async syncStyleYamlData(styleId: string) {
        for (const erdblickStyle of this.erdblickBuiltinStyles) {
            if (erdblickStyle.id == styleId) {
                try {
                    const result= await this.fetchStylesYamlSources([erdblickStyle]);
                    if (result !== undefined && result.get(styleId) !== undefined) {
                        const styleString = result.get(styleId)!;
                        if (this.styles.has(styleId)) {
                            this.styles.get(styleId)!.featureLayerStyle?.delete();
                        }
                        this.styles.set(styleId, {
                            id: styleId,
                            modified: false,
                            imported: false,
                            params: this.parameterService.styleConfig(styleId),
                            source: styleString,
                            featureLayerStyle: null,
                            options: [],
                            key: `${this.styles.size}`,
                            type: "Style",
                            children: []
                        });
                        this.saveModifiedBuiltinStyles();
                        this.reapplyStyle(styleId);
                    }
                } catch (error) {
                    console.error('Style retrieval failed:', error);
                }
            }
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
            const blobContent = typeof content.source === 'string' ? content.source : JSON.stringify(content.source);
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

    async importStyleYamlFile(event: any, file: File, styleId: string, fileUploader: FileUpload | undefined): Promise<boolean> {
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

        this.deleteStyle(styleId);
        this.styles.set(styleId, {
            id: styleId,
            modified: false,
            imported: true,
            params: {
                visible: true,
                options: {}
            },
            source: styleData,
            featureLayerStyle: null,
            options: [],
            key: `${this.styles.size}`,
            type: "Style",
            children: []
        });

        ++this.importedStylesCount;
        this.saveImportedStyles();
        this.reapplyStyle(styleId);
        return true;
    }

    deleteStyle(styleId: string) {
        // TODO: check if the style was modified and offer to export it
        // NOTE: Should implement dirty checking to detect unsaved changes and prompt user
        // with export option before deletion to prevent accidental loss of work.
        let style = this.styles.get(styleId);
        if (!style)
            return;
        style.featureLayerStyle?.delete();
        this.styleRemovedForId.next(styleId);
        this.styles.delete(styleId);
        if (style.imported) {
            this.importedStylesCount--;
            this.saveImportedStyles();
        }
        else
            this.saveModifiedBuiltinStyles();
    }

    setStyleSource(styleId: string, styleSource: string) {
        if (!this.styles.has(styleId))
            return;
        const style = this.styles.get(styleId)!;
        style.source = styleSource;
        style.modified = true;
        if (style.imported) {
            this.saveImportedStyles();
        } else {
            this.saveModifiedBuiltinStyles();
        }
        this.reapplyStyle(styleId);
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
            for (let [styleId, style] of JSON.parse(importedStyleData)) {
                style.featureLayerStyle = null;
                this.styles.set(styleId, style);
                this.importedStylesCount++;
            }
        }
    }

    loadModifiedBuiltinStyles() {
        const modifiedBuiltinStyleData = localStorage.getItem('builtinStyleData');
        if (modifiedBuiltinStyleData) {
            for (let [styleId, style] of JSON.parse(modifiedBuiltinStyleData)) {
                if (this.styles.has(styleId)) {
                    style.featureLayerStyle = null;
                    style.params = this.parameterService.styleConfig(styleId);
                    this.styles.set(styleId, style);
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

    initializeWasmStyle(styleId: string) {
        const style = this.styles.get(styleId);
        if (!style)
            return;
        const styleUint8Array = this.textEncoder.encode(style.source);
        const result = uint8ArrayToWasm(
            (wasmBuffer: any) => {
                const featureLayerStyle = new coreLib.FeatureLayerStyle(wasmBuffer);
                if (featureLayerStyle) {
                    style.featureLayerStyle = new coreLib.FeatureLayerStyle(wasmBuffer);
                    style.options = [];
                    // Transport FeatureStyleOptions from WASM array to JS.
                    let options = style.featureLayerStyle.options();
                    for (let i = 0; i < options.size(); ++i) {
                        const option = options.get(i)! as FeatureStyleOptionWithStringType;
                        style.options.push(option);

                        // Apply the default value for the option, if no value is stored yet.
                        if (!style.params.options.hasOwnProperty(option.id)) {
                            style.params.options[option.id] = option.defaultValue;
                        }

                        // From the pre-initialized option value, ensure that it complies
                        // with the expected data type. Also, we need to convert the value
                        // type to a string, so it is understood by prime-ng p-tree.
                        const currentValue = style.params.options[option.id];
                        if (option.type === coreLib.FeatureStyleOptionType.Bool) {
                            option.type = "Bool";
                            style.params.options[option.id] = !!currentValue;
                        }
                    }
                    options.delete();
                    return true;
                }
                return false;
            },
            styleUint8Array);
        if (result === undefined || !result) {
            console.error(`Encountered Uint8Array parsing issue in style "${styleId}" for the following YAML data:\n${style.source}`)
            this.erroredStyleIds.set(styleId, "YAML Parse Error");
        }
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
        let style = this.styles.get(styleId)!;
        this.initializeWasmStyle(styleId);
        this.styleGroups.next(this.computeStyleGroups());
        this.styleRemovedForId.next(styleId);
        if (style.params.visible) {
            this.styleAddedForId.next(styleId);
        }
    }

    private setStylesIdChildren(style: ErdblickStyle) {
        style.key = style.id;
        style.children = [];
        style.expanded = true;
        style.type = "Style";
        for (let option of style.options) {
            option.key = `${style.id}/${option.id}`;
            option.styleId = style.id;
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
                    anyVisible = (styleChild.params.visible || anyVisible);
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
        style.params.visible = enabled !== undefined ? enabled : !style.params.visible;
        if (delayRepaint) {
            this.reapplyStyle(styleId);
        }
        this.parameterService.setStyleConfig(styleId, style.params);
    }

    toggleOption(styleId: string, optionId: string, enabled: boolean) {
        const style = this.styles.get(styleId)!;
        style.params.options[optionId] = enabled;
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
        this.styleSha256(style.source).then(styleHash => {
            this.styleHashes.set(style.id, {
                sha256: styleHash,
                isNew: !styleHashes.has(style.id),
                isChanged: styleHash !== styleHashes.get(style.id)
            });
        });
    }

    updateStyleHashes() {
        localStorage.removeItem('styleHashes');
        const pairs = Array.from(this.styleHashes, ([styleId, status]) => [styleId, status.sha256]);
        localStorage.setItem('styleHashes', JSON.stringify(pairs));
        this.styleHashes.clear();
    }

    private async styleSha256(input: string): Promise<string> {
        if (globalThis.isSecureContext && globalThis.crypto?.subtle) {
            const data = new TextEncoder().encode(input);
            const buffer = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(buffer), b => b.toString(16)
                .padStart(2, '0')).join('');
        } else {
            return "";
        }
    }
}
