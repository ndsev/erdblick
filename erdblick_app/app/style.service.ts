import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {from, mergeMap, map, reduce, firstValueFrom, Subject, BehaviorSubject, Observable, Subscriber} from "rxjs";
import {FeatureLayerStyle} from "../../build/libs/core/erdblick-core";
import {ParametersService} from "./parameters.service";
import {FileUpload} from "primeng/fileupload";

export interface ErdblickStyle {
    id: string,
    url: string
}

export type ErdblickStyleData = {
    enabled: boolean,
    featureLayerStyle: FeatureLayerStyle
}

const defaultStyle: ErdblickStyle = {
    id: "Default Style",
    url: "/bundle/styles/default-style.yaml"
};

@Injectable({providedIn: 'root'})
export class StyleService {

    activatedStyles: Map<string, boolean> = new Map<string, boolean>();
    activatedImportedStyles: Map<string, boolean> = new Map<string, boolean>();
    styleData: Map<string, string> = new Map<string, string>();
    importedStyleData: Map<string, string> = new Map<string, string>();
    stylesLoaded: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
    private erdblickStyles: Array<ErdblickStyle> = [];

    constructor(private httpClient: HttpClient) {
        this.stylesLoaded.next(false);
        this.activatedStyles.set(defaultStyle.id, true);
        this.retrieveStyles([defaultStyle]).then(dataMap => {
            this.styleData = dataMap;
            let styleUrls: Array<ErdblickStyle> = [];
            httpClient.get("/config.json", {responseType: "json"}).subscribe({
                next: (data: any) => {
                    if (data && data["styles"]) {
                        styleUrls = [...styleUrls, ...data["styles"]];
                        styleUrls.forEach((styleUrl: ErdblickStyle) => {
                            if (!styleUrl.url.startsWith("http") && !styleUrl.url.startsWith("/bundle")) {
                                styleUrl.url = `/bundle/styles/${styleUrl.url}`;
                            }
                            this.activatedStyles.set(styleUrl.id, true);
                        });
                        this.erdblickStyles = styleUrls;
                        this.retrieveStyles(styleUrls).then(dataMap => {
                            if (dataMap.size > 0) {
                                this.styleData = new Map([...dataMap.entries(), ...this.styleData.entries()]);
                                this.activatedStyles.set(defaultStyle.id, false);
                            }
                            this.retrieveImportedStyles();
                            this.stylesLoaded.next(true);
                        });
                    }
                },
                error: error => {
                    this.stylesLoaded.next(true);
                    console.log(error);
                }
            });
        });
    }

    retrieveStyles(styles: Array<ErdblickStyle>) {
        return firstValueFrom(from(styles).pipe(
            mergeMap(style =>
                this.httpClient.get(style.url, {responseType: 'text'})
                    .pipe(map(data => ({style, data})))
            ),
            reduce((acc, {style, data}) => {
                acc.set(style.id, data);
                return acc;
            }, new Map<string, string>())
        ));
    }

    async syncStyle(styleId: string) {
        for (const erdblickStyle of this.erdblickStyles) {
            if (erdblickStyle.id == styleId) {
                try {
                    const result= await this.retrieveStyles([erdblickStyle]);
                    if (result !== undefined && result.get(styleId) !== undefined) {
                        const styleData = result.get(styleId)!;
                        this.styleData.set(styleId, styleData);
                    }
                } catch (error) {
                    console.error('Style retrieval failed:', error);
                }
            }
        }
    }

    exportStyle(styleId: string, imported: boolean = false) {
        const content = imported ? this.importedStyleData.get(styleId) : this.styleData.get(styleId);
        if (content === undefined) {
            return false;
        }
        try {
            // Create a blob from the content
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
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

    importStyle(event: any, file: File, styleId: string, fileUploader: FileUpload | undefined) {
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
                    this.activatedImportedStyles.set(styleId, true);
                    this.importedStyleData.set(styleId, styleData);
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
        this.activatedImportedStyles.delete(styleId);
        this.importedStyleData.delete(styleId);
        this.saveImportedStyles();
    }

    saveImportedStyles() {
        localStorage.setItem('activatedImportedStyles', JSON.stringify(
            Array.from(this.activatedImportedStyles.entries()))
        );
        localStorage.setItem('importedStyleData', JSON.stringify(
            Array.from(this.importedStyleData.entries()))
        );
    }

    retrieveImportedStyles() {
        const activatedImportedStyles = localStorage.getItem('activatedImportedStyles');
        const importedStyleData = localStorage.getItem('importedStyleData');
        if (activatedImportedStyles && importedStyleData) {
            this.activatedImportedStyles = new Map(JSON.parse(activatedImportedStyles));
            this.importedStyleData = new Map(JSON.parse(importedStyleData));
        }
    }
}