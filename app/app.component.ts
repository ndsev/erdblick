import {Component, ViewContainerRef} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {MapDataService} from "./mapdata/map.service";
import {AppStateService} from "./shared/appstate.service";
import {AppModeService} from "./shared/app-mode.service";
import {DebugWindow, ErdblickDebugApi} from "./app.debugapi.component";
import {InfoMessageService} from "./shared/info.service";

// Redeclare window with extended interface
declare let window: DebugWindow;

interface Versions {
    name: string;
    tag: string;
}

interface SurveyConfig {
    id: string;
    start?: string;
    end?: string;
    emoji?: string;
    linkHtml?: string;
}

@Component({
    selector: 'app-root',
    template: `
        <mapview-container></mapview-container>
        @if (!appModeService.isVisualizationOnly) {
            <map-panel></map-panel>
            <search-panel></search-panel>
            <inspection-container></inspection-container>
            <coordinates-panel></coordinates-panel>
            <stats-dialog></stats-dialog>
            <style-panel></style-panel>
            <survey></survey>
        }
        <p-toast position="top-center" key="tc" [baseZIndex]="9500"></p-toast>
        <legal-dialog></legal-dialog>
        <div id="info">
            @if (copyright.length) {
                <div id="copyright-info" (click)="openLegalInfo()">
                    {{ copyright }}
                </div>
            }
            <div>
                @if (!distributionVersions.length) {
                    <span>{{ erdblickVersion }}</span>
                } @else {
                    <span style="cursor: pointer" (click)="showExposedVersions()">
                        {{ distributionVersions[0].name }}&nbsp;{{ distributionVersions[0].tag }}
                    </span>
                }
            </div>
        </div>
        <p-dialog header="Distribution Version Information" [(visible)]="distVersionsDialogVisible"
                  [modal]="false" [style]="{'min-height': '10em', 'min-width': '20em'}">
            <div class="dialog-content">
                <p-table [value]="distributionVersions" [tableStyle]="{ 'min-width': '20em' }">
                    <ng-template #header>
                        <tr>
                            <th>Name</th>
                            <th>Version</th>
                        </tr>
                    </ng-template>
                    <ng-template #body let-version>
                        <tr>
                            <td>{{ version.name }}</td>
                            <td>{{ version.tag }}</td>
                        </tr>
                    </ng-template>
                </p-table>
            </div>
            <p-button type="button" label="Close" icon="pi pi-times" (click)="distVersionsDialogVisible = false">
            </p-button>
        </p-dialog>
        <router-outlet></router-outlet>
    `,
    styles: [`
        .dialog-content {
            margin-bottom: 0.5em;
        }

        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `],
    standalone: false
})
export class AppComponent {

    title: string = "erdblick";
    erdblickVersion: string = "";
    copyright: string = "";
    distributionVersions: Array<Versions> = [];
    distVersionsDialogVisible: boolean = false;

    constructor(private httpClient: HttpClient,
                public mapService: MapDataService,
                public appModeService: AppModeService,
                public stateService: AppStateService,
                private viewContainerRef: ViewContainerRef,
                private infoMessageService: InfoMessageService) {
        // Register a default container for alert dialogs
        this.infoMessageService.registerDefaultContainer(this.viewContainerRef);
        window.ebDebug = new ErdblickDebugApi(
            this.mapService,
            this.stateService
        );

        this.httpClient.get("config.json", {responseType: 'json'}).subscribe({
            next: (data: any) => {
                try {
                    if (data && data["extensionModules"] && data["extensionModules"]["distribVersions"]) {
                        let distribVersions = data["extensionModules"]["distribVersions"];
                        if (distribVersions !== undefined) {
                            const distribVersionsPath = `/config/${distribVersions}.js`;
                            // Using string interpolation so webpack can trace imports, and tell Vite to leave the absolute path untouched
                            import(/* @vite-ignore */ distribVersionsPath)
                                .then((plugin) => plugin.default() as Array<Versions>)
                                .then((versions: Array<Versions>) => {
                                    this.distributionVersions = versions;
                                })
                                .catch((error) => {
                                    console.error(error);
                                    this.getBasicVersion();
                                });
                            return;
                        } else {
                            this.getBasicVersion();
                        }
                    } else {
                        this.getBasicVersion();
                    }
                } catch (error) {
                    console.error(error);
                    this.getBasicVersion();
                }
            },
            error: error => {
                console.error(error);
                this.getBasicVersion();
            }
        });
        this.mapService.legalInformationUpdated.subscribe(_ => {
            this.copyright = "";
            let firstSet: Set<string> | undefined = this.mapService.legalInformationPerMap.values().next().value;
            if (firstSet !== undefined && firstSet.size) {
                this.copyright = '© '.concat(firstSet.values().next().value as string).slice(0, 14).concat('…');
            }
        });
    }

    openLegalInfo() {
        this.stateService.legalInfoDialogVisible = true;
    }

    showExposedVersions() {
        if (this.distributionVersions.length) {
            this.distVersionsDialogVisible = true;
        }
    }

    getBasicVersion() {
        this.httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.erdblickVersion = `${this.title} ${data.toString()}`;
            });
    }
}
