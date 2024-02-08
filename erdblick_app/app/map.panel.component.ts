import {Component, OnInit} from "@angular/core";
import {Cartesian3} from "cesium";
import {InfoMessageService} from "./info.service";
import {JumpTarget, JumpTargetService} from "./jump.service";
import {ErdblickLayer, MapService} from "./map.service";
import {ErdblickStyle, StyleService} from "./style.service";
import {HttpClient} from "@angular/common/http";
import {ActivatedRoute} from "@angular/router";


@Component({
    selector: 'map-panel',
    template: `
        <p-dialog class="map-layer-dialog" header="Maps Layers" [(visible)]="layerDialogVisible"
                  [position]="'topleft'" [draggable]="false" [resizable]="false">
            <div class="osm-controls">
                <span style="font-size: 0.9em">OSM Overlay:</span>
                <p-inputSwitch [(ngModel)]="mapService.osmEnabled" (ngModelChange)="updateOSMOverlay()"></p-inputSwitch>
                <div *ngIf="mapService.osmEnabled" style="display: inline-block">
                    <input type="text" pInputText [(ngModel)]="'Opacity: ' + mapService.osmOpacityValue" class="w-full"/>
                    <p-slider [(ngModel)]="mapService.osmOpacityValue" (ngModelChange)="updateOSMOverlay()"
                              class="w-full"></p-slider>
                </div>
            </div>
            <p-fieldset class="map-tab" legend="Maps">
                <div *ngIf="!mapService.mapModel!.availableMapItems.size">No maps loaded.</div>
                <div *ngIf="mapService.mapModel!.availableMapItems.size" class="maps-container">
                    <div *ngFor="let mapItem of mapService.mapModel!.availableMapItems | keyvalue">
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
                                          label="" pTooltip="Toggle layer"
                                          tooltipPosition="bottom">
                                </p-button>
                                <p-button *ngIf="mapLayer.coverage" (click)="focus(mapLayer.coverage, $event)"
                                          icon="pi pi-search"
                                          label="" pTooltip="Focus on layer"
                                          tooltipPosition="bottom">
                                </p-button>
                                <p-inputNumber [(ngModel)]="mapLayer.level"
                                               (ngModelChange)="onLayerLevelChanged($event, mapItem.key + '/' + mapLayer.name)"
                                               [style]="{'width': '2rem'}" [showButtons]="true"
                                               buttonLayout="horizontal" spinnerMode="horizontal" inputId="horizontal"
                                               decrementButtonClass="p-button-secondary"
                                               incrementButtonClass="p-button-secondary"
                                               incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus"
                                               [min]="0" [max]="15"
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
                        </div>
                    </div>
                </div>
            </p-fieldset>
        </p-dialog>
        <p-button (click)="showLayerDialog()" icon="pi pi-images" label="" pTooltip="Show map layers"
                  tooltipPosition="right"
                  class="layers-button">
        </p-button>
    `,
    styles: [`
        .osm-controls {
            display: flex;
            align-items: center;
            gap: 1em;
            margin-left: 1em;
        }
    `]
})
export class MapPanelComponent {

    layerDialogVisible: boolean = false;

    constructor(public mapService: MapService,
                private messageService: InfoMessageService,
                public styleService: StyleService) {
    }

    showLayerDialog() {
        this.layerDialogVisible = !this.layerDialogVisible;
    }

    focus(tileId: BigInt, event: any) {
        event.stopPropagation();
        if (this.mapService.mapModel !== undefined && this.mapService.coreLib !== undefined) {
            this.mapService.mapModel.zoomToWgs84PositionTopic.next(this.mapService.coreLib.getTilePosition(tileId));
        }
    }

    onLayerLevelChanged(event: Event, layerName: string) {
        let level = Number(event.toString());
        if (this.mapService.mapModel !== undefined) {
            this.mapService.mapModel.layerIdToLevel.set(layerName, level);
            this.mapService.mapModel.update();
        } else {
            this.messageService.showError("Cannot access the map model. The model is not available.");
        }
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
        if (this.mapService.mapModel !== undefined) {
            this.mapService.mapModel.update();
        } else {
            this.messageService.showError("Cannot access the map model. The model is not available.");
        }
    }

    toggleStyle(style: string) {
        const isAvailable = this.styleService.activatedStyles.get(style);
        this.styleService.activatedStyles.set(style, !isAvailable);
        this.mapService.reloadStyle();
    }
}