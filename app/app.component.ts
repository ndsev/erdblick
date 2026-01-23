import {Component, OnDestroy, ViewContainerRef} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {MapDataService} from "./mapdata/map.service";
import {AppStateService} from "./shared/appstate.service";
import {AppModeService} from "./shared/app-mode.service";
import {DebugWindow, ErdblickDebugApi} from "./app.debugapi.component";
import {InfoMessageService} from "./shared/info.service";
import {environment} from "./environments/environment";
import {DialogStackService} from "./shared/dialog-stack.service";

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
        <dockable-layout></dockable-layout>
        @if (!environment.visualizationOnly) {
            <datasources></datasources>
            <map-panel></map-panel>
            <stats-dialog></stats-dialog>
            <style-panel></style-panel>
            <feature-search></feature-search>
            <p-toast position="top-center" key="tc" [baseZIndex]="9500"></p-toast>
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
export class AppComponent implements OnDestroy {

    title: string = "erdblick";
    erdblickVersion: string = "";
    copyright: string = "";
    distributionVersions: Array<Versions> = [];
    distVersionsDialogVisible: boolean = false;
    private detachDialogFocusListener?: () => void;

    constructor(private httpClient: HttpClient,
                public mapService: MapDataService,
                public appModeService: AppModeService,
                public stateService: AppStateService,
                private viewContainerRef: ViewContainerRef,
                private infoMessageService: InfoMessageService,
                private dialogStack: DialogStackService) {
        // Register a default container for alert dialogs
        this.infoMessageService.registerDefaultContainer(this.viewContainerRef);
        this.bindDialogFocusStacking();
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

    ngOnDestroy() {
        this.detachDialogFocusListener?.();
    }

    openLegalInfo() {
        this.stateService.legalInfoDialogVisible = true;
    }

    private bindDialogFocusStacking() {
        const handler = (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            if (!target) {
                return;
            }
            const dialogElement = target.closest('.p-dialog') as HTMLElement | null;
            if (!dialogElement) {
                return;
            }
            if (dialogElement.closest('.map-layer-dialog')) {
                return;
            }
            if (dialogElement.closest('.search-menu-dialog') || dialogElement.closest('.feature-search-dialog')) {
                const mainBar = document.querySelector('.main-bar') as HTMLElement | null;
                if (mainBar) {
                    this.dialogStack.bringElementToFront(mainBar);
                }
                const wrapper = dialogElement.closest('.search-wrapper') as HTMLElement | null;
                this.dialogStack.bringElementToFront(wrapper ?? dialogElement);
                return;
            }
            this.dialogStack.bringElementToFront(dialogElement);
        };
        document.addEventListener('mousedown', handler, true);
        this.detachDialogFocusListener = () => {
            document.removeEventListener('mousedown', handler, true);
        };
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

    protected readonly environment = environment;
}
