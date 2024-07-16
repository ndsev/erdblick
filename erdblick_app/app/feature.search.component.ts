import {Component, ViewChild} from "@angular/core";
import {FeatureSearchService} from "./feature.search.service";
import {JumpTargetService} from "./jump.service";
import {InspectionService} from "./inspection.service";
import {MapService} from "./map.service";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {Listbox} from "primeng/listbox";

@Component({
    selector: "feature-search",
    template: `
        <p-dialog class="search-menu-dialog" header="Search Loaded Features" [(visible)]="isPanelVisible" style="padding: 0 0.5em 0.5em 0.5em"
                  [position]="'topleft'" [draggable]="false" [resizable]="false" (onHide)="searchService.clear()">
            <div class="feature-search-controls">
                <p-button (click)="pauseSearch()" [icon]="isSearchPaused ? 'pi pi-play-circle' : 'pi pi-pause-circle'"
                          [label]="isSearchPaused ? 'Resume' : 'Pause'" [disabled]="!canPauseStopSearch"
                          [pTooltip]="isSearchPaused ? 'Resume current search' : 'Pause current search'"
                          tooltipPosition="bottom"></p-button>
                <p-button (click)="stopSearch()" icon="pi pi-stop-circle" label="Stop" [disabled]="!canPauseStopSearch"
                          pTooltip="Stop current search" tooltipPosition="bottom"></p-button>
                <p-button (click)="cancelSearch()" icon="pi pi-times-circle" label="Discard" 
                          pTooltip="Discard current search" tooltipPosition="bottom"></p-button>
            </div>
            <p-progressBar [value]="percentDone">
                <ng-template pTemplate="content" let-percentDone>
                    <span>{{ searchService.doneTiles }} / {{ searchService.totalTiles }} tiles</span>
                </ng-template>
            </p-progressBar>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Elapsed time:</span><span>{{ searchService.timeElapsed }}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Features:</span><span>{{ searchService.totalFeatureCount }}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Matched:</span><span>{{ results.length }}</span>
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
                       emptyMessage="No features matched." [scrollHeight]="'calc(100vh - 24em)'"
                       #listbox
            />
        </p-dialog>
    `,
    styles: [``]
})
export class FeatureSearchComponent {
    isPanelVisible: boolean = false;
    results: Array<any> = [];
    placeholder: Array<any> = [];
    traceResults: Array<any> = [];
    selectedResult: any;
    percentDone: number = 0;
    isSearchPaused: boolean = false;
    canPauseStopSearch: boolean = false;

    @ViewChild('listbox') listbox!: Listbox;

    constructor(public searchService: FeatureSearchService,
                public jumpService: JumpTargetService,
                public mapService: MapService,
                public inspectionService: InspectionService,
                public sidePanelService: SidePanelService) {
        this.sidePanelService.observable().subscribe(panel=> {
            this.isPanelVisible = panel == SidePanelState.FEATURESEARCH || this.isPanelVisible;
        });
        this.searchService.isFeatureSearchActive.subscribe(isActive => {
            if (isActive) {
                this.results = [];
                this.placeholder = [{label: "Loading..."}];
                this.canPauseStopSearch = isActive;
            } else {
                this.listbox.options = this.results;
            }
        });
        this.searchService.searchUpdates.subscribe(tileResult => {
            for (const [mapTileKey, featureId, _] of tileResult.matches) {
                // TODO: Also show info from the mapTileKey
                const mapId = mapTileKey.split(':')[1]
                this.results.push({label: `${featureId}`, mapId: mapId, featureId: featureId});
            }
        });
        this.searchService.progress.subscribe(value => {
            this.percentDone = value;
            if (value >= 100) {
                this.listbox.options = this.results;
                this.canPauseStopSearch = false;
            }
        });
    }

    selectResult(event: any) {
        if (event.value.mapId && event.value.featureId) {
            this.jumpService.highlightFeature(event.value.mapId, event.value.featureId).then();
            this.mapService.focusOnFeature(this.inspectionService.selectedFeature!)
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
            this.listbox.options = this.results;
            this.isSearchPaused = true;
        }
    }

    stopSearch() {
        if (this.canPauseStopSearch) {
            this.listbox.options = this.results;
            this.searchService.stop();
            this.canPauseStopSearch = false;
        }
    }

    cancelSearch() {
        this.searchService.clear();
        this.isPanelVisible = false;
    }
}