import {
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    ElementRef,
    HostListener,
    OnDestroy,
    Renderer2,
    ViewChild
} from "@angular/core";
import { debounce, debounceTime, distinctUntilChanged, Subject, Subscription, switchMap, timer } from "rxjs";
import { RegisteredActionCandidate } from "../action/action.model";
import { AppActionRegistry } from "../action/action-registry.service";
import { RightClickMenuService } from "../mapview/rightclickmenu.service";
import { AppDialogComponent } from "../layout/app-dialog.component";
import getCaretCoordinates from "./caret.util";
import { InfoMessageService } from "../diagnostics/info.service";
import { KeyboardService } from "../keyboard/keyboard.service";
import {
    historyEntryDedupeKey,
    historyEntryKey,
    isLegacyOmnibarHistoryEntry,
    LegacyOmnibarHistoryEntry,
    normalizeResolvedOmnibarHistoryEntry,
    normalizeOmnibarHistoryEntry,
    normalizeOmnibarHistoryPayload,
    OmnibarHistoryEntry,
    withOmnibarHistoryActionName
} from "./omnibar-history";
import {
    featureSearchActionPayloadFromCompletion,
    SearchService
} from "../search/search.service";
import {
    JumpTargetService
} from "../navigation/jump.service";
import { LocationNavigationService } from "../navigation/location-navigation.service";
import { isSupportedLocationSearchQuery, GeolocationService } from "../geolocation/geolocation.service";
import { OmnibarState } from "./omnibar.state";
import { CompletionCandidate } from "../search/feature-search.types";

interface OmnibarHistoryViewEntry extends OmnibarHistoryEntry {
    label: string;
}

interface OmnibarResizeSession {
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
    selector: 'omnibar-panel',
    template: `
        <div class="omnibar-wrapper">
            <div class="omnibar-input">
                <!-- Expand on dialog show and collapse on dialog hide -->
                <textarea #textarea class="single-line" pTextarea rows="1"
                          data-testid="omnibar-input"
                          [ngModel]="inputValue"
                          (click)="showActionOverlay()"
                          (ngModelChange)="setInputValue($event)"
                          (keydown)="onKeydown($event)"
                          (keyup)="onKeyup($event)"
                          (blur)="onBlur()"
                          (focus)="onFocus()"
                          (scroll)="updateCursor()"
                          placeholder="Search">
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
                    (closeRequested)="dismissCompletionForCurrentInput()">
                </search-completion-popup>
            </div>

            <div class="resizable-container" data-testid="omnibar-container" #omnibarControls>
                <app-dialog #actionsdialog class="omnibar-menu-dialog" data-testid="omnibar-menu-dialog" [showHeader]="false" [(visible)]="state.isOpen"
                          [baseZIndex]="actionsBaseZIndex"
                          [focusOnShow]="false"
                          [draggable]="false" [resizable]="false" [closeOnEscape]="false">
                    <div data-testid="omnibar-menu-panel">
                        <div class="omnibar-menu" *ngFor="let item of activeCandidates">
                            <div onEnterClick (click)="onActionClick($event, item)" class="omnibar-option-wrapper"
                               data-testid="omnibar-action" [attr.data-action-id]="item.id"
                               [ngClass]="{'item-disabled': !item.enabled }" tabindex="0">
                                <span class="icon-circle {{ item.color }}">
                                    @if (item.iconType === 'material') {
                                        <span class="material-symbols-outlined">{{ item.icon }}</span>
                                    } @else {
                                        <i class="pi {{ item.icon }}"></i>
                                    }
                                </span>
                                <div class="omnibar-option">
                                    <span class="omnibar-option-name">{{ item.name }}</span>
                                    <br>
                                    <span [innerHTML]="item.label"></span>
                                </div>
                            </div>
                        </div>

                        <div class="omnibar-menu" *ngFor="let item of visibleHistory" >
                            <div onEnterClick (click)="selectHistoryEntry(item)" class="omnibar-option-wrapper" tabindex="0"
                                 data-testid="omnibar-history-action" [attr.data-action-id]="item.actionId">
                                <div class="icon-circle violet">
                                    <i class="pi pi-history"></i>
                                </div>
                                <div class="omnibar-option-container">
                                    <div class="omnibar-option">
                                        <span class="omnibar-option-name">{{ item.input }}</span>
                                        <br>
                                        <span [innerHTML]="item.label"></span>
                                    </div>
                                    <p-button (click)="removeHistoryEntry(item, $event)" icon="pi pi-times" tabindex="-1"></p-button>
                                </div>
                            </div>
                        </div>
                        <div class="omnibar-menu" *ngFor="let item of inactiveCandidates; let i = index">
                            <div onEnterClick (click)="targetToHistory(item)" class="omnibar-option-wrapper"
                                 [ngClass]="{'item-disabled': !item.enabled }" tabindex="0">
                                <span class="icon-circle grey">
                                    @if (item.iconType === 'material') {
                                        <span class="material-symbols-outlined">{{ item.icon }}</span>
                                    } @else {
                                        <i class="pi {{ item.icon }}"></i>
                                    }
                                </span>
                                <div class="omnibar-option">
                                    <span class="omnibar-option-name">{{ item.name }}</span>
                                    <br>
                                    <span [innerHTML]="item.label"></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </app-dialog>
                @if (state.isOpen) {
                    <div class="app-resize-handle app-resize-handle-se app-resize-horizontal omnibar-resize-handle"
                         data-testid="omnibar-resize-handle"
                         aria-hidden="true"
                         [style.z-index]="resizeHandleZIndex"
                         (pointerdown)="beginResize($event)"
                         (pointermove)="continueResize($event)"
                         (pointerup)="finishResize($event)"
                         (pointercancel)="finishResize($event)"
                         (lostpointercapture)="finishResize($event)">
                    </div>
                }
            </div>
        </div>
        
        <app-dialog header="Which map is the feature located in?" [(visible)]="mapSelectionVisible" [position]="'center'"
                  [resizable]="false" [modal]="true" class="map-selection-dialog">
            <div *ngFor="let map of mapSelection; let i = index" style="width: 100%">
                <p-button [label]="map" type="button" (click)="setSelectedMap(map)"/>
            </div>
            <p-button label="Cancel" (click)="setSelectedMap(null)" severity="danger"/>
        </app-dialog>
    `,
    standalone: false
})
/**
 * Presents registered actions, saved commands, place suggestions and feature-query completion.
 */
export class OmnibarComponent implements AfterViewInit, OnDestroy {
    private static readonly ACTIONS_BASE_Z_INDEX = 130000;
    readonly actionsBaseZIndex = OmnibarComponent.ACTIONS_BASE_Z_INDEX;
    resizeHandleZIndex = OmnibarComponent.ACTIONS_BASE_Z_INDEX + 1;

    actionCandidates: Array<RegisteredActionCandidate> = [];
    activeCandidates: Array<RegisteredActionCandidate> = [];
    inactiveCandidates: Array<RegisteredActionCandidate> = [];
    inputValue: string = "";
    history: Array<OmnibarHistoryViewEntry> = [];
    visibleHistory: Array<OmnibarHistoryViewEntry> = [];
    private readonly subscriptions = new Subscription();
    private readonly focusShortcutHandler = (_event: KeyboardEvent) => this.focusInput();

    /* Autocompletion */
    private inputChanged: Subject<void> = new Subject<void>();
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
        // Keep completion above Actions dialog without using a hardcoded global z-index.
        zIndex: OmnibarComponent.ACTIONS_BASE_Z_INDEX + 2000,
    };
    private acceptedCompletionCandidate: CompletionCandidate | null = null;
    private dismissedCompletionSignature: string | null = null;
    private destroyed = false;
    private resizeSession?: OmnibarResizeSession;

    mapSelectionVisible: boolean = false;
    mapSelection: Array<string> = [];

    @ViewChild('textarea') textarea!: ElementRef<HTMLTextAreaElement>;
    @ViewChild('actionsdialog') dialog!: AppDialogComponent;
    @ViewChild('omnibarControls') private omnibarControls?: ElementRef<HTMLElement>;

    cursorPosition: number = 0;

    // Selection state preservation for text selection across focus changes
    private savedSelectionStart: number = 0;
    private savedSelectionEnd: number = 0;
    private savedSelectionDirection: 'forward' | 'backward' | 'none' = 'none';

    /**
     * Wires the omnibar to global keyboard shortcuts, jump-target updates, history persistence, and completion streams.
     */
    constructor(private renderer: Renderer2,
        private elRef: ElementRef,
        private keyboardService: KeyboardService,
        private messageService: InfoMessageService,
        private jumpService: JumpTargetService,
        private menuService: RightClickMenuService,
        public featureSearch: SearchService,
        private locationNavigation: LocationNavigationService,
        private changeDetectorRef: ChangeDetectorRef,
        public readonly locationSearch: GeolocationService,
        private readonly actions: AppActionRegistry,
        public readonly state: OmnibarState) {
        this.keyboardService.registerShortcut("Ctrl+k", this.focusShortcutHandler);

        this.subscriptions.add(this.jumpService.targetValueSubject.subscribe((event: string) => {
            this.setCurrentCandidates(this.currentCandidates());
            this.validateMenuItems();
        }));

        this.subscriptions.add(this.jumpService.targetsChanged.subscribe(() => {
            this.setCurrentCandidates(this.currentCandidates());
            this.reloadHistory();
            this.refreshActionMenu();
        }));

        this.subscriptions.add(this.locationSearchQueryChanged.pipe(
            debounce(() => timer(this.locationSearch.debounceMs)),
            switchMap(query => this.locationSearch.search(query, this.locationSearch.state.locationSearchResultLimit))
        ).subscribe(matches => {
            const completedQuery = this.inputValue.trim();
            // A cached provider can complete synchronously while Angular is
            // checking the omnibar-menu ngFor inputs. Publish the replacement
            // in the next task and discard it if the input has moved on.
            setTimeout(() => {
                if (this.destroyed ||
                    this.inputValue.trim() !== completedQuery ||
                    !this.shouldRequestLocationSearch(this.inputValue)) {
                    return;
                }
                this.locationNavigation.updateSuggestions(completedQuery, matches);
                this.setCurrentCandidates(this.currentCandidates());
                this.reloadHistory();
                this.refreshActionMenu();
                this.changeDetectorRef.markForCheck();
            }, 0);
        }));

        this.subscriptions.add(this.locationSearch.state.locationSearchResultLimitState.subscribe(() => {
            this.updateLocationSearchQuery(this.inputValue);
            this.refreshActionMenu();
        }));

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
                this.executeAndRemember({
                    version: 2,
                    actionId: "source-data",
                    input: value,
                    actionName: "Inspect Tile Layer Source Data"
                });
            }
        }));

        this.subscriptions.add(this.state.historyState.subscribe(() => this.reloadHistory()));

        this.subscriptions.add(this.featureSearch.completionCandidates.pipe(distinctUntilChanged()).subscribe((value: CompletionCandidate[]) => {
            if (this.isCompletionDismissedFor(this.inputValue, this.cursorPosition)) {
                this.completionItems = [];
                this.completion.visible = false;
                this.changeDetectorRef.markForCheck();
                return;
            }
            this.completionItems = value.filter((item, index, array) => {
                // Discard any candidate that is equal to the current input
                // or does not relate to the current input (e.g. delayed results).
                return item.query !== this.inputValue && item.source === this.inputValue;
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
                this.refreshOverlayZIndices();
            }
            this.completion.visible = length > 0 && focusValid;
            this.changeDetectorRef.markForCheck();
        }));

        this.subscriptions.add(this.featureSearch.completionPending.pipe(distinctUntilChanged()).subscribe((pending: boolean) => {
            if (pending && this.isCompletionDismissedFor(this.inputValue, this.cursorPosition)) {
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
                this.refreshOverlayZIndices();
                this.updateCursor();
            } else if (this.completionItems.length === 0) {
                this.completion.visible = false;
            }
            this.changeDetectorRef.markForCheck();
        }));

        this.subscriptions.add(this.inputChanged.pipe(debounceTime(this.completion.completionDelay)).subscribe(() => {
            this.completeQuery(this.inputValue, this.cursorPosition);
        }));
    }

    /**
     * Hooks dialog lifecycle events once the PrimeNG dialog reference exists.
     */
    ngAfterViewInit() {
        this.subscriptions.add(
            this.featureSearch.fixedDiagnosticsSearchQuery.subscribe(fixedQuery => this.setInputValue(fixedQuery))
        );

        this.subscriptions.add(this.dialog.onShow.subscribe(() => {
            setTimeout(() => {
                this.expandTextarea();
                this.refreshOverlayZIndices();
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
        this.cancelResize();
        this.keyboardService.unregisterShortcut("Ctrl+k", this.focusShortcutHandler);
        this.subscriptions.unsubscribe();
        this.inputChanged.complete();
        this.locationSearchQueryChanged.complete();
    }

    /** Starts a pointer-captured, width-only resize of the action pane. */
    protected beginResize(event: PointerEvent): void {
        if (event.button !== 0 || this.resizeSession) {
            return;
        }
        const container = this.omnibarControls?.nativeElement;
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
        this.resizeSession = {
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

    /** Updates the omnibar pane width while its resize pointer remains captured. */
    protected continueResize(event: PointerEvent): void {
        const session = this.resizeSession;
        const container = this.omnibarControls?.nativeElement;
        if (!session || !container || event.pointerId !== session.pointerId) {
            return;
        }
        event.preventDefault();
        const requestedWidth = session.startWidth + event.clientX - session.startPointerX;
        const width = Math.min(session.maxWidth, Math.max(session.minWidth, requestedWidth));
        container.style.width = `${width}px`;
    }

    /** Finishes omnibar pane resizing and restores page-level pointer styles. */
    protected finishResize(event: PointerEvent): void {
        if (!this.resizeSession || event.pointerId !== this.resizeSession.pointerId) {
            return;
        }
        this.cancelResize();
    }

    /** Converts a computed CSS length to pixels, falling back for non-numeric values such as `none`. */
    private cssPixelValue(value: string, fallback: number): number {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    /** Cancels any active omnibar resize and releases its pointer capture. */
    private cancelResize(): void {
        const session = this.resizeSession;
        if (!session) {
            return;
        }
        this.resizeSession = undefined;
        if (session.handle.hasPointerCapture(session.pointerId)) {
            session.handle.releasePointerCapture(session.pointerId);
        }
        document.body.style.cursor = session.bodyCursor;
        document.body.style.userSelect = session.bodyUserSelect;
    }

    /** Executes a resolved omnibar action and closes the action dialog if it is currently available. */
    private executeHistoryEntry(entry: OmnibarHistoryEntry): void {
        this.inputValue = entry.input;
        this.runTarget(entry);
        this.dialog?.close(new Event("close-on-execute"));
    }
    /** Choices are regenerated by the same registered owners that execute them. */
    private candidatesForInput(value: string): RegisteredActionCandidate[] {
        return this.actions.getCandidates(value);
    }
    private currentCandidates(): RegisteredActionCandidate[] {
        return this.candidatesForInput(this.inputValue);
    }
    private setCurrentCandidates(actionCandidates: RegisteredActionCandidate[]): void {
        this.actionCandidates = actionCandidates;
    }
    /** Resolve live identities and saved payloads afresh; stale displayed choices are never reused. */
    private resolveTargetForEntry(entry: OmnibarHistoryEntry): RegisteredActionCandidate | undefined {
        return this.actions.getCandidates(entry.input, { id: entry.actionId, payload: entry.payload })
            .find(candidate => candidate.id === entry.actionId);
    }

    /** Creates a persisted history entry for a selected target. */
    private historyEntryForTarget(target: RegisteredActionCandidate, input: string): OmnibarHistoryEntry | null {
        const trimmedInput = input.trim();
        if (!trimmedInput) {
            return null;
        }
        const payload = normalizeOmnibarHistoryPayload(
            target.id === "features"
                ? this.featureSearch.actionPayloadForHistory(this.featureSearchPayloadForInput(trimmedInput) ?? target.payload)
                : target.payload
        );
        return {
            version: 2,
            actionId: target.id,
            input: trimmedInput,
            actionName: target.name,
            ...(payload !== undefined ? { payload } : {}),
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
    private migrateLegacyHistoryEntry(entry: LegacyOmnibarHistoryEntry): OmnibarHistoryEntry | null {
        const [index, input] = entry;
        const legacyOrder = ["search_feature_input", "inspect_source_input", "jump_feature_input", "jump_plugin_input",
            "navigate_location_result", "jump_coordinates", "open_external_viewer"];
        const targets = this.candidatesForInput(input)
            .filter(target => legacyOrder.includes(target.action))
            .sort((left, right) => legacyOrder.indexOf(left.action) - legacyOrder.indexOf(right.action));
        if (index < 0 || index >= targets.length) {
            return null;
        }
        return this.historyEntryForTarget(targets[index], input);
    }

    /** Builds the display model for an omnibar history entry. */
    private toHistoryViewEntry(entry: OmnibarHistoryEntry): OmnibarHistoryViewEntry {
        const target = this.resolveTargetForEntry(entry);
        const resolvedEntry = target ? withOmnibarHistoryActionName(entry, target.name) : entry;
        return {
            ...resolvedEntry,
            label: target?.name ?? entry.actionName ?? "Omnibar action is no longer available"
        };
    }


    /** Executes one omnibar action and records it in the bounded local history. */
    private executeAndRemember(entry: OmnibarHistoryEntry): void {
        this.state.remember(entry);
        this.executeHistoryEntry(entry);
        this.reloadHistory();
    }


    /**
     * Reloads persisted omnibar history and drops entries that no longer point at valid actions.
     */
    private reloadHistory() {
        const rawEntries = this.state.historyState.value;
        const migratedEntries: Array<OmnibarHistoryEntry> = [];
        const seenKeys = new Set<string>();
        let shouldRewrite = false;

        for (const rawEntry of rawEntries) {
            const normalized = normalizeOmnibarHistoryEntry(rawEntry);
            if (!normalized) {
                shouldRewrite = true;
                continue;
            }

            const entry = isLegacyOmnibarHistoryEntry(normalized)
                ? this.migrateLegacyHistoryEntry(normalized)
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
                ...(viewEntry.actionName ? { actionName: viewEntry.actionName } : {}),
                ...(viewEntry.payload !== undefined ? { payload: viewEntry.payload } : {}),
                ...(viewEntry.savedAt !== undefined ? { savedAt: viewEntry.savedAt } : {})
            };
            const dedupeKey = historyEntryDedupeKey(refreshedEntry);
            if (seenKeys.has(dedupeKey)) {
                shouldRewrite = true;
                continue;
            }
            seenKeys.add(dedupeKey);
            migratedEntries.push(refreshedEntry);
            shouldRewrite ||= entry !== normalized ||
                JSON.stringify(refreshedEntry) !== JSON.stringify(normalizeResolvedOmnibarHistoryEntry(rawEntry));
        }

        while (migratedEntries.length > 100) {
            migratedEntries.pop();
            shouldRewrite = true;
        }

        this.history = migratedEntries.map(entry => this.toHistoryViewEntry(entry));
        this.refreshVisibleHistory();
        if (shouldRewrite) {
            this.state.replaceHistory(migratedEntries);
        }
    }

    /** Removes one persisted history entry. */
    removeHistoryEntry(entry: OmnibarHistoryEntry, event?: Event) {
        event?.preventDefault();
        event?.stopPropagation();

        const key = historyEntryKey(entry);
        this.history = this.history.filter(historyEntry => historyEntryKey(historyEntry) !== key);
        this.state.replaceHistory(this.history.map(historyEntry => ({
            version: 2,
            actionId: historyEntry.actionId,
            input: historyEntry.input,
            ...(historyEntry.actionName ? { actionName: historyEntry.actionName } : {}),
            ...(historyEntry.payload !== undefined ? { payload: historyEntry.payload } : {}),
            ...(historyEntry.savedAt !== undefined ? { savedAt: historyEntry.savedAt } : {})
        })));
        this.reloadHistory();
    }

    /**
     * Re-evaluates which jump targets are currently executable for the active input.
     */
    validateMenuItems() {
        this.actionCandidates.forEach(item => item.enabled = this.canRunTarget(item, this.inputValue));
    }

    /**
     * Opens the action dialog and repositions the completion popup relative to the caret.
     */
    showActionOverlay() {
        this.updateCursor();
        this.state.isOpen = true;
        this.setInputValue(this.inputValue);
        this.refreshOverlayZIndices();
    }

    /**
     * Keeps the completion popup just above the PrimeNG action dialog without hardcoding a global z-index.
     */
    private refreshOverlayZIndices() {
        const container = this.dialog?.container();
        const inlineZIndex = container ? Number.parseInt(container.style.zIndex, 10) : Number.NaN;
        const computedZIndex = container
            ? Number.parseInt(window.getComputedStyle(container).zIndex, 10)
            : Number.NaN;
        const dialogZIndex = Number.isFinite(inlineZIndex)
            ? inlineZIndex
            : (Number.isFinite(computedZIndex) ? computedZIndex : OmnibarComponent.ACTIONS_BASE_Z_INDEX);
        this.resizeHandleZIndex = dialogZIndex + 1;
        this.completion.zIndex = dialogZIndex + 2000;
        this.changeDetectorRef.markForCheck();
    }

    /**
     * Updates the omnibar value and recomputes active targets, inactive targets, and matching history entries.
     */
    setInputValue(value: string) {
        if (value !== this.inputValue) {
            this.dismissedCompletionSignature = null;
        }
        this.inputValue = value;
        if (this.acceptedCompletionCandidate?.query.trim() !== value.trim()) {
            this.acceptedCompletionCandidate = null;
        }
        if (!value) {
            this.jumpService.targetValueSubject.next(value);
            this.updateLocationSearchQuery(value);
            this.refreshActionMenu();
            return;
        }
        this.jumpService.targetValueSubject.next(value);
        this.updateLocationSearchQuery(value);
        this.refreshActionMenu();
    }
    private updateLocationSearchQuery(value: string): void {
        this.locationNavigation.updateSuggestions(value.trim(), []);
        this.setCurrentCandidates(this.currentCandidates());
        if (this.shouldRequestLocationSearch(value)) this.locationSearchQueryChanged.next(value.trim());
    }

    /** Returns whether the current input is suitable for the configured place-name providers. */
    private shouldRequestLocationSearch(value: string): boolean {
        return isSupportedLocationSearchQuery(value);
    }

    /** Refreshes action menu state from the current input value. */
    private refreshActionMenu() {
        this.activeCandidates = [];
        this.inactiveCandidates = [];
        for (const candidate of this.actionCandidates) {
            if (this.canRunTarget(candidate, this.inputValue)) {
                this.activeCandidates.push(candidate);
            } else {
                this.inactiveCandidates.push(candidate);
            }
        }
        this.refreshVisibleHistory();
    }

    /** Refreshes the history suggestions shown in the action menu. */
    private refreshVisibleHistory() {
        const value = this.inputValue;
        if (!value) {
            this.visibleHistory = this.history;
            return;
        }
        this.visibleHistory = Object.values(
            this.history.reduce((acc, obj) => {
                if (obj.input.includes(value)) {
                    const key = historyEntryDedupeKey(obj);
                    if (!acc[key]) {
                        acc[key] = obj;
                    }
                }
                return acc;
            }, {} as Record<string, typeof this.history[number]>)
        );
    }

    /**
     * Resolves the pending multi-map selection dialog used by jump targets.
     */
    setSelectedMap(value: string | null) {
        this.jumpService.setSelectedMap!(value);
        this.mapSelectionVisible = false;
    }

    /**
     * Executes the selected action and records its arguments when it supports history.
     */
    targetToHistory(target: RegisteredActionCandidate) {
        if (!this.canRunTarget(target, this.inputValue)) {
            return;
        }
        const entry = this.historyEntryForTarget(target, this.inputValue);
        if (entry && (target.saveToHistory ?? true)) {
            this.executeAndRemember(entry);
            return;
        }
        this.executeResolvedTarget(target, {
            version: 2,
            actionId: target.id,
            input: this.inputValue.trim(),
            actionName: target.name
        });
        this.dialog?.close(new Event("close-on-execute"));
    }

    /** Source/license links are independently actionable inside a location-result row. */
    protected onActionClick(event: Event, target: RegisteredActionCandidate): void {
        if (event.target instanceof Element && event.target.closest("a")) return;
        this.targetToHistory(target);
    }

    /** Returns whether a target can run for the supplied input, including empty-input actions. */
    private canRunTarget(target: RegisteredActionCandidate, input: string): boolean {
        return (!!input.trim() || target.acceptsEmptyInput === true) && target.enabled;
    }
    runTarget(entry: OmnibarHistoryEntry): void {
        this.locationNavigation.cancel();
        const item = this.resolveTargetForEntry(entry);
        if (!item) {
            this.messageService.showError("Omnibar action is no longer available");
            return;
        }
        this.executeResolvedTarget(item, entry);
    }
    /** The UI supplies presentation/history; argument validation and dispatch stay in AppActionRegistry. */
    private executeResolvedTarget(item: RegisteredActionCandidate, entry: OmnibarHistoryEntry): void {
        this.locationNavigation.cancel();
        if (!this.canRunTarget(item, entry.input)) {
            this.messageService.showError("Omnibar action is not valid for the stored input");
            return;
        }
        const failed = (error: unknown) => this.messageService.showError(error instanceof Error ? error.message : String(error));
        try {
            const result = this.actions.execute(item.action, item.input);
            if (result instanceof Promise) result.catch(failed);
        } catch (error) { failed(error); }
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
            this.inputChanged.next();
        }
    }

    /**
     * Handles omnibar keyboard behavior, including completion navigation and dialog dismissal.
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

            if (this.activeCandidates.length) {
                this.targetToHistory(this.activeCandidates[0]);
            }

            this.resetCompletion();
            textarea.blur();
        } else if (event.key === 'Escape') {
            event.stopPropagation();
            if (this.completion.visible || this.completion.pending || this.completionItems.length > 0) {
                this.dismissCompletionForCurrentInput();
                return;
            } else if (this.inputValue) {
                this.setInputValue("");
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
                this.setInputValue(completion);
                this.textarea.nativeElement.focus();
            } else {
                const item = completion ?? this.completionItems[this.completion.selectionIndex];
                if (!item || (!completion && !this.shouldApplyCompletionOnEnter())) {
                    return;
                }
                this.setInputValue(item.query);
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

    /** Returns whether Enter should accept a visible omnibar completion instead of executing the action. */
    private shouldApplyCompletionOnEnter(): boolean {
        return this.completion.visible
            && this.completionItems.length > 0
            && !this.isCompletionDismissedFor(this.inputValue, this.cursorPosition)
            && !this.featureSearch.hasExactCompletionCandidate(this.inputValue);
    }

    /**
     * Rotates the completion selection index with wrap-around.
     */
    selectNextCompletion(next: boolean = true) {
        const direction = next && +1 || -1
        const count = this.completionItems.length || 0;
        if (this.isCompletionDismissedFor(this.inputValue, this.cursorPosition)) {
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
     * Executes one persisted omnibar history entry directly.
     */
    selectHistoryEntry(entry: OmnibarHistoryEntry) {
        this.executeAndRemember({
            version: 2,
            actionId: entry.actionId,
            input: entry.input,
            ...(entry.actionName ? { actionName: entry.actionName } : {}),
            ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
            ...(entry.savedAt !== undefined ? { savedAt: entry.savedAt } : {})
        });
    }

    /**
     * Expands and focuses the omnibar when the action dialog opens.
     */
    expandTextarea() {
        this.renderer.setAttribute(this.textarea.nativeElement, 'rows', '3');
        this.renderer.removeClass(this.textarea.nativeElement, 'single-line');
        setTimeout(() => {
            this.textarea.nativeElement.focus();
        }, 100)
    }

    /**
     * Restores the compact single-line omnibar once the dialog closes.
     */
    shrinkTextarea() {
        this.cursorPosition = this.textarea.nativeElement.selectionStart || 0;
        this.renderer.setAttribute(this.textarea.nativeElement, 'rows', '1');
        this.renderer.addClass(this.textarea.nativeElement, 'single-line');
    }

    /**
     * Programmatically focuses the omnibar for the global keyboard shortcut.
     */
    focusInput() {
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

    /** Central outside-click filter that treats every non-omnibar target as a dismissal. */
    private handleGlobalDown(event: Event): void {
        if (!this.state.isOpen && !this.completion.visible && !this.completion.pending) {
            return;
        }
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target) {
            return;
        }
        const clickedInsideComponent = this.elRef.nativeElement.contains(target as Node);
        const clickedInsideCompletionPopup = !!target.closest('.search-completion-popup');
        if (!clickedInsideComponent && !clickedInsideCompletionPopup) {
            this.closeActionOverlay(event);
        }
    }

    /** Closes the action dialog and detached completion popup together. */
    private closeActionOverlay(event: Event): void {
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
            this.featureSearch.clearCurrentCompletion();
            return;
        }
        if (this.isCompletionDismissedFor(query, point ?? query.length)) {
            this.hideCompletionPopup();
            this.featureSearch.clearCurrentCompletion();
            return;
        }

        this.featureSearch.completeQuery(query, point ?? query.length);
        this.completion.selectionIndex = 0;
    }

    /**
     * Clears both local popup state and the feature-search service's outstanding completion job.
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
            this.inputValue,
            this.cursorPosition || this.inputValue.length
        );
        this.featureSearch.clearCurrentCompletion();
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
