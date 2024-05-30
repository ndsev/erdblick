import {Component, Input} from "@angular/core";

@Component({
    selector: "feature-search",
    template: `
        <p-dialog class="search-menu-dialog" header="Match Features" [(visible)]="visibility"
                  [position]="'topleft'" [draggable]="false" [resizable]="false">
            <p-progressBar [value]="currentTilesProccessed">
                <ng-template pTemplate="content" let-currentTilesProccessed>
                    <span>{{currentTilesProccessed}} / {{tilesTotal}}</span>
                </ng-template>
            </p-progressBar>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Elapsed time:</span><span>{{elapsedTime}}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Features:</span><span>{{featuresTotal}}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Matched:</span><span>{{results.length}}</span>
            </div>
            <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 0.5em 0; font-size: 0.9em; align-items: center;">
                <span>Highlight colour:</span><span><p-colorPicker [(ngModel)]="color" /></span>
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
    @Input() visibility: boolean = true;

    color: string = "#00f2ff";
    currentTilesProccessed: number = 50;
    tilesTotal: number = 100;
    elapsedTime: number = 0;
    featuresTotal: number = 9000;
    results: Array<any> = [
        { label: "Road.54556565.0" },
        { label: "Road.54556565.0" },
        { label: "Road.54556565.0" },
        { label: "Road.54556565.0" },
        { label: "Road.54556565.0" },
        { label: "Road.54556565.0" },
        { label: "Road.54556565.0" },
        { label: "Road.54556565.0" }
    ];
    traceResults: Array<any> = [
        { name: "Trace Result 0", content: "Trace result" },
        { name: "Trace Result 1", content: "Trace result" },
        { name: "Trace Result 2", content: "Trace result" },
        { name: "Trace Result 3", content: "Trace result" }
    ];
    selectedResult: any;

    constructor() {

    }

    selectResult(event: any) {

    }
}