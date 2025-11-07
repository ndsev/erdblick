import {AfterViewInit, Component, ElementRef, Renderer2, ViewChild, effect, input} from "@angular/core";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, DEFAULT_EM_WIDTH, InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {coreLib} from "../integrations/wasm";

@Component({
    selector: 'inspection-panel-dialog',
    template: `
        <p-dialog class="inspection-dialog" [modal]="false" [closable]="false" [visible]="true">
        @if (panel()) {
            <ng-template #header>
                <div class="inspector-title">
                    <span>
                    @if (panel().sourceData !== undefined) {
                        <p-button icon="pi pi-chevron-left" (click)="onGoBack($event)" (mousedown)="$event.stopPropagation()"/>
                    } @else {
                        <p-colorpicker [(ngModel)]="panel().color" (click)="$event.stopPropagation()" (mousedown)="$event.stopPropagation()"
                                       (ngModelChange)="stateService.setInspectionPanelColor(panel().id, panel().color)"/>
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
                    <p-button icon="" (click)="dock($event)" (mousedown)="$event.stopPropagation()">
                        <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">move_to_inbox</span>
                    </p-button>
                    <p-button icon="" (click)="togglePinnedState($event)"
                              [styleClass]="panel().pinned ? 'p-button-success' : 'p-button-primary'"
                              (mousedown)="$event.stopPropagation()">
                        @if (panel().pinned) {
                            <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">keep</span>
                        } @else {
                            <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">keep_off</span>
                        }
                    </p-button>
                    <p-button icon="pi pi-times" styleClass="p-button-danger" (click)="unsetPanel()" (mousedown)="$event.stopPropagation()"/>
                </span>
                </div>
            </ng-template>
            
            <ng-template #content>
                <div class="resizable-container">
                    <div style="width: 100%; height: 100%">
                        @if (errorMessage) {
                            <div>
                                <strong>Error</strong><br>{{ errorMessage }}
                            </div>
                        } @else if (panel().sourceData) {
                            <sourcedata-panel [panel]="panel()" (errorOccurred)="onSourceDataError($event)"></sourcedata-panel>
                        } @else {
                            <feature-panel [panel]="panel()"></feature-panel>
                        }
                    </div>
                </div>
            </ng-template>
        }
        </p-dialog>
    `,
    styles: [``],
    standalone: false
})
export class InspectionPanelDialogComponent {
    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    title = "";
    errorMessage: string = "";
    layerMenuItems: { label: string, disabled: boolean, command: () => void }[] = [];
    selectedLayerItem?: { label: string, disabled: boolean, command: () => void };

    constructor(private mapService: MapDataService,
                public stateService: AppStateService,
                private renderer: Renderer2) {
        effect(() => {
            this.updateHeaderFor(this.panel());
        });
    }

    private updateHeaderFor(panel: InspectionPanelModel<FeatureWrapper>) {
        if (panel.sourceData !== undefined) {
            const selection = panel.sourceData!;
            const [mapId, layerId, tileId] = coreLib.parseMapTileKey(selection.mapTileKey);
            this.title = tileId === 0n ? `Metadata for ${mapId}: ` : `${tileId}.`;
            const map = this.mapService.maps.maps.get(mapId);
            if (map) {
                this.layerMenuItems = Array.from(map.layers.values())
                    .filter(item => item.type === "SourceData")
                    .filter(item => (item.id.startsWith("SourceData") && tileId !== 0n) || (item.id.startsWith("Metadata") && tileId === 0n))
                    .map(item => {
                        return {
                            label: this.mapService.layerNameForSourceDataLayerId(item.id, item.id.startsWith("Metadata")),
                            disabled: item.id === layerId,
                            command: () => {
                                const sourceData = { ...selection };
                                sourceData.mapTileKey = coreLib.getSourceDataLayerKey(mapId, item.id, tileId);
                                sourceData.address = undefined;
                                this.stateService.setSelection(sourceData, panel.id);
                            }
                        }
                    }).sort((a, b) => a.label.localeCompare(b.label));
                this.selectedLayerItem = this.layerMenuItems.filter(item => item.disabled).pop();
            } else {
                this.layerMenuItems = [];
                this.title = "";
                this.selectedLayerItem = undefined;
            }
        } else {
            this.title = panel.features.length > 1 ? `Selected ${panel.features.length} features` : panel.features[0].featureId;
            this.layerMenuItems = [];
            this.selectedLayerItem = undefined;
        }
    }

    onGoBack(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        if (p.features.length) {
            this.title = p.features.length > 1 ? `Selected ${p.features.length} features` : p.features[0].featureId;
        }
        this.errorMessage = "";
        this.stateService.setSelection(p.features, p.id);
    }

    onSelectedLayerItem() {
        if (this.selectedLayerItem && !this.selectedLayerItem.disabled) {
            this.selectedLayerItem.command();
        }
    }

    onDropdownClick(event: MouseEvent) {
        event.stopPropagation();
    }

    onSourceDataError(errorMessage: string) {
        this.errorMessage = errorMessage;
        console.error("Error while processing SourceData tree:", errorMessage);
    }

    togglePinnedState(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        this.stateService.setInspectionPanelPinnedState(p.id, !p.pinned);
    }

    unsetPanel() {
        this.stateService.unsetPanel(this.panel().id);
    }

    dock(event: MouseEvent) {
        event.stopPropagation();
        this.stateService.setInspectionPanelUndockedState(this.panel().id, false);
    }
}
