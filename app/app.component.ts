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

@Component({
    selector: 'app-root',
    template: `
        <mapview-container></mapview-container>
        <map-panel *ngIf="!appModeService.isVisualizationOnly"></map-panel>
        <p-toast position="top-center" key="tc" [baseZIndex]="9500"></p-toast>
        <search-panel *ngIf="!appModeService.isVisualizationOnly"></search-panel>
        <inspection-container *ngIf="!appModeService.isVisualizationOnly"></inspection-container>
        <coordinates-panel *ngIf="!appModeService.isVisualizationOnly"></coordinates-panel>
        <stats-dialog *ngIf="!appModeService.isVisualizationOnly"></stats-dialog>
        <legal-dialog></legal-dialog>
        <style-panel></style-panel>
        <div id="survey" [class]="{'hidden': isSurveyHidden}">
            <span class="survey-tree" style="font-size: 1.75em" (click)="triggerFireworks()">🎄</span>
            <a href="">Happy holidays!<br>Take part in our 2026 survey now<br>to help make MapViewer even better!</a>
            <span class="material-symbols-outlined" (click)="dismissSurvey($event)">
                close
            </span>
            <div *ngIf="showFireworks" class="survey-fireworks">
                <span class="firework f1"></span>
                <span class="firework f2"></span>
                <span class="firework f3"></span>
                <span class="firework f4"></span>
                <span class="firework f5"></span>
                <span class="firework f6"></span>
                <span class="firework f7"></span>
                <span class="firework f8"></span>
                <span class="firework f9"></span>
                <span class="firework f10"></span>
                <span class="firework f11"></span>
                <span class="firework f12"></span>
                <span class="firework f13"></span>
                <span class="firework f14"></span>
                <span class="firework f15"></span>
                <span class="firework f16"></span>
            </div>
        </div>
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

        #survey .survey-tree {
            position: relative;
            display: inline-block;
            cursor: pointer;
        }

        #survey .survey-fireworks {
            position: absolute;
            inset: 0;
            pointer-events: none;
        }

        #survey .firework {
            position: absolute;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: #ffeeb2;
            opacity: 0;
            animation: survey-firework 800ms ease-out forwards;
        }

        #survey .firework.f1 {
            top: 10%;
            left: 8%;
        }

        #survey .firework.f2 {
            top: 25%;
            left: 45%;
            background-color: #ffb6b6;
        }

        #survey .firework.f3 {
            top: 20%;
            left: 88%;
            background-color: #91d9ff;
        }

        #survey .firework.f4 {
            top: 60%;
            left: 18%;
            background-color: #ffef9c;
        }

        #survey .firework.f5 {
            top: 75%;
            left: 55%;
            background-color: #ffabab;
        }

        #survey .firework.f6 {
            top: 65%;
            left: 92%;
            background-color: #66ccff;
        }

        #survey .firework.f7 {
            top: 5%;
            left: 30%;
            background-color: #ffcc00;
        }

        #survey .firework.f8 {
            top: 35%;
            left: 5%;
            background-color: #ff6666;
        }

        #survey .firework.f9 {
            top: 10%;
            left: 60%;
            background-color: #66ccff;
        }

        #survey .firework.f10 {
            top: 45%;
            left: 38%;
            background-color: #ffcc00;
        }

        #survey .firework.f11 {
            top: 55%;
            left: 72%;
            background-color: #ff6666;
        }

        #survey .firework.f12 {
            top: 80%;
            left: 10%;
            background-color: #66ccff;
        }

        #survey .firework.f13 {
            top: 85%;
            left: 40%;
            background-color: #ffeeb3;
        }

        #survey .firework.f14 {
            top: 82%;
            left: 75%;
            background-color: #ffbfbf;
        }

        #survey .firework.f15 {
            top: 30%;
            left: 25%;
            background-color: #bde9ff;
        }

        #survey .firework.f16 {
            top: 50%;
            left: 90%;
            background-color: #fff0b6;
        }

        @keyframes survey-firework {
            0% {
                transform: scale(0.2);
                opacity: 1;
            }
            100% {
                transform: scale(1.4);
                opacity: 0;
            }
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
    isSurveyHidden: boolean = false;
    showFireworks: boolean = false;

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
            this.distributionVersionsDialogVisible = true;
        }
    }

    getBasicVersion() {
        this.httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.erdblickVersion = `${this.title} ${data.toString()}`;
            });
    }

    dismissSurvey(event: any) {
        event.stopPropagation();
        this.isSurveyHidden = true;
    }

    triggerFireworks() {
        this.showFireworks = true;
        window.setTimeout(() => {
            this.showFireworks = false;
        }, 600);
    }
}
