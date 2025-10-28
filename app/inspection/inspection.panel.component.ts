import {AfterViewInit, Component, ElementRef, input, Renderer2, ViewChild, effect} from "@angular/core";
import {AppStateService, DEFAULT_EM_WIDTH, InspectionPanelModel} from "../shared/appstate.service";
import {MapDataService} from "../mapdata/map.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {coreLib} from "../integrations/wasm";

interface SourceLayerMenuItem {
    label: string,
    disabled: boolean,
    command: () => void
}

@Component({
    selector: 'inspection-panel',
    template: `
        <p-accordion class="inspect-panel" value="0">
            <p-accordion-panel value="0">
                <p-accordion-header>
                    <div class="inspector-title">
                        <span>
                        @if (panel().selectedSourceData !== undefined) {
                            <p-button icon="pi pi-chevron-left" (click)="onGoBack($event)" (mousedown)="$event.stopPropagation()"/>
                        }

                        <!--TODO: Replace the icon with a color picker-->
                        <!--                        <i class="pi {{ tabs[activeIndex].icon || '' }}"></i>-->
                        <span class="title" [pTooltip]="title" tooltipPosition="bottom">
                            {{ title }}
                        </span>

                        @if (panel().selectedSourceData !== undefined) {
                            <p-select class="source-layer-dropdown" [options]="layerMenuItems" [(ngModel)]="selectedLayerItem"
                                      (click)="onDropdownClick($event)" (mousedown)="onDropdownClick($event)"
                                      scrollHeight="20em" (ngModelChange)="onSelectedLayerItem()" optionLabel="label"
                                      optionDisabled="disabled" appendTo="body"/>
                        }
                        </span>
                        <span>
                            <p-button icon="" (click)="togglePinnedState($event)" (mousedown)="$event.stopPropagation()">
                            @if (panel().pinned) {
                                <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">keep</span>
                            } @else {
                                <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">keep_off</span>
                            }
                            </p-button>
                            <p-button icon="pi pi-times" (click)="unsetPanel()" (mousedown)="$event.stopPropagation()"/>
                        </span>
                    </div>
                </p-accordion-header>

                <p-accordion-content>
                    <div class="flex resizable-container" #resizeableContainer
                         [style.width.em]="panel().size[0]"
                         [style.height.em]="panel().size[1]"
                         (mouseup)="onInspectionContainerResize($event, panel())"
                         [ngClass]="{'resizable-container-expanded': isExpanded}">
<!--                        <div class="resize-handle" (click)="isExpanded = !isExpanded">-->
<!--                            <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>-->
<!--                            <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>-->
<!--                        </div>-->
                    @if (errorMessage) {
                        <div>
                            <strong>Error</strong><br>{{ errorMessage }}
                        </div>
                    } @else if (panel().selectedSourceData) {
                        <sourcedata-panel [panel]="panel()" (errorOccurred)="onSourceDataError($event)"></sourcedata-panel>
                    } @else {
                        <feature-panel [panel]="panel()"></feature-panel>
                    }
                    </div>
                </p-accordion-content>
            </p-accordion-panel>
        </p-accordion>
    `,
    styles: [`
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

    constructor(private mapService: MapDataService,
                public stateService: AppStateService,
                private renderer: Renderer2) {
        effect(() => {
            const panel = this.panel();
            if (panel.selectedSourceData !== undefined) {
                const selection = panel.selectedSourceData!;
                const [mapId, layerId, tileId] = coreLib.parseMapTileKey(selection.mapTileKey);
                this.title = tileId === 0n ? `Metadata for ${mapId}: ` : `${tileId}.`;
                const map = this.mapService.maps.maps.get(mapId);
                if (map) {
                    // TODO: Fix missing entries for the metadata on tile 0
                    this.layerMenuItems = Array.from(map.layers.values())
                        .filter(item => item.type === "SourceData")
                        .filter(item => {
                            return (item.id.startsWith("SourceData") && tileId !== 0n) ||
                                (item.id.startsWith("Metadata") && tileId === 0n);
                        })
                        .map(item => {
                            return {
                                label: this.mapService.layerNameForSourceDataLayerId(
                                    item.id,
                                    item.id.startsWith("Metadata")
                                ),
                                disabled: item.id === layerId,
                                command: () => {
                                    let sourceData = {...selection};
                                    sourceData.mapTileKey = coreLib.getSourceDataLayerKey(mapId, item.id, tileId);
                                    sourceData.address = undefined;
                                    this.stateService.setSelection(sourceData, this.panel().id);
                                },
                            } as SourceLayerMenuItem;
                        }).sort((a, b) => a.label.localeCompare(b.label));
                    this.selectedLayerItem = this.layerMenuItems.filter(item => item.disabled).pop();
                } else {
                    this.layerMenuItems = [];
                    this.selectedLayerItem = undefined;
                }
            } else {
                this.title = panel.selectedFeatures.length > 1 ?
                    `Selected ${panel.selectedFeatures.length} features` :
                    panel.selectedFeatures[0].featureId;
                this.layerMenuItems = [];
                this.selectedLayerItem = undefined;
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
        this.errorMessage = "";
        this.stateService.setSelection(this.panel().selectedFeatures, this.panel().id);
    }

    onSelectedLayerItem() {
        if (this.selectedLayerItem && !this.selectedLayerItem.disabled) {
            // TODO: FIXXXXXXXXXX!!!
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
        if (!element.classList.contains("resizable-container") || !element.offsetWidth || !element.offsetHeight) {
            return;
        }

        const currentEmWidth = element.offsetWidth / this.stateService.baseFontSize;
        const currentEmHeight = element.offsetHeight / this.stateService.baseFontSize;
        panel.size[0] = currentEmWidth < DEFAULT_EM_WIDTH ? DEFAULT_EM_WIDTH : currentEmWidth;
        panel.size[1] = currentEmHeight;
        this.stateService.setInspectionPanelSize(panel.id, [currentEmWidth, currentEmHeight]);
    }

    detectSafari() {
        const isSafari = /Safari/i.test(navigator.userAgent);
        if (isSafari) {
            this.renderer.addClass(this.resizeableContainer.nativeElement, 'safari');
        }
    }

    onSourceDataError(errorMessage: string) {
        this.errorMessage = errorMessage;
        console.error("Error while processing SourceData tree:", errorMessage);
    }

    togglePinnedState(event: MouseEvent) {
        event.stopPropagation();
        this.stateService.setInspectionPanelPinnedState(this.panel().id, !this.panel().pinned);
    }

    unsetPanel() {
        this.stateService.unsetPanel(this.panel().id);
    }
}
