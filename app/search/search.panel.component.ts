import {AfterViewInit, Component, ElementRef, HostListener, Renderer2, ViewChild} from "@angular/core";
import {GeoMath, Rectangle} from "../integrations/geo";
import {InfoMessageService} from "../shared/info.service";
import {SearchTarget, JumpTargetService} from "./jump.service";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService} from "../shared/appstate.service";
import {KeyboardService} from "../shared/keyboard.service";
import {debounceTime, distinctUntilChanged, map, of, skip, startWith, Subject, switchMap, timer} from "rxjs";
import {RightClickMenuService} from "../mapview/rightclickmenu.service";
import {FeatureSearchService} from "./feature.search.service";
import getCaretCoordinates from "../shared/caret.util";
import {CompletionCandidate} from "./search.worker";
import {coreLib} from "../integrations/wasm";
import {DialogStackService} from "../shared/dialog-stack.service";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {
    historyEntryDedupeKey,
    historyEntryKey,
    isLegacySearchHistoryEntry,
    LegacySearchHistoryEntry,
    normalizeResolvedSearchHistoryEntry,
    normalizeSearchHistoryEntry,
    sameSearchHistoryEntry,
    SearchHistoryEntry,
    SearchHistoryStateEntry,
    withSearchHistoryActionName
} from "../shared/search-history";

interface SearchHistoryViewEntry extends SearchHistoryEntry {
    label: string;
}

@Component({
    selector: 'search-panel',
    template: `
        <div class="search-wrapper">
            <div class="search-input">
                <!-- Expand on dialog show and collapse on dialog hide -->
                <textarea #textarea class="single-line" pTextarea rows="1"
                          data-testid="search-input"
                          [(ngModel)]="searchInputValue"
                          (click)="showSearchOverlay()"
                          (ngModelChange)="setSearchValue(searchInputValue)"
                          (keydown)="onKeydown($event)"
                          (keyup)="onKeyup($event)"
                          (blur)="onBlur()"
                          (focus)="onFocus()"
                          (scroll)="updateCursor()"
                          placeholder="Search">
                </textarea>

                @if (completion.visible || completion.pending) {
                    <div class="completion-popup" (mousedown)="onCompletionPopupDown($event)"
                         [style.top.px]="completion.top"
                         [style.left.px]="completion.left" [style.z-index]="completion.zIndex">
                        @for (item of completionItems; track $index) {
                            <div [ngClass]="{'selected': $index === completion.selectionIndex}"
                                 (click)="applyCompletion(item.query)">
                                <div class="row">
                                    <span>{{ item.text }}</span><span class="type">({{ item.kind }})</span>
                                </div>
                                @if (item.hint) {
                                    <div class="row hint">
                                        {{ item.hint }}
                                    </div>
                                }
                            </div>
                        }
                        @if (completion.pending) {
                            <p-progress-spinner aria-label="Loading completion candidates" 
                                                [style]="{ height: '1em', width: '1em' }" />
                        }
                    </div>
                }
            </div>

            <div class="resizable-container" #searchcontrols>
                <app-dialog #actionsdialog class="search-menu-dialog" data-testid="search-menu-dialog" [showHeader]="false" [(visible)]="searchService.showFeatureSearchDialog"
                          [baseZIndex]="30040"
                          [focusOnShow]="false"
                          [draggable]="false" [resizable]="false" [closeOnEscape]="false">
                    <div data-testid="search-menu-panel">
                        <div class="search-menu" *ngFor="let item of activeSearchItems">
                            <div onEnterClick (click)="targetToHistory(item)" class="search-option-wrapper"
                               [ngClass]="{'item-disabled': !item.enabled }" tabindex="0">
                                <span class="icon-circle {{ item.color }}">
                                    <i class="pi {{ item.icon }}"></i>
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
                                    <p-button (click)="removeSearchHistoryEntry(item)" icon="pi pi-times" tabindex="-1"></p-button>
                                </div>
                            </div>
                        </div>
                        <div class="search-menu" *ngFor="let item of inactiveSearchItems; let i = index">
                            <div onEnterClick (click)="targetToHistory(item)" class="search-option-wrapper"
                                 [ngClass]="{'item-disabled': !item.enabled }" tabindex="0">
                                <span class="icon-circle grey">
                                    <i class="pi {{ item.icon }}"></i>
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
    styles: [`
        .item-disabled {
            color: darkgrey;
            pointer-events: none;
        }
    `],
    standalone: false
})
/**
 * Implements the omnibox-style search panel used for jumping, searching loaded features, and query completion.
 */
export class SearchPanelComponent implements AfterViewInit {
    private static readonly SEARCH_ACTIONS_BASE_Z_INDEX = 30040;

    searchItems: Array<SearchTarget> = [];
    private targetById = new Map<string, SearchTarget>();
    private targetByIdInput = "";
    activeSearchItems: Array<SearchTarget> = [];
    inactiveSearchItems: Array<SearchTarget> = [];
    searchInputValue: string = "";
    searchHistory: Array<SearchHistoryViewEntry> = [];
    visibleSearchHistory: Array<SearchHistoryViewEntry> = [];
    private suppressHistoryExecution = false;

    /* Autocompletion */
    private searchInputChanged: Subject<void> = new Subject<void>();
    completionItems: Array<CompletionCandidate> = [];
    completion = {
        // Position of the popup
        top: 0,
        left: 0,
        // Selected item
        selectionIndex: 0,
        // True if the popup is visible
        visible: false,
        // True if we are waiting for candidates
        pending: false,
        // Delay in ms to show the spinner
        pendingDelay: 600,
        // Delay for requesting completion candidates
        completionDelay: 150,
        // Keep completion above Search Actions dialog without using a hardcoded global z-index.
        zIndex: SearchPanelComponent.SEARCH_ACTIONS_BASE_Z_INDEX + 1,
    };

    mapSelectionVisible: boolean = false;
    mapSelection: Array<string> = [];

    @ViewChild('textarea') textarea!: ElementRef<HTMLTextAreaElement>;
    @ViewChild('actionsdialog') dialog!: AppDialogComponent;

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

        /////////// Jump to mapget tile id
        let label = "tileId = ?";
        if (this.jumpService.validateMapgetTileId(value)) {
            label = `tileId = ${value}`;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "j:mapget-tile-id",
            icon: "pi-table",
            color: "green",
            name: "Mapget Tile ID",
            label: label,
            enabled: false,
            jump: (value: string) => { return this.parseMapgetTileId(value) },
            validate: (value: string) => { return this.jumpService.validateMapgetTileId(value) }
        });

        /////////// Jump to lon-lat
        label = "lon = ? | lat = ? | (level = ?)"
        if (this.validateWGS84(value, true)) {
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
            enabled: false,
            jump: (value: string) => { return this.parseWgs84Coordinates(value, true)?.target },
            validate: (value: string) => { return this.validateWGS84(value, true) }
        });

        /////////// Jump to lat-lon
        label = "lat = ? | lon = ? | (level = ?)"
        if (this.validateWGS84(value, false)) {
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
            enabled: false,
            jump: (value: string) => { return this.parseWgs84Coordinates(value, false)?.target },
            validate: (value: string) => { return this.validateWGS84(value, false) }
        });

        /////////// Jump to Google Maps/OSM
        label = "lat = ? | lon = ?"
        if (this.validateWGS84(value, false)) {
            label = this.parseWgs84Coordinates(value, false)!.label;
        } else {
            label += `<br><span class="search-option-warning">Insufficient parameters</span>`;
        }
        targetsArray.push({
            id: "e:gm",
            icon: "pi-map-marker",
            color: "green",
            name: "Open WGS84 Lat-Lon in Google Maps",
            label: label,
            enabled: false,
            jump: (value: string) => { return this.openInGM(value) },
            validate: (value: string) => { return this.validateWGS84(value, false) }
        });
        targetsArray.push({
            id: "e:osm",
            icon: "pi-map-marker",
            color: "green",
            name: "Open WGS84 Lat-Lon in Open Street Maps",
            label: label,
            enabled: false,
            jump: (value: string) => { return this.openInOSM(value) },
            validate: (value: string) => { return this.validateWGS84(value, false) }
        });
        return targetsArray;
    }

    /**
     * Wires the omnibox to global keyboard shortcuts, jump-target updates, history persistence, and completion streams.
     */
    constructor(private renderer: Renderer2,
                private elRef: ElementRef,
                public mapService: MapDataService,
                public stateService: AppStateService,
                private keyboardService: KeyboardService,
                private messageService: InfoMessageService,
                private jumpService: JumpTargetService,
                private menuService: RightClickMenuService,
                public searchService: FeatureSearchService,
                private dialogStack: DialogStackService) {
        this.keyboardService.registerShortcut("Ctrl+k", this.clickOnSearchToStart.bind(this));

        this.jumpService.targetValueSubject.subscribe((event: string) => {
            this.validateMenuItems();
        });

        this.jumpService.jumpTargets.subscribe((jumpTargets: Array<SearchTarget>) => {
            this.setCurrentSearchItems([
                ...jumpTargets,
                ...this.staticTargets
            ]);
            this.reloadSearchHistory();
            this.refreshSearchMenu();
        });

        // TODO: Get rid of map selection, as soon as we support
        //  multi-selection from different maps. Then we can
        //  just search all maps simultaneously.
        // NOTE: Currently users must select specific maps to search. Once cross-map
        // multi-selection is implemented, search can operate on all maps at once.
        jumpService.mapSelectionSubject.subscribe(maps => {
            this.mapSelection = maps;
            this.mapSelectionVisible = true;
        });

        this.stateService.searchState.subscribe(search => {
            const entry = this.resolveStateEntry(search);
            if (!entry) {
                return;
            }
            if (isLegacySearchHistoryEntry(entry)) {
                this.searchInputValue = entry[1];
                const migrated = this.migrateLegacySearchHistoryEntry(entry);
                if (migrated) {
                    this.withSuppressedHistoryExecution(() => {
                        this.stateService.migrateSearchStateValue(migrated);
                        this.stateService.migrateLastSearchHistoryEntry(migrated);
                    });
                }
                return;
            }

            this.searchInputValue = entry.input;
            const lastEntry = normalizeResolvedSearchHistoryEntry(this.stateService.lastSearchHistoryEntry);
            if (!sameSearchHistoryEntry(lastEntry, entry)) {
                this.stateService.lastSearchHistoryEntry = entry;
            }
        });

        this.stateService.lastSearchHistoryEntryState.pipe(skip(2)).subscribe(entry => {
            if (!this.stateService.ready.getValue()) {
                return;
            }
            const resolvedEntry = this.resolveStateEntry(entry);
            if (isLegacySearchHistoryEntry(resolvedEntry)) {
                const migrated = this.migrateLegacySearchHistoryEntry(resolvedEntry);
                if (migrated) {
                    this.withSuppressedHistoryExecution(() => this.stateService.migrateLastSearchHistoryEntry(migrated));
                }
                this.reloadSearchHistory();
                return;
            }
            if (resolvedEntry && !this.suppressHistoryExecution) {
                this.searchInputValue = resolvedEntry.input;
                this.runTarget(resolvedEntry);
                this.dialog.close(new Event("close-on-execute"));
            }
            this.reloadSearchHistory();
        });

        this.menuService.lastInspectedTileSourceDataOption.subscribe(lastInspectedData => {
            if (lastInspectedData && lastInspectedData.tileId && lastInspectedData.mapId && lastInspectedData.layerId) {
                const value = `${lastInspectedData?.tileId} "${lastInspectedData?.mapId}" "${lastInspectedData?.layerId}"`;
                this.stateService.setSearchHistoryState({
                    version: 2,
                    actionId: "source-data",
                    input: value,
                    actionName: "Inspect Tile Layer Source Data"
                });
            }
        });

        this.reloadSearchHistory();

        this.searchService.completionPending.pipe(
            switchMap(pending => pending ? timer(this.completion.pendingDelay).pipe(map(() => true)) : of(false)),
            startWith(false),
            distinctUntilChanged()
        ).subscribe((pending: boolean) => {
            this.completion.pending = pending;
        })

        this.searchService.completionCandidates.pipe(distinctUntilChanged()).subscribe((value: CompletionCandidate[]) => {
            this.completionItems = value.filter((item, index, array) => {
                // Discard any candidate that is equal to the current input
                // or does not relate to the current input (e.g. delayed results).
                return item.query !== this.searchInputValue && item.source === this.searchInputValue;
            });

            const length = this.completionItems.length
            if (length <= this.completion.selectionIndex)
                this.completion.selectionIndex = length;

            // Only show the pop-up if the pop-up was prev. hidden
            // or the currently focused element is the query input.
            // This is to prevent the pop-up showing if the user quickly
            // tabs out of the query input before the first completion
            // items are ready.
            const focusValid =
                this.completion.visible ||
                this.textarea.nativeElement === document.activeElement;

            if (length > 0 && focusValid) {
                this.refreshCompletionZIndex();
            }
            this.completion.visible = length > 0 && focusValid;
        });

        this.searchInputChanged.pipe(debounceTime(this.completion.completionDelay)).subscribe(() => {
            this.completeQuery(this.searchInputValue, this.cursorPosition);
        })
    }

    /**
     * Hooks dialog lifecycle events once the PrimeNG dialog reference exists.
     */
    ngAfterViewInit() {
        this.searchService.fixedDiagnosticsSearchQuery.subscribe(fixedQuery => this.setSearchValue(fixedQuery));

        this.dialog.onShow.subscribe(() => {
            setTimeout(() => {
                this.expandTextarea();
                this.refreshCompletionZIndex();
            }, 10);
        });

        this.dialog.onHide.subscribe(() => {
            setTimeout(() => {
                this.shrinkTextarea();
            }, 10);
        });
    }

    /** Normalizes a raw persisted search entry from state. */
    private resolveStateEntry(raw: unknown): SearchHistoryStateEntry | null {
        return normalizeSearchHistoryEntry(raw);
    }

    /** Runs an action without triggering search history execution side effects. */
    private withSuppressedHistoryExecution(action: () => void) {
        this.suppressHistoryExecution = true;
        try {
            action();
        } finally {
            this.suppressHistoryExecution = false;
        }
    }

    /** Returns search targets applicable to an input value. */
    private searchItemsForValue(value: string): Array<SearchTarget> {
        return [
            ...this.jumpService.getJumpTargetsForValue(value),
            ...this.staticTargetsForValue(value)
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
        return {
            version: 2,
            actionId: target.id,
            input: trimmedInput,
            actionName: target.name,
            savedAt: Date.now()
        };
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

    /**
     * Removes one persisted history entry and mirrors the change back to app state.
     */
    removeSearchHistoryEntry(entry: SearchHistoryEntry) {
        const key = historyEntryKey(entry);
        this.searchHistory = this.searchHistory.filter(historyEntry => historyEntryKey(historyEntry) !== key);
        this.writeSearchHistory(this.searchHistory.map(historyEntry => ({
            version: 2,
            actionId: historyEntry.actionId,
            input: historyEntry.input,
            ...(historyEntry.actionName ? {actionName: historyEntry.actionName} : {}),
            ...(historyEntry.savedAt !== undefined ? {savedAt: historyEntry.savedAt} : {})
        })));
        this.reloadSearchHistory();
        const activeSearch = normalizeResolvedSearchHistoryEntry(this.stateService.search);
        if (activeSearch && historyEntryKey(activeSearch) === key) {
            this.stateService.search = [];
        }
    }

    /**
     * Parses decimal or degree-minute-second WGS84 coordinate strings, optionally with a tile level.
     */
    parseWgs84Coordinates(coordinateString: string, isLonLat: boolean): {target: Rectangle | number[], label: string, coords: number[]} | undefined {
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
                    coords: [lat, lon]
                };
            }
            return {
                target: [lat, lon, 0],
                label: isLonLat ? `lon = ${lon} | lat = ${lat}` : `lat = ${lat} | lon = ${lon}`,
                coords: [lat, lon]
            };
        }
        return undefined;
    }

    /**
     * Converts a numeric mapget tile id into a WGS84 rectangle for camera jumps.
     */
    parseMapgetTileId(value: string): Rectangle | undefined {
        if (!value) {
            this.messageService.showError("No value provided!");
            return;
        }
        try {
            const wgs84TileId = BigInt(value);
            return Rectangle.fromDegrees(...coreLib.getTileBox(wgs84TileId));
        } catch (e) {
            this.messageService.showError("Possibly malformed TileId: " + (e as Error).message.toString());
        }
        return undefined;
    }

    /**
     * Dispatches the parsed jump target either as a camera move or a rectangle fit request.
     */
    jumpToLocation(coordinates: number[] | undefined | Rectangle) {
        if (coordinates === null) {
            return;
        }
        if (coordinates === undefined) {
            this.messageService.showError("Could not parse coordinates from the input.");
            return;
        }
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
            this.jumpService.markedPosition.next(coordinates);
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
    }

    /**
     * Opens the parsed coordinates in Google Maps and returns them for local reuse.
     */
    openInGM(value: string): number[] | undefined {
        if (!value) {
            this.messageService.showError("No value provided!");
            return;
        }
        const result = this.parseWgs84Coordinates(value, false)?.coords;
        if (result) {
            const lat = result[0];
            const lon = result[1];
            window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lon}`, "_blank");
            return result;
        }
        return;
    }

    /**
     * Opens the parsed coordinates in OpenStreetMap and returns them for local reuse.
     */
    openInOSM(value: string): Rectangle | number[] | undefined {
        if (!value) {
            this.messageService.showError("No value provided!");
            return;
        }
        const result = this.parseWgs84Coordinates(value, false)?.coords;
        if (result) {
            const lat = result[0];
            const lon = result[1];
            window.open(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=16`, "_blank");
            return result;
        }
        return;
    }

    /**
     * Re-evaluates which jump targets are currently executable for the active input.
     */
    validateMenuItems() {
        this.searchItems.forEach(item =>
            item.enabled = this.searchInputValue != "" && item.validate(this.searchInputValue)
        );
    }

    /**
     * Validates coordinate inputs by parsing them and checking geographic bounds.
     */
    validateWGS84(value: string, isLonLat: boolean = false) {
        const result = this.parseWgs84Coordinates(value, isLonLat);
        if (result) {
            return result.coords[0] >= -90 && result.coords[0] <= 90 && result.coords[1] >= -180 && result.coords[1] <= 180;
        }
        return false;
    }

    /**
     * Opens the action dialog and repositions the completion popup relative to the caret.
     */
    showSearchOverlay() {
        this.updateCursor();
        this.searchService.showFeatureSearchDialog = true;
        this.setSearchValue(this.searchInputValue);
        this.refreshCompletionZIndex();
    }

    /**
     * Keeps the completion popup just above the PrimeNG search-actions dialog without hardcoding a global z-index.
     */
    private refreshCompletionZIndex() {
        const container = this.dialog?.container();
        if (!container) {
            this.completion.zIndex = SearchPanelComponent.SEARCH_ACTIONS_BASE_Z_INDEX + 1;
            return;
        }

        const inlineZIndex = Number.parseInt(container.style.zIndex, 10);
        const computedZIndex = Number.parseInt(window.getComputedStyle(container).zIndex, 10);
        const dialogZIndex = Number.isFinite(inlineZIndex)
            ? inlineZIndex
            : (Number.isFinite(computedZIndex)
                ? computedZIndex
                : SearchPanelComponent.SEARCH_ACTIONS_BASE_Z_INDEX);
        this.completion.zIndex = dialogZIndex + 1;
    }

    /**
     * Updates the omnibox value and recomputes active targets, inactive targets, and matching history entries.
     */
    setSearchValue(value: string) {
        this.searchInputValue = value;
        if (!value) {
            this.stateService.setSearchHistoryState(null);
            this.jumpService.targetValueSubject.next(value);
            this.setCurrentSearchItems([...this.jumpService.jumpTargets.getValue(), ...this.staticTargets]);
            this.refreshSearchMenu();
            return;
        }
        this.jumpService.targetValueSubject.next(value);
        this.refreshSearchMenu();
    }

    /** Refreshes search menu state from the current input value. */
    private refreshSearchMenu() {
        this.activeSearchItems = [];
        this.inactiveSearchItems = [];
        if (!this.searchInputValue) {
            this.inactiveSearchItems = this.searchItems;
            this.visibleSearchHistory = this.searchHistory;
            return;
        }
        for (const searchItem of this.searchItems) {
            if (searchItem.validate(this.searchInputValue)) {
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
        const entry = this.searchHistoryEntryForTarget(target, this.searchInputValue);
        if (entry) {
            this.stateService.setSearchHistoryState(entry);
        }
    }

    /**
     * Executes the chosen search target by either jumping locally or delegating to its side-effect callback.
     */
    runTarget(entry: SearchHistoryEntry) {
        const item = this.resolveTargetForEntry(entry);
        if (!item) {
            this.messageService.showError("Search action is no longer available");
            return;
        }
        if (!item.validate(entry.input)) {
            this.messageService.showError("Search action is not valid for the stored input");
            return;
        }
        if (item.jump !== undefined) {
            this.jumpToLocation(item.jump(entry.input));
            return;
        }

        if (item.execute !== undefined) {
            item.execute(entry.input);
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
            this.completion.visible = false;
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

            if (this.completion.visible) {
                this.applyCompletion();
                event.stopPropagation();
            } else {
                if (this.searchInputValue.trim() && this.activeSearchItems.length) {
                    this.targetToHistory(this.activeSearchItems[0]);
                } else {
                    this.stateService.setSearchHistoryState(null);
                }

                textarea.blur();
            }
        } else if (event.key === 'Escape') {
            event.stopPropagation();
            if (this.completion.visible || this.completion.pending) {
                this.resetCompletion();
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
            if (this.completion.visible) {
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
    applyCompletion(text: string | undefined = undefined) {
        if (this.completion.visible || text) {
            if (text !== undefined) {
                this.setSearchValue(text);
                this.textarea.nativeElement.focus();
            } else {
                let item = this.completionItems[this.completion.selectionIndex];
                this.setSearchValue(item.query);

                let cursor = item.begin + item.text.length
                setTimeout(() => {
                    this.textarea.nativeElement.setSelectionRange(
                        cursor, cursor, "forward");
                }, 0);
            }

            this.completionItems = [];
            this.completion.visible = false;
        }
    }

    /**
     * Rotates the completion selection index with wrap-around.
     */
    selectNextCompletion(next: boolean = true) {
        const direction = next && +1 || -1
        const count = this.completionItems.length || 0;

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
     * Replays one persisted search history entry through the shared search-state channel.
     */
    selectHistoryEntry(entry: SearchHistoryEntry) {
        this.stateService.setSearchHistoryState({
            version: 2,
            actionId: entry.actionId,
            input: entry.input,
            ...(entry.actionName ? {actionName: entry.actionName} : {}),
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

    /**
     * Central outside-click filter that ignores interactive controls and map-view interactions.
     */
    private handleGlobalDown(event: Event): void {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const clickedInsideComponent = target ? this.elRef.nativeElement.contains(target as Node) : false;
        const clickedInsideMapView = !!target?.closest('.mapviewer-renderlayer');
        const clickedInsideResizablePanel = !!target?.closest('.resizable-container');

        // Check if the clicked element is a form control or other interactive element we should ignore.
        const clickedOnInteractiveElement = !!target && (
            target.tagName === 'BUTTON' ||
            target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable ||
            !!target.closest('p-checkbox') ||
            !!target.closest('p-dropdown') ||
            !!target.closest('p-multiselect') ||
            !!target.closest('p-calendar') ||
            !!target.closest('p-inputnumber') ||
            (!!target.closest('.p-component') && !clickedInsideMapView) ||
            clickedInsideResizablePanel
        );

        if (!clickedInsideComponent && !clickedOnInteractiveElement) {
            this.dialog.close(new MouseEvent(event.type));
        }
    }

    /**
     * Starts a new completion request for the current query and cursor position.
     */
    completeQuery(query: string, point: number | undefined) {
        if (!query) {
            this.completion.visible = false;
            this.completionItems = [];
            this.searchService.clearCurrentCompletion();
            return;
        }

        this.searchService.completeQuery(query, point || query.length);
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
        this.searchService.completionPending.next(false);
        this.searchService.completionCandidates.next([]);
    }
}
