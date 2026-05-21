import {Component, DoCheck, ElementRef, OnDestroy, Renderer2, ViewChild} from '@angular/core';
import {environment} from "./environments/environment";
import {AppStateService, FEATURE_SEARCH_DIALOG_LAYOUT_ID, INSPECTION_DOCK_TAB_ID, SEARCH_DOCK_TAB_ID} from "./shared/appstate.service";
import {FeatureSearchService} from "./search/feature.search.service";

@Component({
    selector: 'dockable-layout',
    template: `
        <div class="main-layout">
            <div class="viewer-layout" [ngClass]="{'open': !stateService.isDockOpen, 'collapsed': stateService.isDockOpen}">
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
                                        <p-badge value="1"/>
                                    </p-tab>
                                }
                            </p-tablist>
                            <p-tabpanels>
                                @if (hasDockedInspections()) {
                                    <p-tabpanel [value]="inspectionDockTabId">
                                        <inspection-container [ngClass]="{'hidden': !stateService.isDockOpen}"></inspection-container>
                                    </p-tabpanel>
                                }
                                @if (isFeatureSearchDocked()) {
                                    <p-tabpanel [value]="searchDockTabId">
                                        <feature-search></feature-search>
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
    styles: [``],
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
    private detachMove?: () => void;
    private detachUp?: () => void;
    private detachCancel?: () => void;
    private dockRight = 0;
    private dragging = false;
    private dockPauseEndRafFirst?: number;
    private dockPauseEndRafSecond?: number;
    private dockResizePauseActive = false;

    constructor(public stateService: AppStateService,
                private renderer: Renderer2,
                private featureSearchService: FeatureSearchService) {}

    protected readonly environment = environment;
    protected readonly inspectionDockTabId = INSPECTION_DOCK_TAB_ID;
    protected readonly searchDockTabId = SEARCH_DOCK_TAB_ID;

    /** Toggles dock visibility and emits resize-pause events around the transition. */
    protected toggleDock() {
        this.dispatchDockResizePauseStart();
        this.stateService.isDockOpen = !this.stateService.isDockOpen;
        this.scheduleDockResizePauseEnd();
    }

    protected dockedInspectionCount(): number {
        return this.stateService.selection.filter(panel => !panel.undocked).length;
    }

    protected hasDockedInspections(): boolean {
        return this.dockedInspectionCount() > 0;
    }

    protected isFeatureSearchDocked(): boolean {
        return this.stateService.isSurfaceDocked(FEATURE_SEARCH_DIALOG_LAYOUT_ID) &&
            this.featureSearchService.currentSearch !== null;
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
        this.clearScheduledDockResizePauseEnd();
        this.dispatchDockResizePauseEnd();
    }

    /** Closes the right-hand dock without changing any surface dock state. */
    protected closeDock() {
        this.stateService.isDockOpen = false;
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
