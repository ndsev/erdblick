import {AfterViewInit, Component, ElementRef, NgZone, OnDestroy} from '@angular/core';
import {Subscription} from 'rxjs';
import {MapDataService} from './mapdata/map.service';
import {
    ABOUT_DIALOG_LAYOUT_ID,
    DATASOURCES_EDITOR_DIALOG_LAYOUT_ID,
    KEYBOARD_DIALOG_LAYOUT_ID,
    LEGAL_INFO_DIALOG_LAYOUT_ID,
    PREFERENCES_DIALOG_LAYOUT_ID,
    AppStateService,
    STYLES_DIALOG_LAYOUT_ID,
    VIEW_SYNC_LAYERS,
    VIEW_SYNC_MOVEMENT,
    VIEW_SYNC_POSITION,
    VIEW_SYNC_PROJECTION
} from './shared/appstate.service';
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
        @if (mapsPanelOpen) {
            <p-button class="maps-button" data-testid="maps-toggle" (click)="closeMapsPanel()" label=""
                      tooltipPosition="bottom" tooltipStyleClass="maps-panel-button-tooltip"
                      (mouseenter)="alignMapsPanelTooltip($event)"
                      pTooltip="Close maps configuration panel">
                <span class="material-symbols-outlined">close</span>
            </p-button>
        } @else {
            <p-button class="maps-button" data-testid="maps-toggle" (click)="showMapsPanel()" icon="" label=""
                      tooltipPosition="bottom" tooltipStyleClass="maps-panel-button-tooltip"
                      (mouseenter)="alignMapsPanelTooltip($event)"
                      pTooltip="Open maps configuration panel">
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
/**
 * Main menu bar for maps, styles, view options, diagnostics, and help actions.
 *
 * It adapts between desktop and mobile layouts based on both viewport width and
 * the actual width of the viewer layout.
 */
export class MainBarComponent implements AfterViewInit, OnDestroy {
    private readonly subscriptions = new Subscription();
    private mediaQueryList?: MediaQueryList;
    private mediaQueryChangeListener?: (event: MediaQueryListEvent) => void;
    private viewerLayoutResizeObserver?: ResizeObserver;
    private viewerLayoutElement?: HTMLElement;
    private mobileMenubarStateFrame?: number;
    private mapsPanelTooltipAlignFrame?: number;
    private mapsPanelTooltipSafetyTimeout?: number;
    private viewportMobileMenubar = false;
    private viewerLayoutMobileMenubar = false;

    protected isMobileMenubar = false;
    protected readonly desktopMenubarBreakpoint = MAIN_BAR_BREAKPOINT;
    protected readonly forcedMobileMenubarBreakpoint = MAIN_BAR_FORCED_MOBILE_BREAKPOINT;
    protected readonly environment = environment;
    menuItems: MenuItem[] = [];
    copyright: string = '';

    get mapsPanelOpen(): boolean {
        return this.stateService.mapsOpenState.getValue();
    }

    constructor(public mapService: MapDataService,
                public stateService: AppStateService,
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

    /** Starts observing the viewer layout width once the main bar is attached to the DOM. */
    ngAfterViewInit() {
        this.setupViewerLayoutTracking();
    }

    /** Releases media-query, resize-observer, and tooltip-alignment resources. */
    ngOnDestroy() {
        this.teardownMobileMenuTracking();
        this.teardownViewerLayoutTracking();
        this.cancelMapsPanelTooltipAlignment();
        if (this.mobileMenubarStateFrame !== undefined) {
            window.cancelAnimationFrame(this.mobileMenubarStateFrame);
        }
        this.mobileMenubarStateFrame = undefined;
        this.subscriptions.unsubscribe();
    }

    /** Tracks viewport breakpoint changes for the mobile menubar mode. */
    private setupMobileMenuTracking() {
        this.mediaQueryList = window.matchMedia(MAIN_BAR_MEDIA_QUERY);
        this.viewportMobileMenubar = this.mediaQueryList.matches;
        this.isMobileMenubar = this.viewportMobileMenubar || this.viewerLayoutMobileMenubar;
        this.mediaQueryChangeListener = (event: MediaQueryListEvent) => {
            this.viewportMobileMenubar = event.matches;
            this.scheduleMobileMenubarStateUpdate();
        };
        this.mediaQueryList.addEventListener('change', this.mediaQueryChangeListener);
    }

    /** Opens the preferences dialog from the menu. */
    showPreferencesDialog() {
        this.stateService.openDialog(PREFERENCES_DIALOG_LAYOUT_ID);
    }

    /** Opens the keyboard-help dialog from the menu. */
    showControlsDialog() {
        this.stateService.openDialog(KEYBOARD_DIALOG_LAYOUT_ID);
    }

    /** Opens the diagnostics performance dialog from the menu. */
    openDiagnosticsPerformance() {
        this.diagnostics.openPerformanceDialog();
    }

    /** Opens the diagnostics log dialog from the menu. */
    openDiagnosticsLog() {
        this.diagnostics.openLogDialog();
    }

    /** Opens the diagnostics export dialog from the menu. */
    openDiagnosticsExport() {
        this.diagnostics.openExportDialog({
            includeProgress: true,
            includePerformance: true,
            includeLogs: true
        });
    }

    /** Opens the external user guide. */
    openHelp() {
        window.open('https://developer.nds.live/tools/mapviewer/user-guide', '_blank');
    }

    /** Opens the About dialog. */
    openAboutDialog() {
        this.stateService.openDialog(ABOUT_DIALOG_LAYOUT_ID);
    }

    /** Opens the datasource editor dialog. */
    private openDatasources() {
        this.stateService.openDialog(DATASOURCES_EDITOR_DIALOG_LAYOUT_ID);
    }

    /** Opens the styles dialog. */
    private openStylesDialog() {
        this.stateService.openDialog(STYLES_DIALOG_LAYOUT_ID);
    }

    /** Opens the maps panel. */
    protected showMapsPanel() {
        this.stateService.mapsOpenState.next(true);
    }

    /** Closes the maps panel. */
    protected closeMapsPanel() {
        this.stateService.mapsOpenState.next(false);
    }

    /** Schedules tooltip alignment for the maps-panel button tooltip. */
    protected alignMapsPanelTooltip(event: MouseEvent) {
        const target = event.currentTarget as HTMLElement | null;
        if (!target) {
            return;
        }

        this.cancelMapsPanelTooltipAlignment();
        const align = () => this.alignMapsPanelTooltipToTarget(target);
        this.mapsPanelTooltipAlignFrame = window.requestAnimationFrame(() => {
            this.mapsPanelTooltipAlignFrame = undefined;
            align();
        });
        // PrimeNG creates and measures the tooltip asynchronously; a second pass
        // catches the occasional post-frame size/position correction.
        this.mapsPanelTooltipSafetyTimeout = window.setTimeout(() => {
            this.mapsPanelTooltipSafetyTimeout = undefined;
            align();
        }, 50);
    }

    /** Opens the legal-information dialog. */
    protected openLegalInfo() {
        this.stateService.openDialog(LEGAL_INFO_DIALOG_LAYOUT_ID);
    }

    /** Aligns the maps-panel tooltip under the triggering button and keeps it on-screen. */
    private alignMapsPanelTooltipToTarget(target: HTMLElement) {
        const tooltip = document.querySelector<HTMLElement>('.maps-panel-button-tooltip');
        if (!tooltip) {
            return;
        }

        const button = target.querySelector<HTMLElement>('button') ?? target;
        const targetRect = button.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const viewportPaddingPx = 4;
        const left = Math.min(
            Math.max(targetRect.left, viewportPaddingPx),
            Math.max(viewportPaddingPx, window.innerWidth - tooltipRect.width - viewportPaddingPx)
        );

        tooltip.style.left = `${left + window.scrollX}px`;
        tooltip.style.top = `${targetRect.bottom + window.scrollY + viewportPaddingPx}px`;

        const arrow = tooltip.querySelector<HTMLElement>('.p-tooltip-arrow');
        if (arrow) {
            arrow.style.left = `${targetRect.left - left + targetRect.width / 2}px`;
        }
    }

    /** Cancels any queued tooltip-alignment passes. */
    private cancelMapsPanelTooltipAlignment() {
        if (this.mapsPanelTooltipAlignFrame !== undefined) {
            window.cancelAnimationFrame(this.mapsPanelTooltipAlignFrame);
            this.mapsPanelTooltipAlignFrame = undefined;
        }
        if (this.mapsPanelTooltipSafetyTimeout !== undefined) {
            window.clearTimeout(this.mapsPanelTooltipSafetyTimeout);
            this.mapsPanelTooltipSafetyTimeout = undefined;
        }
    }

    /** Removes the viewport breakpoint listener. */
    private teardownMobileMenuTracking() {
        if (!this.mediaQueryList || !this.mediaQueryChangeListener) {
            return;
        }
        this.mediaQueryList.removeEventListener('change', this.mediaQueryChangeListener);
        this.mediaQueryChangeListener = undefined;
        this.mediaQueryList = undefined;
    }

    /** Computes the initial viewer-layout-driven mobile menubar state. */
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

    /** Observes the viewer layout width so the menubar can collapse before it clips. */
    private setupViewerLayoutTracking() {
        const viewerLayoutElement = this.viewerLayoutElement ?? this.findViewerLayoutElement();
        if (!viewerLayoutElement) {
            return;
        }

        this.viewerLayoutElement = viewerLayoutElement;
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

    /** Releases the viewer layout resize observer. */
    private teardownViewerLayoutTracking() {
        this.viewerLayoutResizeObserver?.disconnect();
        this.viewerLayoutResizeObserver = undefined;
        this.viewerLayoutElement = undefined;
    }

    /** Updates the viewer-layout contribution to the mobile menubar state. */
    private updateViewerLayoutMobileState(width: number) {
        this.viewerLayoutMobileMenubar = width < this.getViewerLayoutMobileBreakpointPx();
        this.scheduleMobileMenubarStateUpdate();
    }

    /** Applies the effective mobile menubar state and rebuilds menu items if it changed. */
    private updateMobileMenubarState() {
        const isMobileMenubar = this.viewportMobileMenubar || this.viewerLayoutMobileMenubar;
        if (this.isMobileMenubar === isMobileMenubar) {
            return;
        }
        this.isMobileMenubar = isMobileMenubar;
        this.rebuildMenuItems();
    }

    /** Coalesces mobile-menubar recalculation into a single animation-frame callback. */
    private scheduleMobileMenubarStateUpdate() {
        if (this.mobileMenubarStateFrame !== undefined) {
            return;
        }
        this.ngZone.runOutsideAngular(() => {
            this.mobileMenubarStateFrame = window.requestAnimationFrame(() => {
                this.mobileMenubarStateFrame = undefined;
                this.ngZone.run(() => {
                    this.updateMobileMenubarState();
                });
            });
        });
    }

    /** Locates the enclosing viewer layout element for width-based menu decisions. */
    private findViewerLayoutElement(): HTMLElement | undefined {
        const viewerLayoutElement = this.elementRef.nativeElement.closest('.viewer-layout');
        return viewerLayoutElement instanceof HTMLElement ? viewerLayoutElement : undefined;
    }

    /** Converts the viewer-layout breakpoint from `em` to pixels. */
    private getViewerLayoutMobileBreakpointPx(): number {
        const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        const effectiveRootFontSize = Number.isFinite(rootFontSize) ? rootFontSize : 16;
        return MAIN_BAR_VIEWER_LAYOUT_BREAKPOINT_EM * effectiveRootFontSize;
    }

    /** Rebuilds the current menu model using the latest view count and layout mode. */
    private rebuildMenuItems(numViews: number = this.stateService.numViews): void {
        this.menuItems = this.buildMenuItems(numViews, this.isMobileMenubar);
    }

    /** Builds the PrimeNG menu model for the current application and layout state. */
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

    /** Toggles one synchronized-view option and mirrors the change into state. */
    private toggleSyncOption(code: string): void {
        const nextSelection = this.stateService.viewSync.includes(code)
            ? this.stateService.viewSync.filter(currentCode => currentCode !== code)
            : [...this.stateService.viewSync, code];
        this.stateService.updateSelectedSyncOptions(nextSelection);
    }

    /** Returns whether a menu item corresponds to an active synchronized-view option. */
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
