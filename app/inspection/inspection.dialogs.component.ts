import {Component, OnDestroy} from "@angular/core";
import {Subscription} from "rxjs";
import {InspectionSelectionService} from "./inspection-selection.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {AppStateService, InspectionComparisonModel, InspectionPanelModel} from "../shared/appstate.service";

@Component({
    selector: 'inspection-dialogs',
    template: `
        @for (panel of undockedPanels; track panel.id; let i = $index) {
            @if (panel.features.length > 0 || panel.sourceData !== undefined) {
                <inspection-panel-dialog [panel]="panel" [dialogIndex]="i"></inspection-panel-dialog>
            }
        }
        @if (comparison) {
            <inspection-comparison-dialog [comparison]="comparison"></inspection-comparison-dialog>
        }
    `,
    styles: [``],
    standalone: false
})
/** Hosts floating inspection dialogs independently from the dock tab lifecycle. */
export class InspectionDialogsComponent implements OnDestroy {
    undockedPanels: InspectionPanelModel<FeatureWrapper>[] = [];
    comparison: InspectionComparisonModel | null = null;

    private readonly subscriptions = new Subscription();

    constructor(private mapService: InspectionSelectionService,
                private stateService: AppStateService) {
        this.subscriptions.add(this.mapService.selectionTopic.subscribe(panels => {
            this.undockedPanels = panels.filter(panel => panel.undocked);
        }));
        this.subscriptions.add(this.stateService.inspectionComparisonState.subscribe(comparison => {
            this.comparison = comparison;
        }));
    }

    /** Stops listening to inspection state when the host is destroyed. */
    ngOnDestroy() {
        this.subscriptions.unsubscribe();
    }
}
