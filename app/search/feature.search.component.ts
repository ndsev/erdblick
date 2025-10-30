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

@Component({
    selector: "feature-search",
    template: `
        <p-dialog class="feature-search-dialog" header="Search Loaded Features"
                  [(visible)]="isPanelVisible" style="padding: 0 0.5em 0.5em 0.5em"
                  [position]="'left'" [draggable]="true" [resizable]="true"
                  (onShow)="onShow($event)" (onHide)="onHide($event)">
            <div class="feature-search-controls">
                <div class="progress-bar-container">
                    <p-progressBar [value]="percentDone">
                        <ng-template pTemplate="content" let-percentDone>
                            <span>{{ searchService.doneTiles }} / {{ searchService.totalTiles }} tiles</span>
                        </ng-template>
                    </p-progressBar>
                </div>
                <p-button (click)="pauseSearch()"
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
                        <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                            <span>Highlight colour:</span>
                            <p-colorPicker [(ngModel)]="searchService.pointColor"
                                           (ngModelChange)="searchService.updatePointColor()" appendTo="body"/>
                        </div>
                        <p-multiSelect [options]="grouping" [(ngModel)]="selectedGroupingOptions" [filter]="false"
                                       [showToggleAll]="false" (ngModelChange)="recalculateResultsByGroups()"
                                       placeholder="Select Grouping" [maxSelectedLabels]="5"
                                       display="chip" optionLabel="name" class="w-full md:w-80">
                        </p-multiSelect>
                        
                        <!-- Results Tree -->
                        <div style="height: 100%">
                            <p-tree [value]="resultsTree"
                                    selectionMode="single"
                                    [metaKeySelection]="false"
                                    [virtualScroll]="true"
                                    [virtualScrollItemSize]="35"
                                    (onNodeSelect)="selectResult($event)"
                                    emptyMessage="No features matched.">
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
                                                <div><span>Here: </span><code style="width: 100%;"
                                                                              [innerHTML]="message.query | highlightRegion:message.location.offset:message.location.size:25"></code>
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
    selectedResult: any;
    diagnostics: Array<DiagnosticsMessage> = [];
    percentDone: number = 0;
    isSearchPaused: boolean = false;
    canPauseStopSearch: boolean = false;
    results: Array<{ label: string; mapId: string; layerId: string; featureId: string }> = [];
    groupedResults: Array<{ header: string; items: Array<{ label: string; mapId: string; layerId: string; featureId: string }> }> = [];
    resultsTree: TreeNode[] = [];
    grouping: { name: string, value: number }[] = [
        {name: 'Maps', value: 1},
        {name: 'Layers', value: 2},
        {name: 'Feature', value: 3},
        {name: 'Tile', value: 4}
    ];
    selectedGroupingOptions: { name: string, value: number }[] = [this.grouping[0]];

    // Active result panel index
    resultPanelIndex: string = "";

    @Input() searchPanelComponent!: SearchPanelComponent;
    @ViewChild('alert', { read: ViewContainerRef, static: true }) alertContainer!: ViewContainerRef;

    constructor(public searchService: FeatureSearchService,
                public jumpService: JumpTargetService,
                public mapService: MapDataService,
                public stateService: AppStateService,
                public keyboardService: KeyboardService,
                private infoMessageService: InfoMessageService) {
        this.searchService.isFeatureSearchActive.subscribe(isActive => {
            this.isPanelVisible = true;
            if (isActive) {
                this.canPauseStopSearch = isActive;
            }
        });
        this.searchService.progress.subscribe(value => {
            this.percentDone = value;
            if (value >= 100) {
                this.searchResultReady();
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
                Array.from(errors).join('\n'))

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
            for (let i = 0; i < this.stateService.numViews; i++) {
                this.jumpService.highlightByJumpTargetFilter(i, selected.mapId, selected.featureId,
                    coreLib.HighlightMode.SELECTION_HIGHLIGHT, true).then();
            }
        }
    }

    pauseSearch() {
        if (this.canPauseStopSearch) {
            if (this.isSearchPaused && this.searchService.currentSearchGroup) {
                const query = this.searchService.currentSearchGroup?.query;
                console.log(`Resuming query '${query}'`);
                this.isSearchPaused = false;
                this.searchService.run(query, true);
            } else {
                this.searchService.pause();
                this.results = this.searchService.searchResults;
                this.recalculateResultsByGroups();
                this.isSearchPaused = true;
            }
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
        this.percentDone = 0;
        this.isSearchPaused = false;
        this.canPauseStopSearch = false;
        this.results = [];
        this.groupedResults = [];
        this.searchService.clear();
        this.isPanelVisible = false;
    }

    onShow(_: any) {
        this.recalculateResultsByGroups();
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
            3: { label: 'Feature', get: (r) => r.featureType },
            4: { label: 'Tile',    get: (r) => r.tileId }
        };

        const buildTree = (items: ResultItem[], depth: number, parentKey: string): TreeNode[] => {
            if (depth >= selectedOrder.length || selectedOrder.length === 0) {
                // Create leaf nodes for results
                return items.map((it, idx) => ({
                    key: `${parentKey}/leaf:${idx}:${it.featureId}`,
                    label: it.label,
                    data: { mapId: it.mapId, featureId: it.featureId },
                    leaf: true,
                    selectable: true
                } as TreeNode));
            }

            const key = selectedOrder[depth];
            const acc = accessors[key];
            if (!acc) {
                // Fallback to leaves if accessor missing
                return items.map((it, idx) => ({
                    key: `${parentKey}/leaf:${idx}:${it.featureId}`,
                    label: it.label,
                    data: { mapId: it.mapId, featureId: it.featureId },
                    leaf: true,
                    selectable: true
                } as TreeNode));
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
            let index = 0;
            for (const [value, groupItems] of partitions) {
                const nodeKey = `${parentKey}/${acc.label}:${value}`;
                nodes.push({
                    key: nodeKey,
                    label: `${acc.label}: ${value}`,
                    selectable: false,
                    expanded: true,
                    children: buildTree(groupItems, depth + 1, nodeKey)
                } as TreeNode);
                index++;
            }
            return nodes;
        };

        const tree = buildTree(results, 0, 'root');
        this.resultsTree = tree;
        // Keep groupedResults for potential legacy uses (not used in template anymore)
        this.groupedResults = [];
    }
}
