import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {from, mergeMap, map, reduce} from "rxjs";

export interface ErdblickStyle {
    id: string,
    url: string
}

export interface ErdblickStyleData {
    id: string,
    version: string,
    rules: Array<any>
}

const defaultStyle: ErdblickStyle = {
    id: "Default Style",
    url: "/bundle/styles/default-style.yaml"
};

@Injectable({providedIn: 'root'})
export class StyleService {

    activatedStyles: Map<string, boolean> = new Map<string, boolean>();
    styleData: Map<string, string> = new Map<string, any>();

    constructor(private httpClient: HttpClient) {
        this.activatedStyles.set(defaultStyle.id, true);
        this.retrieveStyles([defaultStyle]).subscribe(dataMap => {
            this.styleData = dataMap;
        });
        let styleUrls: Array<ErdblickStyle> = [];
        httpClient.get("/config.json", {responseType: "json"}).subscribe({
            next: (data: any) => {
                styleUrls = [...styleUrls, ...data["styles"]];
                styleUrls.forEach((styleUrl: ErdblickStyle) => {
                    if (!styleUrl.url.startsWith("http") && !styleUrl.url.startsWith("/bundle")) {
                        styleUrl.url = `/bundle/styles/${styleUrl.url}`;
                    }
                    this.activatedStyles.set(styleUrl.id, true);
                });
                this.retrieveStyles(styleUrls).subscribe(dataMap => {
                    this.styleData = new Map([...dataMap.entries(), ...this.styleData.entries()]);
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
                acc.set(style.id, data);
                return acc;
            }, new Map<string, string>())
        );
    }
}