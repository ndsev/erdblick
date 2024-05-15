import {Component, ViewChild} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {MapInfoItem, MapService} from "./map.service";
import {StyleService} from "./style.service";
import {ParametersService} from "./parameters.service";
import {FileUpload} from "primeng/fileupload";
import {Subscription} from "rxjs";
import {Dialog} from "primeng/dialog";
import {KeyValue} from "@angular/common";
import {coreLib} from "./wasm";
import {SidePanelService} from "./panel.service";


@Component({
    selector: 'map-panel',
    template: `
        <p-dialog class="map-layer-dialog" header="" [(visible)]="layerDialogVisible"
                  [position]="'topleft'" [draggable]="false" [resizable]="false">
            <p-fieldset class="map-tab" legend="Maps and Layers">
                <div class="osm-controls">
                    <span style="font-size: 0.9em">OSM Overlay:</span>
                    <p-button (click)="toggleOSMOverlay()" class="osm-button"
                              icon="{{osmEnabled ? 'pi pi-eye' : 'pi pi-eye-slash'}}"
                              label="" pTooltip="Toggle OSM overlay" tooltipPosition="bottom">
                    </p-button>
                    <div *ngIf="osmEnabled" style="display: inline-block">
                        <input type="text" pInputText [(ngModel)]="'Opacity: ' + osmOpacityValue"
                               class="w-full slider-input"/>
                        <p-slider [(ngModel)]="osmOpacityValue" (ngModelChange)="updateOSMOverlay()"
                                  class="w-full"></p-slider>
                    </div>
                </div>
                <p-divider></p-divider>
                <div *ngIf="!mapItems.size" style="margin-top: 0.75em">No maps loaded.</div>
                <div *ngIf="mapItems.size" class="maps-container">
                    <div *ngFor="let mapItem of mapItems | keyvalue" class="map-container">
                        <span class="font-bold white-space-nowrap map-header">
<!--                            <p-checkbox [(ngModel)]="mapItem.value.visible"-->
<!--                                        (ngModelChange)="toggleLayer(mapItem.key, '')"-->
<!--                                        [label]="mapItem.key" [binary]="true"/>-->
                            {{ mapItem.key }}
                        </span>
                        <div *ngFor="let mapLayer of mapItem.value.layers | keyvalue: unordered" class="flex-container">
                            <span class="font-bold white-space-nowrap" style="margin-left: 0.5em">
                                <p-checkbox [(ngModel)]="mapLayer.value.visible"
                                            (ngModelChange)="toggleLayer(mapItem.key, mapLayer.key)"
                                            [label]="mapLayer.key" [binary]="true"/>
                            </span>
                            <div class="layer-controls">
                                <!--                                <p-checkbox [(ngModel)]="gridEnabled" (ngModelChange)="updateGrid()" label="Grid" [value]="true" />-->
                                <p-button (click)="toggleTileBorders(mapItem.key, mapLayer.key)"
                                          label="" pTooltip="Toggle tile borders" tooltipPosition="bottom"
                                          [style]="{'padding-left': '0', 'padding-right': '0'}">
                                    <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">{{ mapLayer.value.tileBorders ? 'select_all' : 'deselect' }}</span>
                                </p-button>
                                <p-button *ngIf="mapLayer.value.coverage[0]"
                                          (click)="focus(mapLayer.value.coverage[0], $event)"
                                          label="" pTooltip="Focus on layer" tooltipPosition="bottom"
                                          [style]="{'padding-left': '0', 'padding-right': '0'}">
                                    <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">loupe</span>
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
                <div *ngIf="!styleService.builtinStylesCount && !styleService.importedStylesCount">
                    No styles loaded.
                </div>
                <div class="styles-container">
                    <div *ngIf="styleService.builtinStylesCount">
                        <div *ngFor="let style of styleService.styleData | keyvalue: unordered">
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
                    <div *ngIf="styleService.importedStylesCount">
                        <div *ngFor="let style of styleService.styleData | keyvalue: unordered">
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
                </div>
                <div *ngIf="styleService.erroredStyleIds.size" class="styles-container">
                    <div *ngFor="let message of styleService.erroredStyleIds | keyvalue: unordered"
                         class="flex-container">
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
        <p-dialog header="Style Editor" [(visible)]="editorDialogVisible" [modal]="false" #editorDialog
                  class="editor-dialog">
            <editor></editor>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                    <p-button (click)="applyEditedStyle()" label="Apply" icon="pi pi-check"
                              [disabled]="!dataWasModified"></p-button>
                    <p-button (click)="closeEditorDialog($event)" [label]='this.dataWasModified ? "Discard" : "Cancel"'
                              icon="pi pi-times"></p-button>
                    <div style="display: flex; flex-direction: column; align-content: center; justify-content: center; color: silver; font-size: medium;">
                        <div>Press <span style="color: grey">Ctrl-S/Cmd-S</span> to save changes</div>
                        <div>Press <span style="color: grey">Esc</span> to quit without saving</div>
                    </div>
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
    savedStyleDataSubscription: Subscription = new Subscription();
    dataWasModified: boolean = false;

    osmEnabled: boolean = true;
    osmOpacityValue: number = 30;

    @ViewChild('styleUploader') styleUploader: FileUpload | undefined;
    @ViewChild('editorDialog') editorDialog: Dialog | undefined;

    constructor(public mapService: MapService,
                private messageService: InfoMessageService,
                public styleService: StyleService,
                public parameterService: ParametersService,
                private sidePanelService: SidePanelService)
    {
        this.parameterService.parameters.subscribe(parameters => {
            this.osmEnabled = parameters.osm;
            this.osmOpacityValue = parameters.osmOpacity;
        });
        this.mapService.maps.subscribe(
            mapItems => this.mapItems = mapItems
        );
        this.sidePanelService.activeSidePanel.subscribe(activePanel => {
            if (activePanel != SidePanelService.MAPS) {
                this.layerDialogVisible = false;
            }
        })
    }

    showLayerDialog() {
        this.layerDialogVisible = !this.layerDialogVisible;
        if (this.layerDialogVisible) {
            this.sidePanelService.activeSidePanel.next(SidePanelService.MAPS);
        }
    }

    focus(tileId: bigint, event: any) {
        event.stopPropagation();
        this.mapService.moveToWgs84PositionTopic.next(
            coreLib.getTilePosition(BigInt(tileId))
        );
    }

    onLayerLevelChanged(event: Event, mapName: string, layerName: string) {
        this.mapService.setMapLayerLevel(mapName, layerName, Number(event.toString()));
    }

    toggleOSMOverlay() {
        this.osmEnabled = !this.osmEnabled;
        this.updateOSMOverlay();
    }

    updateOSMOverlay() {
        const parameters = this.parameterService.parameters.getValue();
        if (parameters) {
            parameters.osm = this.osmEnabled;
            parameters.osmOpacity = this.osmOpacityValue;
            this.parameterService.parameters.next(parameters);
        }
    }

    toggleTileBorders(mapName: string, layerName: string) {
        this.mapService.toggleLayerTileBorderVisibility(mapName, layerName);
    }

    toggleLayer(mapName: string, layerName: string = "") {
        this.mapService.toggleMapLayerVisibility(mapName, layerName);
    }

    toggleStyle(styleId: string) {
        this.styleService.toggleStyle(styleId);
    }

    resetStyle(styleId: string) {
        this.styleService.reloadStyle(styleId);
        this.styleService.toggleStyle(styleId, true);
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
            this.styleService.importStyleYamlFile(event, file, styleId, this.styleUploader)
                .then((ok) => {
                    if (!ok) {
                        this.messageService.showError(`Could not read empty data for: ${styleId}`);
                    }
                })
                .catch((error) => {
                    this.messageService.showError(`Error occurred while trying to import style: ${styleId}`);
                    console.log(error);
                });
        }
    }

    removeStyle(styleId: string) {
        this.styleService.deleteStyle(styleId);
    }

    showStyleEditor(styleId: string) {
        this.styleService.selectedStyleIdForEditing.next(styleId);
        this.editorDialogVisible = true;
        this.editedStyleDataSubscription = this.styleService.styleEditedStateData.subscribe(editedStyleData => {
            const originalStyleData = this.styleService.styleData.get(styleId)?.data!;
            this.dataWasModified = !(editedStyleData.replace(/\n+$/, '') == originalStyleData.replace(/\n+$/, ''));
        });
        this.savedStyleDataSubscription = this.styleService.styleEditedSaveTriggered.subscribe(_ => {
            this.applyEditedStyle();
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
        this.styleService.setStyleData(styleId, styleData);
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
        this.savedStyleDataSubscription.unsubscribe();
    }

    discardStyleEdits() {
        const styleId = this.styleService.selectedStyleIdForEditing.getValue();
        this.styleService.selectedStyleIdForEditing.next(styleId);
        this.warningDialogVisible = false;
    }

    openStyleHelp() {
        window.open( "https://github.com/ndsev/erdblick?tab=readme-ov-file#style-definitions", "_blank");
    }

    unordered(a: KeyValue<string, any>, b: KeyValue<string, any>): number {
        return 0;
    }
}