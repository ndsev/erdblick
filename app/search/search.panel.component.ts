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
import {GeoMath, Rectangle} from "../integrations/geo";
import {InfoMessageService} from "../shared/info.service";
import {
    JumpTargetService,
    normalizeSearchJumpResult,
    SearchJump,
    SearchJumpResult,
    SearchTarget
} from "./jump.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {AppStateService} from "../shared/appstate.service";
import {KeyboardService} from "../shared/keyboard.service";
import {debounce, debounceTime, distinctUntilChanged, Subject, switchMap, timer, Subscription} from "rxjs";
import {RightClickMenuService} from "../mapview/rightclickmenu.service";
import {
    FeatureSearchService,
    featureSearchActionPayloadFromCompletion
} from "./feature.search.service";
import getCaretCoordinates from "../shared/caret.util";
import {CompletionCandidate} from "./search.model";
import {coreLib} from "../integrations/wasm";
import {AppDialogComponent} from "../shared/app-dialog.component";
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
import {
    isSupportedLocationSearchQuery,
    LocationSearchService,
    normalizeLocationSearchPayload
} from "./location.search.service";
import {
    packedTileIdFromMortonString,
    packedTileIdFromParsedNdsCoordinates,
    parseMortonCoordinateString,
    parseNdsCoordinateString,
    parsePackedTileId as parsePackedTileIdValue
} from "../coords/nds-coordinate.util";
import {
    ExternalViewerLocation,
    ExternalViewerProvider,
    ExternalViewerService,
    ResolvedExternalViewerLocation
} from "./external-viewer.service";

interface SearchHistoryViewEntry extends SearchHistoryEntry {
    label: string;
}

interface ParsedCoordinateJump extends SearchJump {
    label: string;
    markerPosition: number[];
    x?: number;
    y?: number;
    level?: number;
}

interface ParsedNdsCoordinateLabel {
    x: number;
    y: number;
    level?: number;
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
    selector: 'search-panel',
    template: `
        <div class="search-wrapper">
            <div class="search-input">
                <!-- Expand on dialog show and collapse on dialog hide -->
                <textarea #textarea class="single-line" pTextarea rows="1"
                          data-testid="search-input"
                          [ngModel]="searchInputValue"
                          (click)="showSearchOverlay()"
                          (ngModelChange)="setSearchValue($event)"
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

            <div class="resizable-container" #searchcontrols>
                <app-dialog #actionsdialog class="search-menu-dialog" data-testid="search-menu-dialog" [showHeader]="false" [(visible)]="searchService.showFeatureSearchDialog"
                          [baseZIndex]="searchActionsBaseZIndex"
                          [focusOnShow]="false"
                          [draggable]="false" [resizable]="false" [closeOnEscape]="false">
                    <div data-testid="search-menu-panel">
                        <div class="search-menu" *ngFor="let item of activeSearchItems">
                            <div onEnterClick (click)="targetToHistory(item)" class="search-option-wrapper"
                               [ngClass]="{'item-disabled': !item.enabled }" tabindex="0">
                                <span class="icon-circle {{ item.color }}">
                                    @if (item.iconType === 'material') {
                                        <span class="material-symbols-outlined">{{ item.icon }}</span>
                                    } @else {
                                        <i class="pi {{ item.icon }}"></i>
                                    }
                                </span>
                                <div class="search-option">
                                    <span class="search-option-name">{{ item.name }}</span>
                                    <br>
                                    <span [innerHTML]="item.label"></span>
                                </div>
                            </div>
                        </div>

                        <div class="search-menu" *ngFor="let item of visibleSearchHistory" >
                            <div onEnterClick (click)="selectHistoryEntry(item)" class="search-option-wrapper" tabindex="0">
                                <div class="icon-circle violet">
                                    <i class="pi pi-history"></i>
                                </div>
                                <div class="search-option-container">
                                    <div class="search-option">
                                        <span class="search-option-name">{{ item.input }}</span>
                                        <br>
                                        <span [innerHTML]="item.label"></span>
                                    </div>
                                    <p-button (click)="removeSearchHistoryEntry(item, $event)" icon="pi pi-times" tabindex="-1"></p-button>
                                </div>
                            </div>
                        </div>
                        <div class="search-menu" *ngFor="let item of inactiveSearchItems; let i = index">
                            <div onEnterClick (click)="targetToHistory(item)" class="search-option-wrapper"
                                 [ngClass]="{'item-disabled': !item.enabled }" tabindex="0">
                                <span class="icon-circle grey">
                                    @if (item.iconType === 'material') {
                                        <span class="material-symbols-outlined">{{ item.icon }}</span>
                                    } @else {
                                        <i class="pi {{ item.icon }}"></i>
                                    }
                                </span>
                                <div class="search-option">
                                    <span class="search-option-name">{{ item.name }}</span>
                                    <br>
                                    <span [innerHTML]="item.label"></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </app-dialog>
                @if (searchService.showFeatureSearchDialog) {
                    <div class="app-resize-handle app-resize-handle-se app-resize-horizontal search-resize-handle"
                         data-testid="search-resize-handle"
                         aria-hidden="true"
                         [style.z-index]="searchResizeHandleZIndex"
                         (pointerdown)="beginSearchResize($event)"
                         (pointermove)="continueSearchResize($event)"
                         (pointerup)="finishSearchResize($event)"
                         (pointercancel)="finishSearchResize($event)"
                         (lostpointercapture)="finishSearchResize($event)">
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
 * Implements the omnibox-style search panel used for jumping, searching loaded features, and query completion.
 */
export class SearchPanelComponent implements AfterViewInit, OnDestroy {
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
        return this.staticTargetsForValue(this.searchInputValue);
    }

    /** Builds static search targets for the current input value. */
    private staticTargetsForValue(inputValue: string) {
        const targetsArray: Array<SearchTarget> = [];
        const value = inputValue.trim();

        /////////// Jump to packed tile id
        let label = "packedTileId = ?";
        const packedTileIdValid = this.jumpService.validatePackedTileId(value);
        if (packedTileIdValid) {
            label = `packedTileId = ${value}`;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:packed-tile-id",
            icon: "pi-table",
            color: "green",
            name: "PackedTileId",
            label: label,
            enabled: packedTileIdValid,
            jump: (value: string) => { return this.parsePackedTileId(value) },
            validate: (value: string) => { return this.jumpService.validatePackedTileId(value) }
        });

        /////////// Jump to NDS x-y
        label = "x = ? | y = ? | (level = ?)";
        const ndsXyValid = this.validateNdsCoordinates(value, true);
        if (ndsXyValid) {
            label = this.parseNdsCoordinates(value, true)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:nds-x-y",
            icon: "pi-map-marker",
            color: "green",
            name: "NDS X-Y Coordinates",
            label: label,
            enabled: ndsXyValid,
            jump: (value: string) => this.parseNdsCoordinates(value, true),
            validate: (value: string) => { return this.validateNdsCoordinates(value, true) }
        });

        /////////// Jump to NDS y-x
        label = "y = ? | x = ? | (level = ?)";
        const ndsYxValid = this.validateNdsCoordinates(value, false);
        if (ndsYxValid) {
            label = this.parseNdsCoordinates(value, false)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:nds-y-x",
            icon: "pi-map-marker",
            color: "green",
            name: "NDS Y-X Coordinates",
            label: label,
            enabled: ndsYxValid,
            jump: (value: string) => this.parseNdsCoordinates(value, false),
            validate: (value: string) => { return this.validateNdsCoordinates(value, false) }
        });

        /////////// Jump to Morton code
        label = "mortonCode = ? | (level = ?)";
        const mortonValid = this.validateMortonCoordinates(value);
        if (mortonValid) {
            label = this.parseMortonCoordinates(value)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:morton-code",
            icon: "pi-map-marker",
            color: "green",
            name: "Morton Code Coordinates",
            label: label,
            enabled: mortonValid,
            jump: (value: string) => this.parseMortonCoordinates(value),
            validate: (value: string) => { return this.validateMortonCoordinates(value) }
        });

        /////////// Jump to lon-lat
        label = "lon = ? | lat = ? | (level = ?)"
        const lonLatValid = this.validateWGS84(value, true);
        if (lonLatValid) {
            label = this.parseWgs84Coordinates(value, true)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:wgs84-lon-lat",
            icon: "pi-map-marker",
            color: "green",
            name: "WGS84 Lon-Lat Coordinates",
            label: label,
            enabled: lonLatValid,
            jump: (value: string) => this.parseWgs84Coordinates(value, true),
            validate: (value: string) => { return this.validateWGS84(value, true) }
        });

        /////////// Jump to lat-lon
        label = "lat = ? | lon = ? | (level = ?)"
        const latLonValid = this.validateWGS84(value, false);
        if (latLonValid) {
            label = this.parseWgs84Coordinates(value, false)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:wgs84-lat-lon",
            icon: "pi-map-marker",
            color: "green",
            name: "WGS84 Lat-Lon Coordinates",
            label: label,
            enabled: latLonValid,
            jump: (value: string) => this.parseWgs84Coordinates(value, false),
            validate: (value: string) => { return this.validateWGS84(value, false) }
        });

        /////////// Open in external viewers
        const externalLocation = this.externalViewerLocation(value);
        for (const provider of this.externalViewerService.providers) {
            targetsArray.push(this.externalViewerTarget(provider, externalLocation));
        }
        return targetsArray;
    }

    /**
     * Wires the omnibox to global keyboard shortcuts, jump-target updates, history persistence, and completion streams.
     */
    constructor(private renderer: Renderer2,
                private elRef: ElementRef,
                public mapService: MapViewStateService,
                public stateService: AppStateService,
                private keyboardService: KeyboardService,
                private messageService: InfoMessageService,
                private jumpService: JumpTargetService,
                private menuService: RightClickMenuService,
                public searchService: FeatureSearchService,
                private locationSearchService: LocationSearchService,
                private externalViewerService: ExternalViewerService,
                private changeDetectorRef: ChangeDetectorRef) {
        this.keyboardService.registerShortcut("Ctrl+k", this.searchShortcutHandler);

        this.subscriptions.add(this.jumpService.targetValueSubject.subscribe((event: string) => {
            this.validateMenuItems();
        }));

        this.subscriptions.add(this.jumpService.jumpTargets.subscribe((jumpTargets: Array<SearchTarget>) => {
            this.setCurrentSearchItems(this.currentSearchItems(jumpTargets));
            this.reloadSearchHistory();
            this.refreshSearchMenu();
        }));

        this.subscriptions.add(this.locationSearchQueryChanged.pipe(
            debounce(() => timer(this.locationSearchService.debounceMs)),
            switchMap(query => this.locationSearchService.search(query, this.stateService.locationSearchResultLimit))
        ).subscribe(matches => {
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
                this.locationSearchItems = matches.map(match =>
                    this.locationSearchService.createSearchTarget(match)
                );
                this.setCurrentSearchItems(this.currentSearchItems());
                this.reloadSearchHistory();
                this.refreshSearchMenu();
                this.changeDetectorRef.markForCheck();
            }, 0);
        }));

        this.subscriptions.add(this.stateService.locationSearchResultLimitState.subscribe(() => {
            this.updateLocationSearchQuery(this.searchInputValue);
            this.refreshSearchMenu();
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
        const locationItems = value === this.searchInputValue ? this.locationSearchItems : [];
        return [
            ...this.jumpService.getJumpTargetsForValue(value),
            ...locationItems,
            ...this.staticTargetsForValue(value)
        ];
    }

    /** Builds the search menu from current jump targets, async location matches, and static local actions. */
    private currentSearchItems(jumpTargets: Array<SearchTarget> = this.jumpService.jumpTargets.getValue()): Array<SearchTarget> {
        return [
            ...jumpTargets,
            ...this.locationSearchItems,
            ...this.staticTargets
        ];
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
        const locationPayload = normalizeLocationSearchPayload(entry.payload);
        if (locationPayload) {
            const locationTarget = this.locationSearchService.createSearchTarget(locationPayload);
            if (locationTarget.id === entry.actionId) {
                return locationTarget;
            }
        }
        if (entry.input === this.targetByIdInput) {
            return this.targetById.get(entry.actionId);
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
                ? this.featureSearchPayloadForInput(trimmedInput) ?? target.payload
                : target.payload
        );
        return {
            version: 2,
            actionId: target.id,
            input: trimmedInput,
            actionName: target.name,
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
        this.writeSearchHistory(this.searchHistory.map(historyEntry => ({
            version: 2,
            actionId: historyEntry.actionId,
            input: historyEntry.input,
            ...(historyEntry.actionName ? {actionName: historyEntry.actionName} : {}),
            ...(historyEntry.payload !== undefined ? {payload: historyEntry.payload} : {}),
            ...(historyEntry.savedAt !== undefined ? {savedAt: historyEntry.savedAt} : {})
        })));
        this.reloadSearchHistory();
    }

    /**
     * Parses decimal or degree-minute-second WGS84 coordinate strings, optionally with a tile level.
     */
    parseWgs84Coordinates(coordinateString: string, isLonLat: boolean): ParsedCoordinateJump | undefined {
        let lon = 0;
        let lat = 0;
        let level = 0;
        let isMatched = false;
        coordinateString = coordinateString.trim();

        // WGS (decimal)
        let exp = /^[^\d-]*(-?\d+(?:\.\d*)?)[^\d-]+(-?\d+(?:\.\d*)?)[^\d\.]*(\d+)?[^\d]*$/g;
        let matches = [...coordinateString.matchAll(exp)];
        if (matches.length > 0) {
            let matchResults = matches[0];
            if (matchResults.length >= 3) {
                if (isLonLat) {
                    lon = Number(matchResults[1]);
                    lat = Number(matchResults[2]);
                } else {
                    lon = Number(matchResults[2]);
                    lat = Number(matchResults[1]);
                }

                if (matchResults.length >= 4 && matchResults[3] !== undefined) {
                    // Zoom level provided.
                    level = Math.max(1, Math.min(Number(matchResults[3].toString()), 14));
                }
                isMatched = true;
            }
        }

        // WGS (degree)
        if (!isMatched) {
            if (isLonLat) {
                exp = /((?:[0-9]{0,1}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([WE])\s*((?:[0-9]{0,2}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([NS])[^\d\.]*(\d+)?[^\d]*$/g
            } else {
                exp = /((?:[0-9]{0,2}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([NS])\s*((?:[0-9]{0,1}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([WE])[^\d\.]*(\d+)?[^\d]*$/g;
            }
            matches = [...coordinateString.matchAll(exp)];
        }
        if (!isMatched && matches.length > 0) {
            let matchResults = matches[0];
            if (matchResults.length >= 9) {
                let degreeLon = isLonLat ? Number(matchResults[1]) : Number(matchResults[5]);
                let minutesLon = isLonLat ? Number(matchResults[2]) : Number(matchResults[6]);
                let secondsLon = isLonLat ? Number(matchResults[3]) : Number(matchResults[7]);
                let degreeLat = isLonLat ? Number(matchResults[5]) : Number(matchResults[1]);
                let minutesLat = isLonLat ? Number(matchResults[6]) : Number(matchResults[2]);
                let secondsLat = isLonLat ? Number(matchResults[7]) : Number(matchResults[3]);

                lat = degreeLat + (minutesLat * 60.0 + secondsLat) / 3600.0;
                if (matchResults[4][0] == 'S') {
                    lat = -lat;
                }

                lon = degreeLon + (minutesLon * 60.0 + secondsLon) / 3600.0;
                if (matchResults[8][0] == 'W') {
                    lon = -lon;
                }

                if (matchResults.length >= 10 && matchResults[9] !== undefined) {
                    // Zoom level provided.
                    level = Math.max(1, Math.min(Number(matchResults[9].toString()), 14));
                }

                isMatched = true;
            }
        }

        if (isMatched) {
            if (level) {
                const tileId = coreLib.getTileIdFromPosition(lon, lat, level);
                return {
                    target: Rectangle.fromDegrees(...coreLib.getTileBox(tileId)),
                    label: isLonLat ? `lon = ${lon} | lat = ${lat} | level = ${level}` : `lat = ${lat} | lon = ${lon} | level = ${level}`,
                    markerPosition: [lat, lon]
                };
            }
            return {
                target: [lat, lon, 0],
                label: isLonLat ? `lon = ${lon} | lat = ${lat}` : `lat = ${lat} | lon = ${lon}`,
                markerPosition: [lat, lon]
            };
        }
        return undefined;
    }

    /** Converts a signed NDS.Live packed tile id into a WGS84 rectangle for camera jumps. */
    parsePackedTileId(value: string): Rectangle | undefined {
        if (!value) {
            this.messageService.showError("No value provided!");
            return;
        }
        try {
            const packedTileId = parsePackedTileIdValue(value);
            if (!packedTileId) {
                throw new Error("TileId is not a valid PackedTileId.");
            }
            return Rectangle.fromDegrees(...coreLib.getTileBox(packedTileId.value));
        } catch (e) {
            this.messageService.showError("Possibly malformed PackedTileId: " + (e as Error).message.toString());
        }
        return undefined;
    }

    /** Parses NDS coordinate pairs into either a point jump or a tile-extent jump when a level is present. */
    parseNdsCoordinates(value: string, isXyOrder: boolean): ParsedCoordinateJump | undefined {
        const parsed = parseNdsCoordinateString(value, isXyOrder);
        if (!parsed) {
            return undefined;
        }
        const label = this.ndsCoordinateLabel(parsed, isXyOrder);
        if (parsed.level !== undefined) {
            const tileId = packedTileIdFromParsedNdsCoordinates(parsed);
            if (tileId === undefined) {
                return undefined;
            }
            return {
                target: Rectangle.fromDegrees(...coreLib.getTileBox(tileId)),
                label,
                markerPosition: [parsed.lat, parsed.lon],
                x: parsed.x,
                y: parsed.y,
                level: parsed.level
            };
        }
        return {
            target: [parsed.lat, parsed.lon, 0],
            label,
            markerPosition: [parsed.lat, parsed.lon],
            x: parsed.x,
            y: parsed.y
        };
    }

    /** Parses a Morton code into either a point jump or a tile-extent jump when a level is present. */
    parseMortonCoordinates(value: string): ParsedCoordinateJump | undefined {
        const parsed = parseMortonCoordinateString(value);
        if (!parsed) {
            return undefined;
        }
        const label = this.mortonCoordinateLabel(parsed);
        if (parsed.level !== undefined) {
            const tileId = packedTileIdFromMortonString(value);
            if (tileId === undefined) {
                return undefined;
            }
            return {
                target: Rectangle.fromDegrees(...coreLib.getTileBox(tileId)),
                label,
                markerPosition: [parsed.lat, parsed.lon],
                x: parsed.x,
                y: parsed.y,
                level: parsed.level
            };
        }
        return {
            target: [parsed.lat, parsed.lon, 0],
            label,
            markerPosition: [parsed.lat, parsed.lon],
            x: parsed.x,
            y: parsed.y
        };
    }

    /** Builds the search-action label for parsed NDS coordinate input. */
    private ndsCoordinateLabel(parsed: ParsedNdsCoordinateLabel, isXyOrder: boolean): string {
        const ordered = isXyOrder
            ? `x = ${parsed.x} | y = ${parsed.y}`
            : `y = ${parsed.y} | x = ${parsed.x}`;
        return parsed.level === undefined ? ordered : `${ordered} | level = ${parsed.level}`;
    }

    /** Builds the search-action label for parsed Morton-code input. */
    private mortonCoordinateLabel(parsed: ParsedNdsCoordinateLabel): string {
        const base = `x = ${parsed.x} | y = ${parsed.y}`;
        return parsed.level === undefined ? base : `${base} | level = ${parsed.level}`;
    }

    /**
     * Dispatches the parsed jump target either as a camera move or a rectangle fit request.
     */
    jumpToLocation(result: SearchJumpResult | undefined, label?: string | null) {
        if (result === undefined) {
            this.messageService.showError("Could not parse coordinates from the input.");
            return;
        }
        const jump = normalizeSearchJumpResult(result);
        const coordinates = jump.target;
        const targetViewIndex = this.stateService.focusedView;
        if (Array.isArray(coordinates)) {
            let lat = coordinates[0];
            let lon = coordinates[1];
            const cameraView = this.stateService.cameraViewDataState.getValue(targetViewIndex);
            let alt = coordinates[2] ? coordinates[2] : cameraView.destination.alt;

            this.mapService.moveToWgs84PositionTopic.next({
                x: lon,
                y: lat,
                z: alt,
                targetView: targetViewIndex
            });
            if (label) {
                this.mapService.showLocationLabelTopic.next({
                    targetView: targetViewIndex,
                    x: lon,
                    y: lat,
                    label
                });
            }
        } else {
            this.mapService.moveToRectangleTopic.next({
                targetView: targetViewIndex,
                rectangle: {
                    west: GeoMath.toDegrees(coordinates.west),
                    south: GeoMath.toDegrees(coordinates.south),
                    east: GeoMath.toDegrees(coordinates.east),
                    north: GeoMath.toDegrees(coordinates.north),
                }
            });
        }
        if (jump.markerPosition) {
            this.jumpService.markedPosition.next(jump.markerPosition);
        }
    }

    /** Builds one omnibox action for a configured external map viewer. */
    private externalViewerTarget(
        provider: ExternalViewerProvider,
        location: ResolvedExternalViewerLocation | undefined
    ): SearchTarget {
        return {
            id: provider.id,
            icon: "pi-map-marker",
            color: "green",
            name: provider.name,
            label: location
                ? this.externalViewerLabel(location)
                : `lat = ? | lon = ?<br><span class="search-option-warning">Invalid coordinates</span>`,
            enabled: location !== undefined,
            acceptsEmptyInput: true,
            saveToHistory: (input: string) => this.explicitExternalViewerLocation(input) !== undefined,
            execute: (input: string) => {
                const resolved = this.externalViewerLocation(input);
                if (resolved) {
                    this.externalViewerService.open(provider, resolved);
                }
            },
            validate: (input: string) => this.externalViewerLocation(input) !== undefined
        };
    }

    /** Formats the coordinate and fallback source shown below an external-viewer action. */
    private externalViewerLabel(location: ResolvedExternalViewerLocation): string {
        const sourceLabels = {
            input: "search input",
            marker: "current marker",
            viewport: "viewport centre"
        } as const;
        return `lat = ${location.lat} | lon = ${location.lon} | ${sourceLabels[location.source]}`;
    }

    /** Resolves valid explicit coordinates or applies the shared marker/viewport fallback. */
    private externalViewerLocation(value: string): ResolvedExternalViewerLocation | undefined {
        const explicit = this.explicitExternalViewerLocation(value);
        if (explicit) {
            return this.externalViewerService.resolveLocation(explicit);
        }
        if (this.looksLikeCoordinateInput(value)) {
            return undefined;
        }
        return this.externalViewerService.resolveLocation();
    }

    /** Returns a valid explicit latitude/longitude input without applying fallback behavior. */
    private explicitExternalViewerLocation(value: string): ExternalViewerLocation | undefined {
        const parsed = this.parseWgs84Coordinates(value, false);
        if (!parsed || !this.validateWGS84(value, false)) {
            return undefined;
        }
        return {lat: parsed.markerPosition[0], lon: parsed.markerPosition[1]};
    }

    /** Distinguishes malformed two-coordinate input from ordinary search text. */
    private looksLikeCoordinateInput(value: string): boolean {
        return (value.match(/-?\d+(?:\.\d+)?/g) ?? []).length >= 2;
    }

    /**
     * Re-evaluates which jump targets are currently executable for the active input.
     */
    validateMenuItems() {
        this.searchItems.forEach(item => item.enabled = this.canRunTarget(item, this.searchInputValue));
    }

    /**
     * Validates coordinate inputs by parsing them and checking geographic bounds.
     */
    validateWGS84(value: string, isLonLat: boolean = false) {
        const result = this.parseWgs84Coordinates(value, isLonLat);
        if (result) {
            return result.markerPosition[0] >= -90 && result.markerPosition[0] <= 90 &&
                result.markerPosition[1] >= -180 && result.markerPosition[1] <= 180;
        }
        return false;
    }

    /** Validates integer NDS coordinate input accepted by the built-in NDS jump targets. */
    validateNdsCoordinates(value: string, isXyOrder: boolean) {
        return this.parseNdsCoordinates(value, isXyOrder) !== undefined;
    }

    /** Validates Morton-code input accepted by the built-in Morton jump target. */
    validateMortonCoordinates(value: string) {
        return this.parseMortonCoordinates(value) !== undefined;
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

    /** Returns whether a target can run for the supplied input, including empty-input actions. */
    private canRunTarget(target: SearchTarget, input: string): boolean {
        return (!!input.trim() || target.acceptsEmptyInput === true) && target.validate(input);
    }

    /**
     * Executes the chosen search target by either jumping locally or delegating to its side-effect callback.
     */
    runTarget(entry: SearchHistoryEntry) {
        const item = this.resolveTargetForEntry(entry);
        if (!item) {
            if (this.locationSearchService.isLocationTargetId(entry.actionId)) {
                this.restoreLocationSearchTarget(entry);
                return;
            }
            this.messageService.showError("Search action is no longer available");
            return;
        }
        this.executeResolvedTarget(item, entry);
    }

    /** Executes an already resolved target. */
    private executeResolvedTarget(item: SearchTarget, entry: SearchHistoryEntry) {
        if (!item.validate(entry.input)) {
            this.messageService.showError("Search action is not valid for the stored input");
            return;
        }
        if (item.jump !== undefined) {
            const payload = entry.payload ?? item.payload;
            this.jumpToLocation(item.jump(entry.input, payload), this.locationSearchService.labelFromPayload(payload));
            return;
        }

        if (item.execute !== undefined) {
            item.execute(entry.input, entry.payload ?? item.payload);
            return;
        }
    }

    /** Recreates compact location URL/search-state entries from the built-in mapget /location endpoint. */
    private restoreLocationSearchTarget(entry: SearchHistoryEntry): void {
        const subscription = this.locationSearchService.restoreMapgetLocationTarget(entry.actionId, entry.input)
            .subscribe(result => {
                if (!result.target) {
                    this.messageService.showError(result.error ?? "Could not restore location search result.");
                    return;
                }
                this.executeResolvedTarget(result.target, {
                    ...entry,
                    payload: result.target.payload
                });
            });
        this.subscriptions.add(subscription);
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
