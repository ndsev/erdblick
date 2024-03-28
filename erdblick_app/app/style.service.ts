import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {
    of,
    forkJoin,
    map,
    firstValueFrom,
    BehaviorSubject,
    Observable,
    Subscriber,
    catchError, Subject
} from "rxjs";
import {FileUpload} from "primeng/fileupload";
import {FeatureLayerStyle} from "../../build/libs/core/erdblick-core";
import {uint8ArrayToWasm} from "./wasm";
import {CoreService} from "./core.service";
import {ParametersService} from "./parameters.service";
import {MapService} from "./map.service";
import {TileVisualization} from "./visualization.model";

interface ErdblickStyleEntry {
    id: string,
    url: string
}

export interface ErdblickStyle {
    id: string,
    modified: boolean,
    imported: boolean,
    enabled: boolean,
    data: string,
    featureLayerStyle: FeatureLayerStyle | null
}

/**
 * Retrieves and stores YAML style plain data
 * Keeps track of activated styles and error messages
 */
@Injectable({providedIn: 'root'})
export class StyleService {

    availableStylesActivations: Map<string, boolean> = new Map<string, boolean>();
    styleData: Map<string, ErdblickStyle> = new Map<string, ErdblickStyle>();
    private erdblickBuiltinStyles: Array<ErdblickStyleEntry> = [];
    erroredStyleIds: Map<string, string> = new Map<string, string>();

    selectedStyleIdForEditing: BehaviorSubject<string> = new BehaviorSubject<string>("");
    styleBeingEdited: boolean = false;
    styleEditedStateData: BehaviorSubject<string> = new BehaviorSubject<string>("");
    styleEditedSaveTriggered: Subject<boolean> = new Subject<boolean>();

    builtinStylesCount = 0;
    importedStylesCount = 0;

    private textEncoder: TextEncoder = new TextEncoder();
    styleRemovedForId: Subject<string> = new Subject<string>();
    styleAddedForId: Subject<string> = new Subject<string>();

    constructor(private httpClient: HttpClient,
                public coreService: CoreService) {
    }

    async initialiseStyles(): Promise<void> {
        try {
            const data: any = await firstValueFrom(this.httpClient.get("/config.json", {responseType: "json"}));
            if (data && data["styles"]) {
                let styleUrls = [...data["styles"]] as [ErdblickStyleEntry];
                styleUrls.forEach((styleUrl: ErdblickStyleEntry) => {
                    if (!styleUrl.url.startsWith("http") && !styleUrl.url.startsWith("/bundle")) {
                        styleUrl.url = `/bundle/styles/${styleUrl.url}`;
                    }
                });
                const dataMap = await this.fetchStylesYamlSources(styleUrls);
                if (dataMap.size > 0) {
                    dataMap.forEach((styleString, styleId) => {
                        if (styleString) {
                            this.styleData.set(styleId, {
                                id: styleId,
                                modified: false,
                                imported: false,
                                enabled: true,
                                data: styleString,
                                featureLayerStyle: null
                            });
                            this.availableStylesActivations.set(styleId, true);
                            this.builtinStylesCount++;
                            styleUrls.forEach(styleUrl => {
                                if (styleUrl.id == styleId) this.erdblickBuiltinStyles.push(styleUrl);
                            });
                        } else {
                            this.erroredStyleIds.set(styleId, "Wrong URL / No data");
                            console.error(`Wrong URL or no data available for style: ${styleId}`);
                        }
                    });
                    this.retrieveModifiedBuiltinStyles();
                }
                this.retrieveImportedStyles();
            } else {
                this.retrieveImportedStyles();
            }
        } catch (error) {
            this.retrieveImportedStyles();
            console.error(error);
        }
    }

    async fetchStylesYamlSources(styles: Array<ErdblickStyleEntry>) {
        const requests = styles.map((style, index) =>
            this.httpClient.get(style.url, { responseType: 'text' })
                .pipe(
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
                        let enabled = true;
                        if (this.availableStylesActivations.has(styleId)) {
                            enabled = this.availableStylesActivations.get(styleId)!;
                        }
                        this.styleData.set(styleId, {
                            id: styleId,
                            modified: false,
                            imported: false,
                            enabled: enabled,
                            data: styleString,
                            featureLayerStyle: null
                        });
                        this.saveModifiedBuiltinStyles();
                    }
                } catch (error) {
                    console.error('Style retrieval failed:', error);
                }
            }
        }
    }

    exportStyleYamlFile(styleId: string) {
        const content = this.styleData.get(styleId)!;
        if (content === undefined) {
            return false;
        }
        try {
            // Create a blob from the content
            const blob = new Blob([content.data], { type: 'text/plain;charset=utf-8' });
            // Create a URL for the blob
            const url = window.URL.createObjectURL(blob);

            // Create a temporary anchor tag to trigger the download
            const a = document.createElement('a');
            a.href = url;
            a.download = `${styleId}.yaml`;

            // Append the anchor to the body, trigger the download, and remove the anchor
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Revoke the blob URL to free up resources
            window.URL.revokeObjectURL(url);
        } catch (e) {
            console.log(e);
            return false;
        }

        return true;
    }

    importStyleYamlFile(event: any, file: File, styleId: string, fileUploader: FileUpload | undefined) {
        const fileReader = new FileReader();
        fileReader.readAsText(file);
        // Prevent the default upload behavior
        // Dummy XHR, as we handle the file ourselves
        event.xhr = new XMLHttpRequest();

        return new Observable((observer: Subscriber<boolean>): void => {
            fileReader.onload = (e) => {
                const uploadedContent = fileReader.result;
                if (fileUploader !== undefined) {
                    fileUploader.clear();
                }
                if (uploadedContent) {
                    let styleData: string = "";
                    if (uploadedContent instanceof ArrayBuffer) {
                        const decoder = new TextDecoder('utf-8');
                        styleData = decoder.decode(uploadedContent);
                    } else {
                        styleData = uploadedContent;
                    }
                    this.availableStylesActivations.set(styleId, true);
                    this.styleData.set(styleId, {
                        id: styleId,
                        modified: false,
                        imported: true,
                        enabled: true,
                        data: styleData,
                        featureLayerStyle: null
                    });
                    this.saveImportedStyles();
                    observer.next(true);
                } else {
                    observer.next(false);
                }
                observer.complete();
            };

            fileReader.onerror = (error): void => {
                observer.error(error);
            }
        });
    }

    removeImportedStyle(styleId: string) {
        // TODO: check if the style was modified and offer to export it
        this.availableStylesActivations.delete(styleId);
        this.styleData.delete(styleId);
        this.cycleImportedStyle(styleId, true);
        this.saveImportedStyles();
    }

    updateStyle(styleId: string, styleData: string) {
        if (this.styleData.has(styleId)) {
            const style = this.styleData.get(styleId)!;
            style.data = styleData;
            style.modified = true;
            this.styleData.set(styleId, style);
            if (style.imported) {
                this.saveImportedStyles();
            } else {
                this.saveModifiedBuiltinStyles();
            }
        }
    }

    saveModifiedBuiltinStyles() {
        localStorage.setItem('builtinStyleData', JSON.stringify(
            [...this.styleData].filter(([key, value]) => !value.imported && value.modified)
        ));
    }

    saveImportedStyles() {
        localStorage.setItem('activatedImportedStyles', JSON.stringify(
            [...this.availableStylesActivations].filter(([key, value]) => {
                const imported = this.styleData.get(key)?.imported;
                return imported !== undefined && imported;
            })
        ));
        localStorage.setItem('importedStyleData', JSON.stringify(
            [...this.styleData].filter(([key, value]) => value.imported)
        ));
    }

    retrieveImportedStyles() {
        const activatedImportedStyles = localStorage.getItem('activatedImportedStyles');
        const importedStyleData = localStorage.getItem('importedStyleData');
        if (activatedImportedStyles && importedStyleData) {
            new Map<string, boolean>(JSON.parse(activatedImportedStyles)).forEach((isActivated, styleId) => {
                this.availableStylesActivations.set(styleId, isActivated);
            });
            new Map<string, Object>(JSON.parse(importedStyleData)).forEach((style, styleId) => {
                const erdblickStyle = style as ErdblickStyle;
                erdblickStyle.featureLayerStyle = null;
                this.styleData.set(styleId, erdblickStyle);
                this.importedStylesCount++;
            });
        }
    }

    retrieveModifiedBuiltinStyles() {
        const modifiedBuiltinStyleData = localStorage.getItem('builtinStyleData');
        if (modifiedBuiltinStyleData) {
            new Map<string, Object>(JSON.parse(modifiedBuiltinStyleData)).forEach((style, styleId) => {
                if (this.styleData.has(styleId)) {
                    const erdblickStyle = style as ErdblickStyle;
                    erdblickStyle.featureLayerStyle = null;
                    this.styleData.set(styleId, erdblickStyle);
                }
            });
        }
    }

    clearStorageForImportedStyles() {
        localStorage.removeItem('activatedImportedStyles');
        localStorage.removeItem('importedStyleData');
    }

    clearStorageForBuiltinStyles() {
        localStorage.removeItem('builtinStyleData');
    }

    loadStyles() {
        if (this.styleData) {
            this.styleData.forEach((style: ErdblickStyle, _) => {
                style.featureLayerStyle?.delete();
            });
        }

        // const parameters = this.parametersService.parameters.getValue();
        // if (parameters) {
        //     [...this.availableStylesActivations.keys()].forEach(styleId =>
        //         this.availableStylesActivations.set(styleId, parameters.styles.includes(styleId)));
        // }

        this.styleData.forEach((style: ErdblickStyle, styleId: string) => {
            this.loadErdblickStyleData(styleId);
        });

        console.log("Loaded styles.");
    }

    loadErdblickStyleData(styleId: string) {
        const style = this.styleData.get(styleId);
        if (style !== undefined) {
            const styleUint8Array = this.textEncoder.encode(style.data);
            const result = uint8ArrayToWasm(this.coreService.coreLib,
                (wasmBuffer: any) => {
                    const featureLayerStyle = new this.coreService.coreLib!.FeatureLayerStyle(wasmBuffer);
                    if (featureLayerStyle) {
                        style.featureLayerStyle = new this.coreService.coreLib!.FeatureLayerStyle(wasmBuffer);
                        this.styleData.set(styleId, style);
                        return true;
                    }
                    return false;
                },
                styleUint8Array);
            if (result === undefined || !result) {
                console.error(`Encountered Uint8Array parsing issue in style "${styleId}" for the following YAML data:\n${style.data}`)
                this.erroredStyleIds.set(styleId, "YAML Parse Error");
            }
        }
    }

    reloadStyle(styleId: string) {
        if (this.styleData.has(styleId)) {
            this.syncStyleYamlData(styleId).then(_ => {
                this.styleData.get(styleId)!.featureLayerStyle?.delete();
                this.loadErdblickStyleData(styleId);
                this.styleRemovedForId.next(styleId);
                this.styleAddedForId.next(styleId);
            });
            console.log(`Reloaded style: ${styleId}.`);
        }
    }

    cycleImportedStyle(styleId: string, remove= false) {
        if (remove && !this.styleData.has(styleId)) {
            console.log(`No style data for: ${styleId}.`);
            return;
        }
        const style = this.styleData.get(styleId);
        if (style === undefined) {
            console.log(`Could not retrieve style for: ${styleId}.`);
            return;
        }
        if (remove) {
            style.featureLayerStyle?.delete();
            this.availableStylesActivations.delete(styleId);
            this.styleData.delete(styleId);
            this.styleRemovedForId.next(styleId);
            this.importedStylesCount--;
        } else {
            this.loadErdblickStyleData(styleId);
            this.styleAddedForId.next(styleId);
            this.importedStylesCount++;
        }
        console.log(`Cycled imported style: ${styleId}. ${remove ? 'Removed' : 'Added' }.`);
    }

    private reapplyStyle(styleId: string, imported: boolean = false) {
        const isActivated = this.availableStylesActivations.get(styleId);
        if (isActivated === undefined) {
            return;
        }
        if (!this.styleData.has(styleId)) {
            return;
        }
        this.loadErdblickStyleData(styleId);
        this.styleData.get(styleId)!.enabled = isActivated;
        this.styleRemovedForId.next(styleId);
        if (isActivated) {
            const style = this.styleData.get(styleId)!;
            this.styleAddedForId.next(styleId);
        }
        console.log(`${isActivated ? 'Activated' : 'Deactivated'} style: ${styleId}.`);
    }

    reapplyStyles(styleIds: Array<string>) {
        styleIds.forEach(styleId => this.reapplyStyle(styleId));
    }

    reapplyAllStyles() {
        this.reapplyStyles([...this.availableStylesActivations.keys()]);
    }

    *allStyles(): Generator<[string, ErdblickStyle], void, unknown> {
        for (let styleIdAndData of this.styleData)
            yield styleIdAndData;
    }
}