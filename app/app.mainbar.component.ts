import {AfterViewInit, Component, ElementRef, OnDestroy, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {MapDataService} from './mapdata/map.service';
import {StyleService} from './styledata/style.service';
import {
    AppStateService,
    VIEW_SYNC_LAYERS,
    VIEW_SYNC_MOVEMENT,
    VIEW_SYNC_POSITION,
    VIEW_SYNC_PROJECTION
} from './shared/appstate.service';
import {EditorService} from './shared/editor.service';
import {environment} from './environments/environment';
import {DiagnosticsFacadeService} from './diagnostics/diagnostics.facade.service';
import {MenuItem} from "primeng/api";

@Component({
    selector: 'main-bar',
    template: `
        @if (stateService.mapsDialogVisible) {
            <p-button class="maps-button" (click)="closeMapsPanel()" label="" tooltipPosition="right" pTooltip="Close maps configuration panel">
                <span class="material-symbols-outlined">close</span>
            </p-button>
        } @else {
            <p-button class="maps-button" (click)="showMapsPanel()" icon="" label="" tooltipPosition="right" pTooltip="Open maps configuration panel">
                <span class="material-symbols-outlined">stacks</span>
            </p-button>
        }
        <p-menubar #mainBarMenubar class="main-bar" [model]="menuItems">
            <ng-template #start>
                @if (!environment.visualizationOnly) {
                    <search-panel></search-panel>
                }
            </ng-template>
            <ng-template #item let-item>
                <a pRipple class="p-menubar-item-link">
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
export class MainBarComponent implements AfterViewInit, OnDestroy {
    @ViewChild('mainBarMenubar', {read: ElementRef})
    private menubarRef?: ElementRef<HTMLElement>;
    private menubarClassObserver?: MutationObserver;
    private readonly subscriptions = new Subscription();

    menuItems: MenuItem[] = [
        {
            name: 'Edit',
            icon: 'tune',
            items: [
                {
                    name: 'Styles Configurator',
                    icon: 'palette',
                    command: () => { this.openStylesDialog(); }
                },
                {
                    name: 'Datasources',
                    icon: 'data_table',
                    command: () => { this.openDatasources(); }
                },
                {
                    name: 'Settings',
                    icon: 'settings',
                    command: () => { this.showPreferencesDialog(); },
                }
            ]
        },
        {
            name: 'View',
            icon: 'view_column',
            items: [
                {
                    name: 'Split View',
                    icon: 'add_column_right',
                    command: () => { this.stateService.numViews = 2; }
                },
                {
                    name: 'Close View',
                    icon: 'tab_close',
                    command: () => { this.stateService.numViews = 1; }
                },
                {
                    name: 'Sync Views',
                    icon: 'sync',
                    items: [
                        {
                            name: "Position",
                            icon: "location_on",
                            command: () => {
                                this.stateService.syncOptions.forEach(option => {
                                    if (option.code === VIEW_SYNC_POSITION) {
                                        option.value = !option.value;
                                    }
                                });
                                this.stateService.updateSelectedSyncOptions();
                            }
                        },
                        {
                            name: "Movement",
                            icon: "drag_pan",
                            command: () => {
                                this.stateService.syncOptions.forEach(option => {
                                    if (option.code === VIEW_SYNC_MOVEMENT) {
                                        option.value = !option.value;
                                    }
                                });
                                this.stateService.updateSelectedSyncOptions();
                            }
                        },
                        {
                            name: "Projection",
                            icon: "3d_rotation",
                            command: () => {
                                this.stateService.syncOptions.forEach(option => {
                                    if (option.code === VIEW_SYNC_PROJECTION) {
                                        option.value = !option.value;
                                    }
                                });
                                this.stateService.updateSelectedSyncOptions();
                            }
                        },
                        {
                            name: "Layers",
                            icon: "layers",
                            command: () => {
                                this.stateService.syncOptions.forEach(option => {
                                    if (option.code === VIEW_SYNC_LAYERS) {
                                        option.value = !option.value;
                                    }
                                });
                                this.stateService.updateSelectedSyncOptions();
                            }
                        }
                    ]
                }
            ]
        },
        {
            name: 'Tools',
            icon: 'build',
            items: [
                {
                    name: 'Performance Statistics',
                    icon: 'insights',
                    command: () => { this.openDiagnosticsPerformance(); }
                },
                {
                    name: 'Export Diagnostics',
                    icon: 'download',
                    command: () => { this.openDiagnosticsExport(); }
                },
                {
                    name: 'Logs',
                    icon: 'list_alt',
                    command: () => { this.openDiagnosticsLog(); }
                }
            ]
        },
        {
            name: 'Help',
            icon: 'question_mark',
            items: [
                {
                    name: 'Controls',
                    icon: 'keyboard',
                    command: () => { this.showControlsDialog(); }
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
        this.subscriptions.add(this.mapService.legalInformationUpdated.subscribe(_ => {
            this.copyright = '';
            let firstSet: Set<string> | undefined = this.mapService.legalInformationPerMap.values().next().value;
            if (firstSet !== undefined && firstSet.size) {
                this.copyright = '© '.concat(firstSet.values().next().value as string).slice(0, 14).concat('…');
            }
        }));
        this.updateViewMenuItemsVisibility(this.stateService.numViews);
        this.subscriptions.add(this.stateService.numViewsState.subscribe(numViews => {
            this.updateViewMenuItemsVisibility(numViews);
        }));
    }

    ngAfterViewInit() {
        const menubar = this.menubarRef?.nativeElement;
        if (!menubar) {
            return;
        }
        this.syncMobileMapsMenuItem(menubar.classList.contains('p-menubar-mobile'));
        this.menubarClassObserver = new MutationObserver(records => {
            for (const record of records) {
                if (record.type === 'attributes' && record.attributeName === 'class') {
                    this.syncMobileMapsMenuItem(menubar.classList.contains('p-menubar-mobile'));
                }
            }
        });
        this.menubarClassObserver.observe(menubar, {attributes: true, attributeFilter: ['class']});
    }

    ngOnDestroy() {
        this.menubarClassObserver?.disconnect();
        this.subscriptions.unsubscribe();
    }

    showPreferencesDialog() {
        this.stateService.preferencesDialogVisible = true;
    }

    showControlsDialog() {
        this.stateService.controlsDialogVisible = true;
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

    protected showMapsPanel() {
        this.stateService.mapsDialogVisible = true;
    }

    protected closeMapsPanel() {
        this.stateService.mapsDialogVisible = false;
    }

    protected openLegalInfo() {
        this.stateService.legalInfoDialogVisible = true;
    }

    private syncMobileMapsMenuItem(isMobileMenubar: boolean) {
        const hasMobileMapsMenuItem = this.menuItems[0]["name"] === 'Maps';
        if (isMobileMenubar && !hasMobileMapsMenuItem) {
            this.menuItems = [{
                name: 'Maps',
                icon: 'stacks',
                command: () => { this.showMapsPanel(); }
            }, ...this.menuItems];
            return;
        }
        if (!isMobileMenubar && hasMobileMapsMenuItem) {
            this.menuItems = this.menuItems.slice(1);
        }
    }

    private updateViewMenuItemsVisibility(numViews: number): void {
        const viewMenu = this.menuItems.find(item => item['name'] === 'View');
        if (!viewMenu?.items) {
            return;
        }

        const splitViewItem = viewMenu.items.find(item => item['name'] === 'Split View');
        if (splitViewItem) {
            splitViewItem.visible = numViews <= 1;
        }

        const closeViewItem = viewMenu.items.find(item => item['name'] === 'Close View');
        if (closeViewItem) {
            closeViewItem.visible = numViews > 1;
        }

        this.menuItems = [...this.menuItems];
    }

    protected readonly environment = environment;
}
