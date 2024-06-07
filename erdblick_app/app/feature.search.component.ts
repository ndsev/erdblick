import {ChangeDetectorRef, Component, Input} from "@angular/core";
import {FeatureSearchService} from "./feature.search.service";
import {JumpTargetService} from "./jump.service";
import {InspectionService} from "./inspection.service";
import {MapService} from "./map.service";
import {SidePanelService, SidePanelState} from "./sidepanel.service";

@Component({
    selector: "feature-search",
    template: `
        <p-dialog class="search-menu-dialog" header="Match Features" [(visible)]="isPanelVisible"
                  [position]="'topleft'" [draggable]="false" [resizable]="false" (onHide)="searchService.clear()">
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
            <p-listbox class="results-listbox" [options]="results" [(ngModel)]="selectedResult"
                       optionLabel="label" [virtualScroll]="false" [virtualScrollItemSize]="38"
                       [multiple]="false" [metaKeySelection]="false"
                       (onChange)="selectResult($event)" emptyMessage="No features matched."
                       scrollHeight="37em"
            />
        </p-dialog>
    `,
    styles: [``]
})
export class FeatureSearchComponent {
    isPanelVisible: boolean = false;
    results: Array<any> = [];
    traceResults: Array<any> = [];
    selectedResult: any;
    percentDone: number = 0;

    constructor(public searchService: FeatureSearchService,
                public jumpService: JumpTargetService,
                public mapService: MapService,
                public inspectionService: InspectionService,
                public sidePanelService: SidePanelService) {
        this.sidePanelService.observable().subscribe(panel=> {
            this.isPanelVisible = panel == SidePanelState.FEATURESEARCH || this.isPanelVisible;
        });
        this.searchService.isFeatureSearchActive.subscribe(value => {
            this.results = [];
        });
        this.searchService.searchUpdates.subscribe(tileResult => {
            for (const [mapTileKey, featureId, _] of tileResult.matches) {
                // TODO: Also show info from the mapTileKey
                const mapId = mapTileKey.split(':')[1]
                this.results = [...this.results, {label: `${featureId}`, mapId: mapId, featureId: featureId}]
            }
        });
        this.searchService.progress.subscribe(value => {
            this.percentDone = value;
        });
    }

    selectResult(event: any) {
        if (event.value.mapId && event.value.featureId) {
            this.jumpService.highlightFeature(event.value.mapId, event.value.featureId).then();
            this.mapService.focusOnFeature(this.inspectionService.selectedFeature!)
        }
    }
}