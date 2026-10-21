import { ChangeDetectorRef, Component, OnDestroy } from "@angular/core";
import { Subscription } from "rxjs";
import { FeatureWrapper } from "../mapdata/feature-inspection.model";
import { AppStateService } from "../shared/appstate.service";
import { InspectionSelectionService } from "./inspection-selection.service";
import { InspectionComparisonModel, InspectionPanelModel } from "./inspection-state.model";
import { InspectionStateService } from "./inspection-state.service";

@Component({
    selector: 'inspection-dialogs',
    template: `
        @for (panel of undockedPanels; track panel.id; let i = $index) {
            @if (panel.loading || panel.features.length > 0 || panel.sourceData !== undefined) {
                <inspection-panel-dialog [panel]="panel" [dialogIndex]="i"></inspection-panel-dialog>
            }
        }
        @if (comparison) {
            <inspection-comparison-dialog [comparison]="comparison"></inspection-comparison-dialog>
        }
    `,
    standalone: false
})
/** Hosts floating inspection dialogs independently from the dock tab lifecycle. */
export class InspectionDialogsComponent implements OnDestroy {
    undockedPanels: InspectionPanelModel<FeatureWrapper>[] = [];
    comparison: InspectionComparisonModel | null = null;

    private readonly subscriptions = new Subscription();

    constructor(private mapService: InspectionSelectionService,
        private stateService: AppStateService,
        private readonly cdr: ChangeDetectorRef,
        public readonly inspectionState: InspectionStateService) {
        this.subscriptions.add(this.mapService.selectionTopic.subscribe(panels => {
            this.undockedPanels = panels.filter(panel => panel.undocked);
            this.cdr.markForCheck();
        }));
        this.subscriptions.add(this.inspectionState.inspectionComparisonState.subscribe(comparison => {
            this.comparison = comparison;
            this.cdr.markForCheck();
        }));
    }

    /** Stops listening to inspection state when the host is destroyed. */
    ngOnDestroy() {
        this.subscriptions.unsubscribe();
    }
}
