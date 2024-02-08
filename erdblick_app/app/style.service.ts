import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {parse, stringify} from 'yaml';
import {from, mergeMap, map, reduce} from "rxjs";

export interface ErdblickStyle {
    name: string,
    url: string
}

export interface ErdblickStyleData {
    name: string,
    version: string,
    rules: Array<any>
}

const defaultStyleUrl = "/bundle/styles/default-style.yaml";
const combinedStyleUrl = "/bundle/styles/combined-style.yaml";

@Injectable({providedIn: 'root'})
export class StyleService {

    // availableStyles: Map<ErdblickStyle, boolean> = new Map<ErdblickStyle, boolean>();
    activatedStyles: Map<string, boolean> = new Map<string, boolean>();
    private styleData: Map<string, any> = new Map<string, any>();

    constructor(private httpClient: HttpClient) {
        httpClient.get("/config.json", {responseType: "json"}).subscribe({
            next: (data: any) => {
                let styleUrls: Array<ErdblickStyle> = data["styles"];
                console.log(styleUrls);
                styleUrls.forEach((styleUrl: ErdblickStyle) => {
                    if (!styleUrl.url.startsWith("http") && !styleUrl.url.startsWith("/bundle")) {
                        styleUrl.url = `/bundle/styles/${styleUrl.url}`;
                    }
                    // this.availableStyles.set(styleUrl, true);
                    this.activatedStyles.set(styleUrl.name, true);
                });
                this.retrieveStyles(styleUrls).subscribe(dataMap => {
                    this.styleData = dataMap;
                });
            },
            error: error => {
                console.log(error);
            }
        });
    }

    retrieveStyles(styles: Array<ErdblickStyle>) {
        return from(styles).pipe(
            mergeMap(style =>
                this.httpClient.get(style.url, {responseType: 'text'})
                    .pipe(map(data => ({style, data})))
            ),
            reduce((acc, {style, data}) => {
                acc.set(style.name, parse(data));
                return acc;
            }, new Map<string, any>())
        );
    }

    getUnifiedStyleData() {
        if (!this.activatedStyles.size) {
            this.httpClient.get(defaultStyleUrl, {responseType: "text"}).subscribe({
                next: (data: string) => {
                    return data;
                },
                error: error => {
                    console.log(error);
                    return null;
                }
            });
            return null;
        } else {
            let compositeStyle = {
                name: "CompositeStyle",
                version: "0.0",
                rules: new Array<any>()
            }
            this.activatedStyles.forEach((isAvailable, styleName) => {
                if (isAvailable) {
                    const styleData = this.styleData.get(styleName) as ErdblickStyleData;
                    compositeStyle.rules = [...compositeStyle.rules, ...styleData.rules];
                }
            });
            return stringify(compositeStyle);
        }
    }
}