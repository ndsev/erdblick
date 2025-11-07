import {Component, ViewContainerRef} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {MapDataService} from "./mapdata/map.service";
import {AppStateService} from "./shared/appstate.service";
import {AppModeService} from "./shared/app-mode.service";
import {DebugWindow, ErdblickDebugApi} from "./app.debugapi.component";
import {InfoMessageService} from "./shared/info.service";
import {environment} from "./environments/environment";

// Redeclare window with extended interface
declare let window: DebugWindow;

interface Versions {
    name: string;
    tag: string;
}

@Component({
    selector: 'app-root',
    template: `
        <dockable-layout></dockable-layout>
        @if (!environment.visualizationOnly) {
            <datasources></datasources>
            <map-panel></map-panel>
            <coordinates-panel></coordinates-panel>
            <stats-dialog></stats-dialog>
            <style-panel></style-panel>
            <p-toast position="top-center" key="tc" [baseZIndex]="9500"></p-toast>
        }
        <legal-dialog></legal-dialog>
        <div id="info">
            <div *ngIf="copyright.length" id="copyright-info" (click)="openLegalInfo()">
                {{ copyright }}
            </div>
            <div>
                <span *ngIf="!distributionVersions.length">{{ erdblickVersion }}</span>
                <span *ngIf="distributionVersions.length" style="cursor: pointer" (click)="showExposedVersions()">
                    {{ distributionVersions[0].name }}&nbsp;{{ distributionVersions[0].tag }}
                </span>
            </div>
        </div>
        <p-dialog header="Distribution Version Information" [(visible)]="distributionVersionsDialogVisible" 
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
            <p-button type="button" label="Close" icon="pi pi-times" (click)="distributionVersionsDialogVisible = false">
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
    distributionVersionsDialogVisible: boolean = false;

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
                            // Using string interpolation so webpack can trace imports from the location
                            import(`../config/${distribVersions}.js`).then(function (plugin) {
                                return plugin.default() as Array<Versions>;
                            }).then((versions: Array<Versions>) => {
                                this.distributionVersions = versions;
                            }).catch((error) => {
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
            this.distributionVersionsDialogVisible = true;
        }
    }

    getBasicVersion() {
        this.httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.erdblickVersion = `${this.title} ${data.toString()}`;
            });
    }

    protected readonly environment = environment;
}
