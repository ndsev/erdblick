import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {
    of,
    from,
    map,
    mergeMap,
    reduce,
    firstValueFrom,
    BehaviorSubject,
    Observable,
    Subscriber,
    catchError
} from "rxjs";
import {FileUpload} from "primeng/fileupload";
import {FeatureLayerStyle} from "../../build/libs/core/erdblick-core";

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

export const defaultStyle: ErdblickStyleEntry = {
    id: "Default Style",
    url: "/bundle/styles/default-style.yaml"
};

/**
 * Retrieves and stores YAML style plain data
 * Keeps track of activated styles and error messages
 */
@Injectable({providedIn: 'root'})
export class StyleService {

    availableStylesActivations: Map<string, boolean> = new Map<string, boolean>();
    styleData: Map<string, ErdblickStyle> = new Map<string, ErdblickStyle>();
    stylesLoaded: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
    private erdblickBuiltinStyles: Array<ErdblickStyleEntry> = [];
    erroredStyleIds: Map<string, string> = new Map<string, string>();

    selectedStyleIdForEditing: BehaviorSubject<string> = new BehaviorSubject<string>("");
    styleBeingEdited: boolean = false;
    styleEditedStateData: BehaviorSubject<string> = new BehaviorSubject<string>("");

    builtinStylesCount = 0;
    importedStylesCount = 0;

    constructor(private httpClient: HttpClient) {
        this.stylesLoaded.next(false);
        this.fetchStylesYamlSources([defaultStyle]).then(dataMap => {
            this.styleData.set(defaultStyle.id, {
                id: defaultStyle.id,
                modified: false,
                imported: false,
                enabled: true,
                data: dataMap.get(defaultStyle.id)!,
                featureLayerStyle: null
            });
            this.availableStylesActivations.set(defaultStyle.id, true);
            this.erdblickBuiltinStyles = [defaultStyle];
            this.builtinStylesCount++;
            let styleUrls: Array<ErdblickStyleEntry> = [];
            httpClient.get("/config.json", {responseType: "json"}).subscribe({
                next: (data: any) => {
                    if (data && data["styles"]) {
                        styleUrls = [...data["styles"]];
                        styleUrls.forEach((styleUrl: ErdblickStyleEntry) => {
                            if (!styleUrl.url.startsWith("http") && !styleUrl.url.startsWith("/bundle")) {
                                styleUrl.url = `/bundle/styles/${styleUrl.url}`;
                            }
                        });
                        this.fetchStylesYamlSources(styleUrls).then(dataMap => {
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
                            this.stylesLoaded.next(true);
                        });
                    } else {
                        this.retrieveImportedStyles();
                        this.stylesLoaded.next(true);
                    }
                },
                error: error => {
                    this.retrieveImportedStyles();
                    this.stylesLoaded.next(true);
                    console.log(error);
                }
            });
        });
    }

    fetchStylesYamlSources(styles: Array<ErdblickStyleEntry>) {
        return firstValueFrom(from(styles).pipe(
            mergeMap(style =>
                this.httpClient.get(style.url, {responseType: 'text'})
                    .pipe(
                        map(data => ({style, data})),
                        catchError(error => {
                            console.error('Error fetching style', style.id, error);
                            return of({style, data: ""});
                        })
                    )
            ),
            reduce((acc, {style, data}) => {
                acc.set(style.id, data);
                return acc;
            }, new Map<string, string>())
        ));
    }

    async syncStyleYamlData(styleId: string) {
        for (const erdblickStyle of this.erdblickBuiltinStyles) {
            if (erdblickStyle.id == styleId) {
                try {
                    const result= await this.fetchStylesYamlSources([erdblickStyle]);
                    if (result !== undefined && result.get(styleId) !== undefined) {
                        const styleString = result.get(styleId)!;
                        this.styleData.set(styleId, {
                            id: styleId,
                            modified: false,
                            imported: false,
                            enabled: true,
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
}