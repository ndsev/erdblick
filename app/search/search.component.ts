import {
    ChangeDetectorRef,
    Component,
    ElementRef,
    EventEmitter,
    Input,
    OnChanges,
    OnDestroy,
    Output,
    SimpleChanges,
    ViewChild,
    ViewContainerRef
} from "@angular/core";
import { Subscription } from "rxjs";
import { AppConfirmPopupService } from "../alert/app-confirm-popup.service";
import { InfoMessageService } from "../diagnostics/info.service";
import { AppDialogComponent } from "../layout/app-dialog.component";
import { AppPanelComponent } from "../layout/app-panel.component";
import type { AppSurfaceHeaderAction } from "../layout/app-surface-header.component";
import { DialogStackService } from "../layout/dialog-stack.service";
import { SEARCH_DOCK_TAB_ID } from "../layout/layout.model";
import { LayoutService } from "../layout/layout.service";
import type { FeatureSearchScope } from "./search-definition.model";
import { SearchResultsComponent } from "./search-results.component";
import type { FeatureSearchSession } from "./search-session.model";
import {
    featureSearchActionPayloadFromCompletion,
    featureSearchSelectedMapLayersFromPayload
} from "./search-session.model";
import { CompletionCandidate } from "./search.model";
import { SearchService } from "./search.service";
import { SimfilExpressionInputComponent } from "./simfil-expression-input.component";

@Component({
    selector: "feature-search",
    template: `
        @if (session) {
            @if (isDocked()) {
                <app-panel #featureSearchPanel class="feature-search-panel" data-testid="feature-search-docked-panel"
                           [layoutId]="session.layoutId" [persistLayout]="true"
                           [dockedPanelCount]="dockedPanelCount"
                           [expanded]="featureSearchExpanded"
                           (expandedChange)="featureSearchExpanded = $event"
                           [preferredBodyHeightEm]="measurePreferredFeatureSearchHeightEm"
                           [maxBodyHeightEm]="60"
                           (onShow)="onDockedPanelShow()"
                           (bodySizeChange)="onDockedPanelBodySizeChange()">
                    <ng-template #header>
                        <ng-container *ngTemplateOutlet="searchHeader"></ng-container>
                    </ng-template>
                    <ng-template #content>
                        <ng-container *ngTemplateOutlet="searchContent"></ng-container>
                    </ng-template>
                </app-panel>
            } @else {
                <app-dialog #featureSearchDialog class="feature-search-dialog" data-testid="feature-search-dialog"
                          [closeOnEscape]="false" [modal]="false" [closable]="false"
                          [visible]="featureSearchDialogVisible" (visibleChange)="onPanelVisibleChange($event)"
                          [draggable]="true" [resizable]="true"
                          [dockDropCue]="true"
                          [persistLayout]="true" [persistOpenState]="false" [layoutId]="session.layoutId"
                          (onShow)="onDialogShow($event)"
                          (onDragEnd)="onDialogDragEnd()"
                          (onResizeEnd)="syncTreeScrollHeight()" (onHide)="onHide($event)">
                    <ng-template #header>
                        <ng-container *ngTemplateOutlet="searchHeader"></ng-container>
                    </ng-template>
                    <ng-template #content>
                        <ng-container *ngTemplateOutlet="searchContent"></ng-container>
                    </ng-template>
                </app-dialog>
            }
        }

        <ng-template #searchHeader>
            <app-surface-header class="feature-search-surface-header"
                                [title]="featureSearchTitle()"
                                titleIcon="search"
                                [titleTooltipDisabled]="true"
                                [hasSmartControl]="true"
                                [dockMode]="isDocked() ? 'undock' : 'dock'"
                                [sizeToggleVisible]="isDocked()"
                                [sizeToggleDisabled]="dockedPanelCount <= 1"
                                [expanded]="featureSearchExpanded"
                                [dragEnabled]="true"
                                [extraActions]="featureSearchHeaderActions()"
                                (focusRequest)="bringSurfaceToFront()"
                                (dockRequest)="toggleDocked()"
                                (sizeToggleRequest)="toggleExpanded()"
                                (closeRequest)="closeSearch($event)"
                                (dragPointerDown)="onHeaderPointerDown($event)">
                <p-toggleswitch surfaceHeaderSmartControl
                                [ngModel]="searchEnabled()"
                                [disabled]="!session"
                                inputId="feature-search-enabled-toggle"
                                data-testid="feature-search-enabled-toggle"
                                (click)="$event.stopPropagation()"
                                (mousedown)="$event.stopPropagation()"
                                (ngModelChange)="onSearchEnabledChange($event)">
                </p-toggleswitch>
            </app-surface-header>
        </ng-template>

        <ng-template #searchContent>
            <div #featureSearchContentContainer class="feature-search-content" [class.feature-search-content-disabled]="!searchEnabled()">
            <div class="feature-search-query omnibar-input">
                <simfil-expression-input #featureSearchQueryInput
                                         class="feature-search-query-input"
                                         [value]="featureSearchQuery"
                                         (valueChange)="onFeatureSearchQueryChange($event)"
                                         [singleLine]="!featureSearchQueryExpanded"
                                         [disabled]="!searchEnabled()"
                                         [submitOnEnter]="true"
                                         [completionOwnerId]="featureSearchCompletionOwnerId"
                                         [completionScope]="featureSearchScope"
                                         [completionMapLayers]="session?.definition?.selectedMapLayers ?? []"
                                         [completionZIndex]="featureSearchCompletionZIndex"
                                         placeholder="Search query"
                                         (clicked)="expandFeatureSearchQueryInput()"
                                         (focused)="expandFeatureSearchQueryInput()"
                                         (blurred)="shrinkFeatureSearchQueryInput()"
                                         (completionAccepted)="onFeatureSearchQueryCompletionAccepted($event)"
                                         (submitted)="rerunSearch()">
                </simfil-expression-input>
            </div>
            <search-scope [searchId]="searchId" [session]="session" [definition]="session?.definition" [analysis]="session?.schemaAnalysis"></search-scope>
            <search-diagnostics mode="progress" [searchId]="searchId" [session]="session"
                [revision]="sessionRevision" [treeIngress]="treeIngress"></search-diagnostics>
            <p-tabs [value]="resultPanelIndex"
                    (valueChange)="onResultPanelIndexChange($event)"
                    class="feature-search-tabs"
                    data-testid="feature-search-panel"
                    scrollable>
                <p-tablist>
                    <p-tab value="results">
                        <span>Results </span>
                        <p-badge [value]="resultCount"/>
                    </p-tab>
                    <p-tab value="style">
                        <span>Visualization </span>
                        <p-badge [value]="session?.definition?.searchStyleRules?.length ?? 0"/>
                    </p-tab>
                    <p-tab value="diagnostics">
                        <span>Diagnostics </span>
                        <p-badge [value]="session?.results?.diagnostics?.length ?? 0"/>
                    </p-tab>
                </p-tablist>

                <p-tabpanels>
                    <!-- Results -->
                    <p-tabpanel value="results">
                        <search-results #searchResults [searchId]="searchId" [session]="session"
                            [revision]="sessionRevision" [docked]="isDocked()"
                            (ingressChange)="onTreeIngressChange($event)"></search-results>
                    </p-tabpanel>

                    <!-- Style -->
                    <p-tabpanel value="style">
                        <search-visualization [searchId]="searchId" [session]="session"
                            [definition]="session?.definition" [analysis]="session?.schemaAnalysis"
                            [summaries]="session?.results?.valueSummaries" [active]="resultPanelIndex === 'style'"
                            [featureSearchCompletionZIndex]="featureSearchCompletionZIndex"></search-visualization>
                    </p-tabpanel>

                    <!-- Diagnostics -->
                    <p-tabpanel value="diagnostics">
                        <search-diagnostics [searchId]="searchId" [session]="session" [revision]="sessionRevision"
                            [active]="resultPanelIndex === 'diagnostics'" [queryEdited]="featureSearchQueryDirty"
                            [treeIngress]="treeIngress"></search-diagnostics>
                    </p-tabpanel>
                </p-tabpanels>
            </p-tabs>
            </div>
        </ng-template>
        <app-confirm-popup [key]="bookmarkedCloseConfirmKey"
                           styleClass="feature-search-close-confirm-popup">
            <ng-template #extraActions>
                <p-button label="Export"
                          size="small"
                          severity="secondary"
                          [outlined]="true"
                          (click)="exportBookmarkedCloseSearch()">
                </p-button>
            </ng-template>
        </app-confirm-popup>
        <div #alert></div>
    `,
    standalone: false
})
/**
 * Dialog that presents long-running feature-search progress, result grouping, styles, and diagnostics.
 */
export class SearchComponent implements OnChanges, OnDestroy {
    @Input({ required: true }) searchId!: string;
    @Input() dockedPanelCount = 1;
    @Output() panelDragRequest = new EventEmitter<{ session: FeatureSearchSession, event: PointerEvent }>();

    session?: FeatureSearchSession;
    sessionRevision = 0;
    resultCount = 0;
    treeIngress = {done: 0, total: 0};
    @ViewChild('searchResults') searchResultsComponent?: SearchResultsComponent;
    /** Publishes one completed append chunk to the independent progress presentation. */
    protected onTreeIngressChange(progress: {done: number; total: number}): void {
        // Initial input synchronization can emit during the child's check. Publish
        // afterwards so the progress sibling never changes inside the same check.
        queueMicrotask(() => {
            if (this.destroyed) return;
            this.treeIngress = progress;
            this.changeDetector.markForCheck();
        });
    }

    /** Requests layout synchronization at dialog transitions which precede ResizeObserver. */
    syncTreeScrollHeight(): void { this.searchResultsComponent?.syncTreeScrollHeight(); }

    private readonly subscriptions = new Subscription();
    featureSearchDialogVisible = true;
    canStopSearch: boolean = false;

    // Active result panel index
    resultPanelIndex: string = "results";
    featureSearchExpanded = false;
    featureSearchQuery = "";
    featureSearchQueryDirty = false;
    featureSearchQueryExpanded = false;
    featureSearchCompletionOwnerId = "";
    featureSearchCompletionZIndex = 30050;
    featureSearchScope: FeatureSearchScope = 'auto';
    private lastSearchQuery = "";
    private activeSearchGroupId = "";
    private completedSearchGroupId = "";
    private lastErrorAlertSignature = "";
    private surfacedDockedSearchId = "";
    private closingSearchId: string | null = null;
    private pendingBookmarkedCloseSessionId: string | null = null;
    private featureSearchHeaderActionsSignature = "";
    private featureSearchHeaderActionsCache: AppSurfaceHeaderAction[] = [];
    private sessionSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    protected readonly measurePreferredFeatureSearchHeightEm = () => this.measurePreferredBodyHeightEm();

    @ViewChild('alert', { read: ViewContainerRef, static: true }) alertContainer!: ViewContainerRef;
    @ViewChild('featureSearchContentContainer') featureSearchContentContainer?: ElementRef<HTMLElement>;
    @ViewChild('featureSearchQueryInput') featureSearchQueryInput?: SimfilExpressionInputComponent;
    @ViewChild('featureSearchDialog') featureSearchDialog: AppDialogComponent | undefined;
    @ViewChild('featureSearchPanel') featureSearchPanel: AppPanelComponent | undefined;

    /**
     * Subscribes to search progress and keeps the dialog state synchronized with the active search.
     */
    constructor(public searchService: SearchService,
        private infoMessageService: InfoMessageService,
        private dialogStack: DialogStackService,
        private confirmPopupService: AppConfirmPopupService,
        public readonly layout: LayoutService,
        private readonly changeDetector: ChangeDetectorRef) {
        this.subscriptions.add(this.searchService.progress.subscribe(updatedSession => {
            if (!updatedSession || updatedSession.id !== this.searchId) {
                return;
            }
            this.scheduleSessionSync();
        }));
        this.subscriptions.add(this.searchService.sessionsChanged.subscribe(() => {
            this.scheduleSessionSync();
        }));

    }

    /** Rebinds this visual wrapper when the owning session id changes. */
    ngOnChanges(changes: SimpleChanges): void {
        if (changes['searchId']) {
            this.bindSession();
            this.featureSearchCompletionOwnerId = `feature-search:${this.searchId}`;
        }
    }

    /** Loads the current session snapshot for this component instance. */
    private bindSession(): void {
        const session = this.searchService.getSession(this.searchId);
        if (!session) {
            this.session = undefined;
            this.resetLocalState();
            return;
        }
        this.syncFromSession(session);
    }

    /** Coalesces external session emissions behind the active Angular check. */
    private scheduleSessionSync(): void {
        if (this.destroyed || this.sessionSyncTimer !== null) {
            return;
        }
        this.sessionSyncTimer = setTimeout(() => {
            this.sessionSyncTimer = null;
            if (this.destroyed) return;
            const session = this.searchService.getSession(this.searchId);
            if (session) {
                this.syncFromSession(session);
                this.changeDetector.markForCheck();
            }
        }, 0);
    }

    /** Copies session state into the local view model without crossing streams between searches. */
    private syncFromSession(session: FeatureSearchSession): void {
        this.session = session;
        this.sessionRevision += 1;
        this.resultCount = session.results.searchResults.length;
        this.featureSearchDialogVisible = true;
        const wasQueryDirty = this.featureSearchQueryDirty;
        const previousQuery = this.lastSearchQuery;
        const previousScope = this.featureSearchScope;
        this.lastSearchQuery = session.definition.query;
        this.featureSearchScope = session.definition.scope;
        if (this.activeSearchGroupId !== session.runId) {
            this.activeSearchGroupId = session.runId;
            this.completedSearchGroupId = "";
            this.lastErrorAlertSignature = "";
            if (!wasQueryDirty) {
                this.featureSearchQuery = session.definition.query;
            }
            if (previousQuery !== session.definition.query
                || previousScope !== session.definition.scope
                || this.resultPanelIndex !== 'style') {
                this.resultPanelIndex = 'results';
            }
        } else if (!wasQueryDirty && this.featureSearchQuery !== session.definition.query) {
            this.featureSearchQuery = session.definition.query;
        }
        this.updateFeatureSearchQueryDirty();
        if (this.isDocked() && this.layout.state.isDockOpen && this.surfacedDockedSearchId !== session.id) {
            this.layout.state.dockActiveTab = SEARCH_DOCK_TAB_ID;
            this.surfacedDockedSearchId = session.id;
        }
        if (session.results.complete) {
            this.searchResultReady(this.completedSearchGroupId !== session.runId);
            this.completedSearchGroupId = session.runId;
            this.canStopSearch = false;
        } else {
            this.canStopSearch = true;
            this.completedSearchGroupId = "";
        }
    }

    /** Stops feature search subscriptions when the component is destroyed. */
    ngOnDestroy() {
        this.destroyed = true;
        this.subscriptions.unsubscribe();
        if (this.sessionSyncTimer !== null) {
            clearTimeout(this.sessionSyncTimer);
            this.sessionSyncTimer = null;
        }
    }

    protected isDocked(): boolean {
        return !!this.session && this.searchService.isSessionDocked(this.session.id);
    }

    protected searchEnabled(): boolean {
        return this.session?.definition.enabled ?? true;
    }

    protected featureSearchTitle(): string {
        return this.session?.definition.query.trim() || "Search Loaded Features";
    }

    /**
     * Recomputes the virtual tree height once the dialog becomes measurable.
     */
    onDialogShow(event: any) {
        this.syncTreeScrollHeight();
        this.dialogStack.bringToFront(this.featureSearchDialog);
        this.refreshCompletionZIndex();
    }

    protected onDialogDragEnd() {
        const session = this.session;
        if (!session || !this.shouldDockDialog()) {
            this.dialogStack.bringToFront(this.featureSearchDialog);
            return;
        }
        this.searchService.setSessionDocked(session.id, true);
    }

    protected onDockedPanelShow() {
        this.syncTreeScrollHeight();
        this.refreshCompletionZIndex();
    }

    protected onDockedPanelBodySizeChange(): void {
        this.syncTreeScrollHeight();
    }

    private measurePreferredBodyHeightEm(): number | undefined {
        const content = this.featureSearchContentContainer?.nativeElement;
        if (!content || !this.layout.baseFontSize) {
            return undefined;
        }
        const height = content.scrollHeight / this.layout.baseFontSize;
        return Number.isFinite(height) && height > 0 ? height : undefined;
    }

    protected bringSurfaceToFront() {
        if (!this.isDocked()) {
            this.dialogStack.bringToFront(this.featureSearchDialog);
        }
    }

    private refreshCompletionZIndex() {
        const container = this.featureSearchDialog?.container();
        const inlineZIndex = container ? Number.parseInt(container.style.zIndex, 10) : Number.NaN;
        const computedZIndex = container ? Number.parseInt(window.getComputedStyle(container).zIndex, 10) : Number.NaN;
        const surfaceZIndex = Number.isFinite(inlineZIndex)
            ? inlineZIndex
            : (Number.isFinite(computedZIndex) ? computedZIndex : 30050);
        this.featureSearchCompletionZIndex = this.isDocked() ? 32070 : surfaceZIndex + 2000;
    }

    private shouldDockDialog(): boolean {
        return this.featureSearchDialog?.overlapsDockDropTarget() ?? false;
    }

    protected toggleDocked() {
        const session = this.session;
        if (!session) {
            return;
        }
        this.searchService.setSessionDocked(session.id, !this.isDocked());
        if (!this.isDocked()) {
            this.featureSearchExpanded = false;
            setTimeout(() => this.dialogStack.bringToFront(this.featureSearchDialog), 0);
        } else {
            setTimeout(() => this.syncTreeScrollHeight(), 0);
        }
    }

    protected toggleExpanded() {
        if (this.dockedPanelCount <= 1) {
            return;
        }
        this.featureSearchPanel?.toggleExpanded();
    }

    protected onHeaderPointerDown(event: PointerEvent) {
        const session = this.session;
        if (!session || event.button !== 0) {
            return;
        }
        if (this.isDocked()) {
            this.panelDragRequest.emit({ session, event });
        } else {
            this.featureSearchDialog?.startDrag(event);
        }
    }

    protected expandFeatureSearchQueryInput() {
        this.featureSearchQueryExpanded = true;
        this.refreshCompletionZIndex();
    }

    protected shrinkFeatureSearchQueryInput() {
        this.featureSearchQueryExpanded = false;
    }

    protected onFeatureSearchQueryChange(value: string): void {
        this.featureSearchQuery = value ?? "";
        this.updateFeatureSearchQueryDirty();
    }

    /** Seeds map-layer selection from a schema completion accepted in the main search-query input. */
    protected onFeatureSearchQueryCompletionAccepted(candidate: CompletionCandidate): void {
        const session = this.session;
        if (!session || !this.searchEnabled()) {
            return;
        }
        const originLayers = featureSearchSelectedMapLayersFromPayload(
            featureSearchActionPayloadFromCompletion(candidate)
        ) ?? [];
        if (!originLayers.length) {
            return;
        }

        if (this.searchService.applySearchMapLayersForDetectedContext(session.id, originLayers)) {
            this.infoMessageService.showInfo("Auto-detected map layers for search.");
        }
    }

    protected rerunSearch() {
        const query = this.searchQueryForRerun();
        if (!query || !this.session || !this.searchEnabled()) {
            return;
        }
        this.featureSearchQuery = query;
        this.lastSearchQuery = query;
        this.featureSearchQueryDirty = false;
        this.searchService.rerunSearch(this.session.id, query);
    }

    protected searchQueryForRerun(): string {
        return this.featureSearchQuery.trim() || this.session?.definition.query || this.lastSearchQuery;
    }

    protected searchQueryEdited(): boolean {
        const query = this.featureSearchQuery.trim();
        const sessionQuery = this.session?.definition.query.trim() ?? "";
        return query.length > 0 && query !== sessionQuery;
    }

    protected refreshSearchAreaOrQuery(): void {
        if (this.searchQueryEdited()) {
            this.rerunSearch();
            return;
        }
        this.updateSearchInArea();
    }

    private updateFeatureSearchQueryDirty(): void {
        const persistedQuery = this.session?.definition.query ?? this.lastSearchQuery;
        this.featureSearchQueryDirty = this.featureSearchQuery.trim() !== (persistedQuery ?? "").trim();
    }

    /** Tracks tab changes and refreshes expensive style-field metadata only when the style tab becomes visible. */
    protected onResultPanelIndexChange(value: string | number | undefined): void {
        this.resultPanelIndex = String(value ?? "results");
        if (this.resultPanelIndex === "results") {
            this.syncTreeScrollHeight();
        }
    }

    protected onFeatureSearchAutoUpdateChange(autoUpdate: boolean): void {
        if (this.session && this.searchEnabled()) {
            this.searchService.setSearchAutoUpdate(this.session.id, autoUpdate);
        }
    }

    protected onSearchEnabledChange(enabled: boolean): void {
        if (this.session) {
            this.searchService.setSearchEnabled(this.session.id, enabled);
        }
    }

    protected updateSearchInArea(): void {
        if (this.session && this.searchEnabled()) {
            this.searchService.updateSearchInArea(this.session.id);
        }
    }

    protected featureSearchHeaderActions(): AppSurfaceHeaderAction[] {
        const bookmarked = !!this.session?.definition.bookmarked;
        const enabled = this.searchEnabled();
        const autoUpdate = !!this.session?.definition.autoUpdate;
        const refreshLabel = this.searchQueryEdited() ? 'Rerun search' : 'Update area';
        const rerunQuery = this.searchQueryForRerun();
        const signature = JSON.stringify([
            this.session?.id ?? "",
            bookmarked,
            enabled,
            autoUpdate,
            refreshLabel,
            !!rerunQuery,
            this.canStopSearch
        ]);
        if (signature === this.featureSearchHeaderActionsSignature) {
            return this.featureSearchHeaderActionsCache;
        }
        this.featureSearchHeaderActionsSignature = signature;
        this.featureSearchHeaderActionsCache = [
            {
                label: bookmarked ? 'Remove bookmark' : 'Bookmark search',
                tooltip: bookmarked ? 'Remove bookmark' : 'Bookmark search',
                icon: bookmarked ? 'pi pi-bookmark-fill' : 'pi pi-bookmark',
                command: () => this.toggleSearchBookmarked()
            },
            {
                label: 'Clone search',
                tooltip: 'Clone search',
                materialIcon: 'copy_all',
                menuIcon: 'pi pi-copy',
                disabled: !this.session,
                command: () => this.cloneSearch()
            },
            {
                label: 'Auto update area',
                tooltip: autoUpdate ? 'Disable automatic area updates' : 'Enable automatic area updates',
                materialIcon: 'autorenew',
                menuIcon: 'pi pi-refresh',
                severity: autoUpdate ? 'success' : 'primary',
                disabled: !enabled || !this.session,
                command: () => this.onFeatureSearchAutoUpdateChange(!autoUpdate)
            },
            {
                label: 'Export as JSON',
                tooltip: 'Export as JSON',
                icon: 'pi pi-download',
                disabled: !this.session,
                command: () => this.exportSearchAsJson()
            },
            {
                label: refreshLabel,
                tooltip: refreshLabel,
                icon: 'pi pi-refresh',
                disabled: !enabled || !rerunQuery,
                command: () => this.refreshSearchAreaOrQuery()
            },
            {
                label: 'Stop search',
                tooltip: 'Stop search',
                icon: 'pi pi-stop-circle',
                disabled: !enabled || !this.canStopSearch,
                command: () => this.stopSearch()
            }
        ];
        return this.featureSearchHeaderActionsCache;
    }

    protected toggleSearchBookmarked(): void {
        if (this.session) {
            this.searchService.setSearchBookmarked(this.session.id, !this.session.definition.bookmarked);
        }
    }

    protected exportSearchAsJson(): void {
        const session = this.session;
        if (!session) {
            return;
        }
        this.openSearchExportDialog(session.id);
    }

    protected cloneSearch(): void {
        if (this.session) {
            this.searchService.cloneSearch(this.session.id);
        }
    }

    private openSearchExportDialog(sessionId: string, closeAfterExport = false): void {
        this.searchService.openExportDialog(sessionId, {
            closeAfterExport,
            ...this.searchResultsComponent?.exportOptions()
        });
    }

    protected get bookmarkedCloseConfirmKey(): string {
        return `feature-search-bookmarked-close:${this.searchId}`;
    }

    protected closeSearch(event?: MouseEvent): void {
        const session = this.session;
        if (!session) {
            return;
        }
        if (this.closingSearchId === session.id) {
            return;
        }
        if (session.definition.bookmarked) {
            this.showBookmarkedClosePopup(session.id, event);
            return;
        }
        this.closingSearchId = session.id;
        this.clearResultTreeBeforeClose();
        this.featureSearchDialogVisible = false;
        setTimeout(() => {
            this.searchService.closeSearch(session.id);
            if (this.closingSearchId === session.id) {
                this.closingSearchId = null;
            }
        }, 0);
    }
    /** Releases the heavy result view before removing the search session. */
    private clearResultTreeBeforeClose(): void {
        this.searchResultsComponent?.clear();
        this.resultCount = 0;
        this.treeIngress = {done: 0, total: 0};
    }

    private showBookmarkedClosePopup(sessionId: string, event?: MouseEvent): void {
        const target = this.bookmarkedClosePopupTarget(event);
        this.featureSearchDialogVisible = true;
        this.pendingBookmarkedCloseSessionId = sessionId;
        this.confirmPopupService.confirm({
            key: this.bookmarkedCloseConfirmKey,
            target,
            header: "Close bookmarked search?",
            message: "It will be permanently deleted. You can export the search before deleting.",
            severity: "error",
            accept: () => this.confirmBookmarkedCloseSearch(),
            reject: () => this.cancelBookmarkedCloseSearch()
        });
    }

    private bookmarkedClosePopupTarget(event?: MouseEvent): EventTarget {
        return (event?.currentTarget ?? event?.target)
            || this.featureSearchDialog?.container()
            || this.featureSearchPanel?.container()
            || document.body;
    }

    protected confirmBookmarkedCloseSearch(): void {
        const sessionId = this.pendingBookmarkedCloseSessionId;
        this.pendingBookmarkedCloseSessionId = null;
        if (sessionId) {
            this.searchService.closeSearch(sessionId);
        }
    }

    protected cancelBookmarkedCloseSearch(): void {
        this.pendingBookmarkedCloseSessionId = null;
        this.featureSearchDialogVisible = true;
    }

    protected exportBookmarkedCloseSearch(): void {
        const sessionId = this.pendingBookmarkedCloseSessionId;
        this.pendingBookmarkedCloseSessionId = null;
        this.confirmPopupService.close();
        if (sessionId) {
            this.openSearchExportDialog(sessionId, true);
        }
    }

    /**
     * Terminates active search work as soon as PrimeNG starts closing the dialog.
     */
    onPanelVisibleChange(visible: boolean) {
        this.featureSearchDialogVisible = visible;
        if (!visible) {
            this.closeSearch();
        }
    }

    /**
     * Finalizes the result tabs once the active search group reports completion.
     */
    searchResultReady(firstCompletionForRun = true) {
        const session = this.session;
        if (!session) {
            return;
        }
        const results = session.results.searchResults;
        const errors = session.results.errors;

        this.canStopSearch = false;
        if (firstCompletionForRun && this.resultPanelIndex !== 'style') {
            this.resultPanelIndex = 'results';
        }

        const errorSignature = Array.from(errors).join('\n');
        const errorAlertSignature = `${session.runId}:${errorSignature}`;
        if (errorSignature && this.lastErrorAlertSignature !== errorAlertSignature) {
            this.lastErrorAlertSignature = errorAlertSignature;
            this.infoMessageService.showAlertDialog(
                this.alertContainer,
                'Feature Search Errors',
                errorSignature);

        } else if (firstCompletionForRun && this.resultPanelIndex !== 'style' && results.length == 0) {
            if (session.results.diagnostics.length > 0)
                this.resultPanelIndex = 'diagnostics';
        }
    }

    /**
     * Stops the active search, freezes the partial result set, and surfaces any accumulated errors.
     */
    stopSearch() {
        const session = this.session;
        if (this.canStopSearch && session) {
            this.searchService.stopSearch(session.id);
            this.canStopSearch = false;

            if (session.results.errors.size) {
                this.infoMessageService.showAlertDialog(
                    this.alertContainer,
                    'Feature Search Errors',
                    Array.from(session.results.errors).join('\n'))
            }
        }
    }

    /**
     * Resets dialog-local state after the dialog closes.
     */
    onHide(_: any) {
        const session = this.session;
        if (session?.definition.bookmarked) {
            this.featureSearchDialogVisible = true;
            return;
        }
        if (session) {
            this.searchService.closeSearch(session.id);
        }
        this.resetLocalState();
        this.featureSearchDialogVisible = false;
    }

    /** Clears local rendering state after the owning session disappears. */
    private resetLocalState(): void {
        this.canStopSearch = false;
        this.resultCount = 0;
        this.featureSearchExpanded = false;
        this.featureSearchQueryExpanded = false;
        this.featureSearchQuery = "";
        this.featureSearchQueryDirty = false;
        this.featureSearchCompletionOwnerId = "";
        this.featureSearchCompletionZIndex = 30050;
        this.featureSearchScope = "auto";
        this.activeSearchGroupId = "";
        this.completedSearchGroupId = "";
        this.treeIngress = {done: 0, total: 0};
        this.lastErrorAlertSignature = "";
        this.surfacedDockedSearchId = "";
        this.pendingBookmarkedCloseSessionId = null;
        this.featureSearchHeaderActionsSignature = "";
        this.featureSearchHeaderActionsCache = [];
        this.closingSearchId = null;
    }
}
