import {Component, ViewChild} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {MapInfoItem, MapItemLayer, MapService} from "./map.service";
import {StyleService} from "./style.service";
import {ParametersService} from "./parameters.service";
import {FileUpload} from "primeng/fileupload";
import {Subscription} from "rxjs";
import {Dialog} from "primeng/dialog";


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
                                <p-button *ngIf="mapLayer.value.coverage[0]"
                                          (click)="focus(mapLayer.value.coverage[0], $event)"
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
                <div *ngIf="!styleService.builtinStylesCount && !styleService.importedStylesCount">No styles loaded.
                </div>
                <div *ngIf="styleService.builtinStylesCount" class="styles-container">
                    <div *ngFor="let style of styleService.styleData | keyvalue">
                        <div *ngIf="!style.value.imported" class="flex-container">
                            <span class="font-bold white-space-nowrap" style="margin-left: 0.5em">
                                {{ style.key }}
                            </span>
                            <div class="layer-controls style-controls">
                                <p-button (click)="showStyleEditor(style.key)"
                                          icon="pi pi-file-edit"
                                          label="" pTooltip="Edit style"
                                          tooltipPosition="bottom">
                                </p-button>
                                <p-button (click)="toggleStyle(style.key)"
                                          icon="{{style.value.enabled ? 'pi pi-eye' : 'pi pi-eye-slash'}}"
                                          label="" pTooltip="Toggle style"
                                          tooltipPosition="bottom">
                                </p-button>
                                <p-button (click)="resetStyle(style.key)"
                                          icon="pi pi-refresh"
                                          label="" pTooltip="Reload style from disk"
                                          tooltipPosition="bottom">
                                </p-button>
                                <p-button (click)="exportStyle(style.key)"
                                          icon="pi pi-file-export"
                                          label="" pTooltip="Export style"
                                          tooltipPosition="bottom">
                                </p-button>
                            </div>
                        </div>
                    </div>
                </div>
                <div *ngIf="styleService.importedStylesCount" class="styles-container">
                    <div *ngFor="let style of styleService.styleData | keyvalue">
                        <div *ngIf="style.value.imported" class="flex-container">
                            <span class="font-bold white-space-nowrap" style="margin-left: 0.5em">
                                {{ style.key }}
                            </span>
                            <div class="layer-controls style-controls">
                                <p-button (click)="showStyleEditor(style.key)"
                                          icon="pi pi-file-edit"
                                          label="" pTooltip="Edit style"
                                          tooltipPosition="bottom">
                                </p-button>
                                <p-button (click)="toggleStyle(style.key)"
                                          icon="{{style.value.enabled ? 'pi pi-eye' : 'pi pi-eye-slash'}}"
                                          label="" pTooltip="Toggle style"
                                          tooltipPosition="bottom">
                                </p-button>
                                <p-button (click)="removeStyle(style.key)"
                                          icon="pi pi-trash"
                                          label="" pTooltip="Remove style"
                                          tooltipPosition="bottom">
                                </p-button>
                                <p-button (click)="exportStyle(style.key)"
                                          icon="pi pi-file-export"
                                          label="" pTooltip="Export style"
                                          tooltipPosition="bottom">
                                </p-button>
                            </div>
                        </div>
                    </div>
                </div>
                <div *ngIf="styleService.erroredStyleIds.size" class="styles-container">
                    <div *ngFor="let message of styleService.erroredStyleIds | keyvalue" class="flex-container">
                        <span class="font-bold white-space-nowrap" style="margin-left: 0.5em; color: red">
                            {{ message.key }}: {{ message.value }} (see console)
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
        <p-dialog header="Style Editor" [(visible)]="editorDialogVisible" [modal]="false" #editorDialog class="editor-dialog">
            <editor></editor>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                    <p-button (click)="applyEditedStyle()" label="Apply" icon="pi pi-check"
                              [disabled]="!dataWasModified"></p-button>
                    <p-button (click)="closeEditorDialog($event)" [label]='this.dataWasModified ? "Discard" : "Close"'
                              icon="pi pi-times"></p-button>
                </div>
                <p-button (click)="openStyleHelp()" label="Help" icon="pi pi-book"></p-button>
            </div>
        </p-dialog>
        <p-dialog header="Warning!" [(visible)]="warningDialogVisible" [modal]="true" #warningDialog>
            <p>You have already edited the style data. Do you really want to discard the changes?</p>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="discardStyleEdits()" label="Yes"></p-button>
                <p-button (click)="warningDialog.close($event)" label="No"></p-button>
            </div>
        </p-dialog>
    `,
    styles: [``]
})
export class MapPanelComponent {

    editorDialogVisible: boolean = false;
    layerDialogVisible: boolean = false;
    warningDialogVisible: boolean = false;
    mapItems: Map<string, MapInfoItem> = new Map<string, MapInfoItem>();
    editedStyleDataSubscription: Subscription = new Subscription();
    dataWasModified: boolean = false;
    @ViewChild('styleUploader') styleUploader: FileUpload | undefined;
    @ViewChild('editorDialog') editorDialog: Dialog | undefined;

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

    focus(tileId: bigint, event: any) {
        event.stopPropagation();
        if (this.mapService.mapModel.getValue() && this.mapService.coreLib !== undefined) {
            this.mapService.mapModel.getValue()!.zoomToWgs84PositionTopic.next(
                this.mapService.coreLib.getTilePosition(BigInt(tileId))
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
        const isActivated = !this.styleService.availableStylesActivations.get(styleId);
        this.styleService.availableStylesActivations.set(styleId, isActivated);
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

    resetStyle(styleId: string) {
        if (this.styleService.styleData.has(styleId) && !this.styleService.styleData.get(styleId)!.imported) {
            this.styleService.availableStylesActivations.set(styleId, true);
            this.mapService.reloadBuiltinStyle(styleId);
        }
    }

    exportStyle(styleId: string) {
        if(!this.styleService.exportStyleYamlFile(styleId)) {
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
            this.styleService.importStyleYamlFile(event, file, styleId, this.styleUploader).subscribe(
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

    showStyleEditor(styleId: string) {
        this.styleService.selectedStyleIdForEditing.next(styleId);
        this.editorDialogVisible = true;
        this.editedStyleDataSubscription = this.styleService.styleEditedStateData.subscribe(editedStyleData => {
            const originalStyleData = this.styleService.styleData.get(styleId)?.data!;
            this.dataWasModified = !(editedStyleData.replace(/\n+$/, '') == originalStyleData.replace(/\n+$/, ''));
        });
    }

    applyEditedStyle() {
        const styleId = this.styleService.selectedStyleIdForEditing.getValue();
        const styleData = this.styleService.styleEditedStateData.getValue().replace(/\n+$/, '');
        if (!styleId) {
            this.messageService.showError(`No cached style ID found!`);
            return;
        }
        if (!styleData) {
            this.messageService.showError(`Cannot apply an empty style definition to style: ${styleId}!`);
            return;
        }
        if (!this.styleService.styleData.has(styleId)) {
            this.messageService.showError(`Could not apply changes to style: ${styleId}. Failed to access!`)
            return;
        }
        this.styleService.updateStyle(styleId, styleData);
        this.mapService.reapplyStyle(styleId);
        this.dataWasModified = false;
    }

    closeEditorDialog(event: any) {
        if (this.editorDialog !== undefined) {
            if (this.dataWasModified) {
                event.stopPropagation();
                this.warningDialogVisible = true;
            } else {
                this.warningDialogVisible = false;
                this.editorDialog.close(event);
            }
        }
        this.editedStyleDataSubscription.unsubscribe();
    }

    discardStyleEdits() {
        const styleId = this.styleService.selectedStyleIdForEditing.getValue();
        this.styleService.selectedStyleIdForEditing.next(styleId);
        this.warningDialogVisible = false;
    }

    openStyleHelp() {
        window.open( "https://github.com/ndsev/erdblick?tab=readme-ov-file#style-definitions", "_blank");
    }
}