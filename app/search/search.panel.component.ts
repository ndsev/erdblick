import {effect, untracked} from "@angular/core";
import {AppStore} from "../shared/app.store";
import {
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    ElementRef,
    HostListener,
    inject,
    OnDestroy,
    Renderer2,
    ViewChild
} from "@angular/core";
import {debounce, debounceTime, distinctUntilChanged, Subject, Subscription, switchMap, timer} from "rxjs";

import {MapViewService} from "../mapview/map-view.service";
import {RightClickMenuService} from "../mapview/rightclickmenu.service";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {AppStateService} from "../shared/appstate.service";
import getCaretCoordinates from "../shared/caret.util";
import {InfoMessageService} from "../shared/info.service";
import {KeyboardService} from "../shared/keyboard.service";
import {
    historyEntryDedupeKey,
    historyEntryKey,
    isLegacySearchHistoryEntry,
    LegacySearchHistoryEntry,
    normalizeResolvedSearchHistoryEntry,
    normalizeSearchHistoryEntry,
    normalizeSearchHistoryPayload,
    SearchHistoryEntry,
    withSearchHistoryActionName
} from "../shared/search-history";
import {CoordinateJumpService} from "./coordinate-jump.service";
import {ExternalViewerService} from "./external-viewer.service";
import {featureSearchActionPayloadFromCompletion, FeatureSearchService} from "./feature.search.service";
import {JumpTargetService, SearchTarget} from "./jump.service";
import {LocationNavigationService} from "./location-navigation.service";
import {
    isSupportedLocationSearchQuery,
    LocationSearchService,
    normalizeLocationSearchPayload
} from "./location.search.service";
import {CompletionCandidate} from "./search.model";

interface SearchHistoryViewEntry extends SearchHistoryEntry {
    label: string;
}

interface SearchResizeSession {
    pointerId: number;
    startPointerX: number;
    startWidth: number;
    minWidth: number;
    maxWidth: number;
    handle: HTMLElement;
    bodyCursor: string;
    bodyUserSelect: string;
}

@Component({
    selector: "search-panel",
    template: `
        <div class="search-wrapper">
            <div class="search-input">
                <!-- Expand on dialog show and collapse on dialog hide -->
                <textarea
                    #textarea
                    class="single-line"
                    pTextarea
                    rows="1"
                    data-testid="search-input"
                    [ngModel]="searchInputValue"
                    (click)="showSearchOverlay()"
                    (ngModelChange)="setSearchValue($event)"
                    (keydown)="onKeydown($event)"
                    (keyup)="onKeyup($event)"
                    (blur)="onBlur()"
                    (focus)="onFocus()"
                    (scroll)="updateCursor()"
                    placeholder="Search"
                >
                </textarea>

                <search-completion-popup
                    [visible]="completion.visible"
                    [pending]="completion.pending"
                    [items]="completionItems"
                    [selectionIndex]="completion.selectionIndex"
                    [top]="completion.top"
                    [left]="completion.left"
                    [zIndex]="completion.zIndex"
                    (popupMouseDown)="onCompletionPopupDown($event)"
                    (candidateSelected)="applyCompletion($event)"
                    (closeRequested)="dismissCompletionForCurrentInput()"
                >
                </search-completion-popup>
            </div>

            <div class="resizable-container" #searchcontrols>
                <app-dialog
                    #actionsdialog
                    class="search-menu-dialog"
                    data-testid="search-menu-dialog"
                    [showHeader]="false"
                    [(visible)]="searchService.showFeatureSearchDialog"
                    [baseZIndex]="searchActionsBaseZIndex"
                    [focusOnShow]="false"
                    [draggable]="false"
                    [resizable]="false"
                    [closeOnEscape]="false"
                >
                    <div data-testid="search-menu-panel">
                        <div class="search-menu" *ngFor="let item of activeSearchItems">
                            <div
                                onEnterClick
                                (click)="onSearchTargetClick($event, item)"
                                class="search-option-wrapper"
                                data-testid="search-action"
                                [attr.data-action-id]="item.id"
                                [ngClass]="{'item-disabled': !item.enabled}"
                                tabindex="0"
                            >
                                <span class="icon-circle {{ item.color }}">
                                    @if (item.iconType === "material") {
                                        <span class="material-symbols-outlined">{{ item.icon }}</span>
                                    } @else {
                                        <i class="pi {{ item.icon }}"></i>
                                    }
                                </span>
                                <div class="search-option">
                                    <span class="search-option-name">{{ item.name }}</span>
                                    <br />
                                    <span [innerHTML]="item.label"></span>
                                </div>
                            </div>
                        </div>

                        <div class="search-menu" *ngFor="let item of visibleSearchHistory">
                            <div
                                onEnterClick
                                (click)="selectHistoryEntry(item)"
                                class="search-option-wrapper"
                                tabindex="0"
                                data-testid="search-history-action"
                                [attr.data-action-id]="item.actionId"
                            >
                                <div class="icon-circle violet">
                                    <i class="pi pi-history"></i>
                                </div>
                                <div class="search-option-container">
                                    <div class="search-option">
                                        <span class="search-option-name">{{ item.input }}</span>
                                        <br />
                                        <span [innerHTML]="item.label"></span>
                                    </div>
                                    <p-button
                                        (click)="removeSearchHistoryEntry(item, $event)"
                                        icon="pi pi-times"
                                        tabindex="-1"
                                    ></p-button>
                                </div>
                            </div>
                        </div>
                        <div class="search-menu" *ngFor="let item of inactiveSearchItems; let i = index">
                            <div
                                onEnterClick
                                (click)="targetToHistory(item)"
                                class="search-option-wrapper"
                                [ngClass]="{'item-disabled': !item.enabled}"
                                tabindex="0"
                            >
                                <span class="icon-circle grey">
                                    @if (item.iconType === "material") {
                                        <span class="material-symbols-outlined">{{ item.icon }}</span>
                                    } @else {
                                        <i class="pi {{ item.icon }}"></i>
                                    }
                                </span>
                                <div class="search-option">
                                    <span class="search-option-name">{{ item.name }}</span>
                                    <br />
                                    <span [innerHTML]="item.label"></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </app-dialog>
                @if (searchService.showFeatureSearchDialog) {
                    <div
                        class="app-resize-handle app-resize-handle-se app-resize-horizontal search-resize-handle"
                        data-testid="search-resize-handle"
                        aria-hidden="true"
                        [style.z-index]="searchResizeHandleZIndex"
                        (pointerdown)="beginSearchResize($event)"
                        (pointermove)="continueSearchResize($event)"
                        (pointerup)="finishSearchResize($event)"
                        (pointercancel)="finishSearchResize($event)"
                        (lostpointercapture)="finishSearchResize($event)"
                    ></div>
                }
            </div>
        </div>

        <app-dialog
            header="Which map is the feature located in?"
            [(visible)]="mapSelectionVisible"
            [position]="'center'"
            [resizable]="false"
            [modal]="true"
            class="map-selection-dialog"
        >
            <div *ngFor="let map of mapSelection; let i = index" style="width: 100%">
                <p-button [label]="map" type="button" (click)="setSelectedMap(map)" />
            </div>
            <p-button label="Cancel" (click)="setSelectedMap(null)" severity="danger" />
        </app-dialog>
    `,
    standalone: false
})
/**
 * Implements the omnibox-style search panel used for jumping, searching loaded features, and query completion.
 */
export class SearchPanelComponent implements AfterViewInit, OnDestroy {
    private readonly coordinates = inject(CoordinateJumpService);

    readonly store = inject(AppStore);
    private readonly actions = this.store.actionCatalog;
    private static readonly SEARCH_ACTIONS_BASE_Z_INDEX = 130000;
    readonly searchActionsBaseZIndex = SearchPanelComponent.SEARCH_ACTIONS_BASE_Z_INDEX;
    searchResizeHandleZIndex = SearchPanelComponent.SEARCH_ACTIONS_BASE_Z_INDEX + 1;

    searchItems: Array<SearchTarget> = [];
    private locationSearchItems: Array<SearchTarget> = [];
    private targetById = new Map<string, SearchTarget>();
    private targetByIdInput = "";
    activeSearchItems: Array<SearchTarget> = [];
    inactiveSearchItems: Array<SearchTarget> = [];
    searchInputValue: string = "";
    searchHistory: Array<SearchHistoryViewEntry> = [];
    visibleSearchHistory: Array<SearchHistoryViewEntry> = [];
    private readonly subscriptions = new Subscription();
    private readonly searchShortcutHandler = (_event: KeyboardEvent) => this.clickOnSearchToStart();

    /* Autocompletion */
    private searchInputChanged: Subject<void> = new Subject<void>();
    private locationSearchQueryChanged: Subject<string> = new Subject<string>();
    completionItems: Array<CompletionCandidate> = [];
    completion = {
        // Position of the popup
        top: 0,
        left: 0,
        // Selected item
        selectionIndex: 0,
        // True if the popup is visible
        visible: false,
        // True while the worker is streaming schema completion batches.
        pending: false,
        // Delay for requesting completion candidates
        completionDelay: 150,
        // Keep completion above Search Actions dialog without using a hardcoded global z-index.
        zIndex: SearchPanelComponent.SEARCH_ACTIONS_BASE_Z_INDEX + 2000,
    };
    private acceptedCompletionCandidate: CompletionCandidate | null = null;
    private dismissedCompletionSignature: string | null = null;
    private destroyed = false;
    private searchResizeSession?: SearchResizeSession;

    mapSelectionVisible: boolean = false;
    mapSelection: Array<string> = [];

    @ViewChild('textarea') textarea!: ElementRef<HTMLTextAreaElement>;
    @ViewChild('actionsdialog') dialog!: AppDialogComponent;
    @ViewChild('searchcontrols') private searchControls?: ElementRef<HTMLElement>;

    cursorPosition: number = 0;

    // Selection state preservation for text selection across focus changes
    private savedSelectionStart: number = 0;
    private savedSelectionEnd: number = 0;
    private savedSelectionDirection: 'forward' | 'backward' | 'none' = 'none';

    /**
     * Computes the static jump targets whose labels depend on the current query string.
     */
    public get staticTargets() {
        return this.coordinates.targets(this.searchInputValue);
    }

    /**
     * Wires the omnibox to global keyboard shortcuts, jump-target updates, history persistence, and completion streams.
     */
    constructor(
        private renderer: Renderer2,
        private elRef: ElementRef,
        public mapService: MapViewService,
        public stateService: AppStateService,
        private keyboardService: KeyboardService,
        private messageService: InfoMessageService,
        private jumpService: JumpTargetService,
        private menuService: RightClickMenuService,
        public searchService: FeatureSearchService,
        private locationSearchService: LocationSearchService,
        private locationNavigation: LocationNavigationService,
        private externalViewerService: ExternalViewerService,
        private changeDetectorRef: ChangeDetectorRef
    ) {
        this.keyboardService.registerShortcut("Ctrl+k", this.searchShortcutHandler);

        this.subscriptions.add(this.jumpService.targetValueSubject.subscribe((event: string) => {
            this.validateMenuItems();
        }));

        this.subscriptions.add(
            this.jumpService.jumpTargets.subscribe((jumpTargets: Array<SearchTarget>) => {
                this.setCurrentSearchItems(this.currentSearchItems());
            this.reloadSearchHistory();
            this.refreshSearchMenu();
            })
        );

        this.subscriptions.add(
            this.locationSearchQueryChanged
                .pipe(
                    debounce(() => timer(this.locationSearchService.debounceMs)),
                    switchMap((query) => this.actions.asyncOmnibarTargets(query))
                )
                .subscribe((matches) => {
            const completedQuery = this.searchInputValue.trim();
                    // A cached provider can complete synchronously while Angular is
                    // checking the search-menu ngFor inputs. Publish the replacement
                    // in the next task and discard it if the input has moved on.
                    setTimeout(() => {
                if (this.destroyed ||
                    this.searchInputValue.trim() !== completedQuery ||
                    !this.shouldRequestLocationSearch(this.searchInputValue)) {
                    return;
                }
                        this.locationSearchItems = matches;
                this.setCurrentSearchItems(this.currentSearchItems());
                this.reloadSearchHistory();
                this.refreshSearchMenu();
                this.changeDetectorRef.markForCheck();
                    }, 0);
                })
        );

        effect(() => {
            this.store.location.locationSearchResultLimit();
            untracked(() => {
                this.updateLocationSearchQuery(this.searchInputValue);
            this.refreshSearchMenu();
            });
        });

        // TODO: Get rid of map selection, as soon as we support
        //  multi-selection from different maps. Then we can
        //  just search all maps simultaneously.
        // NOTE: Currently users must select specific maps to search. Once cross-map
        // multi-selection is implemented, search can operate on all maps at once.
        this.subscriptions.add(jumpService.mapSelectionSubject.subscribe(maps => {
            this.mapSelection = maps;
            this.mapSelectionVisible = true;
        }));

        this.subscriptions.add(this.menuService.lastInspectedTileSourceDataOption.subscribe(lastInspectedData => {
            if (lastInspectedData && lastInspectedData.tileId && lastInspectedData.mapId && lastInspectedData.layerId) {
                const value = `${lastInspectedData?.tileId} "${lastInspectedData?.mapId}" "${lastInspectedData?.layerId}"`;
                this.executeAndRememberSearchEntry({
                    version: 2,
                    actionId: "source-data",
                    input: value,
                    actionName: "Inspect Tile Layer Source Data"
                });
            }
        }));

        this.reloadSearchHistory();

        this.subscriptions.add(this.searchService.completionCandidates.pipe(distinctUntilChanged()).subscribe((value: CompletionCandidate[]) => {
            if (this.isCompletionDismissedFor(this.searchInputValue, this.cursorPosition)) {
                this.completionItems = [];
                this.completion.visible = false;
                this.changeDetectorRef.markForCheck();
                return;
            }
            this.completionItems = value.filter((item, index, array) => {
                // Discard any candidate that is equal to the current input
                // or does not relate to the current input (e.g. delayed results).
                return item.query !== this.searchInputValue && item.source === this.searchInputValue;
            });

            const length = this.completionItems.length;
            if (length === 0) {
                this.completion.selectionIndex = 0;
            } else if (this.completion.selectionIndex >= length) {
                this.completion.selectionIndex = length - 1;
            }

            // Only show the pop-up if the pop-up was prev. hidden
            // or the currently focused element is the query input.
            // This is to prevent the pop-up showing if the user quickly
            // tabs out of the query input before the first completion
            // items are ready.
            const textarea = this.textarea?.nativeElement;
            const focusValid =
                this.completion.visible ||
                this.completion.pending ||
                textarea === document.activeElement;

            if (length > 0 && focusValid) {
                this.refreshSearchOverlayZIndices();
            }
            this.completion.visible = length > 0 && focusValid;
            this.changeDetectorRef.markForCheck();
        }));

        this.subscriptions.add(this.searchService.completionPending.pipe(distinctUntilChanged()).subscribe((pending: boolean) => {
            if (pending && this.isCompletionDismissedFor(this.searchInputValue, this.cursorPosition)) {
                this.completion.pending = false;
                this.completion.visible = false;
                this.changeDetectorRef.markForCheck();
                return;
            }
            const textarea = this.textarea?.nativeElement;
            const focusValid =
                this.completion.visible ||
                pending ||
                textarea === document.activeElement;

            this.completion.pending = pending && focusValid;
            if (this.completion.pending) {
                this.refreshSearchOverlayZIndices();
                this.updateCursor();
            } else if (this.completionItems.length === 0) {
                this.completion.visible = false;
            }
            this.changeDetectorRef.markForCheck();
        }));

        this.subscriptions.add(this.searchInputChanged.pipe(debounceTime(this.completion.completionDelay)).subscribe(() => {
            this.completeQuery(this.searchInputValue, this.cursorPosition);
        }));
    }

    /**
     * Hooks dialog lifecycle events once the PrimeNG dialog reference exists.
     */
    ngAfterViewInit() {
        this.subscriptions.add(
            this.searchService.fixedDiagnosticsSearchQuery.subscribe(fixedQuery => this.setSearchValue(fixedQuery))
        );

        this.subscriptions.add(this.dialog.onShow.subscribe(() => {
            setTimeout(() => {
                this.expandTextarea();
                this.refreshSearchOverlayZIndices();
            }, 10);
        }));

        this.subscriptions.add(this.dialog.onHide.subscribe(() => {
            setTimeout(() => {
                this.shrinkTextarea();
            }, 10);
        }));
    }

    /** Releases subscriptions and global shortcuts when the responsive shell replaces the panel. */
    ngOnDestroy() {
        this.destroyed = true;
        this.locationNavigation.cancel();
        this.cancelSearchResize();
        this.keyboardService.unregisterShortcut("Ctrl+k", this.searchShortcutHandler);
        this.subscriptions.unsubscribe();
        this.searchInputChanged.complete();
        this.locationSearchQueryChanged.complete();
    }

    /** Starts a pointer-captured, width-only resize of the search actions pane. */
    protected beginSearchResize(event: PointerEvent): void {
        if (event.button !== 0 || this.searchResizeSession) {
            return;
        }
        const container = this.searchControls?.nativeElement;
        const handle = event.currentTarget;
        if (!container || !(handle instanceof HTMLElement)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        const bounds = container.getBoundingClientRect();
        const styles = getComputedStyle(container);
        const viewportMaximum = Math.max(1, window.innerWidth - bounds.left);
        const minimum = this.cssPixelValue(styles.minWidth, 1);
        const maximum = Math.max(
            minimum,
            Math.min(this.cssPixelValue(styles.maxWidth, viewportMaximum), viewportMaximum)
        );
        const body = document.body;
        this.searchResizeSession = {
            pointerId: event.pointerId,
            startPointerX: event.clientX,
            startWidth: bounds.width,
            minWidth: minimum,
            maxWidth: maximum,
            handle,
            bodyCursor: body.style.cursor,
            bodyUserSelect: body.style.userSelect
        };
        container.style.width = `${bounds.width}px`;
        body.style.cursor = getComputedStyle(handle).cursor || 'col-resize';
        body.style.userSelect = 'none';
        handle.setPointerCapture(event.pointerId);
    }

    /** Updates the search pane width while its resize pointer remains captured. */
    protected continueSearchResize(event: PointerEvent): void {
        const session = this.searchResizeSession;
        const container = this.searchControls?.nativeElement;
        if (!session || !container || event.pointerId !== session.pointerId) {
            return;
        }
        event.preventDefault();
        const requestedWidth = session.startWidth + event.clientX - session.startPointerX;
        const width = Math.min(session.maxWidth, Math.max(session.minWidth, requestedWidth));
        container.style.width = `${width}px`;
    }

    /** Finishes search-pane resizing and restores page-level pointer styles. */
    protected finishSearchResize(event: PointerEvent): void {
        if (!this.searchResizeSession || event.pointerId !== this.searchResizeSession.pointerId) {
            return;
        }
        this.cancelSearchResize();
    }

    /** Converts a computed CSS length to pixels, falling back for non-numeric values such as `none`. */
    private cssPixelValue(value: string, fallback: number): number {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    /** Cancels any active search resize and releases its pointer capture. */
    private cancelSearchResize(): void {
        const session = this.searchResizeSession;
        if (!session) {
            return;
        }
        this.searchResizeSession = undefined;
        if (session.handle.hasPointerCapture(session.pointerId)) {
            session.handle.releasePointerCapture(session.pointerId);
        }
        document.body.style.cursor = session.bodyCursor;
        document.body.style.userSelect = session.bodyUserSelect;
    }

    /** Executes a resolved omnibox action and closes the action dialog if it is currently available. */
    private executeSearchHistoryEntry(entry: SearchHistoryEntry): void {
        this.searchInputValue = entry.input;
        this.runTarget(entry);
        this.dialog?.close(new Event("close-on-execute"));
    }

    /** Returns search targets applicable to an input value. */
    private searchItemsForValue(value: string): Array<SearchTarget> {
        return [
            ...this.actions.omnibarTargets(value),
            ...(value === this.searchInputValue ? this.locationSearchItems : [])
        ];
    }

    /** Builds the menu from registered local actions and the latest async results. */
    private currentSearchItems(): Array<SearchTarget> {
        return this.searchItemsForValue(this.searchInputValue);
    }

    /** Indexes search targets by id while ignoring duplicates. */
    private buildTargetById(targets: Array<SearchTarget>): Map<string, SearchTarget> {
        const result = new Map<string, SearchTarget>();
        for (const target of targets) {
            if (!target.id) {
                throw new Error(`Search target is missing a stable id: ${target.name}`);
            }
            if (result.has(target.id)) {
                throw new Error(`Duplicate search target id: ${target.id}`);
            }
            result.set(target.id, target);
        }
        return result;
    }

    /** Stores the current search targets and their id index. */
    private setCurrentSearchItems(searchItems: Array<SearchTarget>, input: string = this.searchInputValue) {
        this.searchItems = searchItems;
        this.targetById = this.buildTargetById(searchItems);
        this.targetByIdInput = input;
    }

    /** Finds the current search target represented by a history entry. */
    private resolveTargetForEntry(entry: SearchHistoryEntry): SearchTarget | undefined {
        if (entry.viewId !== undefined && this.store.indexOf(entry.viewId) < 0) return undefined;
        const locationPayload = normalizeLocationSearchPayload(entry.payload);
        if (locationPayload) {
            const locationTarget = this.locationNavigation.createTarget(locationPayload);
            if (locationTarget.id === entry.actionId) {
                return locationTarget;
            }
        }
        return this.buildTargetById(this.searchItemsForValue(entry.input)).get(entry.actionId);
    }

    /** Creates a persisted history entry for a selected target. */
    private searchHistoryEntryForTarget(target: SearchTarget, input: string): SearchHistoryEntry | null {
        const trimmedInput = input.trim();
        if (!trimmedInput) {
            return null;
        }
        const payload = normalizeSearchHistoryPayload(
            target.id === "features"
                ? this.searchService.actionPayloadForHistory(
                      this.featureSearchPayloadForInput(trimmedInput) ?? target.payload
                  )
                : target.payload
        );
        return {
            version: 2,
            actionId: target.id,
            input: trimmedInput,
            actionName: target.name,
            viewId: this.store.focusedViewId(),
            ...(payload !== undefined ? {payload} : {}),
            savedAt: Date.now()
        };
    }

    /** Returns completion-derived feature-search payload when the input still matches the accepted candidate. */
    private featureSearchPayloadForInput(input: string): unknown {
        const candidate = this.acceptedCompletionCandidate;
        return candidate?.query.trim() === input.trim()
            ? featureSearchActionPayloadFromCompletion(candidate)
            : undefined;
    }

    /** Converts a legacy index-based history entry to target-id form. */
    private migrateLegacySearchHistoryEntry(entry: LegacySearchHistoryEntry): SearchHistoryEntry | null {
        const [index, input] = entry;
        const targets = this.searchItemsForValue(input);
        if (index < 0 || index >= targets.length) {
            return null;
        }
        return this.searchHistoryEntryForTarget(targets[index], input);
    }

    /** Builds the display model for a search history entry. */
    private toHistoryViewEntry(entry: SearchHistoryEntry): SearchHistoryViewEntry {
        const target = this.resolveTargetForEntry(entry);
        const resolvedEntry = target ? withSearchHistoryActionName(entry, target.name) : entry;
        return {
            ...resolvedEntry,
            label: target?.name ?? entry.actionName ?? "Search action is no longer available"
        };
    }

    /** Persists the bounded search history list. */
    private writeSearchHistory(entries: Array<SearchHistoryEntry>) {
        localStorage.setItem("searchHistory", JSON.stringify(entries));
    }

    /** Executes one omnibox action and records it in the bounded local history. */
    private executeAndRememberSearchEntry(entry: SearchHistoryEntry): void {
        this.saveSearchHistoryEntry(entry);
        this.executeSearchHistoryEntry(entry);
        this.reloadSearchHistory();
    }

    /** Inserts one history entry at the top while preserving bounded, deduplicated history. */
    private saveSearchHistoryEntry(value: SearchHistoryEntry): void {
        const searchHistoryString = localStorage.getItem("searchHistory");
        let searchHistory: Array<SearchHistoryEntry> = [];
        if (searchHistoryString) {
            const parsed = JSON.parse(searchHistoryString) as unknown;
            const rawEntries = Array.isArray(parsed) && !(parsed.length === 2 && typeof parsed[1] === "string")
                ? parsed
                : [parsed];
            const seen = new Set<string>();
            for (const rawEntry of rawEntries) {
                const entry = normalizeResolvedSearchHistoryEntry(rawEntry);
                if (!entry) {
                    continue;
                }
                const key = historyEntryDedupeKey(entry);
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                searchHistory.push(entry);
            }
        }
        searchHistory = searchHistory.filter(entry => historyEntryDedupeKey(entry) !== historyEntryDedupeKey(value));
        searchHistory.unshift(value);
        while (searchHistory.length > 100) {
            searchHistory.pop();
        }
        this.writeSearchHistory(searchHistory);
    }

    /**
     * Reloads persisted search history and drops entries that no longer point at valid actions.
     */
    private reloadSearchHistory() {
        const searchHistoryString = localStorage.getItem("searchHistory");
        if (!searchHistoryString) {
            this.searchHistory = [];
            this.visibleSearchHistory = [];
            return;
        }

        const rawSearchHistory = JSON.parse(searchHistoryString) as unknown;
        const rawEntries = Array.isArray(rawSearchHistory) &&
            !(rawSearchHistory.length === 2 && typeof rawSearchHistory[1] === "string")
            ? rawSearchHistory
            : [rawSearchHistory];
        const migratedEntries: Array<SearchHistoryEntry> = [];
        const seenKeys = new Set<string>();
        let shouldRewrite = false;

        for (const rawEntry of rawEntries) {
            const normalized = normalizeSearchHistoryEntry(rawEntry);
            if (!normalized) {
                shouldRewrite = true;
                continue;
            }

            const entry = isLegacySearchHistoryEntry(normalized)
                ? this.migrateLegacySearchHistoryEntry(normalized)
                : normalized;
            if (!entry) {
                shouldRewrite = true;
                continue;
            }

            const viewEntry = this.toHistoryViewEntry(entry);
            const refreshedEntry = {
                version: 2 as const,
                actionId: viewEntry.actionId,
                input: viewEntry.input,
                ...(viewEntry.actionName ? {actionName: viewEntry.actionName} : {}),
                ...(viewEntry.payload !== undefined ? {payload: viewEntry.payload} : {}),
                ...(viewEntry.viewId !== undefined ? {viewId: viewEntry.viewId} : {}),
                ...(viewEntry.savedAt !== undefined ? {savedAt: viewEntry.savedAt} : {})
            };
            const dedupeKey = historyEntryDedupeKey(refreshedEntry);
            if (seenKeys.has(dedupeKey)) {
                shouldRewrite = true;
                continue;
            }
            seenKeys.add(dedupeKey);
            migratedEntries.push(refreshedEntry);
            shouldRewrite ||= entry !== normalized ||
                JSON.stringify(refreshedEntry) !== JSON.stringify(normalizeResolvedSearchHistoryEntry(rawEntry));
        }

        while (migratedEntries.length > 100) {
            migratedEntries.pop();
            shouldRewrite = true;
        }

        this.searchHistory = migratedEntries.map(entry => this.toHistoryViewEntry(entry));
        this.refreshVisibleSearchHistory();
        if (shouldRewrite) {
            this.writeSearchHistory(migratedEntries);
        }
    }

    /** Removes one persisted history entry. */
    removeSearchHistoryEntry(entry: SearchHistoryEntry, event?: Event) {
        event?.preventDefault();
        event?.stopPropagation();

        const key = historyEntryKey(entry);
        this.searchHistory = this.searchHistory.filter(historyEntry => historyEntryKey(historyEntry) !== key);
        this.writeSearchHistory(
            this.searchHistory.map((historyEntry) => ({
                version: 2,
                actionId: historyEntry.actionId,
                input: historyEntry.input,
                ...(historyEntry.actionName ? {actionName: historyEntry.actionName} : {}),
                ...(historyEntry.payload !== undefined ? {payload: historyEntry.payload} : {}),
                ...(historyEntry.viewId !== undefined ? {viewId: historyEntry.viewId} : {}),
                ...(historyEntry.savedAt !== undefined ? {savedAt: historyEntry.savedAt} : {})
            }))
        );
        this.reloadSearchHistory();
    }

    /**
     * Re-evaluates which jump targets are currently executable for the active input.
     */
    validateMenuItems() {
        this.searchItems.forEach(item => item.enabled = this.canRunTarget(item, this.searchInputValue));
    }

    /**
     * Opens the action dialog and repositions the completion popup relative to the caret.
     */
    showSearchOverlay() {
        this.updateCursor();
        this.searchService.showFeatureSearchDialog = true;
        this.setSearchValue(this.searchInputValue);
        this.refreshSearchOverlayZIndices();
    }

    /**
     * Keeps the completion popup just above the PrimeNG search-actions dialog without hardcoding a global z-index.
     */
    private refreshSearchOverlayZIndices() {
        const container = this.dialog?.container();
        const inlineZIndex = container ? Number.parseInt(container.style.zIndex, 10) : Number.NaN;
        const computedZIndex = container
            ? Number.parseInt(window.getComputedStyle(container).zIndex, 10)
            : Number.NaN;
        const dialogZIndex = Number.isFinite(inlineZIndex)
            ? inlineZIndex
            : (Number.isFinite(computedZIndex) ? computedZIndex : SearchPanelComponent.SEARCH_ACTIONS_BASE_Z_INDEX);
        this.searchResizeHandleZIndex = dialogZIndex + 1;
        this.completion.zIndex = dialogZIndex + 2000;
        this.changeDetectorRef.markForCheck();
    }

    /**
     * Updates the omnibox value and recomputes active targets, inactive targets, and matching history entries.
     */
    setSearchValue(value: string) {
        if (value !== this.searchInputValue) {
            this.dismissedCompletionSignature = null;
        }
        this.searchInputValue = value;
        if (this.acceptedCompletionCandidate?.query.trim() !== value.trim()) {
            this.acceptedCompletionCandidate = null;
        }
        if (!value) {
            this.jumpService.targetValueSubject.next(value);
            this.updateLocationSearchQuery(value);
            this.refreshSearchMenu();
            return;
        }
        this.jumpService.targetValueSubject.next(value);
        this.updateLocationSearchQuery(value);
        this.refreshSearchMenu();
    }

    /** Requests place completions only for Unicode name-like queries, not numeric ids or ZIP codes. */
    private updateLocationSearchQuery(value: string): void {
        if (this.shouldRequestLocationSearch(value)) {
            this.locationSearchQueryChanged.next(value.trim());
            return;
        }
        if (this.locationSearchItems.length) {
            this.locationSearchItems = [];
            this.setCurrentSearchItems(this.currentSearchItems());
        }
    }

    /** Returns whether the current input is suitable for the configured place-name providers. */
    private shouldRequestLocationSearch(value: string): boolean {
        return isSupportedLocationSearchQuery(value);
    }

    /** Refreshes search menu state from the current input value. */
    private refreshSearchMenu() {
        this.activeSearchItems = [];
        this.inactiveSearchItems = [];
        for (const searchItem of this.searchItems) {
            if (this.canRunTarget(searchItem, this.searchInputValue)) {
                this.activeSearchItems.push(searchItem);
            } else {
                this.inactiveSearchItems.push(searchItem);
            }
        }
        this.refreshVisibleSearchHistory();
    }

    /** Refreshes the history suggestions shown in the search menu. */
    private refreshVisibleSearchHistory() {
        const value = this.searchInputValue;
        if (!value) {
            this.visibleSearchHistory = this.searchHistory;
            return;
        }
        this.visibleSearchHistory = Object.values(
            this.searchHistory.reduce((acc, obj) => {
                if (obj.input.includes(value)) {
                    const key = historyEntryDedupeKey(obj);
                    if (!acc[key]) {
                        acc[key] = obj;
                    }
                }
                return acc;
            }, {} as Record<string, typeof this.searchHistory[number]>)
        );
    }

    /**
     * Resolves the pending multi-map selection dialog used by jump targets.
     */
    setSelectedMap(value: string|null) {
        this.jumpService.setSelectedMap!(value);
        this.mapSelectionVisible = false;
    }

    /**
     * Persists the currently selected target and input so the central search-state flow executes it.
     */
    targetToHistory(target: SearchTarget) {
        if (!this.canRunTarget(target, this.searchInputValue)) {
            return;
        }
        const entry = this.searchHistoryEntryForTarget(target, this.searchInputValue);
        if (entry && (target.saveToHistory?.(this.searchInputValue) ?? true)) {
            this.executeAndRememberSearchEntry(entry);
            return;
        }
        this.executeResolvedTarget(target, {
            version: 2,
            actionId: target.id,
            input: this.searchInputValue.trim(),
            actionName: target.name
        });
        this.dialog?.close(new Event("close-on-execute"));
    }

    /** Source/license links are independently actionable inside a location-result row. */
    protected onSearchTargetClick(event: Event, target: SearchTarget): void {
        if (event.target instanceof Element && event.target.closest("a")) return;
        this.targetToHistory(target);
    }

    /** Returns whether a target can run for the supplied input, including empty-input actions. */
    private canRunTarget(target: SearchTarget, input: string): boolean {
        return (!!input.trim() || target.acceptsEmptyInput === true) && target.validate(input);
    }

    /**
     * Executes the chosen search target by either jumping locally or delegating to its side-effect callback.
     */
    runTarget(entry: SearchHistoryEntry) {
        this.locationNavigation.cancel();
        if (!this.focusHistoryView(entry)) return;
        const item = this.resolveTargetForEntry(entry);
        if (!item) {
            if (this.locationSearchService.isLocationTargetId(entry.actionId)) {
                this.locationNavigation.runFromHistory(entry.actionId, entry.payload);
                return;
            }
            this.messageService.showError("Search action is no longer available");
            return;
        }
        this.executeResolvedTarget(item, entry);
    }

    /** Resolve the logical target just before dispatch; a removed view never falls back to its old index. */
    private focusHistoryView(entry: SearchHistoryEntry): boolean {
        if (entry.viewId === undefined) return true; // Legacy unscoped entries use current focus.
        const index = this.store.indexOf(entry.viewId);
        if (index < 0) {
            this.messageService.showError("The map view saved with this search is no longer available");
            return false;
        }
        this.store.setFocusedView(index);
        return true;
    }

    /** Executes an already resolved target. */
    private executeResolvedTarget(item: SearchTarget, entry: SearchHistoryEntry) {
        this.locationNavigation.cancel();
        if (!this.focusHistoryView(entry)) return;
        if (!item.validate(entry.input)) {
            this.messageService.showError("Search action is not valid for the stored input");
            return;
        }
        if (item.execute !== undefined) {
            try {
                const result = item.execute(entry.input, entry.payload ?? item.payload);
                if (result instanceof Promise)
                    void result.catch((error) => this.messageService.showError(String(error)));
            } catch (error) {
                this.messageService.showError(String(error));
            }
            return;
        }
    }

    /**
     * Recomputes the completion popup anchor from the textarea caret position.
     */
    updateCursor() {
        const textarea = this.textarea.nativeElement;
        const rect = textarea.getBoundingClientRect();
        const cursor = textarea.selectionStart || 0;
        const style = window.getComputedStyle(textarea);
        const fontSizePx = parseFloat(style.fontSize);
        const offset = (1 + 0.75) * fontSizePx; // Text height + padding height
        this.cursorPosition = cursor;

        const caret = getCaretCoordinates(textarea, cursor);
        if (caret) {
            this.completion.top = rect.top + caret.top + offset;
            this.completion.left = rect.left + caret.left;
        } else {
            this.completion.top = rect.bottom;
            this.completion.left = rect.left;
        }
    }

    /**
     * Prevents the popup click from stealing focus before a completion item can be applied.
     */
    onCompletionPopupDown(event: MouseEvent) {
        event.preventDefault();
    }

    /**
     * Hides completion asynchronously and remembers the text selection for later restoration.
     */
    onBlur() {
        this.savedSelectionStart = this.textarea.nativeElement.selectionStart || 0;
        this.savedSelectionEnd = this.textarea.nativeElement.selectionEnd || 0;
        this.savedSelectionDirection = (this.textarea.nativeElement.selectionDirection as 'forward' | 'backward' | 'none') || 'none';

        setTimeout(() => {
            this.completion.visible = false;
            this.completion.pending = false;
        }, 0);
    }

    /**
     * Restores the saved selection if the field regains focus after a popup interaction.
     */
    onFocus() {
        if (!this.completion.visible) {
            setTimeout(() => {
                this.textarea.nativeElement.setSelectionRange(
                    this.savedSelectionStart,
                    this.savedSelectionEnd,
                    this.savedSelectionDirection
                );
            }, 0);
        }
    }

    /**
     * Triggers completion requests for text-changing keys after updating the caret position.
     */
    onKeyup(event: KeyboardEvent) {
        this.updateCursor();

        const ignoredKeys = [
            'Home', 'End', 'PageUp', 'PageDown', 'Escape',
            'Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'
        ]
        if (ignoredKeys.indexOf(event.key) == -1) {
            this.dismissedCompletionSignature = null;
            this.searchInputChanged.next();
        }
    }

    /**
     * Handles omnibox keyboard behavior, including completion navigation and dialog dismissal.
     */
    onKeydown(event: KeyboardEvent) {
        const textarea = this.textarea.nativeElement;
        const dismissCompletionKeys = [
            'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'Delete'
        ]

        // Dismiss the completion pop-up for control-keys
        if (dismissCompletionKeys.indexOf(event.key) >= 0) {
            if (this.completion.visible)
                event.preventDefault();
            this.hideCompletionPopup();
            textarea.focus();
        }

        // Prevent defaults if completion is active
        if (this.completion.visible) {
            if (['ArrowUp', 'ArrowDown', 'Tab'].indexOf(event.key) >= 0) {
                event.preventDefault();
            }
        }

        if (event.key === 'Enter') {
            event.preventDefault();

            if (this.shouldApplyCompletionOnEnter()) {
                this.applyCompletion();
                return;
            }

            if (this.activeSearchItems.length) {
                this.targetToHistory(this.activeSearchItems[0]);
            }

            this.resetCompletion();
            textarea.blur();
        } else if (event.key === 'Escape') {
            event.stopPropagation();
            if (this.completion.visible || this.completion.pending || this.completionItems.length > 0) {
                this.dismissCompletionForCurrentInput();
                return;
            } else if (this.searchInputValue) {
                this.setSearchValue("");
                this.resetCompletion();
                return;
            } else {
                this.dialog.close(event);
                return;
            }
        } else if (event.key === 'Tab') {
            if (this.shouldApplyCompletionOnEnter()) {
                this.applyCompletion();
            }
        } else if (event.key === 'ArrowDown') {
            if (this.completion.visible) {
                this.selectNextCompletion(true);
            }
        } else if (event.key === 'ArrowUp') {
            if (this.completion.visible) {
                this.selectNextCompletion(false);
            }
        }
    }

    /**
     * Applies either an explicit completion string or the currently selected completion candidate.
     */
    applyCompletion(completion: CompletionCandidate | string | undefined = undefined) {
        if (this.completion.visible || completion) {
            if (typeof completion === "string") {
                this.setSearchValue(completion);
                this.textarea.nativeElement.focus();
            } else {
                const item = completion ?? this.completionItems[this.completion.selectionIndex];
                if (!item || (!completion && !this.shouldApplyCompletionOnEnter())) {
                    return;
                }
                this.setSearchValue(item.query);
                this.acceptedCompletionCandidate = item;

                let cursor = item.begin + item.text.length
                setTimeout(() => {
                    this.textarea.nativeElement.setSelectionRange(
                        cursor, cursor, "forward");
                }, 0);
            }

            this.completionItems = [];
            this.completion.visible = false;
            this.completion.pending = false;
            this.dismissedCompletionSignature = null;
        }
    }

    /** Returns whether Enter should accept a visible omnibox completion instead of executing the action. */
    private shouldApplyCompletionOnEnter(): boolean {
        return this.completion.visible
            && this.completionItems.length > 0
            && !this.isCompletionDismissedFor(this.searchInputValue, this.cursorPosition)
            && !this.searchService.hasExactCompletionCandidate(this.searchInputValue);
    }

    /**
     * Rotates the completion selection index with wrap-around.
     */
    selectNextCompletion(next: boolean = true) {
        const direction = next && +1 || -1
        const count = this.completionItems.length || 0;
        if (this.isCompletionDismissedFor(this.searchInputValue, this.cursorPosition)) {
            this.completion.selectionIndex = 0;
            this.completion.visible = false;
            return;
        }

        let index = this.completion.selectionIndex
        if (count == 0)
            index = 0
        else
            index = index + direction

        if (index < 0)
            index = count - 1;
        else if (index >= count)
            index = 0

        this.completion.selectionIndex = index;
        this.completion.visible = count > 0;
    }

    /**
     * Executes one persisted search history entry directly.
     */
    selectHistoryEntry(entry: SearchHistoryEntry) {
        this.executeAndRememberSearchEntry({
            version: 2,
            actionId: entry.actionId,
            input: entry.input,
            ...(entry.actionName ? {actionName: entry.actionName} : {}),
            ...(entry.payload !== undefined ? {payload: entry.payload} : {}),
            ...(entry.viewId !== undefined ? {viewId: entry.viewId} : {}),
            ...(entry.savedAt !== undefined ? {savedAt: entry.savedAt} : {})
        });
    }

    /**
     * Expands and focuses the omnibox when the action dialog opens.
     */
    expandTextarea() {
        this.jumpService.searchIsFocused = true;
        this.renderer.setAttribute(this.textarea.nativeElement, 'rows', '3');
        this.renderer.removeClass(this.textarea.nativeElement, 'single-line');
        setTimeout(() => {
            this.textarea.nativeElement.focus();
        }, 100)
    }

    /**
     * Restores the compact single-line omnibox once the dialog closes.
     */
    shrinkTextarea() {
        this.cursorPosition = this.textarea.nativeElement.selectionStart || 0;
        this.renderer.setAttribute(this.textarea.nativeElement, 'rows', '1');
        this.renderer.addClass(this.textarea.nativeElement, 'single-line');
        this.jumpService.searchIsFocused = false;
    }

    /**
     * Programmatically focuses the omnibox for the global keyboard shortcut.
     */
    clickOnSearchToStart() {
        this.textarea.nativeElement.click();
        this.textarea.nativeElement.focus();
    }

    @HostListener('document:pointerdown', ['$event'])
    /**
     * Pointer-event path for dismissing the action dialog when clicking outside it.
     */
    handlePointerDown(event: PointerEvent): void {
        this.handleGlobalDown(event);
    }

    @HostListener('document:mousedown', ['$event'])
    /**
     * Mouse fallback for browsers that do not emit PointerEvent.
     */
    handleMouseDown(event: MouseEvent): void {
        if (window.PointerEvent) {
            return;
        }
        this.handleGlobalDown(event);
    }

    /** Central outside-click filter that treats every non-omnibox target as a dismissal. */
    private handleGlobalDown(event: Event): void {
        if (!this.searchService.showFeatureSearchDialog && !this.completion.visible && !this.completion.pending) {
            return;
        }
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target) {
            return;
        }
        const clickedInsideComponent = this.elRef.nativeElement.contains(target as Node);
        const clickedInsideCompletionPopup = !!target.closest('.search-completion-popup');
        if (!clickedInsideComponent && !clickedInsideCompletionPopup) {
            this.closeSearchOverlay(event);
        }
    }

    /** Closes the action dialog and detached completion popup together. */
    private closeSearchOverlay(event: Event): void {
        this.completion.visible = false;
        this.completion.pending = false;
        this.dialog?.close(new MouseEvent(event.type));
    }

    /**
     * Starts a new completion request for the current query and cursor position.
     */
    completeQuery(query: string, point: number | undefined) {
        if (!query) {
            this.completion.visible = false;
            this.completion.pending = false;
            this.completionItems = [];
            this.searchService.clearCurrentCompletion();
            return;
        }
        if (this.isCompletionDismissedFor(query, point ?? query.length)) {
            this.hideCompletionPopup();
            this.searchService.clearCurrentCompletion();
            return;
        }

        this.searchService.completeQuery(query, point ?? query.length);
        this.completion.selectionIndex = 0;
    }

    /**
     * Clears both local popup state and the search service's outstanding completion job.
     */
    resetCompletion() {
        this.completeQuery("", undefined);
        this.completion.selectionIndex = 0;
        this.completionItems = [];
        this.completion.visible = false;
        this.completion.pending = false;
        this.dismissedCompletionSignature = null;
    }

    /** Hides the popup locally without invalidating typed text or suppressing future completion requests. */
    private hideCompletionPopup(): void {
        this.completion.visible = false;
        this.completion.pending = false;
    }

    /** Dismisses the current completion generation until the query text or caret changes. */
    dismissCompletionForCurrentInput(): void {
        this.dismissedCompletionSignature = this.completionSignature(
            this.searchInputValue,
            this.cursorPosition || this.searchInputValue.length
        );
        this.searchService.clearCurrentCompletion();
        this.completion.selectionIndex = 0;
        this.completionItems = [];
        this.hideCompletionPopup();
    }

    /** Returns whether completion has been explicitly dismissed for this exact query/caret pair. */
    private isCompletionDismissedFor(query: string, point: number): boolean {
        return this.dismissedCompletionSignature === this.completionSignature(query, point);
    }

    /** Builds the completion identity suppressed by Esc/close until text or caret changes. */
    private completionSignature(query: string, point: number): string {
        return `${query}\u0000${point}`;
    }
}
