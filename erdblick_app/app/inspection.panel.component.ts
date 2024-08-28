import {Component, OnInit} from "@angular/core";
import {InspectionService, SelectedSourceData, selectedSourceDataEqualTo} from "./inspection.service";
import {distinctUntilChanged} from "rxjs";
import {FeaturePanelComponent} from "./feature.panel.component";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";
import {ParametersService} from "./parameters.service";

interface InspectorTab {
    title: string,
    icon: string,
    component: any,
    inputs?: Record<string, any>,
    onClose?: any,
}

@Component({
    selector: 'inspection-panel',
    template: `
        <p-accordion *ngIf="inspectionService.featureTree.value.length && inspectionService.isInspectionPanelVisible"
                     class="w-full inspect-panel"
                     [activeIndex]="0">
            <p-accordionTab>
                <ng-template pTemplate="header">
                    <span class="inspector-title" *ngIf="activeIndex < tabs.length">
                        <p-button icon="pi pi-chevron-left" *ngIf="activeIndex > 0" (click)="onGoBack($event)" />
                        
                        <i class="pi {{ tabs[activeIndex].icon || '' }}"></i>{{ tabs[activeIndex].title || '' }}
                    </span>
                </ng-template>

                <ng-template pTemplate="content">
                    <div *ngFor="let tab of tabs; let i = index">
                        <div [style]="{'display': i == activeIndex ? 'block' : 'none'}">
                            <ng-container *ngComponentOutlet="tab.component; inputs: tab.inputs" />
                        </div>
                    </div>
                </ng-template>
            </p-accordionTab>
        </p-accordion>
    `,
    styles: [
        `@layer erdblick {
            .inspector-title {
                display: flex;
                gap: 4px;
                justify-content: center;
                align-items: center;

                .p-button {
                    width: 30px;
                    height: 30px;
                    margin: 0;
                }
            }
        }`,
    ]
})
export class InspectionPanelComponent
{
    title = "";
    tabs: InspectorTab[] = [];
    activeIndex = 0;

    constructor(public inspectionService: InspectionService, private parameterService: ParametersService) {
        this.pushFeatureInspector();

        this.inspectionService.featureTree.pipe(distinctUntilChanged()).subscribe((tree: string) => {
            this.reset();

            // TODO: Create a new FeaturePanelComponent instance for each unique selected feature
            //       then we can get rid of all the service's View Component logic/functions.
            //       reset() Would then completely clear the tabs.
            const featureId = this.inspectionService.selectedFeatureIdName;
            this.tabs[0].title = featureId;

            const selectedSourceData = parameterService.getSelectedSourceData()
            if (selectedSourceData?.featureId === featureId)
                this.inspectionService.selectedSourceData.next(selectedSourceData);
            else
                this.inspectionService.selectedSourceData.next(null);
        });

        this.inspectionService.selectedSourceData.pipe(distinctUntilChanged(selectedSourceDataEqualTo)).subscribe(selection => {
            if (selection)
                this.pushSourceDataInspector(selection);
        })
    }

    reset() {
        /* We always keep the first tab, which is a feature inspector. */
        this.setTab(0);
        for (let i = 1; i < this.tabs.length - 1; ++i) {
            let close = this.tabs[this.tabs.length - i]['onClose']
            if (close)
                close();
        }
        if (this.tabs.length > 0) {
            this.tabs = [this.tabs[0]!];
        }
    }

    pushFeatureInspector() {
        let tab = {
            title: "",
            icon: "pi-sitemap",
            component: FeaturePanelComponent,
            onClose: () => {
                this.inspectionService.featureTree.next("");
            },
        }

        this.tabs = [...this.tabs, tab];
        this.setTab(-1);
    }

    pushSourceDataInspector(data: SelectedSourceData) {
        let tab = {
            title: SourceDataPanelComponent.layerNameForLayerId(data.layerId),
            icon: "pi-database",
            component: SourceDataPanelComponent,
            inputs: {
                sourceData: data
            },
            onClose: () => {
                this.inspectionService.selectedSourceData.next(null);
            },
        }

        this.tabs = [...this.tabs, tab];
        this.setTab(-1);
    }

    setTab(index: number) {
        if (index < 0)
            index = this.tabs.length - 1;
        this.inspectionService.inspectionPanelChanged.emit();
        this.activeIndex = Math.max(0, index)
    }

    onGoBack(event: any) {
        event.stopPropagation();
        if (this.activeIndex > 0) {
            const onClose = this.tabs[this.activeIndex]['onClose'];
            if (onClose)
                onClose();
            this.setTab(this.activeIndex - 1);
            if (this.tabs.length > 1)
                this.tabs.pop();
        }
    }
}
