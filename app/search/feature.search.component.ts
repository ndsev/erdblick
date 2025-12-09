import {Component, ViewChild, ViewContainerRef, Input} from "@angular/core";
import {FeatureSearchService} from "./feature.search.service";
import {JumpTargetService} from "./jump.service";
import {MapDataService} from "../mapdata/map.service";
import {TreeNode} from "primeng/api";
import {InfoMessageService} from "../shared/info.service";
import {KeyboardService} from "../shared/keyboard.service";
import {DiagnosticsMessage, TraceResult} from "./search.worker";
import {SearchPanelComponent} from "./search.panel.component";
import {coreLib} from "../integrations/wasm";
import {AppStateService} from "../shared/appstate.service";
import {Tree} from "primeng/tree";
import {Scroller} from "primeng/scroller";

@Component({
    selector: "feature-search",
    template: `
        <p-dialog class="feature-search-dialog" header="Search Loaded Features" [closeOnEscape]="false"
                  [(visible)]="isPanelVisible" [draggable]="true" [resizable]="true"
                  (onShow)="syncTreeScrollHeight($event)"
                  (onResizeEnd)="syncTreeScrollHeight($event)" (onHide)="onHide($event)">
            <div class="feature-search-controls">
                <div class="progress-bar-container">
                    <p-progressBar [value]="percentDone">
                        <ng-template pTemplate="content">
                            <span>{{ doneTiles }} / {{ totalTiles }} tiles</span>
                        </ng-template>
                    </p-progressBar>
                </div>
                <p-button (click)="toggleSearchPaused()"
                          [icon]="isSearchPaused ? 'pi pi-play-circle' : 'pi pi-pause-circle'"
                          label=""
                          [disabled]="!canPauseStopSearch" tooltipPosition="bottom"
                          [pTooltip]="isSearchPaused ? 'Resume search' : 'Pause search'"></p-button>
                <p-button (click)="stopSearch()" icon="pi pi-stop-circle" label="" [disabled]="!canPauseStopSearch"
                          pTooltip="Stop search" tooltipPosition="bottom"></p-button>
            </div>

            <p-tabs [(value)]="resultPanelIndex" class="feature-search-tabs" scrollable>
                <p-tablist>
                    <p-tab value="results">
                        <span>Results</span>
                        <p-badge [value]="results.length"/>
                    </p-tab>
                    <p-tab value="diagnostics">
                        <span>Diagnostics</span>
                        <p-badge [value]="diagnostics.length"/>
                    </p-tab>
                    <p-tab value="traces" *ngIf="traces.length > 0">
                        <span>Traces</span>
                        <p-badge [value]="traces.length"/>
                    </p-tab>
                </p-tablist>

                <p-tabpanels>
                    <!-- Results -->
                    <p-tabpanel value="results">
                        <div style="display: flex; flex-direction: row; gap: 0.5em; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                            <span>Highlight colour:</span>
                            <p-colorPicker [(ngModel)]="searchService.pointColor"
                                           (ngModelChange)="searchService.updatePointColor()" appendTo="body"/>
                        </div>
                        <div style="display: flex; flex-direction: row; gap: 0.5em; font-size: 0.9em; align-items: center;">
                            <span>Group:</span>
                            <p-multiSelect [options]="grouping" [(ngModel)]="selectedGroupingOptions" [filter]="false"
                                           [showToggleAll]="false" (ngModelChange)="recalculateResultsByGroups()"
                                           placeholder="Select Grouping" [maxSelectedLabels]="5"
                                           display="chip" optionLabel="name">
                            </p-multiSelect>
                        </div>

                        <!-- Results Tree -->
                        <div style="height: 100%">
                            <p-tree #tree [value]="resultsTree"
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
                                                <div>
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
        </p-dialog>
        <div #alert></div>
    `,
    styles: [``],
    standalone: false
})
export class FeatureSearchComponent {
    isPanelVisible: boolean = false;
    traces: Array<TraceResult> = [];
    diagnostics: Array<DiagnosticsMessage> = [];
    percentDone: number = 0;
    totalTiles: number = 0;
    doneTiles: number = 0;
    isSearchPaused: boolean = false;
    canPauseStopSearch: boolean = false;
    results: Array<{ label: string; mapId: string; layerId: string; featureId: string }> = [];
    resultsTree: TreeNode[] = [];
    grouping: { name: string, value: number }[] = [
        {name: 'Maps', value: 1},
        {name: 'Layers', value: 2},
        {name: 'Features', value: 3},
        {name: 'Tiles', value: 4}
    ];
    selectedGroupingOptions: { name: string, value: number }[] = [this.grouping[0]];

    // Active result panel index
    resultPanelIndex: string = "";

    showFilter: boolean = false;
    resultsStatus: string = "Loading...";
    scrollHeight: string = "28.5em";

    @Input() searchPanelComponent!: SearchPanelComponent; // TODO: Do not use `Input`, use `output`?
    @ViewChild('alert', { read: ViewContainerRef, static: true }) alertContainer!: ViewContainerRef;
    @ViewChild('tree') tree!: Tree;

    constructor(public searchService: FeatureSearchService,
                public jumpService: JumpTargetService,
                public mapService: MapDataService,
                public stateService: AppStateService,
                public keyboardService: KeyboardService,
                private infoMessageService: InfoMessageService) {
        this.searchService.progress.subscribe(searchState => {
            if (!searchState) {
                this.resultsTree = [];
                return;
            }
            this.isPanelVisible = true;
            this.percentDone = searchState.percentDone();
            this.totalTiles = searchState.getTaskCount();
            this.doneTiles = searchState.getCompletedCount();
            if (searchState.isComplete()) {
                this.searchResultReady();
                this.canPauseStopSearch = false;
            } else {
                this.resultsStatus = "Loading...";
                this.canPauseStopSearch = true;
            }
        });
        this.searchService.diagnosticsMessages.subscribe(value => {
            this.diagnostics = value;
            if (this.diagnostics.length > 0 && this.results.length === 0)
                this.resultPanelIndex = 'diagnostics';
        })
    }

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

    selectResult(event: any) {
        // Support both listbox change and tree node select events
        const selected = event?.value || event?.node?.data || event;
        if (selected && selected.mapId && selected.featureId) {
            this.jumpService.highlightByJumpTargetFilter(selected.mapId, selected.featureId,
                coreLib.HighlightMode.SELECTION_HIGHLIGHT, this.stateService.focusedView).then();
        }
    }

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

    onHide(_: any) {
        this.traces = [];
        this.diagnostics = [];
        this.isSearchPaused = false;
        this.canPauseStopSearch = false;
        this.results = [];
        this.resultsTree = [];
        this.showFilter = false;
        this.resultsStatus = "Loading...";
        this.searchService.clear();
        this.isPanelVisible = false;
    }

    onApplyFix(message: DiagnosticsMessage) {
        if (message.fix) {
            this.searchPanelComponent.setSearchValue(message.fix);
        }
    }

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

    syncTreeScrollHeight(event: MouseEvent) {
        const target = event?.target as HTMLElement | null;
        // Find the dialog container regardless of which inner element fired the event
        let wrapper = target?.closest('.feature-search-dialog') as HTMLElement | null;
        if (!wrapper) {
            wrapper = document.querySelector('.feature-search-dialog') as HTMLElement | null;
        }
        const dialog = wrapper?.querySelector('.p-dialog') as HTMLElement | null;
        const container = dialog ?? wrapper;
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
