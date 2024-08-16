import {Component, OnInit} from "@angular/core";
import {InspectionService, SelectedSourceData} from "./inspection.service";
import {distinctUntilChanged} from "rxjs";
import {FeaturePanelComponent} from "./feature.panel.component";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";

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
                    <span class="inspector-title">
                        <p-button icon="pi pi-chevron-left" *ngIf="activeIndex > 0" (click)="onGoBack($event)" />
                        
                        <i class="pi {{ tabs[activeIndex].icon }}"></i>{{ tabs[activeIndex].title }}
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
export class InspectionPanelComponent implements OnInit
{
    title = "";
    tabs: InspectorTab[] = [];
    activeIndex = 0;

    constructor(public inspectionService: InspectionService) {
        this.pushFeatureInspector();

        this.inspectionService.featureTree.pipe(distinctUntilChanged()).subscribe((tree: string) => {
            this.reset();

            // TODO: Create a new FeaturePanelComponent instance for each unique selected feature
            //       then we can get rid of all the service's View Component logic/functions.
            //       reset() Would then completely clear the tabs.
            this.tabs[0].title = this.inspectionService.selectedFeatureIdName;
        });

        this.inspectionService.selectedSourceData.pipe(distinctUntilChanged()).subscribe(selection => {
            this.reset();
            if (selection)
                this.pushSourceDataInspector(selection);
        })
    }

    ngOnInit(): void {}

    reset() {
        /* We always keep the first tab, which is a feature inspector. */
        this.setTab(0);
        this.tabs = [this.tabs.at(0)!];
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
            title: data.layerId,
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
        this.activeIndex = index
    }

    onGoBack(event: any) {
        event.stopPropagation();
        if (this.activeIndex > 0) {
            const onClose = this.tabs[this.activeIndex]['onClose'];
            if (onClose)
                onClose();
            this.activeIndex = this.activeIndex - 1;
        }
    }
}
