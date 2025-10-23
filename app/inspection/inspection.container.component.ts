import {Component} from "@angular/core";
import {MapDataService} from "../mapdata/map.service";

@Component({
    selector: 'inspection-container',
    template: `
        <ng-container *ngIf="mapService.selectionTopic | async as panels">
            @if (panels.length > 0) {
                @for (panel of panels; track panel.id) {
                    @if (panel.selectedFeatures.length > 0 || panel.selectedSourceData !== undefined) {
                        <inspection-panel [panel]="panel"></inspection-panel>
                    }
                }
            }
        </ng-container>
    `,
    styles: [``],
    standalone: false
})
export class InspectionContainerComponent {
    constructor(public mapService: MapDataService) {}
}
