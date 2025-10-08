import {AfterViewInit, Component} from "@angular/core";
import {AppStateService} from "../shared/appstate.service";
import {map} from "rxjs";

@Component({
    selector: 'mapview-container',
    template: `
        <ng-container *ngIf="panelSizes$ | async as panelSizes">
            <p-splitter [panelSizes]="panelSizes" class="mb-8">
                <ng-container *ngIf="viewIndices$ | async as viewIndices">
                    <ng-container *ngFor="let idx of viewIndices; trackBy: trackByIndex">
                        <ng-template pTemplate="panel">
                            <map-view [viewIndex]="idx"></map-view>
                        </ng-template>
                    </ng-container>
                </ng-container>
            </p-splitter>
        </ng-container>
    `,
    styles: [`
        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `],
    standalone: false
})
export class MapViewContainerComponent {
    viewIndices$ = this.stateService.numViewsState.pipe(
        map(n => Array.from({ length: n }, (_, i) => i))
    );
    panelSizes$ = this.stateService.numViewsState.pipe(
        map(n => Array.from({ length: n }, () => 100 / n))
    );

    constructor(private stateService: AppStateService) {
    }

    trackByIndex(_: number, i: number) {
        return i;
    }
}