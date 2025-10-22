import {Component} from "@angular/core";
import {MapDataService} from "../mapdata/map.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {InspectionPanelModel} from "../shared/appstate.service";

@Component({
    selector: 'inspection-container',
    template: `
        @if (panels.length) {
            @for (panel of panels; track panel.id) {
                <inspection-panel [panel]="panel"></inspection-panel>
            }
        }
    `,
    styles: [``],
    standalone: false
})
export class InspectionContainerComponent {
    panels: InspectionPanelModel<FeatureWrapper>[] = [];

    constructor(public mapService: MapDataService) {
        this.mapService.selectionTopic.subscribe(panels => {
            this.panels = panels;
        });
    }
}
