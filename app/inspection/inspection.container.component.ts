import {Component} from "@angular/core";
import {MapDataService} from "../mapdata/map.service";

@Component({
    selector: 'inspection-container',
    template: `
        <div *ngIf="mapService.selectionTopic | async as panels">
            <div class="inspection-container">
                @if (panels.length > 0) {
                    @for (panel of panels; track panel.id) {
                        @if ((panel.features.length > 0 || panel.sourceData !== undefined) && !panel.undocked) {
                            <inspection-panel [panel]="panel" (ejectedPanel)="onEject($event)"></inspection-panel>
                        }
                    }
                }
            </div>
            @for (panel of panels; track panel.id) {
                @if ((panel.features.length > 0 || panel.sourceData !== undefined) && panel.undocked) {
                    <inspection-panel-dialog [panel]="panel"></inspection-panel-dialog>
                }
            }
        </div>
    `,
    styles: [``],
    standalone: false
})
export class InspectionContainerComponent {
    constructor(public mapService: MapDataService) {}

    onEject(panel: any) {
        this.mapService.stateService.setInspectionPanelUndockedState(panel.id, true);
    }
}
