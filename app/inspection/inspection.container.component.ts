import {Component} from "@angular/core";
import {MapDataService} from "../mapdata/map.service";

@Component({
    selector: 'inspection-container',
    template: `
        <div class="inspection-container" *ngIf="mapService.selectionTopic | async as panels">
            @if (panels.length > 0) {
                @for (panel of panels; track panel.id) {
                    @if (panel.features.length > 0 || panel.sourceData !== undefined) {
                        <inspection-panel [panel]="panel"></inspection-panel>
                    }
                }
            }
        </div>
    `,
    styles: [``],
    standalone: false
})
export class InspectionContainerComponent {
    constructor(public mapService: MapDataService) {}
}
