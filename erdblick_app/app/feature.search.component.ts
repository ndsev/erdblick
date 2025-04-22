import {Component, ViewChild, ViewContainerRef, Input} from "@angular/core";
import {FeatureSearchService} from "./feature.search.service";
import {JumpTargetService} from "./jump.service";
import {InspectionService} from "./inspection.service";
import {MapService} from "./map.service";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {Listbox} from "primeng/listbox";
import {InfoMessageService} from "./info.service";
import {KeyboardService} from "./keyboard.service";
import { DiagnosticsMessage, TraceResult } from "./featurefilter.worker";
import { SearchPanelComponent } from "./search.panel.component";

@Component({
    selector: "feature-search",
    template: `
        <div [ngClass]="{'z-index-low': sidePanelService.featureSearchOpen && sidePanelService.searchOpen}">
            <p-dialog class="side-menu-dialog search-results-dialog" header="Search Loaded Features"
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
                <div style="display: flex; flex-direction: row; justify-content: space-between; font-size: 0.9em; align-items: center;">
                    <span>Elapsed time:</span><span>{{ searchService.timeElapsed }}</span>
                </div>
                <div style="display: flex; flex-direction: row; justify-content: space-between; font-size: 0.9em; align-items: center;">
                    <span>Features:</span><span>{{ searchService.totalFeatureCount }}</span>
                </div>
                <div style="display: flex; flex-direction: row; justify-content: space-between; font-size: 0.9em; align-items: center;">
                    <span>Matched:</span><span>{{ searchService.searchResults.length }}</span>
                </div>
                <div style="display: flex; flex-direction: row; justify-content: space-between; font-size: 0.9em; align-items: center;">
                    <span>Highlight colour:</span>
                    <span><p-colorPicker [(ngModel)]="searchService.pointColor"
                                         (ngModelChange)="searchService.updatePointColor()" appendTo="body"/></span>
                </div>

                @for (message of diagnostics; track message; let first = $first) {
                    <p-card class="diagnostics-message">
                        <div style="display: flex; flex-direction: row; justify-content: space-between; font-size: 0.9em; align-items: center;">
                            <span>{{ message.message }}</span>
                            <p-button size="small" label="Fix" *ngIf="message.fix" (onClick)="onApplyFix(message)" />
                        </div>
                    </p-card>
                }

                <p-listbox class="results-listbox" [options]="placeholder" [(ngModel)]="selectedResult"
                           optionLabel="label" [virtualScroll]="true" [virtualScrollItemSize]="35"
                           [multiple]="false" [metaKeySelection]="false" (onChange)="selectResult($event)"
                           emptyMessage="No features matched."
                           #listbox
                />
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
            } else {
                this.listbox.options = this.searchService.searchResults;
            }
        });
        this.searchService.progress.subscribe(value => {
            this.percentDone = value;
            if (value >= 100) {
                this.searchResultReady();
            }
        });
    }

    ngAfterViewInit() {
        // Hack to make the listbox resize properly
        const listWrapper = this.listbox.el.nativeElement.querySelector('.p-listbox-list-wrapper');
        if (listWrapper) {
            listWrapper.style.height = '100%';
            console.log("Set Wrapper Size");
        }
        const scroller = this.listbox.el.nativeElement.querySelector('.p-scroller');
        if (scroller) {
            scroller.style.height = '100%';
            console.log("Set Scroller Size");
        }
    }

    searchResultReady() {
        this.listbox.options = this.searchService.searchResults;
        this.canPauseStopSearch = false;
        if (this.searchService.errors.size) {
            this.infoMessageService.showAlertDialog(
                this.alertContainer,
                'Feature Search Errors',
                Array.from(this.searchService.errors).join('\n'))
        }

        // Cut-off more than 3 items just in case
        this.diagnostics = this.searchService.diagnosticsResults.slice(0, 3);
        this.traces = this.searchService.traceResults;
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
            if (this.isSearchPaused) {
                this.isSearchPaused = false;
                this.searchService.run(this.searchService.currentQuery, true);
                return;
            }
            this.searchService.pause();
            this.listbox.options = this.searchService.searchResults;
            this.isSearchPaused = true;
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
