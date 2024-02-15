import {Component} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {ErdblickLayer, ErdblickMap, MapService} from "./map.service";
import {StyleService} from "./style.service";
import {ErdblickModel} from "./erdblick.model";


@Component({
    selector: 'map-panel',
    template: `
        <p-dialog class="map-layer-dialog" header="" [(visible)]="layerDialogVisible"
                  [position]="'topleft'" [draggable]="false" [resizable]="false">
            <p-fieldset class="map-tab" legend="Maps and Layers">
                <div class="osm-controls">
                    <span style="font-size: 0.9em">OSM Overlay:</span>
                    <p-button (click)="toggleOSMOverlay()" class="osm-button"
                              icon="{{mapService.osmEnabled ? 'pi pi-eye' : 'pi pi-eye-slash'}}"
                              label="" pTooltip="Toggle OSM overlay" tooltipPosition="bottom">
                    </p-button>
<!--                    <p-inputSwitch [(ngModel)]="mapService.osmEnabled" (ngModelChange)="updateOSMOverlay()"></p-inputSwitch>-->
                    <div *ngIf="mapService.osmEnabled" style="display: inline-block">
                        <input type="text" pInputText [(ngModel)]="'Opacity: ' + mapService.osmOpacityValue" class="w-full slider-input"/>
                        <p-slider [(ngModel)]="mapService.osmOpacityValue" (ngModelChange)="updateOSMOverlay()" class="w-full"></p-slider>
                    </div>
                </div>
                <p-divider></p-divider>
                <div *ngIf="!mapItems.size">No maps loaded.</div>
                <div *ngIf="mapItems.size" class="maps-container">
                    <div *ngFor="let mapItem of mapItems | keyvalue" class="map-container">
                        <span class="font-bold white-space-nowrap map-header">
                            {{ mapItem.key }}
                        </span>
                        <div *ngFor="let mapLayer of mapItem.value.mapLayers" class="flex-container">
                            <span class="font-bold white-space-nowrap" style="margin-left: 0.5em">
                                {{ mapLayer.name }}
                            </span>
                            <div class="layer-controls">
                                <p-button (click)="toggleLayer(mapLayer)"
                                          icon="{{mapLayer.visible ? 'pi pi-eye' : 'pi pi-eye-slash'}}"
                                          label="" pTooltip="Toggle layer" tooltipPosition="bottom">
                                </p-button>
                                <p-button *ngIf="mapLayer.coverage" (click)="focus(mapLayer.coverage, $event)"
                                          icon="pi pi-search"
                                          label="" pTooltip="Focus on layer" tooltipPosition="bottom">
                                </p-button>
                                <p-inputNumber [(ngModel)]="mapLayer.level"
                                               (ngModelChange)="onLayerLevelChanged($event, mapItem.key + '/' + mapLayer.name)"
                                               [showButtons]="true" [min]="0" [max]="15"
                                               buttonLayout="horizontal" spinnerMode="horizontal" inputId="horizontal"
                                               decrementButtonClass="p-button-secondary"
                                               incrementButtonClass="p-button-secondary"
                                               incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus"
                                               pTooltip="Change zoom level" tooltipPosition="bottom">
                                </p-inputNumber>
                            </div>
                        </div>
                    </div>
                </div>
            </p-fieldset>
            <p-fieldset class="map-tab" legend="Styles">
                <div *ngIf="!styleService.activatedStyles.size">No styles loaded.</div>
                <div *ngIf="styleService.activatedStyles.size" class="styles-container">
                    <div *ngFor="let style of styleService.activatedStyles | keyvalue" class="flex-container">
                        <span class="font-bold white-space-nowrap" style="margin-left: 0.5em">
                            {{ style.key }}
                        </span>
                        <div class="layer-controls style-controls">
                            <p-button (click)="toggleStyle(style.key)"
                                      icon="{{style.value ? 'pi pi-eye' : 'pi pi-eye-slash'}}"
                                      label="" pTooltip="Toggle style"
                                      tooltipPosition="bottom">
                            </p-button>
                            <p-button (click)="reloadStyle(style.key)"
                                      icon="pi pi-refresh"
                                      label="" pTooltip="Reload style"
                                      tooltipPosition="bottom">
                            </p-button>
                        </div>
                    </div>
                </div>
            </p-fieldset>
        </p-dialog>
        <p-button (click)="showLayerDialog()" label="" class="layers-button" tooltipPosition="right"
                  pTooltip="{{layerDialogVisible ? 'Hide map layers' : 'Show map layers'}}" 
                  icon="{{layerDialogVisible ? 'pi pi-times' : 'pi pi-images'}}">
        </p-button>
    `,
    styles: [``]
})
export class MapPanelComponent {

    layerDialogVisible: boolean = false;
    mapItems: Map<string, ErdblickMap> = new Map<string, ErdblickMap>();

    constructor(public mapService: MapService,
                private messageService: InfoMessageService,
                public styleService: StyleService) {
        this.mapService.mapModel.subscribe(mapModel => {
            if (mapModel) {
                mapModel.availableMapItems.subscribe(mapItems => this.mapItems = mapItems);
            }
        });
    }

    showLayerDialog() {
        this.layerDialogVisible = !this.layerDialogVisible;
    }

    focus(tileId: BigInt, event: any) {
        event.stopPropagation();
        if (this.mapService.mapModel.getValue() && this.mapService.coreLib !== undefined) {
            this.mapService.mapModel.getValue()!.zoomToWgs84PositionTopic.next(
                this.mapService.coreLib.getTilePosition(tileId)
            );
        }
    }

    onLayerLevelChanged(event: Event, layerName: string) {
        let level = Number(event.toString());
        if (this.mapService.mapModel.getValue()) {
            this.mapService.mapModel.getValue()!.layerIdToLevel.set(layerName, level);
            this.mapService.mapModel.getValue()!.update();
        } else {
            this.messageService.showError("Cannot access the map model. The model is not available.");
        }
    }

    toggleOSMOverlay() {
        this.mapService.osmEnabled = !this.mapService.osmEnabled;
        this.updateOSMOverlay();
    }

    updateOSMOverlay() {
        if (this.mapService.osmEnabled) {
            this.mapService.mapView?.updateOpenStreetMapLayer(this.mapService.osmOpacityValue / 100);
        } else {
            this.mapService.mapView?.updateOpenStreetMapLayer(0);
        }
    }

    toggleLayer(mapLayer: ErdblickLayer) {
        mapLayer.visible = !mapLayer.visible;
        if (this.mapService.mapModel.getValue()) {
            this.mapService.mapModel.getValue()!.update();
        } else {
            this.messageService.showError("Cannot access the map model. The model is not available.");
        }
    }

    toggleStyle(styleId: string) {
        const isAvailable = this.styleService.activatedStyles.get(styleId);
        this.styleService.activatedStyles.set(styleId, !isAvailable);
        this.mapService.reloadStyle();
    }

    reloadStyle(styleId: string) {
        this.styleService.activatedStyles.set(styleId, true);
        this.mapService.reloadStyle();
    }
}