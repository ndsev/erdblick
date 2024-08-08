import {Component, ViewChild, ViewContainerRef} from "@angular/core";
import {FeatureSearchService} from "./feature.search.service";
import {JumpTargetService} from "./jump.service";
import {InspectionService} from "./inspection.service";
import {MapService} from "./map.service";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {Listbox} from "primeng/listbox";
import {InfoMessageService} from "./info.service";

@Component({
    selector: "feature-search",
    template: `
        <p-dialog class="side-menu-dialog" header="Search Loaded Features" [(visible)]="isPanelVisible"
                  style="padding: 0 0.5em 0.5em 0.5em"
                  [position]="'topleft'" [draggable]="false" [resizable]="false" (onHide)="searchService.clear()">
            <div class="feature-search-controls">
                <div class="progress-bar-container">
                    <p-progressBar [value]="percentDone">
                        <ng-template pTemplate="content" let-percentDone>
                            <span>{{ searchService.doneTiles }} / {{ searchService.totalTiles }} tiles</span>
                        </ng-template>
                    </p-progressBar>
                </div>
                <p-button (click)="pauseSearch()" [icon]="isSearchPaused ? 'pi pi-play-circle' : 'pi pi-pause-circle'"
                          label=""
                          [disabled]="!canPauseStopSearch" tooltipPosition="bottom"
                          [pTooltip]="isSearchPaused ? 'Resume search' : 'Pause search'"></p-button>
                <p-button (click)="stopSearch()" icon="pi pi-stop-circle" label="" [disabled]="!canPauseStopSearch"
                          pTooltip="Stop search" tooltipPosition="bottom"></p-button>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Elapsed time:</span><span>{{ searchService.timeElapsed }}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Features:</span><span>{{ searchService.totalFeatureCount }}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Matched:</span><span>{{ searchService.searchResults.length }}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Highlight colour:</span>
                <span><p-colorPicker [(ngModel)]="searchService.pointColor"
                                     (ngModelChange)="searchService.updatePointColor()" appendTo="body"/></span>
            </div>
            <p-accordion *ngIf="traceResults.length" class="trace-entries" [multiple]="true">
                <p-accordionTab [header]="trace.name" *ngFor="let trace of traceResults">
                    <span>{{ trace.content }}</span>
                </p-accordionTab>
            </p-accordion>
            <p-listbox class="results-listbox" [options]="placeholder" [(ngModel)]="selectedResult"
                       optionLabel="label" [virtualScroll]="true" [virtualScrollItemSize]="35"
                       [multiple]="false" [metaKeySelection]="false" (onChange)="selectResult($event)"
                       emptyMessage="No features matched." [scrollHeight]="'calc(100vh - 23em)'"
                       #listbox
            />
        </p-dialog>
        <div #alert></div>
    `,
    styles: [``]
})
export class FeatureSearchComponent {
    isPanelVisible: boolean = false;
    placeholder: Array<any> = [];
    traceResults: Array<any> = [];
    selectedResult: any;
    percentDone: number = 0;
    isSearchPaused: boolean = false;
    canPauseStopSearch: boolean = false;

    @ViewChild('listbox') listbox!: Listbox;
    @ViewChild('alert', { read: ViewContainerRef, static: true }) alertContainer!: ViewContainerRef;

    constructor(public searchService: FeatureSearchService,
                public jumpService: JumpTargetService,
                public mapService: MapService,
                public inspectionService: InspectionService,
                public sidePanelService: SidePanelService,
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
                this.listbox.options = this.searchService.searchResults;
                this.canPauseStopSearch = false;
                if (this.searchService.errors.size) {
                    this.infoMessageService.showAlertDialog(
                        this.alertContainer,
                        'Feature Search Errors',
                        Array.from(searchService.errors).join('\n'))
                }
            }
        });
    }

    selectResult(event: any) {
        if (event.value.mapId && event.value.featureId) {
            this.jumpService.highlightFeature(event.value.mapId, event.value.featureId).then(() => {
                if (this.inspectionService.selectedFeature) {
                    this.mapService.focusOnFeature(this.inspectionService.selectedFeature);
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
}