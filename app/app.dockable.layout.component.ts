import {
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    DoCheck,
    ElementRef,
    inject,
    OnDestroy,
    Renderer2,
    ViewChild
} from "@angular/core";
import {map, Observable, startWith, Subscription} from "rxjs";
import {ViewerUiService} from "./actions/viewer-ui.service";
import {CoordinatesPolicyService} from "./coords/coordinates-policy.service";
import {environment} from "./environments/environment";
import {InspectionStateService} from "./inspection/inspection-state.service";
import {MapInfoService} from "./mapdata/map-info.service";
import {MAP_VIEW_LAYOUT_RESIZE_PREPARE_EVENT} from "./mapview/render-view.model";
import {FeatureSearchService, FeatureSearchSession} from "./search/feature.search.service";
import {INSPECTION_DOCK_TAB_ID, LEGAL_INFO_DIALOG_LAYOUT_ID, SEARCH_DOCK_TAB_ID} from "./shared/app-layout.model";
import {AppLayoutService} from "./shared/app-layout.service";
import {AppStateService} from "./shared/appstate.service";
import {DockedPanelDragController, DockedPanelDragOffset} from "./shared/docked-panel-drag.controller";

@Component({
    selector: "dockable-layout",
    template: `
        <div class="main-layout">
            <div
                #viewerLayout
                class="viewer-layout"
                [ngClass]="{open: !layoutState.isDockOpen, collapsed: layoutState.isDockOpen}"
            >
                <mapview-container></mapview-container>
                @if (!environment.visualizationOnly) {
                    <main-bar></main-bar>
                    <coordinates-panel [coordinatesVisible]="coordinatesPolicy.effectiveEnabled"></coordinates-panel>
                    @if (copyright$ | async; as copyright) {
                        <button
                            type="button"
                            class="map-attribution"
                            data-testid="map-attribution"
                            [title]="copyright"
                            aria-label="Copyright and legal information"
                            (click)="layoutState.openDialog(legalInfoDialogId)"
                        >
                            {{ copyright }}
                        </button>
                    }
                    <div class="dock-toggle" data-testid="dock-toggle" (click)="toggleDock()">
                        @if (layoutState.isDockOpen) {
                            <span class="material-symbols-outlined" pTooltip="Collapse dock"> chevron_forward </span>
                        } @else {
                            <span class="material-symbols-outlined" pTooltip="Open dock"> chevron_backward </span>
                        }
                    </div>
                }
            </div>
            @if (!environment.visualizationOnly) {
                <div
                    #dock
                    class="collapsible-dock"
                    data-testid="inspection-dock"
                    [style.width.px]="layoutState.dockWidthState.getValue()"
                    [ngClass]="{collapsed: !this.layoutState.isDockOpen, open: layoutState.isDockOpen}"
                >
                    @if (layoutState.isDockOpen) {
                        <div class="resize-handle" (pointerdown)="onResizeStart($event)"></div>
                    }
                    <div class="drop-hint"></div>
                    @if (hasVisibleDockTabs()) {
                        <p-tabs
                            class="app-dock-tabs"
                            [value]="layoutState.dockActiveTab"
                            (valueChange)="onDockTabChange($event)"
                            scrollable
                        >
                            <p-tablist>
                                @if (hasDockedInspections()) {
                                    <p-tab [value]="inspectionDockTabId">
                                        <span>Inspection</span>
                                        <p-badge [value]="dockedInspectionCount()" />
                                    </p-tab>
                                }
                                @if (isFeatureSearchDocked()) {
                                    <p-tab [value]="searchDockTabId">
                                        <span>Search</span>
                                        <p-badge [value]="dockedFeatureSearchCount()" />
                                    </p-tab>
                                }
                            </p-tablist>
                            <p-button
                                class="dock-tabbar-close-button"
                                icon="pi pi-times"
                                severity="secondary"
                                ariaLabel="Close dock"
                                pTooltip="Close dock"
                                tooltipPosition="bottom"
                                (click)="closeDock()"
                                (mousedown)="$event.stopPropagation()"
                            />
                            <p-tabpanels>
                                @if (hasDockedInspections()) {
                                    <p-tabpanel [value]="inspectionDockTabId">
                                        <inspection-container
                                            [ngClass]="{hidden: !layoutState.isDockOpen}"
                                        ></inspection-container>
                                    </p-tabpanel>
                                }
                                @if (isFeatureSearchDocked()) {
                                    <p-tabpanel [value]="searchDockTabId">
                                        <div
                                            class="feature-search-dock-container"
                                            [ngClass]="{
                                                reordering: searchDockDrag.state.isReordering,
                                                'single-panel': dockedFeatureSearchCount() === 1,
                                                'multi-panel': dockedFeatureSearchCount() > 1
                                            }"
                                        >
                                            @for (session of dockedFeatureSearchSessions(); track session.id) {
                                                <feature-search
                                                    [searchId]="session.id"
                                                    [dockedPanelCount]="dockedFeatureSearchCount()"
                                                    [ngClass]="{
                                                        dragging: searchDockDrag.state.draggedId === session.id,
                                                        'drop-before': searchDockDrag.state.dropBeforeId === session.id,
                                                        'drop-after': searchDockDrag.state.dropAfterId === session.id
                                                    }"
                                                    [attr.data-surface-id]="session.id"
                                                    (panelDragRequest)="onFeatureSearchPanelDragRequest($event)"
                                                ></feature-search>
                                            }
                                        </div>
                                    </p-tabpanel>
                                }
                            </p-tabpanels>
                        </p-tabs>
                    } @else {
                        <div class="dock-empty">
                            <p-button
                                class="close-dock-button"
                                icon="pi pi-times"
                                severity="secondary"
                                (click)="closeDock()"
                                (mousedown)="$event.stopPropagation()"
                            />
                            <span class="material-symbols-outlined dock-empty-icon" aria-hidden="true"
                                >subtitles_off</span
                            >
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
export class DockableLayoutComponent implements AfterViewInit, DoCheck, OnDestroy {
    readonly layoutState = inject(AppLayoutService);
    readonly inspectionState = inject(InspectionStateService);
    private static readonly DOCK_RESIZE_PAUSE_START_EVENT = "erdblick-dock-resize-start";
    private static readonly DOCK_RESIZE_PAUSE_END_EVENT = "erdblick-dock-resize-end";

    @ViewChild("dock") private dockRef?: ElementRef<HTMLDivElement>;
    @ViewChild("viewerLayout") private viewerLayoutRef?: ElementRef<HTMLDivElement>;
    private detachMove?: () => void;
    private detachUp?: () => void;
    private detachCancel?: () => void;
    private dockRight = 0;
    private dragging = false;
    private dockPauseEndRafFirst?: number;
    private dockPauseEndRafSecond?: number;
    private dockResizePauseActive = false;
    private dockOpenSubscription: Subscription;
    private readonly searchSessionsSubscription: Subscription;
    private observedDockOpen: boolean;
    private unregisterResizeTarget?: () => void;
    protected readonly searchDockDrag: DockedPanelDragController<string>;
    protected readonly copyright$: Observable<string>;
    protected readonly legalInfoDialogId = LEGAL_INFO_DIALOG_LAYOUT_ID;

    constructor(
        public stateService: AppStateService,
        public coordinatesPolicy: CoordinatesPolicyService,
        private renderer: Renderer2,
        private featureSearchService: FeatureSearchService,
        private cdr: ChangeDetectorRef,
        private viewerUi: ViewerUiService,
        mapService: MapInfoService
    ) {
        // Keep the map-wide legal-information shortcut, but let layout—not a
        // fixed character limit—shorten its first notice. The dialog lists all notices.
        this.copyright$ = mapService.legalInformationUpdated.pipe(
            startWith(true),
            map(() => {
                const notices = mapService.legalInformationPerMap.values().next().value;
                const notice = notices?.values().next().value;
                return notice ? `© ${notice}` : "";
            })
        );
        this.searchSessionsSubscription = this.featureSearchService.sessionsChanged.subscribe(() =>
            this.cdr.markForCheck()
        );
        this.observedDockOpen = this.layoutState.isDockOpen;
        // detectChanges mounts runtime-backed inspection content and measures its width immediately.
        // Wait until the selection bridge has published its loading shells for this same state patch.
        this.dockOpenSubscription = this.stateService.afterStatePublication.subscribe(() => {
            const nextDockOpen = this.layoutState.isDockOpen;
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

            if (
                !Number.isFinite(viewerWidth) ||
                !Number.isFinite(targetViewerWidth) ||
                viewerWidth <= 0 ||
                Math.abs(targetViewerWidth - viewerWidth) < 0.5
            ) {
                this.scheduleDockResizePauseEnd();
                return;
            }

            window.dispatchEvent(new Event(MAP_VIEW_LAYOUT_RESIZE_PREPARE_EVENT));
            this.scheduleDockResizePauseEnd();
        });
        this.searchDockDrag = new DockedPanelDragController<string>({
            renderer: this.renderer,
            baseFontSize: () => this.layoutState.baseFontSize,
            container: () => this.dockRef?.nativeElement.querySelector(".feature-search-dock-container") ?? null,
            itemSelector: "feature-search",
            readId: (element) => element.dataset["surfaceId"],
            previewClass: "app-dock-drag-preview",
            previewHeaderClass: "app-dock-drag-preview-header",
            previewFillClass: "app-dock-drag-preview-fill",
            applyReorder: (nextDisplayOrder) => {
                const layoutOrder = nextDisplayOrder.map((id) => FeatureSearchService.layoutIdForSearch(id));
                this.layoutState.reorderDockedSurfaces(SEARCH_DOCK_TAB_ID, layoutOrder);
            },
            undock: (searchId, event, offset) => this.undockSearchAt(searchId, event, offset)
        });
    }

    protected readonly environment = environment;
    protected readonly inspectionDockTabId = INSPECTION_DOCK_TAB_ID;
    protected readonly searchDockTabId = SEARCH_DOCK_TAB_ID;

    /** Registers the live dock; only an open, idle dock accepts an explicit width. */
    ngAfterViewInit(): void {
        const dock = this.dockRef?.nativeElement;
        if (!dock) return;
        const savedWidth = this.layoutState.dockWidthState.getValue();
        if (savedWidth !== null) this.setDockWidth(savedWidth);
        this.unregisterResizeTarget = this.viewerUi.registerResizeTarget(dock, {
            describe: () => ({
                kind: "dock",
                dimensions: this.layoutState.isDockOpen ? ["widthPx"] : [],
                busy: this.dragging
            }),
            resize: (size) => {
                if ("panelSizes" in size || size.widthPx === undefined) return;
                this.dispatchDockResizePauseStart();
                this.setDockWidth(size.widthPx);
                this.layoutState.dockWidthState.next(dock.getBoundingClientRect().width);
                window.dispatchEvent(new Event(MAP_VIEW_LAYOUT_RESIZE_PREPARE_EVENT));
                this.scheduleDockResizePauseEnd();
            }
        });
    }

    /** Toggles dock visibility; the dock-open subscription performs the resize preparation. */
    protected toggleDock() {
        this.layoutState.isDockOpen = !this.layoutState.isDockOpen;
    }

    protected dockedInspectionCount(): number {
        return this.inspectionState.selection.filter((panel) => !panel.undocked).length;
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
        this.layoutState.dockActiveTab = nextTab;
    }

    /** Keeps the selected tab aligned with tabs that are currently visible. */
    ngDoCheck(): void {
        const tabs = this.visibleDockTabs();
        if (tabs.length === 0 || tabs.includes(this.layoutState.dockActiveTab)) {
            return;
        }
        this.layoutState.dockActiveTab = tabs[0];
    }

    /** Clears listeners and ensures the resize-pause state is reset on teardown. */
    ngOnDestroy(): void {
        this.unregisterResizeTarget?.();
        this.detachMove?.();
        this.detachUp?.();
        this.detachCancel?.();
        this.dockOpenSubscription.unsubscribe();
        this.searchSessionsSubscription.unsubscribe();
        this.searchDockDrag.destroy();
        this.clearScheduledDockResizePauseEnd();
        this.dispatchDockResizePauseEnd();
    }

    /** Closes the right-hand dock without changing any surface dock state. */
    protected closeDock() {
        if (!this.layoutState.isDockOpen) {
            return;
        }
        this.layoutState.isDockOpen = false;
    }

    /** Starts drag tracking for a docked Feature Search panel. */
    protected onFeatureSearchPanelDragRequest(payload: {session: FeatureSearchSession; event: PointerEvent}): void {
        this.searchDockDrag.start(payload.session.id, payload.event);
    }

    private undockSearchAt(searchId: string, event: PointerEvent, offset: DockedPanelDragOffset): void {
        const session = this.featureSearchService.getSession(searchId);
        if (!session) {
            return;
        }
        this.layoutState.setDialogPosition(session.layoutId, {
            left: Math.max(0, Math.round(event.clientX - offset.x)),
            top: Math.max(0, Math.round(event.clientY - offset.y))
        });
        this.featureSearchService.setSessionDocked(searchId, false);
    }

    /** Starts a manual dock resize interaction from the resize handle. */
    onResizeStart(ev: PointerEvent) {
        if (!this.layoutState.isDockOpen || !this.dockRef) {
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
        document.body.style.cursor = "col-resize";
        (document.body.style as any)["userSelect"] = "none";
        // Listen on window to capture outside the element
        this.detachMove = this.renderer.listen("window", "pointermove", (e: PointerEvent) => this.onPointerMove(e));
        this.detachUp = this.renderer.listen("window", "pointerup", () => this.onPointerUp());
        this.detachCancel = this.renderer.listen("window", "pointercancel", () => this.onPointerUp());
    }

    /** Updates the dock width while the pointer-driven resize interaction is active. */
    private onPointerMove(ev: PointerEvent) {
        if (!this.dragging || !this.dockRef) return;
        // Compute new width from left edge drag: width = rightEdge - pointerX
        const newWidth = Math.max(0, this.dockRight - ev.clientX);
        this.setDockWidth(newWidth);
    }

    /** Keeps a usable strip of map visible for both pointer and explicit dock resizing. */
    private setDockWidth(width: number): void {
        if (this.dockRef)
            this.dockRef.nativeElement.style.width = `${Math.max(0, Math.min(width, window.innerWidth - Math.min(160, window.innerWidth / 2)))}px`;
    }

    /** Finishes the dock resize interaction and restores global pointer styles. */
    private onPointerUp() {
        if (!this.dragging) return;
        this.dragging = false;
        if (this.dockRef)
            this.layoutState.dockWidthState.next(this.dockRef.nativeElement.getBoundingClientRect().width);
        // Cleanup listeners and body styles
        this.detachMove?.();
        this.detachUp?.();
        this.detachCancel?.();
        this.detachMove = undefined;
        this.detachUp = undefined;
        this.detachCancel = undefined;
        this.dispatchDockResizePauseEnd();
        document.body.style.cursor = "";
        (document.body.style as any)["userSelect"] = "";
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
