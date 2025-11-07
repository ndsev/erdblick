import {Component} from "@angular/core";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";

@Component({
    selector: 'inspection-container',
    template: `
        <div class="inspection-container">
            @for (panel of panels; track panel.id) {
                @if ((panel.features.length > 0 || panel.sourceData !== undefined) && !panel.undocked) {
                    <inspection-panel [panel]="panel" (ejectedPanel)="onEject($event)"></inspection-panel>
                }
            }
        </div>
        @for (panel of panels; track panel.id) {
            @if ((panel.features.length > 0 || panel.sourceData !== undefined) && panel.undocked) {
                <inspection-panel-dialog [panel]="panel"></inspection-panel-dialog>
            }
        }
    `,
    styles: [``],
    standalone: false
})
export class InspectionContainerComponent {
    panels: InspectionPanelModel<FeatureWrapper>[] = [];

    constructor(private stateService: AppStateService,
                private mapService: MapDataService) {
        this.mapService.selectionTopic.subscribe(panels => {
            this.panels = panels.toReversed();
            this.stateService.dockOpenState.next(this.panels.length > 0);
        });
    }

    onEject(panel: any) {
        this.mapService.stateService.setInspectionPanelUndockedState(panel.id, true);
    }
}
