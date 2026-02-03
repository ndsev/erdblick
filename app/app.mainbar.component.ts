import {Component} from '@angular/core';
import {map, timer} from 'rxjs';
import {MapDataService} from './mapdata/map.service';
import {StyleService} from './styledata/style.service';
import {AppStateService} from './shared/appstate.service';
import {EditorService} from './shared/editor.service';
import {environment} from './environments/environment';

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
                    <p-progress-spinner strokeWidth="8" fill="transparent" [style]="{ width: '1.25em', height: '1.25em' }" />
                    <span class="material-symbols-outlined" style="color: var(--p-button-danger-background)">
                        warning
                    </span>
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

    readonly loader_icons = ['', 'clock_loader_10', 'clock_loader_20', 'clock_loader_40', 'clock_loader_60', 'clock_loader_80', 'clock_loader_90'];
    readonly loader_icon$ = timer(0, 500).pipe(
        map(i => this.loader_icons.length ? this.loader_icons[i % this.loader_icons.length] : '')
    );

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
                    name: 'Statistics',
                    icon: 'bar_chart_4_bars',
                    command: () => { this.showStatsDialog(); }
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
                public editorService: EditorService) {
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
