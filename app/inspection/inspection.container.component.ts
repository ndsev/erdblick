import {Component} from "@angular/core";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {InspectionComparisonModel, InspectionComparisonService} from "./inspection-comparison.service";

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
        @for (panel of panels; track panel.id; let i = $index) {
            @if ((panel.features.length > 0 || panel.sourceData !== undefined) && panel.undocked) {
                <inspection-panel-dialog [panel]="panel" [dialogIndex]="i"></inspection-panel-dialog>
            }
        }
        @for (comparison of comparisons; track comparison.id) {
            <inspection-comparison-dialog [comparison]="comparison"></inspection-comparison-dialog>
        }
    `,
    styles: [``],
    standalone: false
})
export class InspectionContainerComponent {
    panels: InspectionPanelModel<FeatureWrapper>[] = [];
    comparisons: InspectionComparisonModel[] = [];

    constructor(private stateService: AppStateService,
                private mapService: MapDataService,
                private comparisonService: InspectionComparisonService) {
        this.mapService.selectionTopic.subscribe(panels => {
            this.panels = panels.toReversed();
            this.stateService.dockOpenState.next(this.panels.length > 0);
        });
        this.comparisonService.comparisons.subscribe(comparisons => {
            this.comparisons = comparisons;
        });
    }

    onEject(panel: any) {
        this.mapService.stateService.setInspectionPanelUndockedState(panel.id, true);
    }
}
