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
import {coreLib, uint8ArrayToWasm} from "./wasm";
import {ParametersService, StyleParameters} from "./parameters.service";

interface StyleConfigEntry {
    id: string,
    url: string
}

export type FeatureStyleOptionWithStringType = {
    label: string,
    id: string,
    type: FeatureStyleOptionType,
    defaultValue: any,
    description: string
};

export interface ErdblickStyle {
    id: string,
    modified: boolean,
    imported: boolean,
    params: StyleParameters,
    source: string,
    featureLayerStyle: FeatureLayerStyle | null,
    options: Array<FeatureStyleOptionWithStringType>
}

/**
 * Retrieves and stores YAML style plain data
 * Keeps track of activated styles and error messages
 */
@Injectable({providedIn: 'root'})
export class StyleService {

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

    constructor(private httpClient: HttpClient, private parameterService: ParametersService)
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
            const data: any = await firstValueFrom(this.httpClient.get("/config.json", {responseType: "json"}));
            if (!data || !data.styles) {
                throw new Error("Missing style configuration in config.json.");
            }

            let styleUrls = [...data["styles"]] as [StyleConfigEntry];
            styleUrls.forEach((styleEntry: StyleConfigEntry) => {
                if (!styleEntry.url.startsWith("http") && !styleEntry.url.startsWith("bundle")) {
                    styleEntry.url = `bundle/styles/${styleEntry.url}`;
                }
            });

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
                    options: []
                });
                this.builtinStylesCount++;
                styleUrls.forEach(styleUrl => {
                    if (styleUrl.id == styleId) this.erdblickBuiltinStyles.push(styleUrl);
                });
            });
            this.loadModifiedBuiltinStyles();
        } catch (error) {
            console.error(`Error while initializing styles: ${error}`);
        }
        this.loadImportedStyles();
        this.parameterService.setInitialStyles(Object.fromEntries([...this.styles.entries()].map(([k, v]) => [k, v.params])));
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
                            options: []
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
                options: {},
                showOptions: true
            },
            source: styleData,
            featureLayerStyle: null,
            options: []
        });

        ++this.importedStylesCount;
        this.saveImportedStyles();
        this.reapplyStyle(styleId);
        return true;
    }

    deleteStyle(styleId: string) {
        // TODO: check if the style was modified and offer to export it
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
        localStorage.setItem('builtinStyleData', JSON.stringify(
            [...this.styles].filter(([_, value]) => !value.imported && value.modified)
        ));
    }

    saveImportedStyles() {
        localStorage.setItem('importedStyleData', JSON.stringify(
            [...this.styles].filter(([_, value]) => value.imported)
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
        this.styleRemovedForId.next(styleId);
        if (style.params.visible) {
            this.styleAddedForId.next(styleId);
        }
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
}
