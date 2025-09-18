import {Component} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {ActivatedRoute, NavigationEnd, Params, Router} from "@angular/router";
import {MapService} from "./map.service";
import {ParametersService} from "./parameters.service";
import {filter} from "rxjs";
import {AppModeService} from "./app-mode.service";

// Helper to stringify with booleans in compact representation
function stringifyForUrl(value: any): string {
    return JSON.stringify(value, (_: string, value: any) => {
        return typeof value === 'boolean' ? (value ? 1 : 0) : value;
    });
}

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
        <pref-components *ngIf="!appModeService.isVisualizationOnly"></pref-components>
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

    title: string = "erdblick";
    erdblickVersion: string = "";
    copyright: string = "";
    distributionVersions: Array<Versions> = [];
    distributionVersionsDialogVisible: boolean = false;


    constructor(private httpClient: HttpClient,
                private router: Router,
                private activatedRoute: ActivatedRoute,
                public mapService: MapService,
                public appModeService: AppModeService,
                public parametersService: ParametersService) {
        this.httpClient.get("config.json", {responseType: 'json'}).subscribe({
            next: (data: any) => {
                try {
                    if (data && data["extensionModules"] && data["extensionModules"]["distribVersions"]) {
                        let distribVersions = data["extensionModules"]["distribVersions"];
                        if (distribVersions !== undefined) {
                            // Using string interpolation so webpack can trace imports from the location
                            import(`../../config/${distribVersions}.js`).then(function (plugin) {
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

        // Forward ParameterService updates to the URL.
        this.parametersService.parameters.subscribe(parameters => {
            // Only forward new parameters into the query, if we have
            // parsed the initial values.
            if (!this.parametersService.initialQueryParamsSet) {
                return;
            }
            const entries = [...Object.entries(parameters)].filter(value =>
                this.parametersService.isUrlParameter(value[0])
            );
            entries.forEach(entry => entry[1] = stringifyForUrl(entry[1]));
            this.updateQueryParams(Object.fromEntries(entries), this.parametersService.replaceUrl);
        });
    }

    updateQueryParams(params: Params, replaceUrl: boolean): void {
        this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: 'merge',
            replaceUrl: replaceUrl
        });
    }

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
