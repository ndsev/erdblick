import {Component, ViewChild} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {MapInfoItem, MapItemLayer, MapService} from "./map.service";
import {StyleService} from "./style.service";
import {ParametersService} from "./parameters.service";
import {FileUpload} from "primeng/fileupload";


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
                        <input type="text" pInputText [(ngModel)]="'Opacity: ' + mapService.osmOpacityValue"
                               class="w-full slider-input"/>
                        <p-slider [(ngModel)]="mapService.osmOpacityValue" (ngModelChange)="updateOSMOverlay()"
                                  class="w-full"></p-slider>
                    </div>
                </div>
                <p-divider></p-divider>
                <div *ngIf="!mapItems.size" style="margin-top: 0.75em">No maps loaded.</div>
                <div *ngIf="mapItems.size" class="maps-container">
                    <div *ngFor="let mapItem of mapItems | keyvalue" class="map-container">
                        <span class="font-bold white-space-nowrap map-header">
                            {{ mapItem.key }}
                        </span>
                        <div *ngFor="let mapLayer of mapItem.value.layers | keyvalue" class="flex-container">
                            <span class="font-bold white-space-nowrap" style="margin-left: 0.5em">
                                {{ mapLayer.key }}
                            </span>
                            <div class="layer-controls">
                                <p-button (click)="toggleLayer(mapItem.key, mapLayer.key, mapLayer.value)"
                                          icon="{{mapLayer.value.visible ? 'pi pi-eye' : 'pi pi-eye-slash'}}"
                                          label="" pTooltip="Toggle layer" tooltipPosition="bottom">
                                </p-button>
                                <p-button *ngIf="mapLayer.value.coverage[0]" (click)="focus(mapLayer.value.coverage[0], $event)"
                                          icon="pi pi-search"
                                          label="" pTooltip="Focus on layer" tooltipPosition="bottom">
                                </p-button>
                                <p-inputNumber [(ngModel)]="mapLayer.value.level"
                                               (ngModelChange)="onLayerLevelChanged($event, mapItem.key, mapLayer.key)"
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
                            <p-button (click)="exportStyle(style.key, false)"
                                      icon="pi pi-file-export"
                                      label="" pTooltip="Export style"
                                      tooltipPosition="bottom">
                            </p-button>
                        </div>
                    </div>
                </div>
                <div *ngIf="styleService.activatedImportedStyles.size" class="styles-container">
                    <div *ngFor="let style of styleService.activatedImportedStyles | keyvalue" class="flex-container">
                        <span class="font-bold white-space-nowrap" style="margin-left: 0.5em">
                            {{ style.key }}
                        </span>
                        <div class="layer-controls style-controls">
                            <p-button (click)="toggleImportedStyle(style.key)"
                                      icon="{{style.value ? 'pi pi-eye' : 'pi pi-eye-slash'}}"
                                      label="" pTooltip="Toggle style"
                                      tooltipPosition="bottom">
                            </p-button>
                            <p-button (click)="removeStyle(style.key)"
                                      icon="pi pi-trash"
                                      label="" pTooltip="Remove style"
                                      tooltipPosition="bottom">
                            </p-button>
                            <p-button (click)="exportStyle(style.key, true)"
                                      icon="pi pi-file-export"
                                      label="" pTooltip="Export style"
                                      tooltipPosition="bottom">
                            </p-button>
                        </div>
                    </div>
                </div>
                <div *ngIf="styleService.errorStyleIds.size" class="styles-container">
                    <div *ngFor="let message of styleService.errorStyleIds | keyvalue" class="flex-container">
                        <span class="font-bold white-space-nowrap" style="margin-left: 0.5em; color: red">
                            {{ message.key }}: {{message.value}} (see console)
                        </span>
                    </div>
                </div>
                <div class="styles-container">
                    <div class="flex-container">
                        <span class="font-bold white-space-nowrap" style="margin-left: 0.5em"></span>
                        <div class="layer-controls style-controls">
                            <p-fileUpload name="demo[]" mode="basic" chooseLabel="Import"
                                          [customUpload]="true" [fileLimit]="1" [multiple]="false"
                                          accept=".yaml" [maxFileSize]="1048576"
                                          (uploadHandler)="importStyle($event)"
                                          pTooltip="Import style" tooltipPosition="bottom"
                                          class="import-dialog" #styleUploader>
                            </p-fileUpload>
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
    mapItems: Map<string, MapInfoItem> = new Map<string, MapInfoItem>();
    @ViewChild('styleUploader') styleUploader: FileUpload | undefined;

    constructor(public mapService: MapService,
                private messageService: InfoMessageService,
                public styleService: StyleService,
                public parameterService: ParametersService) {
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

    onLayerLevelChanged(event: Event, mapName: string, layerName: string) {
        const mapLayerName = `${mapName}/${layerName}`;
        const level = event.toString();
        if (this.mapService.mapModel.getValue()) {
            this.mapService.mapModel.getValue()!.layerIdToLevel.set(mapLayerName, Number(level));
            const parameters = this.parameterService.parameters.getValue();
            if (parameters) {
                const mapItem = this.mapItems.get(mapName);
                if (mapItem !== undefined) {
                    for (const [name, layer] of mapItem.layers) {
                        if (name == layerName && layer.visible) {
                            let includes = false;
                            parameters.layers.forEach(layer => {
                                includes = layer[0] == mapLayerName;
                                if (includes) layer[1] = level;
                            })
                            if (!includes) parameters.layers.push([mapLayerName, level]);
                            this.parameterService.parameters.next(parameters);
                        }
                    }
                }
            }
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
        const parameters = this.parameterService.parameters.getValue();
        if (parameters) {
            parameters.osmEnabled = this.mapService.osmEnabled;
            parameters.osmOpacity = this.mapService.osmOpacityValue;
            this.parameterService.parameters.next(parameters);
        }
    }

    toggleLayer(mapName: string, layerName: string, mapLayer: MapItemLayer) {
        const mapLayerName =`${mapName}/${layerName}`;
        mapLayer.visible = !mapLayer.visible;
        if (this.mapService.mapModel.getValue()) {
            const parameters = this.parameterService.parameters.getValue();
            if (parameters) {
                if (mapLayer.visible) {
                    parameters.layers.push([mapLayerName, this.mapService.mapModel.getValue()!.layerIdToLevel.get(mapLayerName)!.toString()]);
                } else {
                    parameters.layers = parameters.layers.filter(layer => layer[0] != mapLayerName);
                }
                this.parameterService.parameters.next(parameters);
            }
            this.mapService.mapModel.getValue()!.update();
        } else {
            this.messageService.showError("Cannot access the map model. The model is not available.");
        }
    }

    toggleStyle(styleId: string) {
        const isActivated = !this.styleService.activatedStyles.get(styleId);
        this.styleService.activatedStyles.set(styleId, isActivated);
        const parameters = this.parameterService.parameters.getValue();
        if (parameters) {
            if (isActivated) {
                parameters.styles.push(styleId);
            } else {
                parameters.styles = parameters.styles.filter(style => style != styleId);
            }
            this.parameterService.parameters.next(parameters);
        }
        this.mapService.reapplyStyle(styleId);
    }

    toggleImportedStyle(styleId: string) {
        const isActivated = !this.styleService.activatedImportedStyles.get(styleId);
        this.styleService.activatedImportedStyles.set(styleId, isActivated);
        this.mapService.reapplyStyle(styleId, true);
    }

    reloadStyle(styleId: string) {
        this.styleService.activatedStyles.set(styleId, true);
        this.mapService.reloadStyle(styleId);
    }

    exportStyle(styleId: string, imported: boolean) {
        if(!this.styleService.exportStyle(styleId, imported)) {
            this.messageService.showError(`Error occurred while trying to export style: ${styleId}`);
        }
    }

    importStyle(event: any) {
        if (event.files && event.files.length > 0) {
            const file: File = event.files[0];
            let styleId = file.name;
            if (styleId.toLowerCase().endsWith(".yaml")) {
                styleId = styleId.slice(0, -5);
            } else if (styleId.toLowerCase().endsWith(".yml")) {
                styleId = styleId.slice(0, -4);
            }
            styleId = `${styleId} (Imported)`
            this.styleService.importStyle(event, file, styleId, this.styleUploader).subscribe(
                (next) => {
                    if (next) {
                        this.mapService.loadImportedStyle(styleId);
                    } else {
                        this.messageService.showError(`Could not read empty data for: ${styleId}`);
                    }
                },
                (error) => {
                    this.messageService.showError(`Error occurred while trying to import style: ${styleId}`);
                    console.log(error);
                }
            );
        }
    }

    removeStyle(styleId: string) {
        this.mapService.removeImportedStyle(styleId);
        this.styleService.removeImportedStyle(styleId);
    }
}