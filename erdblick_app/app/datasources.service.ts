import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {MapService} from "./map.service";
import {BehaviorSubject} from "rxjs";
import {InfoMessageService} from "./info.service";


@Injectable()
export class DataSourcesService {

    configDialogVisible = false;
    loading = false;
    errorMessage: string = "";
    dataSourcesConfigJson: BehaviorSubject<Object> = new BehaviorSubject<Object>({});

    constructor(private messageService: InfoMessageService,
                public mapService: MapService,
                private http: HttpClient) {}

    postConfig(config: string) {
        this.loading = true;
        this.http.post("/config", config, { observe: 'response', responseType: 'text' }).subscribe({
            next: (data: any) => {
                this.messageService.showSuccess(data.body);
                setTimeout(() => {
                    this.loading = false;
                    this.mapService.reloadDataSources().then(_ => this.mapService.update());
                }, 2000);
            },
            error: error => {
                this.loading = false;
                alert(`Error: ${error.error}`);
            }
        });
    }

    getConfig() {
        this.errorMessage = "";
        this.loading = true;
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
                this.loading = false;
                this.errorMessage = `Error: ${error.error}`;
            }
        });
    }
}