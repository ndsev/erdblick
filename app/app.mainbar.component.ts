import {AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {MapInfoService} from './mapdata/map-info.service';
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
import {FeatureSearchService} from "./search/feature.search.service";
import {InfoMessageService} from "./shared/info.service";
import {StyleService} from "./styledata/style.service";

const MAIN_BAR_BREAKPOINT = '56em';
const MAIN_BAR_MEDIA_QUERY = `(max-width: ${MAIN_BAR_BREAKPOINT})`;
const MAIN_BAR_VIEWER_LAYOUT_BREAKPOINT_EM = 45;
const MAIN_BAR_FORCED_MOBILE_BREAKPOINT = '1000000px';
const SEARCH_JSON_IMPORT_MAX_BYTES = 25 * 1024 * 1024;
const STYLE_YAML_IMPORT_MAX_BYTES = 1024 * 1024;
const MENU_LABEL_MAX_LENGTH = 48;
const MENU_LABEL_ELLIPSIS = "...";

interface StyleSheetExportMenuNode {
    name: string;
    styleId?: string;
    children: Map<string, StyleSheetExportMenuNode>;
}

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
        <p-menubar class="main-bar" [model]="menuItems" [breakpoint]="menubarBreakpoint">
            <ng-template #start>
                @if (!environment.visualizationOnly) {
                    <search-panel></search-panel>
                }
            </ng-template>
            <ng-template #item let-item let-root="root">
                <a pRipple class="p-menubar-item-link"
                   [ngClass]="{'sync-option-active': isSyncViewOptionActive(item), 'p-disabled': item.disabled}"
                   [attr.aria-disabled]="item.disabled ? 'true' : null">
                    <span class="material-symbols-outlined">{{ item.icon }}</span>
                    <span>{{ item.name ?? item.label }}</span>
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
        <input #searchJsonImportInput
               type="file"
               accept=".json,application/json"
               class="hidden-file-input"
               (change)="onSearchJsonImportSelected($event)">
        <input #styleYamlImportInput
               type="file"
               accept=".yaml,.yml,application/x-yaml,text/yaml,text/plain"
               class="hidden-file-input"
               (change)="onStyleYamlImportSelected($event)">
    `,
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
    @ViewChild('searchJsonImportInput') private searchJsonImportInput?: ElementRef<HTMLInputElement>;
    @ViewChild('styleYamlImportInput') private styleYamlImportInput?: ElementRef<HTMLInputElement>;

    protected get menubarBreakpoint(): string {
        return this.isMobileMenubar
            ? this.forcedMobileMenubarBreakpoint
            : this.desktopMenubarBreakpoint;
    }

    get mapsPanelOpen(): boolean {
        return this.stateService.mapsOpenState.getValue();
    }

    constructor(public mapService: MapInfoService,
                public stateService: AppStateService,
                private diagnostics: DiagnosticsFacadeService,
                private featureSearchService: FeatureSearchService,
                private styleService: StyleService,
                private infoMessageService: InfoMessageService,
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
        this.subscriptions.add(this.featureSearchService.sessionsChanged.subscribe(() => {
            this.rebuildMenuItems();
        }));
        this.subscriptions.add(this.stateService.featureSearchState.subscribe(() => {
            this.rebuildMenuItems();
        }));
        this.subscriptions.add(this.styleService.styleGroups.subscribe(() => {
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
        window.open('https://developer.nds.live/tools/mapviewer/', '_blank');
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

    /** Opens the hidden file input used to import feature-search JSON. */
    protected triggerSearchJsonImport() {
        this.searchJsonImportInput?.nativeElement.click();
    }

    /** Opens the hidden file input used to import YAML style sheets. */
    protected triggerStyleYamlImport() {
        this.styleYamlImportInput?.nativeElement.click();
    }

    /** Reads a selected feature-search JSON file and imports it as a new search session. */
    protected async onSearchJsonImportSelected(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) {
            return;
        }
        try {
            if (file.size > SEARCH_JSON_IMPORT_MAX_BYTES) {
                this.infoMessageService.showError("Search JSON file is too large.");
                return;
            }
            const payload = JSON.parse(await file.text()) as unknown;
            this.featureSearchService.importSearchJsonPayload(payload);
            this.infoMessageService.showSuccess("Search JSON imported");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.infoMessageService.showError(`Could not import Search JSON: ${message}`);
        } finally {
            input.value = '';
        }
    }

    /** Reads a selected YAML style sheet, imports it, and opens the Style Sheets dialog. */
    protected async onStyleYamlImportSelected(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) {
            return;
        }
        try {
            if (file.size > STYLE_YAML_IMPORT_MAX_BYTES) {
                this.infoMessageService.showError("Style sheet file is too large.");
                return;
            }
            const imported = await this.styleService.importStyleYamlFile(file);
            if (imported) {
                this.infoMessageService.showSuccess("Style sheet imported");
            } else if (this.styleService.lastValidationReport && !this.styleService.lastValidationReport.valid) {
                this.infoMessageService.showError("Could not import Style Sheet: validation failed.");
            } else {
                this.infoMessageService.showError("Could not import Style Sheet: empty or invalid file.");
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.infoMessageService.showError(`Could not import Style Sheet: ${message}`);
        } finally {
            input.value = '';
            this.openStylesDialog();
        }
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
        const exportSearchItems = this.buildExportSearchItems();
        const exportStyleSheetItems = this.buildExportStyleSheetItems();
        const menuItems: MenuItem[] = [
            {
                name: 'File',
                icon: 'folder_open',
                items: [
                    {
                        name: 'Import Search',
                        icon: 'manage_search',
                        command: () => { this.triggerSearchJsonImport(); }
                    },
                    {
                        name: 'Import Style Sheet',
                        icon: 'palette',
                        command: () => { this.triggerStyleYamlImport(); }
                    },
                    {
                        name: 'Export Diagnostics',
                        icon: 'download',
                        command: () => { this.openDiagnosticsExport(); }
                    },
                    {
                        name: 'Export Search',
                        icon: 'travel_explore',
                        disabled: !exportSearchItems.length,
                        items: exportSearchItems
                    },
                    {
                        name: 'Export Style Sheet',
                        icon: 'file_save',
                        disabled: !exportStyleSheetItems.length,
                        items: exportStyleSheetItems
                    }
                ]
            },
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
                        name: 'Preferences',
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

    /** Builds the submenu for exporting live feature-search sessions. */
    private buildExportSearchItems(): MenuItem[] {
        const sessions = this.featureSearchService.getSessions();
        if (!sessions.length) {
            return [];
        }
        return sessions.map(session => ({
            name: this.ellipsizeMenuLabel(session.definition.query, session.id),
            icon: 'manage_search',
            command: () => { this.featureSearchService.openExportDialog(session.id); }
        }));
    }

    /** Builds the submenu for exporting currently loaded style sheets. */
    private buildExportStyleSheetItems(): MenuItem[] {
        const styles = Array.from(this.styleService.styles.values())
            .filter(style => !!style.source)
            .sort((left, right) => left.id.localeCompare(right.id));
        if (!styles.length) {
            return [];
        }
        const root: StyleSheetExportMenuNode = {name: "", children: new Map()};
        for (const style of styles) {
            let current = root;
            for (const segment of this.styleSheetMenuSegments(style.id)) {
                let child = current.children.get(segment);
                if (!child) {
                    child = {name: segment, children: new Map()};
                    current.children.set(segment, child);
                }
                current = child;
            }
            current.styleId = style.id;
        }
        return Array.from(root.children.values())
            .map(node => this.styleSheetExportMenuItem(node));
    }

    /** Splits a style id into menu path segments, ignoring empty slash path parts. */
    private styleSheetMenuSegments(styleId: string): string[] {
        const segments = styleId.split("/")
            .map(segment => segment.trim())
            .filter(segment => !!segment);
        return segments.length ? segments : [styleId];
    }

    /** Converts one style-sheet export tree node into a PrimeNG menu item. */
    private styleSheetExportMenuItem(node: StyleSheetExportMenuNode): MenuItem {
        const childItems = Array.from(node.children.values())
            .map(childNode => this.styleSheetExportMenuItem(childNode));
        const styleId = node.styleId;
        if (styleId && !childItems.length) {
            return {
                name: this.ellipsizeMenuLabel(node.name, styleId),
                icon: 'palette',
                command: () => { this.exportStyleSheet(styleId); }
            };
        }
        if (styleId) {
            childItems.unshift({
                name: 'Export',
                icon: 'file_save',
                command: () => { this.exportStyleSheet(styleId); }
            });
        }
        return {
            name: this.ellipsizeMenuLabel(node.name, styleId ?? node.name),
            icon: 'folder_open',
            items: childItems
        };
    }

    /** Exports one loaded style sheet and reports errors to the user. */
    private exportStyleSheet(styleId: string): void {
        if (!this.styleService.exportStyleYamlFile(styleId)) {
            this.infoMessageService.showError(`Error occurred while trying to export style: ${styleId}`);
        }
    }

    /** Shortens a dynamic menu label without losing the full label tooltip. */
    private ellipsizeMenuLabel(value: string, fallback: string): string {
        const normalized = value.trim().replace(/\s+/g, " ");
        const label = normalized || fallback;
        if (label.length <= MENU_LABEL_MAX_LENGTH) {
            return label;
        }
        const contentLength = MENU_LABEL_MAX_LENGTH - MENU_LABEL_ELLIPSIS.length;
        return `${label.slice(0, contentLength).trimEnd()}${MENU_LABEL_ELLIPSIS}`;
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
