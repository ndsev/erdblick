import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {MapService} from "./map.service";
import {FormGroup} from "@angular/forms";
import {JSONSchema7} from "json-schema";
import {BehaviorSubject} from "rxjs";


@Injectable()
export class DataSourcesService {

    configDialogVisible = false;
    loading = false;
    errorMessage: string = "";
    dataSourcesConfigJson: BehaviorSubject<Object> = new BehaviorSubject<Object>({});

    constructor(public mapService: MapService,
                private http: HttpClient) {}

    postConfig(config: string) {
        this.http.post("/config", config, { observe: 'response' }).subscribe({
            next: (data: any) => {
                console.log("POST", data);
                alert("Successfully updated the DataSource configuration!");
                this.loading = true;
                setTimeout(() => {
                    this.loading = false;
                    this.mapService.reloadDataSources().then(_ => this.mapService.update());
                }, 2000);
            },
            error: error => {
                console.log("POST", error);
                alert(error);
            }
        });
    }

    getConfig() {
        this.errorMessage = "";
        this.http.get("/config").subscribe({
            next: (data: any) => {
                if (!data) {
                    this.errorMessage = "Unknown error: DataSources configuration data is missing!";
                    this.dataSourcesConfigJson.next({});
                    return;
                }
                if (!data["model"]) {
                    this.errorMessage = "Unknown error: DataSources config file data is missing!";
                    this.dataSourcesConfigJson.next({});
                    return;
                }
                if (!data["schema"]) {
                    this.errorMessage = "Unknown error: DataSources schema file data is missing!";
                    this.dataSourcesConfigJson.next({});
                    return;
                }
                this.dataSourcesConfigJson.next(data);
            },
            error: error => {
                this.errorMessage = error.toString();
            }
        });
    }
}