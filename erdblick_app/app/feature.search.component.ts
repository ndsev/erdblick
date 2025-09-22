import {Component, ViewChild, ViewContainerRef, Input} from "@angular/core";
import {FeatureSearchService} from "./feature.search.service";
import {JumpTargetService} from "./jump.service";
import {InspectionService} from "./inspection.service";
import {MapService} from "./map.service";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {Listbox} from "primeng/listbox";
import {InfoMessageService} from "./info.service";
import {KeyboardService} from "./keyboard.service";
import {DiagnosticsMessage, TraceResult} from "./featurefilter.worker";
import {SearchPanelComponent} from "./search.panel.component";

@Component({
    selector: "feature-search",
    template: `
        <div [ngClass]="{'z-index-low': sidePanelService.featureSearchOpen && sidePanelService.searchOpen}">
            <p-dialog class="side-menu-dialog" header="Search Loaded Features"
                      [(visible)]="isPanelVisible" style="padding: 0 0.5em 0.5em 0.5em"
                      [position]="'topleft'" [draggable]="false" [resizable]="false"
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
                            <p-listbox class="results-listbox" [options]="results" [(ngModel)]="selectedResult"
                                    optionLabel="label" [virtualScroll]="true" [virtualScrollItemSize]="35"
                                    [multiple]="false" [metaKeySelection]="false" (onChange)="selectResult($event)"
                                    emptyMessage="No features matched."
                                    #listbox
                            />
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
                                        @for (message of diagnostics; track message; let first = $first) {
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
        </div>
        <div #alert></div>
    `,
    styles: [``],
    standalone: false
})
export class FeatureSearchComponent {
    isPanelVisible: boolean = false;
    placeholder: Array<any> = [];
    traces: Array<TraceResult> = [];
    selectedResult: any;
    diagnostics: Array<DiagnosticsMessage> = [];
    percentDone: number = 0;
    isSearchPaused: boolean = false;
    canPauseStopSearch: boolean = false;
    results: Array<any> = [];

    // Active result panel index
    resultPanelIndex: any = 0;

    @Input() searchPanelComponent!: SearchPanelComponent;
    @ViewChild('listbox') listbox!: Listbox;
    @ViewChild('alert', { read: ViewContainerRef, static: true }) alertContainer!: ViewContainerRef;

    constructor(public searchService: FeatureSearchService,
                public jumpService: JumpTargetService,
                public mapService: MapService,
                public inspectionService: InspectionService,
                public sidePanelService: SidePanelService,
                public keyboardService: KeyboardService,
                private infoMessageService: InfoMessageService) {
        this.sidePanelService.observable().subscribe(panel=> {
            this.isPanelVisible = panel == SidePanelState.FEATURESEARCH || this.isPanelVisible;
        });
        this.searchService.isFeatureSearchActive.subscribe(isActive => {
            if (isActive) {
                this.placeholder = [{label: "Loading..."}];
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
    }

    selectResult(event: any) {
        if (event.value && event.value.mapId && event.value.featureId) {
            this.jumpService.highlightByJumpTargetFilter(event.value.mapId, event.value.featureId).then(() => {
                if (this.inspectionService.selectedFeatures.length) {
                    this.mapService.focusOnFeature(this.inspectionService.selectedFeatures[0]);
                }
            });
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
                this.isSearchPaused = true;
            }
        }
    }

    stopSearch() {
        if (this.canPauseStopSearch) {
            this.listbox.options = this.searchService.searchResults;
            this.searchService.stop();
            this.canPauseStopSearch = false;

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
        this.sidePanelService.featureSearchOpen = false;
        this.keyboardService.dialogOnHide(event);
    }

    onShow(event: any) {
        this.sidePanelService.featureSearchOpen = true;
        this.keyboardService.dialogOnShow(event);
    }

    onApplyFix(message: DiagnosticsMessage) {
        if (message.fix) {
            this.searchPanelComponent.setSearchValue(message.fix);
        }
    }
}
