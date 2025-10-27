import {Component, ViewChild, ViewContainerRef, Input} from "@angular/core";
import {FeatureSearchService} from "./feature.search.service";
import {JumpTargetService} from "./jump.service";
import {MapDataService} from "../mapdata/map.service";
import {Listbox} from "primeng/listbox";
import {InfoMessageService} from "../shared/info.service";
import {KeyboardService} from "../shared/keyboard.service";
import {DiagnosticsMessage, TraceResult} from "./search.worker";
import {SearchPanelComponent} from "./search.panel.component";
import {coreLib} from "../integrations/wasm";
import {AppStateService} from "../shared/appstate.service";

@Component({
    selector: "feature-search",
    template: `
        <p-dialog class="side-menu-dialog" header="Search Loaded Features"
                  [(visible)]="isPanelVisible" style="padding: 0 0.5em 0.5em 0.5em"
                  [position]="'topleft'" [draggable]="true" [resizable]="false"
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
                        <p-badge [value]="results.length" />
                    </p-tab>
                    <p-tab value="diagnostics">
                        <span>Diagnostics</span>
                        <p-badge [value]="diagnostics.length" />
                    </p-tab>
                    <p-tab value="traces" *ngIf="traces.length > 0">
                        <span>Traces</span>
                        <p-badge [value]="traces.length" />
                    </p-tab>
                </p-tablist>

                <p-tabpanels>
                    <!-- Results -->
                    <p-tabpanel value="results">
                        <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                            <span>Highlight colour:</span>
                            <span><p-colorPicker [(ngModel)]="searchService.pointColor"
                                                 (ngModelChange)="searchService.updatePointColor()" appendTo="body"/></span>
                        </div>
                        <p-multiSelect [options]="grouping" [(ngModel)]="selectedGroupingOptions" [filter]="false"
                                       [showToggleAll]="false" (ngModelChange)="recalculateResults()" placeholder="Select Grouping" 
                                       display="chip" optionLabel="name" class="w-full md:w-80">
                        </p-multiSelect>

                        @for (group of groupedResults; track $index) {
                            <div style="margin-top: 0.5rem; font-weight: 600; font-size: 0.9em;">
                                {{ group.header }}
                            </div>
                            <p-listbox class="results-listbox" [options]="group.items" [(ngModel)]="selectedResult"
                                       optionLabel="label" [virtualScroll]="true" [virtualScrollItemSize]="35"
                                       [multiple]="false" [metaKeySelection]="false" (onChange)="selectResult($event)"
                                       emptyMessage="No features matched."
                                       #listbox
                            />
                        }
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
                                                <div><span>Here: </span><code style="width: 100%;" [innerHTML]="message.query | highlightRegion:message.location.offset:message.location.size:25"></code></div>
                                            </div>
                                            <p-button size="small" label="Fix" *ngIf="message.fix" (onClick)="onApplyFix(message)" />
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
    grouping: { name: string, value: number }[] = [
        {name: 'Maps', value: 1},
        {name: 'Layers', value: 2}
    ];
    selectedGroupingOptions: { name: string, value: number }[] = [this.grouping[0]];

    // Active result panel index
    resultPanelIndex: string = "";

    @Input() searchPanelComponent!: SearchPanelComponent;
    @ViewChild('listbox') listbox!: Listbox;
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
        this.recalculateResults();
    }

    selectResult(event: any) {
        if (event.value && event.value.mapId && event.value.featureId) {
            for (let i = 0; i < this.stateService.numViews; i++) {
                this.jumpService.highlightByJumpTargetFilter(i, event.value.mapId, event.value.featureId,
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
                this.listbox.options = this.searchService.searchResults;
                this.results = this.searchService.searchResults;
                this.recalculateResults();
                this.isSearchPaused = true;
            }
        }
    }

    stopSearch() {
        if (this.canPauseStopSearch) {
            this.listbox.options = this.searchService.searchResults;
            this.searchService.stop();
            this.canPauseStopSearch = false;
            this.results = this.searchService.searchResults;
            this.recalculateResults();

            if (this.searchService.errors.size) {
                this.infoMessageService.showAlertDialog(
                    this.alertContainer,
                    'Feature Search Errors',
                    Array.from(this.searchService.errors).join('\n'))
            }
        }
    }

    onHide(event: any) {
        this.searchService.clear();
        this.isPanelVisible = false;
    }

    onShow(event: any) {
        this.recalculateResults();
    }

    onApplyFix(message: DiagnosticsMessage) {
        if (message.fix) {
            this.searchPanelComponent.setSearchValue(message.fix);
        }
    }

    recalculateResults() {
        const results = [...this.results];

        const selectedValues = new Set(this.selectedGroupingOptions.map(o => o.value));
        const byMaps = selectedValues.has(1);
        const byLayers = selectedValues.has(2);

        // Helper to group by a key function
        const groupBy = <T, K extends string | number>(items: T[], keyFn: (item: T) => K): Map<K, T[]> => {
            const map = new Map<K, T[]>();
            for (const item of items) {
                const key = keyFn(item);
                const arr = map.get(key) || [];
                arr.push(item);
                map.set(key, arr);
            }
            return map;
        };

        const groups: Array<{ header: string; items: Array<{ label: string; mapId: string; layerId: string; featureId: string }> }> = [];

        if (byMaps && byLayers) {
            // First group by map, then by layer; flatten to array of arrays
            const maps = groupBy(results, r => r.mapId);
            for (const [mapId, mapGroup] of maps) {
                const layers = groupBy(mapGroup, r => r.layerId);
                for (const [layerId, layerGroup] of layers) {
                    groups.push({ header: `Map: ${mapId} • Layer: ${layerId}`, items: layerGroup });
                }
            }
        } else if (byMaps) {
            const maps = groupBy(results, r => r.mapId);
            for (const [mapId, mapGroup] of maps) {
                groups.push({ header: `Map: ${mapId}`, items: mapGroup });
            }
        } else if (byLayers) {
            const layers = groupBy(results, r => r.layerId);
            for (const [layerId, layerGroup] of layers) {
                groups.push({ header: `Layer: ${layerId}`, items: layerGroup });
            }
        } else {
            // No grouping selected; single group with all results
            groups.push({header: `All Results`, items: results});
        }

        this.groupedResults = groups;
    }
}
