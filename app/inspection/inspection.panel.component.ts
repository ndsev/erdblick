import {AfterViewInit, Component, ElementRef, input, output, Renderer2, ViewChild, effect} from "@angular/core";
import {Popover} from "primeng/popover";
import {AppStateService, DEFAULT_EM_WIDTH, InspectionPanelModel} from "../shared/appstate.service";
import {MapDataService} from "../mapdata/map.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {coreLib} from "../integrations/wasm";
import {InspectionComparisonOption, InspectionComparisonService} from "./inspection-comparison.service";
import {InspectionTreeComponent} from "./inspection.tree.component";

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
                    <div class="inspector-title" (pointerdown)="onHeaderPointerDown($event)">
                        <span>
                            @if (panel().sourceData === undefined && panel().features.length > 0) {
                                <p-colorpicker [(ngModel)]="panel().color" (click)="$event.stopPropagation()"
                                               (mousedown)="$event.stopPropagation()"
                                               (ngModelChange)="stateService.setInspectionPanelColor(panel().id, panel().color)">
                                </p-colorpicker>
                            }
                            <span class="title" [pTooltip]="title" tooltipPosition="bottom">
                                {{ title }}
                            </span>
                            @if (panel().sourceData !== undefined) {
                                <p-select class="source-layer-dropdown" [options]="layerMenuItems"
                                          [(ngModel)]="selectedLayerItem"
                                          (click)="onDropdownClick($event)" (mousedown)="onDropdownClick($event)"
                                          scrollHeight="20em" (ngModelChange)="onSelectedLayerItem()"
                                          optionLabel="label"
                                          optionDisabled="disabled"/>
                            }
                        </span>
                        <span>
                            <p-button class="dock-eject-button" icon="" (click)="undock($event)" (mousedown)="$event.stopPropagation()">
                                <span class="material-symbols-outlined"
                                      style="font-size: 1.2em; margin: 0 auto;">eject</span>
                            </p-button>
                            @if (panel().sourceData === undefined && panel().features.length > 0) {
                                <p-button icon="" (click)="focusOnFeature($event)"
                                          (mousedown)="$event.stopPropagation()"
                                          pTooltip="Focus on feature" tooltipPosition="bottom">
                                    <span class="material-symbols-outlined"
                                          style="font-size: 1.2em; margin: 0 auto;">center_focus_strong</span>
                                </p-button>
                                <p-button icon="" (click)="openGeoJsonMenu($event)"
                                          (mousedown)="$event.stopPropagation()"
                                          pTooltip="GeoJSON actions" tooltipPosition="bottom">
                                    <span class="material-symbols-outlined"
                                          style="font-size: 1.2em; margin: 0 auto;">download</span>
                                </p-button>
                                <p-button icon="" (click)="openComparePopover($event)"
                                          (mousedown)="$event.stopPropagation()"
                                          pTooltip="Compare" tooltipPosition="bottom">
                                    <span class="material-symbols-outlined"
                                          style="font-size: 1.2em; margin: 0 auto;">compare_arrows</span>
                                </p-button>
                            }
                            <p-button icon="pi pi-times" styleClass="p-button-danger" (click)="unsetPanel()"
                                      (mousedown)="$event.stopPropagation()"/>
                        </span>
                    </div>
                </p-accordion-header>

                <p-accordion-content>
                    <div class="resizable-container" #resizeableContainer
                         [style.width.%]="100"
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
                        } @else if (panel().sourceData) {
                            <sourcedata-panel [panel]="panel()"
                                              [showFilter]="false"
                                              [filterText]="filterText()"
                                              (filterTextChange)="filterTextChange.emit($event)"
                                              (errorOccurred)="onSourceDataError($event)"></sourcedata-panel>
                        } @else {
                            <feature-panel [panel]="panel()"
                                           [showFilter]="false"
                                           [filterText]="filterText()"
                                           (filterTextChange)="filterTextChange.emit($event)">
                            </feature-panel>
                        }
                    </div>
                </p-accordion-content>
            </p-accordion-panel>
        </p-accordion>
        <p-popover #comparePopover [baseZIndex]="30000">
            <div class="comparison-popover">
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.25em">
                    <p-multiSelect [options]="compareOptions"
                                   [(ngModel)]="selectedCompareIds"
                                   (onPanelShow)="refreshCompareOptions()"
                                   optionLabel="label"
                                   optionValue="value"
                                   [showClear]="true"
                                   [selectionLimit]="3"
                                   placeholder="Compare with..."
                                   [overlayOptions]="{ autoZIndex: true, baseZIndex: 30010 }"/>
                    @if (selectedCompareIds.length > 0) {
                        <div class="comparison-popover-actions">
                            <p-button icon="pi pi-check" label="" (click)="applyComparison($event)"/>
                        </div>
                    }
                </div>
            </div>
        </p-popover>
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
    compareOptions: InspectionComparisonOption[] = [];
    selectedCompareIds: number[] = [];

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    filterText = input<string | undefined>();
    filterTextChange = output<string>();
    ejectedPanel = output<InspectionPanelModel<FeatureWrapper>>();
    panelDragRequest = output<{panel: InspectionPanelModel<FeatureWrapper>, event: PointerEvent}>();

    @ViewChild('resizeableContainer') resizeableContainer!: ElementRef;
    @ViewChild('comparePopover') comparePopover!: Popover;
    @ViewChild(InspectionTreeComponent) inspectionTree?: InspectionTreeComponent;

    constructor(private mapService: MapDataService,
                public stateService: AppStateService,
                private comparisonService: InspectionComparisonService,
                private renderer: Renderer2) {
        effect(() => {
            this.title = "";
            const panel = this.panel();
            if (panel.sourceData !== undefined) {
                const selection = panel.sourceData!;
                const [mapId, layerId, tileId] = coreLib.parseMapTileKey(selection.mapTileKey);
                this.title = tileId === 0n ? `Metadata for ${mapId}: ` : `${tileId}.`;
                const map = this.mapService.maps.maps.get(mapId);
                if (map) {
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
                    this.title = "";
                    this.selectedLayerItem = undefined;
                }
            } else {
                this.title = panel.features.length > 1 ?
                    `Selected ${panel.features.length} features` :
                    panel.features[0].featureId;
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
        const panel = this.panel();
        if (panel.features.length) {
            this.title = panel.features.length > 1 ?
                `Selected ${panel.features.length} features` :
                panel.features[0].featureId;
        }
        this.errorMessage = "";
        this.stateService.setSelection(this.panel().features, this.panel().id);
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

    unsetPanel() {
        this.stateService.unsetPanel(this.panel().id);
    }

    undock(event: MouseEvent) {
        event.stopPropagation();
        this.ejectedPanel.emit(this.panel());
    }

    focusOnFeature(event: MouseEvent) {
        event.stopPropagation();
        const panel = this.panel();
        if (!panel.features.length) {
            return;
        }
        this.mapService.zoomToFeature(undefined, panel.features[0]);
    }

    openGeoJsonMenu(event: MouseEvent) {
        event.stopPropagation();
        this.inspectionTree?.showGeoJsonMenu(event);
    }

    onHeaderPointerDown(event: PointerEvent) {
        if (event.button !== 0) {
            return;
        }
        const target = event.target as HTMLElement | null;
        if (this.isInteractiveTarget(target)) {
            return;
        }
        this.panelDragRequest.emit({panel: this.panel(), event});
    }

    private isInteractiveTarget(target: HTMLElement | null): boolean {
        if (!target) {
            return false;
        }
        return !!target.closest(
            'button, .p-button, .p-colorpicker, .p-select, .p-dropdown, .p-multiselect, input, textarea, select, option, a'
        );
    }

    openComparePopover(event: MouseEvent) {
        event.stopPropagation();
        this.refreshCompareOptions();
        this.comparePopover.toggle(event);
    }

    refreshCompareOptions() {
        this.compareOptions = this.comparisonService.buildCompareOptions(this.panel().id);
        this.selectedCompareIds = this.selectedCompareIds.filter(id =>
            this.compareOptions.some(option => option.value === id)
        );
    }

    applyComparison(event: MouseEvent) {
        event.stopPropagation();
        if (!this.selectedCompareIds.length) {
            return;
        }
        this.comparisonService.openComparison(this.panel().id, this.selectedCompareIds);
        this.selectedCompareIds = [];
        this.comparePopover.hide();
    }
}
