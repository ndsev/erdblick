import {Component} from '@angular/core';
import {map, timer} from 'rxjs';
import {MapDataService} from './mapdata/map.service';
import {StyleService} from './styledata/style.service';
import {AppStateService} from './shared/appstate.service';
import {EditorService} from './shared/editor.service';
import {environment} from './environments/environment';
import {DiagnosticsFacadeService} from './diagnostics/diagnostics.facade.service';

@Component({
    selector: 'main-bar',
    template: `
        <p-menubar class="main-bar" [model]="menuItems">
            <ng-template #start>
                @if (!environment.visualizationOnly) {
                    <search-panel></search-panel>
                }
            </ng-template>
            <ng-template #item let-item>
                <a pRipple class="p-menubar-item-link" (click)="item.command()">
                    <span class="material-symbols-outlined">{{ item.icon }}</span>
                    <span>{{ item.name }}</span>
                </a>
            </ng-template>
            <ng-template #end>
                <div style="display: flex; flex-direction: row; gap: 0.25em; align-items: center">
                    <diagnostics-indicator></diagnostics-indicator>
                    @if (copyright.length) {
                        <div class="copyright-info" (click)="openLegalInfo()">
                            {{ copyright }}
                        </div>
                    }
                </div>
            </ng-template>
        </p-menubar>
    `,
    styles: [
        `
            .copyright-info {
                width: 5em;
                font-size: 0.8em;
                word-wrap: normal;
                text-align: end;
            }
        `
    ],
    standalone: false
})
export class MainBarComponent {

    menuItems = [
        {
            name: 'Maps',
            icon: 'stacks',
            command: () => { this.showMapsPanel(); }
        },
        {
            name: 'Styles',
            icon: 'palette',
            command: () => { this.openStylesDialog(); }
        },
        {
            name: 'Settings',
            icon: 'settings',
            items: [
                {
                    name: 'Preferences',
                    icon: 'settings',
                    command: () => { this.showPreferencesDialog(); },
                },
                {
                    name: 'Datasources',
                    icon: 'data_table',
                    command: () => { this.openDatasources(); }
                },
                {
                    name: 'Controls',
                    icon: 'keyboard',
                    command: () => { this.showControlsDialog(); }
                }
            ]
        },
        {
            name: 'Help',
            icon: 'question_mark',
            items: [
                {
                    name: 'Performance Statistics',
                    icon: 'insights',
                    command: () => { this.openDiagnosticsPerformance(); }
                },
                {
                    name: 'Log',
                    icon: 'list_alt',
                    command: () => { this.openDiagnosticsLog(); }
                },
                {
                    name: 'Export Diagnostics',
                    icon: 'download',
                    command: () => { this.openDiagnosticsExport(); }
                },
                {
                    name: 'Help',
                    icon: 'question_mark',
                    command: () => { this.openHelp(); }
                },
                {
                    name: 'About',
                    icon: 'info',
                    command: () => { this.openAboutDialog(); }
                }
            ]
        }
    ];

    copyright: string = '';

    constructor(public mapService: MapDataService,
                public styleService: StyleService,
                public stateService: AppStateService,
                public editorService: EditorService,
                private diagnostics: DiagnosticsFacadeService) {
        this.mapService.legalInformationUpdated.subscribe(_ => {
            this.copyright = '';
            let firstSet: Set<string> | undefined = this.mapService.legalInformationPerMap.values().next().value;
            if (firstSet !== undefined && firstSet.size) {
                this.copyright = '© '.concat(firstSet.values().next().value as string).slice(0, 14).concat('…');
            }
        });
    }

    showPreferencesDialog() {
        this.stateService.preferencesDialogVisible = true;
    }

    showControlsDialog() {
        this.stateService.controlsDialogVisible = true;
    }

    showStatsDialog() {
        this.mapService.statsDialogVisible = true;
        this.mapService.statsDialogNeedsUpdate.next();
    }

    openDiagnosticsProgress() {
        this.diagnostics.openProgressDialog();
    }

    openDiagnosticsPerformance() {
        this.diagnostics.openPerformanceDialog();
    }

    openDiagnosticsLog() {
        this.diagnostics.openLogDialog();
    }

    openDiagnosticsExport() {
        this.diagnostics.openExportDialog({
            includeProgress: true,
            includePerformance: true,
            includeLogs: true
        });
    }

    openHelp() {
        window.open('https://developer.nds.live/tools/mapviewer/user-guide', '_blank');
    }

    openAboutDialog() {
        this.stateService.aboutDialogVisible = true;
    }

    private openDatasources() {
        this.editorService.styleEditorVisible = false;
        this.editorService.datasourcesEditorVisible = true;
    }

    private openStylesDialog() {
        this.styleService.stylesDialogVisible = true;
    }

    private showMapsPanel() {
        this.stateService.mapsOpenState.next(true);
    }

    protected openLegalInfo() {
        this.stateService.legalInfoDialogVisible = true;
    }

    protected readonly environment = environment;
}
