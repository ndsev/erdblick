import {AfterViewInit, Component, OnDestroy} from "@angular/core";
import {DebugWindow, ErdblickDebugApi} from "../app.debugapi.component";

// Redeclare window with extended interface
declare let window: DebugWindow;

@Component({
    selector: 'mapview-container',
    template: `
        <div>
            <p-splitter [panelSizes]="panelSizes" class="mb-8">
                <ng-template #panel *ngFor="let index of viewIndices">
                    <map-view [viewIndex]="index"></map-view>
                </ng-template>
            </p-splitter>
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
export class MapViewContainerComponent implements AfterViewInit {
    viewIndices: number[] = [0];
    panelSizes: number[] = [100];

    constructor() {

    }

    ngAfterViewInit() {
        // TODO: Subscribe to adding a new viewer
    }
}
