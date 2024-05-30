import {Component, Input} from "@angular/core";
import {SearchService} from "./search.service";

@Component({
    selector: "feature-search",
    template: `
        <p-dialog class="search-menu-dialog" header="Match Features" [(visible)]="visibility"
                  [position]="'topleft'" [draggable]="false" [resizable]="false" (onHide)="searchService.clear()">
            <p-progressBar [value]="searchService.percentDone()">
                <ng-template pTemplate="content" let-currentTilesProccessed>
                    <span>{{searchService.doneTiles}}</span>/<span>{{searchService.totalTiles}}</span>
                </ng-template>
            </p-progressBar>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Elapsed time:</span><span>{{searchService.timeElapsed}}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Features:</span><span>{{searchService.totalFeatureCount}}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Matched:</span><span>{{results.length}}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Highlight colour:</span><span><p-colorPicker [(ngModel)]="searchService.pointColor" (ngModelChange)="searchService.updatePointColor()" /></span>
            </div>
            <p-accordion *ngIf="traceResults.length" class="trace-entries" [multiple]="true">
                <p-accordionTab [header]="trace.name" *ngFor="let trace of traceResults">
                    <span>{{ trace.content }}</span>
                </p-accordionTab>
            </p-accordion>
            <p-listbox class="results-listbox"
                    [options]="results"
                    [(ngModel)]="selectedResult"
                    optionLabel="label"
                    [virtualScroll]="true"
                    [virtualScrollItemSize]="38"
                    [multiple]="false"
                    [metaKeySelection]="false"
                    (onChange)="selectResult($event)"
                    scrollHeight="250px" />
        </p-dialog>
    `,
    styles: [`
    `]
})
export class FeatureSearchComponent {
    visibility: boolean = false;
    results: Array<any> = [];
    traceResults: Array<any> = [];
    selectedResult: any;

    constructor(public searchService: SearchService) {
        this.searchService.searchActive.subscribe(value => {
            this.visibility = value;
            this.results = [];
        });
        this.searchService.searchUpdates.subscribe(tileResult => {
            for (const [mapTileKey, featureId, _] of tileResult.matches) {
                // TODO: Also show info from the mapTileKey
                this.results.push({label: featureId})
            }
        });
    }

    selectResult(event: any) {
        // TODO: Jump to feature on selection.
    }
}