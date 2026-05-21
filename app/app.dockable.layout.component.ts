import {Component, DoCheck, ElementRef, OnDestroy, Renderer2, ViewChild} from '@angular/core';
import {environment} from "./environments/environment";
import {AppStateService, INSPECTION_DOCK_TAB_ID, SEARCH_DOCK_TAB_ID} from "./shared/appstate.service";
import {FeatureSearchService, FeatureSearchSession} from "./search/feature.search.service";

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
                                        <p-badge [value]="dockedFeatureSearchCount()"/>
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
                                        <div class="feature-search-dock-container"
                                             [ngClass]="{
                                                 'single-panel': dockedFeatureSearchCount() === 1,
                                                 'multi-panel': dockedFeatureSearchCount() > 1
                                            }">
                                            @for (session of dockedFeatureSearchSessions(); track session.id) {
                                                <feature-search [searchId]="session.id"
                                                                [dockedPanelCount]="dockedFeatureSearchCount()"
                                                                [ngClass]="{'dragging': draggedSearchId === session.id,
                                                                            'drop-before': dropBeforeSearchId === session.id,
                                                                            'drop-after': dropAfterSearchId === session.id}"
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
    protected draggedSearchId?: string;
    protected dropBeforeSearchId?: string;
    protected dropAfterSearchId?: string;
    private searchDragStart?: {x: number, y: number};
    private searchDragPointerId?: number;
    private searchDragActive = false;
    private searchDropIndex?: number;
    private searchDetachMove?: () => void;
    private searchDetachUp?: () => void;
    private searchDragPreviewElement?: HTMLDivElement;
    private searchDragPreviewOffset = {x: 0, y: 0};

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
        this.resetSearchDockDrag();
        this.clearScheduledDockResizePauseEnd();
        this.dispatchDockResizePauseEnd();
    }

    /** Closes the right-hand dock without changing any surface dock state. */
    protected closeDock() {
        this.stateService.isDockOpen = false;
    }

    /** Starts drag tracking for a docked Feature Search panel. */
    protected onFeatureSearchPanelDragRequest(payload: {session: FeatureSearchSession, event: PointerEvent}): void {
        if (this.searchDragActive || payload.event.button !== 0) {
            return;
        }
        const event = payload.event;
        this.draggedSearchId = payload.session.id;
        this.searchDragPointerId = event.pointerId;
        this.searchDragStart = {x: event.clientX, y: event.clientY};
        this.searchDragActive = false;
        this.searchDropIndex = undefined;
        this.dropBeforeSearchId = undefined;
        this.dropAfterSearchId = undefined;
        this.clearSearchDragPreview();
        this.searchDetachMove?.();
        this.searchDetachUp?.();
        this.searchDetachMove = this.renderer.listen('window', 'pointermove', (ev: PointerEvent) => this.onSearchDockDragMove(ev));
        this.searchDetachUp = this.renderer.listen('window', 'pointerup', (ev: PointerEvent) => this.onSearchDockDragEnd(ev));
    }

    private onSearchDockDragMove(event: PointerEvent): void {
        if (!this.searchDragStart || event.pointerId !== this.searchDragPointerId) {
            return;
        }
        const distance = Math.hypot(event.clientX - this.searchDragStart.x, event.clientY - this.searchDragStart.y);
        if (!this.searchDragActive && distance < this.stateService.baseFontSize * 0.5) {
            return;
        }
        if (!this.searchDragActive) {
            this.searchDragActive = true;
            document.body.classList.add('dialog-dragging');
        }
        this.ensureSearchDragPreview(event);
        this.positionSearchDragPreview(event.clientX, event.clientY);
        if (this.isPointInSearchDock(event.clientX, event.clientY)) {
            this.updateSearchDropTarget(event.clientY);
        } else {
            this.searchDropIndex = undefined;
            this.dropBeforeSearchId = undefined;
            this.dropAfterSearchId = undefined;
        }
    }

    private onSearchDockDragEnd(event: PointerEvent): void {
        if (event.pointerId !== this.searchDragPointerId) {
            return;
        }
        const searchId = this.draggedSearchId;
        if (this.searchDragActive && searchId) {
            if (this.isPointInSearchDock(event.clientX, event.clientY)) {
                this.updateSearchDropTarget(event.clientY);
                this.applySearchReorder(searchId);
            } else {
                this.undockSearchAt(searchId, event);
            }
        }
        this.resetSearchDockDrag();
    }

    private applySearchReorder(searchId: string): void {
        const displayOrder = this.dockedFeatureSearchSessions().map(session => session.id);
        if (displayOrder.length < 2) {
            return;
        }
        const filtered = displayOrder.filter(id => id !== searchId);
        const dropIndex = Math.min(Math.max(this.searchDropIndex ?? filtered.length, 0), filtered.length);
        const nextDisplayOrder = filtered.slice();
        nextDisplayOrder.splice(dropIndex, 0, searchId);
        if (displayOrder.some((id, index) => id !== nextDisplayOrder[index])) {
            const layoutOrder = nextDisplayOrder.map(id => FeatureSearchService.layoutIdForSearch(id));
            this.stateService.reorderDockedSurfaces(SEARCH_DOCK_TAB_ID, layoutOrder);
        }
    }

    private updateSearchDropTarget(clientY: number): void {
        const container = this.searchDockContainer();
        if (!container || !this.draggedSearchId) {
            return;
        }
        const elements = Array.from(container.querySelectorAll<HTMLElement>('feature-search'))
            .map(el => ({el, id: el.dataset['surfaceId']}))
            .filter(entry => !!entry.id && entry.id !== this.draggedSearchId);
        if (!elements.length) {
            this.searchDropIndex = 0;
            this.dropBeforeSearchId = undefined;
            this.dropAfterSearchId = undefined;
            return;
        }
        let dropIndex = elements.length;
        for (let i = 0; i < elements.length; i++) {
            const rect = elements[i].el.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                dropIndex = i;
                break;
            }
        }
        this.searchDropIndex = dropIndex;
        this.dropBeforeSearchId = dropIndex < elements.length ? elements[dropIndex].id : undefined;
        this.dropAfterSearchId = dropIndex >= elements.length ? elements[elements.length - 1].id : undefined;
    }

    private undockSearchAt(searchId: string, event: PointerEvent): void {
        const session = this.featureSearchService.getSession(searchId);
        if (!session) {
            return;
        }
        const fallbackOffset = this.stateService.baseFontSize;
        const offsetX = this.searchDragPreviewElement ? this.searchDragPreviewOffset.x : fallbackOffset;
        const offsetY = this.searchDragPreviewElement ? this.searchDragPreviewOffset.y : fallbackOffset;
        this.stateService.setDialogPosition(session.layoutId, {
            left: Math.max(0, Math.round(event.clientX - offsetX)),
            top: Math.max(0, Math.round(event.clientY - offsetY))
        });
        this.featureSearchService.setSessionDocked(searchId, false);
    }

    private isPointInSearchDock(x: number, y: number): boolean {
        const rect = this.searchDockContainer()?.getBoundingClientRect();
        return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    private searchDockContainer(): HTMLElement | null {
        return this.dockRef?.nativeElement.querySelector('.feature-search-dock-container') ?? null;
    }

    private ensureSearchDragPreview(event: PointerEvent): void {
        if (this.searchDragPreviewElement || !this.draggedSearchId) {
            return;
        }
        const panelElement = this.searchDockContainer()
            ?.querySelector<HTMLElement>(`feature-search[data-surface-id="${this.draggedSearchId}"]`);
        if (!panelElement) {
            return;
        }
        const rect = panelElement.getBoundingClientRect();
        this.searchDragPreviewOffset = {
            x: Math.min(Math.max((this.searchDragStart?.x ?? event.clientX) - rect.left, 0), rect.width),
            y: Math.min(Math.max((this.searchDragStart?.y ?? event.clientY) - rect.top, 0), rect.height)
        };
        const previewElement = this.renderer.createElement('div') as HTMLDivElement;
        this.renderer.addClass(previewElement, 'app-dock-drag-preview');
        this.renderer.setStyle(previewElement, 'width', `${Math.round(rect.width)}px`);
        this.renderer.setStyle(previewElement, 'height', `${Math.round(rect.height)}px`);
        const header = panelElement.querySelector<HTMLElement>('.p-accordionheader');
        if (header) {
            const headerClone = header.cloneNode(true) as HTMLElement;
            this.renderer.addClass(headerClone, 'app-dock-drag-preview-header');
            this.renderer.appendChild(previewElement, headerClone);
        }
        const fillElement = this.renderer.createElement('div') as HTMLDivElement;
        this.renderer.addClass(fillElement, 'app-dock-drag-preview-fill');
        this.renderer.appendChild(previewElement, fillElement);
        this.renderer.appendChild(document.body, previewElement);
        this.searchDragPreviewElement = previewElement;
    }

    private positionSearchDragPreview(clientX: number, clientY: number): void {
        if (!this.searchDragPreviewElement) {
            return;
        }
        this.renderer.setStyle(this.searchDragPreviewElement, 'left', `${Math.round(clientX - this.searchDragPreviewOffset.x)}px`);
        this.renderer.setStyle(this.searchDragPreviewElement, 'top', `${Math.round(clientY - this.searchDragPreviewOffset.y)}px`);
    }

    private clearSearchDragPreview(): void {
        this.searchDragPreviewElement?.remove();
        this.searchDragPreviewElement = undefined;
        this.searchDragPreviewOffset = {x: 0, y: 0};
    }

    private resetSearchDockDrag(): void {
        this.searchDetachMove?.();
        this.searchDetachUp?.();
        this.searchDetachMove = undefined;
        this.searchDetachUp = undefined;
        this.clearSearchDragPreview();
        this.searchDragStart = undefined;
        this.searchDragPointerId = undefined;
        this.searchDragActive = false;
        this.draggedSearchId = undefined;
        this.searchDropIndex = undefined;
        this.dropBeforeSearchId = undefined;
        this.dropAfterSearchId = undefined;
        document.body.classList.remove('dialog-dragging');
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
