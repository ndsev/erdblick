import {Component, OnDestroy, ViewChild, ViewContainerRef} from "@angular/core";
import {FeatureSearchService} from "./feature.search.service";
import {JumpTargetService} from "./jump.service";
import {MapDataService} from "../mapdata/map.service";
import {TreeNode} from "primeng/api";
import {InfoMessageService} from "../shared/info.service";
import {DiagnosticsMessage, TraceResult} from "./search.worker";
import {coreLib} from "../integrations/wasm";
import {AppStateService, FEATURE_SEARCH_DIALOG_LAYOUT_ID, SEARCH_DOCK_TAB_ID} from "../shared/appstate.service";
import {Tree} from "primeng/tree";
import {Scroller} from "primeng/scroller";
import {DialogStackService} from "../shared/dialog-stack.service";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {Subscription} from "rxjs";
import {AppPanelComponent} from "../shared/app-panel.component";

interface FeatureSearchGroupingOption {
    name: string;
    value: number;
}

@Component({
    selector: "feature-search",
    template: `
        @if (isDocked()) {
            @if (featureSearchDialogVisible) {
                <app-panel #featureSearchPanel class="feature-search-panel" data-testid="feature-search-docked-panel"
                           [layoutId]="featureSearchLayoutId" [persistLayout]="true"
                           [dockedPanelCount]="featureSearchDockedPanelCount"
                           [expanded]="featureSearchExpanded"
                           (onShow)="onDockedPanelShow()">
                    <ng-template #header>
                        <ng-container *ngTemplateOutlet="searchHeader"></ng-container>
                    </ng-template>
                    <ng-template #content>
                        <ng-container *ngTemplateOutlet="searchContent"></ng-container>
                    </ng-template>
                </app-panel>
            }
        } @else {
            <app-dialog #featureSearchDialog class="feature-search-dialog" data-testid="feature-search-dialog"
                      [closeOnEscape]="false"
                      [visible]="featureSearchDialogVisible" (visibleChange)="onPanelVisibleChange($event)"
                      [draggable]="true" [resizable]="true" [appendTo]="'body'"
                      [persistLayout]="true" [persistOpenState]="false" [layoutId]="featureSearchLayoutId"
                      (onShow)="onDialogShow($event)"
                      (onResizeEnd)="syncTreeScrollHeight($event)" (onHide)="onHide($event)">
                <ng-template #header>
                    <ng-container *ngTemplateOutlet="searchHeader"></ng-container>
                </ng-template>
                <ng-template #content>
                    <ng-container *ngTemplateOutlet="searchContent"></ng-container>
                </ng-template>
            </app-dialog>
        }

        <ng-template #searchHeader>
            <app-surface-header class="feature-search-surface-header"
                                title="Search Loaded Features"
                                titleIcon="search"
                                [hasColorPicker]="true"
                                [color]="searchService.pointColor"
                                [dockMode]="isDocked() ? 'undock' : 'dock'"
                                [sizeToggleVisible]="isDocked()"
                                [sizeToggleDisabled]="featureSearchDockedPanelCount <= 1"
                                [expanded]="featureSearchExpanded"
                                (focusRequest)="bringSurfaceToFront()"
                                (colorChange)="onSearchColorChange($event)"
                                (dockRequest)="toggleDocked()"
                                (sizeToggleRequest)="toggleExpanded()"
                                (closeRequest)="closeSearch()">
                <span surfaceHeaderActions class="feature-search-header-actions">
                    <p-button icon="pi pi-refresh"
                              [disabled]="!searchQueryForRerun()"
                              pTooltip="Rerun search"
                              tooltipPosition="bottom"
                              (click)="$event.stopPropagation(); rerunSearch()"
                              (mousedown)="$event.stopPropagation()"/>
                    <p-button [icon]="isSearchPaused ? 'pi pi-play-circle' : 'pi pi-pause-circle'"
                              [disabled]="!canPauseStopSearch"
                              [pTooltip]="isSearchPaused ? 'Resume search' : 'Pause search'"
                              tooltipPosition="bottom"
                              (click)="$event.stopPropagation(); toggleSearchPaused()"
                              (mousedown)="$event.stopPropagation()"/>
                    <p-button icon="pi pi-stop-circle"
                              [disabled]="!canPauseStopSearch"
                              pTooltip="Stop search"
                              tooltipPosition="bottom"
                              (click)="$event.stopPropagation(); stopSearch()"
                              (mousedown)="$event.stopPropagation()"/>
                </span>
            </app-surface-header>
        </ng-template>

        <ng-template #searchContent>
            <div class="feature-search-query search-input">
                <textarea #featureSearchQueryTextarea
                          class="feature-search-query-input"
                          [class.single-line]="!featureSearchQueryExpanded"
                          pTextarea
                          [rows]="featureSearchQueryExpanded ? 3 : 1"
                          [(ngModel)]="featureSearchQuery"
                          (click)="expandFeatureSearchQueryInput()"
                          (focus)="expandFeatureSearchQueryInput()"
                          (blur)="shrinkFeatureSearchQueryInput()"
                          (keydown)="onFeatureSearchQueryKeydown($event)"
                          placeholder="Search query">
                </textarea>
            </div>
            <div class="feature-search-controls">
                <div class="progress-bar-container">
                    <p-progressBar [value]="percentDone">
                        <ng-template pTemplate="content">
                            <span>{{ doneTiles }} / {{ totalTiles }} tiles</span>
                        </ng-template>
                    </p-progressBar>
                </div>
            </div>
            @if (awaitedTilesToLoad > 0) {
                <div class="feature-search-awaiting">
                    <span>Awaited tiles to load:</span>
                    <span>{{ awaitedTilesToLoad }}</span>
                    <p-progress-spinner strokeWidth="10" fill="transparent" animationDuration=".5s"
                                        [style]="{ width: '1em', height: '1em', margin: '0' }"/>
                </div>
            }
            <p-tabs [(value)]="resultPanelIndex" class="feature-search-tabs" data-testid="feature-search-panel" scrollable>
                <p-tablist>
                    <p-tab value="results">
                        <span>Results </span>
                        <p-badge [value]="results.length"/>
                    </p-tab>
                    <p-tab value="diagnostics">
                        <span>Diagnostics </span>
                        <p-badge [value]="diagnostics.length"/>
                    </p-tab>
                    <p-tab value="traces" *ngIf="traces.length > 0">
                        <span>Traces </span>
                        <p-badge [value]="traces.length"/>
                    </p-tab>
                </p-tablist>

                <p-tabpanels>
                    <!-- Results -->
                    <p-tabpanel value="results">
                        <div class="feature-search-results-panel">
                            <div class="feature-search-grouping">
                                <span>Group:</span>
                                <p-multiSelect [options]="grouping" [(ngModel)]="selectedGroupingOptions" [filter]="false"
                                               [showToggleAll]="false" (ngModelChange)="onGroupingOptionsChange($event)"
                                               placeholder="Select Grouping" [maxSelectedLabels]="5"
                                               display="chip" optionLabel="name">
                                </p-multiSelect>
                            </div>

                            <div class="feature-search-tree-host">
                                <p-tree #tree [value]="resultsTree" data-testid="feature-search-tree"
                                        selectionMode="single"
                                        [metaKeySelection]="false"
                                        [lazy]="true"
                                        [virtualScroll]="true"
                                        [virtualScrollItemSize]="stateService.baseFontSize * 2"
                                        [filter]="showFilter"
                                        filterPlaceholder="Filter matched features"
                                        [scrollHeight]="scrollHeight"
                                        [highlightOnSelect]="true"
                                        (onNodeSelect)="selectResult($event)"
                                        [emptyMessage]="resultsStatus">
                                </p-tree>
                            </div>
                        </div>
                    </p-tabpanel>

                    <!-- Diagnostics -->
                    <p-tabpanel value="diagnostics">
                        <div id="searchDiagnosticsPanel">
                            <div>
                                <span class="section-heading">Results</span>
                                <ul>
                                    <li><span>Elapsed time:</span><span>{{ searchService.timeElapsed }}</span></li>
                                    <li><span>Features:</span><span>{{ searchService.totalFeatureCount }}</span></li>
                                    <li><span>Matched:</span><span>{{ searchService.searchResults.length }}</span></li>
                                </ul>
                            </div>
                            <div *ngIf="diagnostics.length > 0">
                                <span class="section-heading">Diagnostics</span>
                                <ul>
                                    @for (message of diagnostics; track message) {
                                        <li>
                                            <div>
                                                <span>{{ message.message }}</span>
                                                <div *ngIf="message.query.length > 0">
                                                    <span>Here: </span>
                                                    <code style="width: 100%;"
                                                          [innerHTML]="message.query | highlightRegion: message.location?.offset:message.location?.size:25"></code>
                                                </div>
                                            </div>
                                            <p-button size="small" label="Fix" *ngIf="message.fix"
                                                      (onClick)="onApplyFix(message)"/>
                                        </li>
                                    }
                                </ul>
                            </div>
                        </div>
                    </p-tabpanel>

                    <!-- Traces -->
                    <p-tabpanel value="traces">
                        <div id="searchTracesPanel">
                            <table>
                                <tr>
                                    <th>Name</th>
                                    <th>Calls</th>
                                    <th>Time</th>
                                </tr>
                                @for (trace of traces; track trace; let first = $first) {
                                    <tr>
                                        <td>{{ trace.name }}</td>
                                        <td>{{ trace.calls }}</td>
                                        <td>{{ trace.totalus }} &mu;s</td>
                                    </tr>
                                }
                            </table>
                        </div>
                    </p-tabpanel>
                </p-tabpanels>
            </p-tabs>
        </ng-template>
        <div #alert></div>
    `,
    styles: [``],
    standalone: false
})
/**
 * Dialog that presents long-running feature-search progress, result grouping, diagnostics, and traces.
 */
export class FeatureSearchComponent implements OnDestroy {
    readonly featureSearchLayoutId = FEATURE_SEARCH_DIALOG_LAYOUT_ID;
    private readonly subscriptions = new Subscription();
    featureSearchDialogVisible = false;
    traces: Array<TraceResult> = [];
    diagnostics: Array<DiagnosticsMessage> = [];
    percentDone: number = 0;
    totalTiles: number = 0;
    doneTiles: number = 0;
    awaitedTilesToLoad: number = 0;
    isSearchPaused: boolean = false;
    canPauseStopSearch: boolean = false;
    results: Array<{ label: string; mapId: string; layerId: string; featureId: string }> = [];
    resultsTree: TreeNode[] = [];
    grouping: FeatureSearchGroupingOption[] = [
        {name: 'Maps', value: 1},
        {name: 'Layers', value: 2},
        {name: 'Features', value: 3},
        {name: 'Tiles', value: 4}
    ];
    selectedGroupingOptions: FeatureSearchGroupingOption[] = [];

    // Active result panel index
    resultPanelIndex: string = "";

    showFilter: boolean = false;
    resultsStatus: string = "Loading...";
    scrollHeight: string = "28.5em";
    featureSearchExpanded = false;
    featureSearchQuery = "";
    featureSearchQueryExpanded = false;
    readonly featureSearchDockedPanelCount = 1;
    private lastSearchQuery = "";
    private activeSearchId = "";
    private surfacedDockedSearchId = "";

    @ViewChild('alert', { read: ViewContainerRef, static: true }) alertContainer!: ViewContainerRef;
    @ViewChild('tree') tree!: Tree;
    @ViewChild('featureSearchDialog') featureSearchDialog: AppDialogComponent | undefined;
    @ViewChild('featureSearchPanel') featureSearchPanel: AppPanelComponent | undefined;

    /**
     * Subscribes to search progress and keeps the dialog state synchronized with the active search.
     */
    constructor(public searchService: FeatureSearchService,
                public jumpService: JumpTargetService,
                public mapService: MapDataService,
                public stateService: AppStateService,
                private infoMessageService: InfoMessageService,
                private dialogStack: DialogStackService) {
        this.selectedGroupingOptions = this.groupingOptionsFromValues(this.stateService.featureSearchGrouping);
        this.subscriptions.add(this.stateService.featureSearchGroupingState.subscribe(groupingValues => {
            const nextOptions = this.groupingOptionsFromValues(groupingValues);
            if (this.sameGroupingOptions(this.selectedGroupingOptions, nextOptions)) {
                return;
            }
            this.selectedGroupingOptions = nextOptions;
            this.recalculateResultsByGroups();
        }));

        this.subscriptions.add(this.searchService.progress.subscribe(searchState => {
            if (!searchState) {
                this.awaitedTilesToLoad = 0;
                this.resultsTree = [];
                this.activeSearchId = "";
                this.surfacedDockedSearchId = "";
                return;
            }
            if (searchState !== this.searchService.currentSearch) {
                return;
            }
            this.featureSearchDialogVisible = true;
            this.lastSearchQuery = searchState.query;
            if (this.activeSearchId !== searchState.id) {
                this.activeSearchId = searchState.id;
                this.featureSearchQuery = searchState.query;
            }
            this.percentDone = searchState.percentDone();
            this.totalTiles = searchState.getTaskCount();
            this.doneTiles = searchState.getCompletedCount();
            this.awaitedTilesToLoad = searchState.getPendingTileCount();
            this.isSearchPaused = searchState.paused;
            if (this.isDocked()) {
                this.stateService.isDockOpen = true;
                if (this.surfacedDockedSearchId !== searchState.id) {
                    this.stateService.dockActiveTab = SEARCH_DOCK_TAB_ID;
                    this.surfacedDockedSearchId = searchState.id;
                }
            }
            if (searchState.isComplete()) {
                this.searchResultReady();
                this.canPauseStopSearch = false;
            } else {
                this.resultsStatus = "Loading...";
                this.canPauseStopSearch = true;
            }
        }));
        this.subscriptions.add(this.searchService.diagnosticsMessages.subscribe(value => {
            this.diagnostics = value;
            if (this.diagnostics.length > 0 && this.results.length === 0)
                this.resultPanelIndex = 'diagnostics';
        }));
    }

    /** Stops feature search subscriptions when the component is destroyed. */
    ngOnDestroy() {
        this.subscriptions.unsubscribe();
    }

    protected isDocked(): boolean {
        return this.stateService.isSurfaceDocked(this.featureSearchLayoutId);
    }

    /**
     * Recomputes the virtual tree height once the dialog becomes measurable.
     */
    onDialogShow(event: any) {
        this.syncTreeScrollHeight(event);
        this.dialogStack.bringToFront(this.featureSearchDialog);
    }

    protected onDockedPanelShow() {
        this.syncTreeScrollHeight();
    }

    protected bringSurfaceToFront() {
        if (!this.isDocked()) {
            this.dialogStack.bringToFront(this.featureSearchDialog);
        }
    }

    protected toggleDocked() {
        this.stateService.setSurfaceDocked(this.featureSearchLayoutId, !this.isDocked(), SEARCH_DOCK_TAB_ID);
        if (!this.isDocked()) {
            this.featureSearchExpanded = false;
            setTimeout(() => this.dialogStack.bringToFront(this.featureSearchDialog), 0);
        } else {
            setTimeout(() => this.syncTreeScrollHeight(), 0);
        }
    }

    protected toggleExpanded() {
        if (this.featureSearchDockedPanelCount <= 1) {
            return;
        }
        this.featureSearchExpanded = !this.featureSearchExpanded;
        setTimeout(() => this.syncTreeScrollHeight(), 0);
    }

    protected onSearchColorChange(color: string) {
        this.searchService.pointColor = color;
        this.searchService.updatePointColor();
    }

    protected expandFeatureSearchQueryInput() {
        this.featureSearchQueryExpanded = true;
    }

    protected shrinkFeatureSearchQueryInput() {
        this.featureSearchQueryExpanded = false;
    }

    protected onFeatureSearchQueryKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            this.rerunSearch();
        }
    }

    protected rerunSearch() {
        const query = this.searchQueryForRerun();
        if (!query) {
            return;
        }
        this.featureSearchQuery = query;
        this.searchService.run(query);
    }

    protected searchQueryForRerun(): string {
        return this.featureSearchQuery.trim() || this.searchService.currentSearch?.query || this.lastSearchQuery;
    }

    protected closeSearch() {
        this.onHide(null);
    }

    /**
     * Terminates active search work as soon as PrimeNG starts closing the dialog.
     */
    onPanelVisibleChange(visible: boolean) {
        this.featureSearchDialogVisible = visible;
        if (!visible) {
            this.searchService.clear();
        }
    }

    /**
     * Finalizes the result tabs once the active search group reports completion.
     */
    searchResultReady() {
        const results = this.searchService.searchResults;
        const traces = this.searchService.traceResults;
        const errors = this.searchService.errors;

        this.canPauseStopSearch = false;
        this.resultPanelIndex = 'results';

        if (errors.size) {
            this.infoMessageService.showAlertDialog(
                this.alertContainer,
                'Feature Search Errors',
                Array.from(errors).join('\n'));

        } else if (results.length == 0) {
            if (this.diagnostics.length > 0)
                this.resultPanelIndex = 'diagnostics';
            else if (traces.length > 0)
                this.resultPanelIndex = 'traces';
        }

        this.traces = traces
        this.results = results;
        this.recalculateResultsByGroups();
    }

    /**
     * Highlights the selected result regardless of whether it came from the tree or a simple list event.
     */
    selectResult(event: any) {
        // Support both listbox change and tree node select events
        const selected = event?.value || event?.node?.data || event;
        if (selected && selected.mapId && selected.featureId) {
            this.jumpService.highlightByJumpTargetFilter(selected.mapId, selected.featureId,
                coreLib.HighlightMode.SELECTION_HIGHLIGHT, this.stateService.focusedView).then();
        }
    }

    /**
     * Pauses or resumes worker dispatch while keeping already collected results visible.
     */
    toggleSearchPaused() {
        if (!this.canPauseStopSearch) {
            return;
        }
        if (this.isSearchPaused) {
            this.searchService.resume();
            this.isSearchPaused = false;
        } else {
            this.searchService.pause();
            this.results = this.searchService.searchResults;
            this.recalculateResultsByGroups();
            this.isSearchPaused = true;
        }
    }

    /**
     * Stops the active search, freezes the partial result set, and surfaces any accumulated errors.
     */
    stopSearch() {
        if (this.canPauseStopSearch) {
            this.searchService.stop();
            this.canPauseStopSearch = false;
            this.results = this.searchService.searchResults;
            this.recalculateResultsByGroups();

            if (this.searchService.errors.size) {
                this.infoMessageService.showAlertDialog(
                    this.alertContainer,
                    'Feature Search Errors',
                    Array.from(this.searchService.errors).join('\n'))
            }
        }
    }

    /**
     * Resets dialog-local state after the dialog closes.
     */
    onHide(_: any) {
        this.traces = [];
        this.diagnostics = [];
        this.isSearchPaused = false;
        this.canPauseStopSearch = false;
        this.awaitedTilesToLoad = 0;
        this.results = [];
        this.resultsTree = [];
        this.showFilter = false;
        this.resultsStatus = "Loading...";
        this.featureSearchExpanded = false;
        this.featureSearchQueryExpanded = false;
        this.featureSearchQuery = "";
        this.activeSearchId = "";
        this.surfacedDockedSearchId = "";
        if (this.isDocked()) {
            this.stateService.setSurfaceDocked(this.featureSearchLayoutId, false, SEARCH_DOCK_TAB_ID);
        }
        if (this.searchService.currentSearch) {
            this.searchService.clear();
        }
        this.featureSearchDialogVisible = false;
    }

    /**
     * Pushes a suggested query fix back into the omnibox workflow.
     */
    onApplyFix(message: DiagnosticsMessage) {
        if (message.fix) {
            this.searchService.fixedDiagnosticsSearchQuery.next(message.fix);
        }
    }

    /** Applies user changes to feature search grouping options. */
    onGroupingOptionsChange(options: FeatureSearchGroupingOption[]) {
        const groupingValues = this.groupingValuesFromOptions(options);
        this.selectedGroupingOptions = this.groupingOptionsFromValues(groupingValues);
        this.stateService.featureSearchGrouping = groupingValues;
        this.recalculateResultsByGroups();
    }

    /** Converts persisted grouping values into dropdown options. */
    private groupingOptionsFromValues(values: number[]): FeatureSearchGroupingOption[] {
        const selected = new Set(values);
        return this.grouping.filter(option => selected.has(option.value));
    }

    /** Converts dropdown options into persisted grouping values. */
    private groupingValuesFromOptions(options: FeatureSearchGroupingOption[] | null | undefined): number[] {
        const selected = new Set((options ?? []).map(option => option.value));
        return this.grouping.filter(option => selected.has(option.value)).map(option => option.value);
    }

    /** Checks whether two grouping option lists are equivalent. */
    private sameGroupingOptions(lhs: FeatureSearchGroupingOption[], rhs: FeatureSearchGroupingOption[]): boolean {
        return lhs.length === rhs.length && lhs.every((option, index) => option.value === rhs[index]?.value);
    }

    /**
     * Rebuilds the PrimeNG tree according to the currently selected grouping dimensions.
     */
    recalculateResultsByGroups() {
        // Convert results into PrimeNG TreeNodes based on selected grouping
        const results = this.results.map(result => {
            const featureIdParts = result.featureId.split('.')
            return {
                label: result.label,
                mapId: result.mapId,
                layerId: result.layerId,
                featureId: result.featureId,
                featureType: featureIdParts[0] ?? "",
                tileId: Number(featureIdParts[1] ?? 0)
            };
        });

        // Selected grouping values as ordered list following the grouping options
        const selected = new Set(this.selectedGroupingOptions.map(o => o.value));
        const selectedOrder: number[] = this.grouping.filter(o => selected.has(o.value)).map(o => o.value);

        type ResultItem = typeof results[number];

        const accessors: Record<number, { label: string, get: (r: ResultItem) => string | number }> = {
            1: { label: 'Map',     get: (r) => r.mapId },
            2: { label: 'Layer',   get: (r) => r.layerId },
            3: { label: 'Features', get: (r) => r.featureType },
            4: { label: 'Tiles',    get: (r) => r.tileId }
        };

        /** Builds the feature search result tree with aggregate counts. */
        const buildTreeWithCounts = (items: ResultItem[], depth: number, parentKey: string): [TreeNode[], number] => {
            if (depth >= selectedOrder.length || selectedOrder.length === 0) {
                const leaves = items.map((it, idx) => ({
                    key: `${parentKey}/leaf:${idx}:${it.featureId}`,
                    label: it.label,
                    data: { mapId: it.mapId, featureId: it.featureId },
                    leaf: true,
                    selectable: true
                } as TreeNode));
                return [leaves, items.length];
            }

            const key = selectedOrder[depth];
            const acc = accessors[key];
            if (!acc) {
                const leaves = items.map((it, idx) => ({
                    key: `${parentKey}/leaf:${idx}:${it.featureId}`,
                    label: it.label,
                    data: { mapId: it.mapId, featureId: it.featureId },
                    leaf: true,
                    selectable: true
                } as TreeNode));
                return [leaves, items.length];
            }

            // Partition items by current accessor
            const partitions = new Map<string | number, ResultItem[]>();
            for (const it of items) {
                const k = acc.get(it);
                const arr = partitions.get(k) || [];
                arr.push(it);
                partitions.set(k, arr);
            }

            const nodes: TreeNode[] = [];
            let total = 0;
            for (const [value, groupItems] of partitions) {
                const nodeKey = `${parentKey}/${acc.label}:${String(value)}`;
                const [children, childCount] = buildTreeWithCounts(groupItems, depth + 1, nodeKey);
                total += childCount;
                nodes.push({
                    key: nodeKey,
                    label: `${acc.label}: ${String(value)} (${childCount})`,
                    selectable: false,
                    expanded: true,
                    children
                } as TreeNode);
            }
            return [nodes, total];
        };

        const [tree] = buildTreeWithCounts(results, 0, 'root');
        this.resultsTree = tree;
        if (this.resultsTree.length) {
            this.showFilter = true;
            this.resultsStatus = "No entries found.";
        } else {
            this.showFilter = false;
            this.resultsStatus = "No matches found.";
        }
    }

    /**
     * Derives the tree scroller height from the dialog size so virtual scrolling stays usable while resizing.
     */
    syncTreeScrollHeight(event?: MouseEvent) {
        const target = event?.target as HTMLElement | null;
        // Find the dialog container regardless of which inner element fired the event
        let wrapper = target?.closest('.feature-search-dialog') as HTMLElement | null;
        if (!wrapper) {
            wrapper = document.querySelector('.feature-search-dialog') as HTMLElement | null;
        }
        const dialog = wrapper?.querySelector('.p-dialog') as HTMLElement | null;
        const panel = this.featureSearchPanel?.container();
        const container = dialog ?? wrapper ?? panel;
        if (!container || !container.offsetHeight || !this.stateService.baseFontSize) {
            return;
        }

        // Compute scrollable height in em units to respect base font size
        const currentEmHeight = container.offsetHeight / this.stateService.baseFontSize;
        // Linear equation to compensate for the slight difference in the content height
        // when the values are smaller or larger
        this.scrollHeight = `${currentEmHeight + 0.0887574 * currentEmHeight - 14.9763}em`;

        // Nudge the internal scroller to recalculate
        setTimeout(() => {
            const scroller = (this.tree as any)?.scroller as Scroller | undefined;
            if (scroller) {
                scroller.scrollHeight = this.scrollHeight;
                scroller.calculateAutoSize();
            }
        }, 1);
    }
}
