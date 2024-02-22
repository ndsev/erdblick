import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {from, mergeMap, map, reduce, firstValueFrom, Subject, BehaviorSubject} from "rxjs";
import {FeatureLayerStyle} from "../../build/libs/core/erdblick-core";

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
    styleData: Map<string, string> = new Map<string, string>();
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
                            this.styleData = new Map([...dataMap.entries(), ...this.styleData.entries()]);
                            this.stylesLoaded.next(true);
                        });
                    }
                },
                error: error => {
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
}