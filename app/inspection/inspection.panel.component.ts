import {AfterViewInit, Component, ElementRef, input, Renderer2, ViewChild} from "@angular/core";
import {InspectionService, SelectedSourceData, selectedSourceDataEqualTo} from "./inspection.service";
import {distinctUntilChanged, Observable} from "rxjs";
import {FeaturePanelComponent} from "./feature.panel.component";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";
import {AppStateService, InspectionPanelModel} from "../shared/appstate.service";
import {MapDataService} from "../mapdata/map.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {toObservable} from "@angular/core/rxjs-interop";
import {MapView} from "../mapview/view";

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

@Component({
    selector: 'inspection-panel',
    template: `
        <p-accordion class="w-full inspect-panel" [ngClass]="{ 'inspect-panel-small-header': panel().selectedSourceData }" value="0">
            <p-accordion-panel value="0">
                <p-accordion-header>
                    <span class="inspector-title">
                        <p-button *ngIf="panel().selectedSourceData" icon="pi pi-chevron-left" (click)="onGoBack($event)" 
                                  (mousedown)="$event.stopPropagation()" />
                        <!--TODO: Replace the icon with a color picker-->
<!--                        <i class="pi {{ tabs[activeIndex].icon || '' }}"></i>-->
                        {{ title }}

                        <p-select *ngIf="panel().selectedSourceData" class="source-layer-dropdown" [options]="layerMenuItems"
                                  [(ngModel)]="selectedLayerItem" (click)="onDropdownClick($event)" (mousedown)="onDropdownClick($event)"
                                  scrollHeight="20em" (ngModelChange)="onSelectedLayerItem()" optionLabel="label"
                                  optionDisabled="disabled" appendTo="body"/>
                    </span>
                </p-accordion-header>

                <p-accordion-content>
                    <div class="flex resizable-container" #resizeableContainer
                         [style.width.px]="panel().size[0]"
                         [style.height.px]="panel().size[1]"
                         (mouseup)="onInspectionContainerResize($event, panel())"
                         [ngClass]="{'resizable-container-expanded': isExpanded}">
                        <div class="resize-handle" (click)="isExpanded = !isExpanded">
                            <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>
                            <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>
                        </div>
                        @if (panel()?.selectedSourceData) {
                            <sourcedata-panel [panel]="panel()"></sourcedata-panel>
                        } @else {
                            <feature-panel [panel]="panel()"></feature-panel>
                        }
                        <ng-template *ngIf="errorMessage">
                            <div class="error">
                                <div>
                                    <strong>Error</strong><br>{{ errorMessage }}
                                </div>
                            </div>
                        </ng-template>
                    </div>
                </p-accordion-content>
            </p-accordion-panel>
        </p-accordion>
    `,
    styles: [`
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
        
        @media only screen and (max-width: 56em) {
            .resizable-container-expanded {
                height: calc(100vh - 3em);
            }
        }
    `],
    standalone: false
})
export class InspectionPanelComponent implements AfterViewInit {
    title = "";
    isExpanded: boolean = true;
    errorMessage: string = "";

    layerMenuItems: SourceLayerMenuItem[] = [];
    selectedLayerItem?: SourceLayerMenuItem;

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();

    @ViewChild('resizeableContainer') resizeableContainer!: ElementRef;

    constructor(public inspectionService: InspectionService,
                public mapService: MapDataService,
                public stateService: AppStateService,
                private renderer: Renderer2) {
        // TODO: We need a feature tree per panel
        this.inspectionService.featureTree.pipe(distinctUntilChanged()).subscribe(_ => {
            this.reset();

            const featureIds = this.inspectionService.selectedFeatures.map(f => f.featureId).join(", ");
            if (this.inspectionService.selectedFeatures.length == 1) {
                this.tabs[0].title = featureIds;
            } else {
                this.tabs[0].title = `Selected ${this.inspectionService.selectedFeatures.length} Features`;
            }

            const selectedSourceData = this.stateService.selectedSourceData
            if (selectedSourceData?.featureIds === featureIds)
                this.inspectionService.selectedSourceData.next(selectedSourceData);
            else
                this.inspectionService.selectedSourceData.next(null);
        });

        this.inspectionService.selectedSourceData.pipe(distinctUntilChanged(selectedSourceDataEqualTo)).subscribe(selection => {
            if (selection) {
                this.reset();
                const map = this.mapService.maps.maps.get(selection.mapId);
                if (map) {
                    // TODO: Fix missing entries for the metadata on tile 0
                    this.layerMenuItems = Array.from(map.layers.values())
                        .filter(item => item.type == "SourceData")
                        .filter(item => {
                            return item.id.startsWith("SourceData") ||
                                (item.id.startsWith("Metadata") && selection.tileId === 0);
                        })
                        .map(item => {
                            return {
                                label: layerNameForSourceDataLayerId(
                                    item.id,
                                    item.id.startsWith("Metadata")
                                ),
                                disabled: item.id === selection.layerId,
                                command: () => {
                                    let sourceData = {...selection};
                                    sourceData.layerId = item.id;
                                    sourceData.address = BigInt(0);
                                    this.inspectionService.selectedSourceData.next(sourceData);
                                },
                            };
                        }).sort((a, b) => a.label.localeCompare(b.label));
                    this.selectedLayerItem = this.layerMenuItems.filter(item => item.disabled).pop();
                } else {
                    this.layerMenuItems = [];
                }
                this.pushSourceDataInspector(selection);
            }
        });
    }

    ngAfterViewInit() {
        this.detectSafari();
    }

    onGoBack(event: any) {
        // The back-button can be used to navigate from a SourceData selection
        // back to the feature-set from which it was called up.
        event.stopPropagation();
        this.stateService.setSelection(this.panel().selectedFeatures, this.panel().id);
    }

    onSelectedLayerItem() {
        if (this.selectedLayerItem && !this.selectedLayerItem.disabled) {
            this.selectedLayerItem.command();
        }
    }

    onDropdownClick(event: MouseEvent) {
        event.stopPropagation();
    }

    onInspectionContainerResize(event: MouseEvent, panel: InspectionPanelModel<FeatureWrapper> | undefined): void {
        if (!panel) {
            return;
        }
        const element = event.target as HTMLElement;
        if (!element.classList.contains("resizable-container")) {
            return;
        }
        if (!element.offsetWidth || !element.offsetHeight) {
            return;
        }

        const currentEmWidth = element.offsetWidth / this.stateService.baseFontSize;
        if (currentEmWidth < 40.0) {
            panel.size[0] = 40 * this.stateService.baseFontSize;
        } else {
            panel.size[0] = element.offsetWidth;
        }
        panel.size[1] = element.offsetHeight;
        this.stateService.setInspectionPanelSize(panel.id, panel.size);
    }

    /**
     * Set an error message that gets displayed.
     * Unsets the tree to an empty array.
     *
     * @param message Error message
     */
    setError(message: string) {
        this.errorMessage = message;
        console.error("Error while processing tree:", this.errorMessage);
    }

    detectSafari() {
        const isSafari = /Safari/i.test(navigator.userAgent);
        if (isSafari) {
            this.renderer.addClass(this.resizeableContainer.nativeElement, 'safari');
        }
    }
}
