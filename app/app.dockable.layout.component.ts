import {ChangeDetectorRef, Component, DoCheck, ElementRef, OnDestroy, Renderer2, ViewChild} from '@angular/core';
import {environment} from "./environments/environment";
import {AppStateService, INSPECTION_DOCK_TAB_ID, SEARCH_DOCK_TAB_ID} from "./shared/appstate.service";
import {FeatureSearchService, FeatureSearchSession} from "./search/feature.search.service";
import {DockedPanelDragController, DockedPanelDragOffset} from "./shared/docked-panel-drag.controller";
import {Subscription} from "rxjs";
import {MAP_VIEW_LAYOUT_RESIZE_PREPARE_EVENT} from "./mapview/render-view.model";

@Component({
    selector: 'dockable-layout',
    template: `
        <div class="main-layout">
            <div #viewerLayout class="viewer-layout" [ngClass]="{'open': !stateService.isDockOpen, 'collapsed': stateService.isDockOpen}">
                <mapview-container></mapview-container>
                @if (!environment.visualizationOnly) {
                    <main-bar></main-bar>
                    <coordinates-panel></coordinates-panel>
                    <div class="dock-toggle" (click)="toggleDock()">
                        @if (stateService.isDockOpen) {
                            <span class="material-symbols-outlined" pTooltip="Collapse dock">
                                chevron_forward
                            </span>
                        } @else {
                            <span class="material-symbols-outlined" pTooltip="Open dock">
                                chevron_backward
                            </span>
                        }
                    </div>
                }
            </div>
            @if (!environment.visualizationOnly) {
                <div #dock class="collapsible-dock" [ngClass]="{'collapsed': !this.stateService.isDockOpen, 'open': stateService.isDockOpen}">
                    @if (stateService.isDockOpen) {
                        <div class="resize-handle" (pointerdown)="onResizeStart($event)"></div>
                    }
                    <div class="drop-hint"></div>
                    @if (hasVisibleDockTabs()) {
                        <p-tabs class="app-dock-tabs"
                                [value]="stateService.dockActiveTab"
                                (valueChange)="onDockTabChange($event)"
                                scrollable>
                            <p-tablist>
                                @if (hasDockedInspections()) {
                                    <p-tab [value]="inspectionDockTabId">
                                        <span>Inspection</span>
                                        <p-badge [value]="dockedInspectionCount()"/>
                                    </p-tab>
                                }
                                @if (isFeatureSearchDocked()) {
                                    <p-tab [value]="searchDockTabId">
                                        <span>Search</span>
                                        <p-badge [value]="dockedFeatureSearchCount()"/>
                                    </p-tab>
                                }
                            </p-tablist>
                            <p-button class="dock-tabbar-close-button"
                                      icon="pi pi-times"
                                      severity="secondary"
                                      ariaLabel="Close dock"
                                      pTooltip="Close dock"
                                      tooltipPosition="bottom"
                                      (click)="closeDock()"
                                      (mousedown)="$event.stopPropagation()"/>
                            <p-tabpanels>
                                @if (hasDockedInspections()) {
                                    <p-tabpanel [value]="inspectionDockTabId">
                                        <inspection-container [ngClass]="{'hidden': !stateService.isDockOpen}"></inspection-container>
                                    </p-tabpanel>
                                }
                                @if (isFeatureSearchDocked()) {
                                    <p-tabpanel [value]="searchDockTabId">
                                        <div class="feature-search-dock-container"
                                             [ngClass]="{
                                                 'reordering': searchDockDrag.state.isReordering,
                                                 'single-panel': dockedFeatureSearchCount() === 1,
                                                 'multi-panel': dockedFeatureSearchCount() > 1
                                            }">
                                            @for (session of dockedFeatureSearchSessions(); track session.id) {
                                                <feature-search [searchId]="session.id"
                                                                [dockedPanelCount]="dockedFeatureSearchCount()"
                                                                [ngClass]="{'dragging': searchDockDrag.state.draggedId === session.id,
                                                                            'drop-before': searchDockDrag.state.dropBeforeId === session.id,
                                                                            'drop-after': searchDockDrag.state.dropAfterId === session.id}"
                                                                [attr.data-surface-id]="session.id"
                                                                (panelDragRequest)="onFeatureSearchPanelDragRequest($event)"></feature-search>
                                            }
                                        </div>
                                    </p-tabpanel>
                                }
                            </p-tabpanels>
                        </p-tabs>
                    } @else {
                        <div class="dock-empty">
                            <p-button class="close-dock-button" icon="pi pi-times" severity="secondary" (click)="closeDock()"
                                      (mousedown)="$event.stopPropagation()"/>
                            <span class="material-symbols-outlined dock-empty-icon" aria-hidden="true">subtitles_off</span>
                            <div class="dock-empty-title">No docked panels</div>
                            <div class="dock-empty-text">
                                Select a feature, or drag a floating dockable dialogue here.
                            </div>
                        </div>
                    }
                </div>
            }
        </div>
    `,
    standalone: false
})
/**
 * Top-level viewer layout that manages the right-hand inspection dock.
 *
 * It owns dock open/close state, user-resizing of the dock, and the temporary
 * pause events used to suppress layout-sensitive work during dock transitions.
 */
export class DockableLayoutComponent implements DoCheck, OnDestroy {
    private static readonly DOCK_RESIZE_PAUSE_START_EVENT = "erdblick-dock-resize-start";
    private static readonly DOCK_RESIZE_PAUSE_END_EVENT = "erdblick-dock-resize-end";

    @ViewChild('dock') private dockRef?: ElementRef<HTMLDivElement>;
    @ViewChild('viewerLayout') private viewerLayoutRef?: ElementRef<HTMLDivElement>;
    private detachMove?: () => void;
    private detachUp?: () => void;
    private detachCancel?: () => void;
    private dockRight = 0;
    private dragging = false;
    private dockPauseEndRafFirst?: number;
    private dockPauseEndRafSecond?: number;
    private dockResizePauseActive = false;
    private dockOpenSubscription: Subscription;
    private observedDockOpen: boolean;
    protected readonly searchDockDrag: DockedPanelDragController<string>;

    constructor(public stateService: AppStateService,
                private renderer: Renderer2,
                private featureSearchService: FeatureSearchService,
                private cdr: ChangeDetectorRef) {
        this.observedDockOpen = this.stateService.isDockOpen;
        this.dockOpenSubscription = this.stateService.dockOpenState.subscribe(nextDockOpen => {
            if (nextDockOpen === this.observedDockOpen) {
                return;
            }
            this.observedDockOpen = nextDockOpen;
            const viewerLayout = this.viewerLayoutRef?.nativeElement;
            if (!viewerLayout) {
                return;
            }

            this.dispatchDockResizePauseStart();
            const viewerWidth = viewerLayout.getBoundingClientRect().width;
            this.cdr.detectChanges();
            const targetViewerWidth = viewerLayout.getBoundingClientRect().width;

            if (!Number.isFinite(viewerWidth) || !Number.isFinite(targetViewerWidth) || viewerWidth <= 0
                || Math.abs(targetViewerWidth - viewerWidth) < 0.5) {
                this.scheduleDockResizePauseEnd();
                return;
            }

            window.dispatchEvent(new Event(MAP_VIEW_LAYOUT_RESIZE_PREPARE_EVENT));
            this.scheduleDockResizePauseEnd();
        });
        this.searchDockDrag = new DockedPanelDragController<string>({
            renderer: this.renderer,
            baseFontSize: () => this.stateService.baseFontSize,
            container: () => this.dockRef?.nativeElement.querySelector('.feature-search-dock-container') ?? null,
            itemSelector: 'feature-search',
            readId: element => element.dataset['surfaceId'],
            previewClass: 'app-dock-drag-preview',
            previewHeaderClass: 'app-dock-drag-preview-header',
            previewFillClass: 'app-dock-drag-preview-fill',
            applyReorder: nextDisplayOrder => {
                const layoutOrder = nextDisplayOrder.map(id => FeatureSearchService.layoutIdForSearch(id));
                this.stateService.reorderDockedSurfaces(SEARCH_DOCK_TAB_ID, layoutOrder);
            },
            undock: (searchId, event, offset) => this.undockSearchAt(searchId, event, offset)
        });
    }

    protected readonly environment = environment;
    protected readonly inspectionDockTabId = INSPECTION_DOCK_TAB_ID;
    protected readonly searchDockTabId = SEARCH_DOCK_TAB_ID;

    /** Toggles dock visibility; the dock-open subscription performs the resize preparation. */
    protected toggleDock() {
        this.stateService.isDockOpen = !this.stateService.isDockOpen;
    }

    protected dockedInspectionCount(): number {
        return this.stateService.selection.filter(panel => !panel.undocked).length;
    }

    protected hasDockedInspections(): boolean {
        return this.dockedInspectionCount() > 0;
    }

    protected isFeatureSearchDocked(): boolean {
        return this.dockedFeatureSearchCount() > 0;
    }

    protected dockedFeatureSearchCount(): number {
        return this.dockedFeatureSearchSessions().length;
    }

    protected dockedFeatureSearchSessions() {
        return this.featureSearchService.getDockedSessions();
    }

    protected hasVisibleDockTabs(): boolean {
        return this.visibleDockTabs().length > 0;
    }

    protected onDockTabChange(value: string | number | undefined): void {
        const nextTab = value?.toString();
        if (!nextTab || !this.visibleDockTabs().includes(nextTab)) {
            return;
        }
        this.stateService.dockActiveTab = nextTab;
    }

    /** Keeps the selected tab aligned with tabs that are currently visible. */
    ngDoCheck(): void {
        const tabs = this.visibleDockTabs();
        if (tabs.length === 0 || tabs.includes(this.stateService.dockActiveTab)) {
            return;
        }
        this.stateService.dockActiveTab = tabs[0];
    }

    /** Clears listeners and ensures the resize-pause state is reset on teardown. */
    ngOnDestroy(): void {
        this.detachMove?.();
        this.detachUp?.();
        this.detachCancel?.();
        this.dockOpenSubscription.unsubscribe();
        this.searchDockDrag.destroy();
        this.clearScheduledDockResizePauseEnd();
        this.dispatchDockResizePauseEnd();
    }

    /** Closes the right-hand dock without changing any surface dock state. */
    protected closeDock() {
        if (!this.stateService.isDockOpen) {
            return;
        }
        this.stateService.isDockOpen = false;
    }

    /** Starts drag tracking for a docked Feature Search panel. */
    protected onFeatureSearchPanelDragRequest(payload: {session: FeatureSearchSession, event: PointerEvent}): void {
        this.searchDockDrag.start(payload.session.id, payload.event);
    }

    private undockSearchAt(searchId: string, event: PointerEvent, offset: DockedPanelDragOffset): void {
        const session = this.featureSearchService.getSession(searchId);
        if (!session) {
            return;
        }
        this.stateService.setDialogPosition(session.layoutId, {
            left: Math.max(0, Math.round(event.clientX - offset.x)),
            top: Math.max(0, Math.round(event.clientY - offset.y))
        });
        this.featureSearchService.setSessionDocked(searchId, false);
    }

    /** Starts a manual dock resize interaction from the resize handle. */
    onResizeStart(ev: PointerEvent) {
        if (!this.stateService.isDockOpen || !this.dockRef) {
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        const el = this.dockRef.nativeElement;
        const rect = el.getBoundingClientRect();
        this.dockRight = rect.right;
        this.dragging = true;
        this.dispatchDockResizePauseStart();
        // Improve UX while dragging
        document.body.style.cursor = 'col-resize';
        (document.body.style as any)['userSelect'] = 'none';
        // Listen on window to capture outside the element
        this.detachMove = this.renderer.listen('window', 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
        this.detachUp = this.renderer.listen('window', 'pointerup', () => this.onPointerUp());
        this.detachCancel = this.renderer.listen('window', 'pointercancel', () => this.onPointerUp());
    }

    /** Updates the dock width while the pointer-driven resize interaction is active. */
    private onPointerMove(ev: PointerEvent) {
        if (!this.dragging || !this.dockRef) return;
        // Compute new width from left edge drag: width = rightEdge - pointerX
        const newWidth = Math.max(0, this.dockRight - ev.clientX);
        this.dockRef.nativeElement.style.width = `${newWidth}px`;
    }

    /** Finishes the dock resize interaction and restores global pointer styles. */
    private onPointerUp() {
        if (!this.dragging) return;
        this.dragging = false;
        // Cleanup listeners and body styles
        this.detachMove?.();
        this.detachUp?.();
        this.detachCancel?.();
        this.detachMove = undefined;
        this.detachUp = undefined;
        this.detachCancel = undefined;
        this.dispatchDockResizePauseEnd();
        document.body.style.cursor = '';
        (document.body.style as any)['userSelect'] = '';
    }

    /** Emits the global start event used to pause dock-sensitive work. */
    private dispatchDockResizePauseStart() {
        if (this.dockResizePauseActive) {
            return;
        }
        this.dockResizePauseActive = true;
        window.dispatchEvent(new Event(DockableLayoutComponent.DOCK_RESIZE_PAUSE_START_EVENT));
    }

    /** Emits the global end event used to resume dock-sensitive work. */
    private dispatchDockResizePauseEnd() {
        if (!this.dockResizePauseActive) {
            return;
        }
        this.dockResizePauseActive = false;
        window.dispatchEvent(new Event(DockableLayoutComponent.DOCK_RESIZE_PAUSE_END_EVENT));
    }

    /** Defers the dock-resize pause end until layout has settled across two RAFs. */
    private scheduleDockResizePauseEnd() {
        this.clearScheduledDockResizePauseEnd();
        this.dockPauseEndRafFirst = window.requestAnimationFrame(() => {
            this.dockPauseEndRafFirst = undefined;
            this.dockPauseEndRafSecond = window.requestAnimationFrame(() => {
                this.dockPauseEndRafSecond = undefined;
                this.dispatchDockResizePauseEnd();
            });
        });
    }

    /** Cancels any queued pause-end callbacks. */
    private clearScheduledDockResizePauseEnd() {
        if (this.dockPauseEndRafFirst !== undefined) {
            window.cancelAnimationFrame(this.dockPauseEndRafFirst);
            this.dockPauseEndRafFirst = undefined;
        }
        if (this.dockPauseEndRafSecond !== undefined) {
            window.cancelAnimationFrame(this.dockPauseEndRafSecond);
            this.dockPauseEndRafSecond = undefined;
        }
    }

    private visibleDockTabs(): string[] {
        const tabs: string[] = [];
        if (this.dockedInspectionCount() > 0) {
            tabs.push(INSPECTION_DOCK_TAB_ID);
        }
        if (this.isFeatureSearchDocked()) {
            tabs.push(SEARCH_DOCK_TAB_ID);
        }
        return tabs;
    }
}
