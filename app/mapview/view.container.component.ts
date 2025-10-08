import {AfterViewInit, Component} from "@angular/core";
import {AppStateService} from "../shared/appstate.service";
import {map} from "rxjs";

@Component({
    selector: 'mapview-container',
    template: `
        <div>
            <ng-container *ngIf="showSplitter">
                <p-splitter [panelSizes]="panelSizes$ | async" class="mb-8">
                    <ng-container *ngFor="let idx of viewIndices$ | async; trackBy: trackByIndex">
                        <ng-template pTemplate="panel">
                            <map-view [viewIndex]="idx"></map-view>
                        </ng-template>
                    </ng-container>
                </p-splitter>
            </ng-container>
        </div>
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
    // A flag to force split-rerender
    showSplitter = true;

    constructor(private stateService: AppStateService) {
        this.stateService.numViewsState.subscribe(() => {
            // whenever numViews changes, force a quick toggle to remount splitter
            this.showSplitter = false;
            setTimeout(() => {
                this.showSplitter = true;
            });
        });
    }

    trackByIndex(_: number, i: number) {
        return i;
    }
}