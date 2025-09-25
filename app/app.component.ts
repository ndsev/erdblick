import {Component} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {ActivatedRoute, NavigationEnd, Router} from "@angular/router";
import {Location} from '@angular/common';
import {MapService} from "./mapdata/map.service";
import {AppStateService} from "./shared/appstate.service";
import {filter} from "rxjs";
import {AppModeService} from "./shared/app-mode.service";

interface Versions {
    name: string;
    tag: string;
}

@Component({
    selector: 'app-root',
    template: `
        <erdblick-view></erdblick-view>
        <map-panel *ngIf="!appModeService.isVisualizationOnly"></map-panel>
        <p-toast position="top-center" key="tc"></p-toast>
        <search-panel *ngIf="!appModeService.isVisualizationOnly"></search-panel>
        <inspection-panel *ngIf="!appModeService.isVisualizationOnly"></inspection-panel>
        <coordinates-panel *ngIf="!appModeService.isVisualizationOnly"></coordinates-panel>
        <stats-dialog *ngIf="!appModeService.isVisualizationOnly"></stats-dialog>
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
    public parametersService: AppStateService;

    title: string = "erdblick";
    erdblickVersion: string = "";
    copyright: string = "";
    distributionVersions: Array<Versions> = [];
    distributionVersionsDialogVisible: boolean = false;


    constructor(private httpClient: HttpClient,
                private router: Router,
                private location: Location,
                private activatedRoute: ActivatedRoute,
                public mapService: MapService,
                public appModeService: AppModeService) {
        // Create parametersService with router and location for URL sync
        this.parametersService = new AppStateService(appModeService, router, location);
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
        this.init();
        this.mapService.legalInformationUpdated.subscribe(_ => {
            this.copyright = "";
            let firstSet: Set<string> | undefined = this.mapService.legalInformationPerMap.values().next().value;
            if (firstSet !== undefined && firstSet.size) {
                this.copyright = '© '.concat(firstSet.values().next().value as string).slice(0, 14).concat('…');
            }
        });
    }

    init() {
        this.router.events.subscribe()
        // Forward URL parameter changes to the ParameterService.
        this.router.events.pipe(
            // Filter the events to only include NavigationEnd events
            filter(event => event instanceof NavigationEnd)
        ).subscribe((event) => {
            this.parametersService.parseAndApplyQueryParams(this.activatedRoute.snapshot.queryParams);
        });

        // URL updates are now handled internally by AppStateService
        // No need to subscribe to parameters for URL updates
    }

    // URL updates are now handled internally by AppStateService

    openLegalInfo() {
        this.parametersService.legalInfoDialogVisible = true;
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
}
