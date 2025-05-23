import {Component} from "@angular/core";
import {InspectionService, SelectedSourceData, selectedSourceDataEqualTo} from "./inspection.service";
import {distinctUntilChanged} from "rxjs";
import {FeaturePanelComponent} from "./feature.panel.component";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";
import {ParametersService} from "./parameters.service";
import {MapService} from "./map.service";

interface InspectorTab {
    title: string,
    icon: string,
    component: any,
    inputs?: Record<string, any>,
    onClose?: any,
}

interface SourceLayerMenuItem {
    label: string,
    disabled: boolean,
    command: () => void
}

export interface InspectionContainerSize {
    height: number,
    width: number,
    type: string
}

@Component({
    selector: 'inspection-panel',
    template: `
        <p-accordion *ngIf="inspectionService.isInspectionPanelVisible"
                     class="w-full inspect-panel" [ngClass]="{'inspect-panel-small-header': activeIndex > 0}"
                     [activeIndex]="0" >
            <p-accordionTab>
                <ng-template pTemplate="header">
                    <span class="inspector-title" *ngIf="activeIndex < tabs.length">
                        <p-button icon="pi pi-chevron-left" (click)="onGoBack($event)" 
                                  *ngIf="activeIndex > 0 && inspectionService.selectedFeatures.length" />
                        
                        <i class="pi {{ tabs[activeIndex].icon || '' }}"></i>{{ tabs[activeIndex].title || '' }}
                        
                        <p-select class="source-layer-dropdown" *ngIf="activeIndex > 0" [options]="layerMenuItems" 
                                    [(ngModel)]="selectedLayerItem" (click)="onDropdownClick($event)" scrollHeight="20em"
                                    (ngModelChange)="onSelectedLayerItem()" optionLabel="label" optionDisabled="disabled" 
                                  appendTo="body"/>
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
                    width: 1.75em !important;
                    height: 1.75em !important;
                    margin: 0;
                }
            }
        }
        `,
    ],
    standalone: false
})
export class InspectionPanelComponent
{
    title = "";
    tabs: InspectorTab[] = [];
    activeIndex = 0;

    layerMenuItems: SourceLayerMenuItem[] = [];
    selectedLayerItem?: SourceLayerMenuItem;

    constructor(public inspectionService: InspectionService,
                public mapService: MapService,
                private parameterService: ParametersService) {
        this.pushFeatureInspector();

        this.inspectionService.featureTree.pipe(distinctUntilChanged()).subscribe(_ => {
            this.reset();

            // TODO: Create a new FeaturePanelComponent instance for each unique feature selection.
            //       Then we can get rid of all the service's View Component logic/functions.
            //       reset() Would then completely clear the tabs.
            const featureIds = this.inspectionService.selectedFeatures.map(f=>f.featureId).join(", ");
            if (this.inspectionService.selectedFeatures.length == 1) {
                this.tabs[0].title = featureIds;
            } else {
                this.tabs[0].title = `Selected ${this.inspectionService.selectedFeatures.length} Features`;
            }

            const selectedSourceData = this.parameterService.getSelectedSourceData()
            if (selectedSourceData?.featureIds === featureIds)
                this.inspectionService.selectedSourceData.next(selectedSourceData);
            else
                this.inspectionService.selectedSourceData.next(null);
        });

        this.inspectionService.selectedSourceData.pipe(distinctUntilChanged(selectedSourceDataEqualTo)).subscribe(selection => {
            if (selection) {
                this.reset();
                const map = this.mapService.maps.getValue().get(selection.mapId);
                if (map) {
                    this.layerMenuItems = Array.from(map.layers.values()).filter(item => item.type == "SourceData").map(item => {
                        return {
                            label: this.inspectionService.layerNameForSourceDataLayerId(item.layerId),
                            disabled: item.layerId === selection.layerId,
                            command: () => {
                                let sourceData = {...selection};
                                sourceData.layerId = item.layerId;
                                sourceData.address = BigInt(0);
                                this.inspectionService.selectedSourceData.next(sourceData);
                            },
                        };
                    });
                    this.selectedLayerItem = this.layerMenuItems.filter(item => item.disabled).pop();
                } else {
                    this.layerMenuItems = [];
                }
                this.pushSourceDataInspector(selection);
            }
        });
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
            title: `${data.tileId}.`,
            icon: "",
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

    onSelectedLayerItem() {
        if (this.selectedLayerItem && !this.selectedLayerItem.disabled) {
            this.selectedLayerItem.command();
        }
    }

    onDropdownClick(event: MouseEvent) {
        event.stopPropagation();
    }
}
