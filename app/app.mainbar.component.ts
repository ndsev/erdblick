import {AfterViewInit, Component, ElementRef, NgZone, OnDestroy} from '@angular/core';
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

const MAIN_BAR_BREAKPOINT = '56em';
const MAIN_BAR_MEDIA_QUERY = `(max-width: ${MAIN_BAR_BREAKPOINT})`;
const MAIN_BAR_VIEWER_LAYOUT_BREAKPOINT_EM = 45;
const MAIN_BAR_FORCED_MOBILE_BREAKPOINT = '1000000px';

@Component({
    selector: 'main-bar',
    host: {
        '[class.main-bar-mobile-layout]': 'isMobileMenubar'
    },
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
        @if (isMobileMenubar) {
            <p-menubar class="main-bar" [model]="menuItems" [breakpoint]="forcedMobileMenubarBreakpoint">
                <ng-template #start>
                    @if (!environment.visualizationOnly) {
                        <search-panel></search-panel>
                    }
                </ng-template>
                <ng-template #item let-item let-root="root">
                    <a pRipple class="p-menubar-item-link" [ngClass]="{'sync-option-active': isSyncViewOptionActive(item)}">
                        <span class="material-symbols-outlined">{{ item.icon }}</span>
                        <span>{{ item.name }}</span>
                        @if (!root && item.items?.length) {
                            <span class="pi submenu-indicator pi-angle-right"></span>
                        }
                    </a>
                </ng-template>
                <ng-template #end>
                    <div style="display: flex; flex-direction: row; gap: 0; align-items: center">
                        <diagnostics-indicator></diagnostics-indicator>
                        @if (copyright.length) {
                            <div class="copyright-info" (click)="openLegalInfo()">
                                {{ copyright }}
                            </div>
                        }
                    </div>
                </ng-template>
            </p-menubar>
        } @else {
            <p-menubar class="main-bar" [model]="menuItems" [breakpoint]="desktopMenubarBreakpoint">
                <ng-template #start>
                    @if (!environment.visualizationOnly) {
                        <search-panel></search-panel>
                    }
                </ng-template>
                <ng-template #item let-item let-root="root">
                    <a pRipple class="p-menubar-item-link" [ngClass]="{'sync-option-active': isSyncViewOptionActive(item)}">
                        <span class="material-symbols-outlined">{{ item.icon }}</span>
                        <span>{{ item.name }}</span>
                        @if (!root && item.items?.length) {
                            <span class="pi submenu-indicator pi-angle-right"></span>
                        }
                    </a>
                </ng-template>
                <ng-template #end>
                    <div style="display: flex; flex-direction: row; gap: 0; align-items: center">
                        <diagnostics-indicator></diagnostics-indicator>
                        @if (copyright.length) {
                            <div class="copyright-info" (click)="openLegalInfo()">
                                {{ copyright }}
                            </div>
                        }
                    </div>
                </ng-template>
            </p-menubar>
        }
    `,
    styles: [
        `
            .copyright-info {
                width: 6.5em;
                font-size: 0.8em;
                word-wrap: break-word;
                text-align: end;
                cursor: pointer;
                margin-right: 0.5em;
            }
        `
    ],
    standalone: false
})
export class MainBarComponent implements AfterViewInit, OnDestroy {
    private readonly subscriptions = new Subscription();
    private mediaQueryList?: MediaQueryList;
    private mediaQueryChangeListener?: (event: MediaQueryListEvent) => void;
    private viewerLayoutResizeObserver?: ResizeObserver;
    private viewerLayoutElement?: HTMLElement;
    private viewportMobileMenubar = false;
    private viewerLayoutMobileMenubar = false;

    protected isMobileMenubar = false;
    protected readonly desktopMenubarBreakpoint = MAIN_BAR_BREAKPOINT;
    protected readonly forcedMobileMenubarBreakpoint = MAIN_BAR_FORCED_MOBILE_BREAKPOINT;
    protected readonly environment = environment;
    menuItems: MenuItem[] = [];
    copyright: string = '';

    constructor(public mapService: MapDataService,
                public styleService: StyleService,
                public stateService: AppStateService,
                public editorService: EditorService,
                private diagnostics: DiagnosticsFacadeService,
                private elementRef: ElementRef<HTMLElement>,
                private ngZone: NgZone) {
        this.setupMobileMenuTracking();
        this.initializeViewerLayoutMobileState();
        this.rebuildMenuItems();
        this.subscriptions.add(this.mapService.legalInformationUpdated.subscribe(_ => {
            this.copyright = '';
            let firstSet: Set<string> | undefined = this.mapService.legalInformationPerMap.values().next().value;
            if (firstSet !== undefined && firstSet.size) {
                this.copyright = '© '
                    .concat(firstSet.values().next().value as string)
                    .slice(0, 22)
                    .trim()
                    .concat('…')
                    .replace(' ', ' ');
            }
        }));
        this.subscriptions.add(this.stateService.numViewsState.subscribe(numViews => {
            this.rebuildMenuItems(numViews);
        }));
        this.subscriptions.add(this.stateService.viewSyncState.subscribe(() => {
            this.rebuildMenuItems();
        }));
    }

    ngAfterViewInit() {
        this.setupViewerLayoutTracking();
    }

    ngOnDestroy() {
        this.teardownMobileMenuTracking();
        this.teardownViewerLayoutTracking();
        this.subscriptions.unsubscribe();
    }

    private setupMobileMenuTracking() {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return;
        }
        this.mediaQueryList = window.matchMedia(MAIN_BAR_MEDIA_QUERY);
        this.viewportMobileMenubar = this.mediaQueryList.matches;
        this.isMobileMenubar = this.viewportMobileMenubar || this.viewerLayoutMobileMenubar;
        this.mediaQueryChangeListener = (event: MediaQueryListEvent) => {
            this.viewportMobileMenubar = event.matches;
            this.updateMobileMenubarState();
        };
        if (typeof this.mediaQueryList.addEventListener === 'function') {
            this.mediaQueryList.addEventListener('change', this.mediaQueryChangeListener);
        } else {
            this.mediaQueryList.addListener(this.mediaQueryChangeListener);
        }
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

    private teardownMobileMenuTracking() {
        if (!this.mediaQueryList || !this.mediaQueryChangeListener) {
            return;
        }
        if (typeof this.mediaQueryList.removeEventListener === 'function') {
            this.mediaQueryList.removeEventListener('change', this.mediaQueryChangeListener);
        } else {
            this.mediaQueryList.removeListener(this.mediaQueryChangeListener);
        }
        this.mediaQueryChangeListener = undefined;
        this.mediaQueryList = undefined;
    }

    private initializeViewerLayoutMobileState() {
        const viewerLayoutElement = this.findViewerLayoutElement();
        if (!viewerLayoutElement) {
            return;
        }

        this.viewerLayoutElement = viewerLayoutElement;
        const width = viewerLayoutElement.getBoundingClientRect().width;
        if (typeof width !== 'number' || width <= 0) {
            return;
        }

        this.viewerLayoutMobileMenubar = width < this.getViewerLayoutMobileBreakpointPx();
        this.isMobileMenubar = this.viewportMobileMenubar || this.viewerLayoutMobileMenubar;
    }

    private setupViewerLayoutTracking() {
        const viewerLayoutElement = this.viewerLayoutElement ?? this.findViewerLayoutElement();
        if (!viewerLayoutElement) {
            return;
        }

        this.viewerLayoutElement = viewerLayoutElement;
        if (typeof ResizeObserver !== 'undefined') {
            this.viewerLayoutResizeObserver = new ResizeObserver(entries => {
                this.ngZone.run(() => {
                    const [entry] = entries;
                    const width = entry?.contentRect.width ?? this.viewerLayoutElement?.getBoundingClientRect().width;
                    if (typeof width === 'number') {
                        this.updateViewerLayoutMobileState(width);
                    }
                });
            });
            this.viewerLayoutResizeObserver.observe(viewerLayoutElement);
        }
    }

    private teardownViewerLayoutTracking() {
        this.viewerLayoutResizeObserver?.disconnect();
        this.viewerLayoutResizeObserver = undefined;
        this.viewerLayoutElement = undefined;
    }

    private updateViewerLayoutMobileState(width: number) {
        this.viewerLayoutMobileMenubar = width < this.getViewerLayoutMobileBreakpointPx();
        this.updateMobileMenubarState();
    }

    private updateMobileMenubarState() {
        const isMobileMenubar = this.viewportMobileMenubar || this.viewerLayoutMobileMenubar;
        if (this.isMobileMenubar === isMobileMenubar) {
            return;
        }
        this.isMobileMenubar = isMobileMenubar;
        this.rebuildMenuItems();
    }

    private findViewerLayoutElement(): HTMLElement | undefined {
        const viewerLayoutElement = this.elementRef.nativeElement.closest('.viewer-layout');
        return viewerLayoutElement instanceof HTMLElement ? viewerLayoutElement : undefined;
    }

    private getViewerLayoutMobileBreakpointPx(): number {
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
            return MAIN_BAR_VIEWER_LAYOUT_BREAKPOINT_EM * 16;
        }

        const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        const effectiveRootFontSize = Number.isFinite(rootFontSize) ? rootFontSize : 16;
        return MAIN_BAR_VIEWER_LAYOUT_BREAKPOINT_EM * effectiveRootFontSize;
    }

    private rebuildMenuItems(numViews: number = this.stateService.numViews): void {
        this.menuItems = this.buildMenuItems(numViews, this.isMobileMenubar);
    }

    private buildMenuItems(numViews: number, includeMobileMaps: boolean): MenuItem[] {
        const menuItems: MenuItem[] = [
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
                        visible: numViews <= 1,
                        command: () => { this.stateService.numViews = 2; }
                    },
                    {
                        name: 'Close Right View',
                        icon: 'tab_close',
                        visible: numViews > 1,
                        command: () => { this.stateService.numViews = 1; }
                    },
                    {
                        name: 'Sync Views',
                        icon: 'sync',
                        items: [
                            {
                                name: "Position",
                                icon: "location_on",
                                command: () => { this.toggleSyncOption(VIEW_SYNC_POSITION); }
                            },
                            {
                                name: "Movement",
                                icon: "drag_pan",
                                command: () => { this.toggleSyncOption(VIEW_SYNC_MOVEMENT); }
                            },
                            {
                                name: "Projection",
                                icon: "3d_rotation",
                                command: () => { this.toggleSyncOption(VIEW_SYNC_PROJECTION); }
                            },
                            {
                                name: "Layers",
                                icon: "layers",
                                command: () => { this.toggleSyncOption(VIEW_SYNC_LAYERS); }
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
        if (includeMobileMaps) {
            menuItems.unshift({
                name: 'Maps',
                icon: 'stacks',
                command: () => { this.showMapsPanel(); }
            });
        }
        return menuItems;
    }

    private toggleSyncOption(code: string): void {
        this.stateService.syncOptions.forEach(option => {
            if (option.code === code) {
                option.value = !option.value;
            }
        });
        this.stateService.updateSelectedSyncOptions();
    }

    protected isSyncViewOptionActive(item: MenuItem): boolean {
        const itemName = item['name'];
        switch (itemName) {
            case 'Position':
                return this.stateService.viewSync.includes(VIEW_SYNC_POSITION);
            case 'Movement':
                return this.stateService.viewSync.includes(VIEW_SYNC_MOVEMENT);
            case 'Projection':
                return this.stateService.viewSync.includes(VIEW_SYNC_PROJECTION);
            case 'Layers':
                return this.stateService.viewSync.includes(VIEW_SYNC_LAYERS);
            default:
                return false;
        }
    }
}
