import {Component, ViewChild} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {CoverageRectItem, MapInfoItem, MapService} from "./map.service";
import {ErdblickStyle, StyleService} from "./style.service";
import {ParametersService} from "./parameters.service";
import {FileUpload} from "primeng/fileupload";
import {Subscription} from "rxjs";
import {Dialog} from "primeng/dialog";
import {KeyValue} from "@angular/common";
import {coreLib} from "./wasm";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {MenuItem} from "primeng/api";
import {Menu} from "primeng/menu";
import {KeyboardService} from "./keyboard.service";
import {EditorService} from "./editor.service";
import {DataSourcesService} from "./datasources.service";


@Component({
    selector: 'map-panel',
    template: `
        <p-dialog #mapLayerDialog class="map-layer-dialog" header="" [(visible)]="layerDialogVisible"
                  [position]="'topleft'" [draggable]="false" [resizable]="false">
            <p-fieldset class="map-tab" legend="Maps and Layers">
                <div class="osm-controls">
                    <p-button onEnterClick (click)="openDatasources()" class="osm-button"
                              icon="pi pi-server" label="" pTooltip="Open datasources configuration"
                              tooltipPosition="bottom" tabindex="0">
                    </p-button>
                    <p-divider layout="vertical" styleClass="hidden md:flex"></p-divider>
                    <span style="font-size: 0.9em">OSM Overlay:</span>
                    <p-button onEnterClick (click)="toggleOSMOverlay()" class="osm-button"
                              icon="{{osmEnabled ? 'pi pi-eye' : 'pi pi-eye-slash'}}"
                              label="" pTooltip="Toggle OSM overlay" tooltipPosition="bottom" tabindex="0">
                    </p-button>
                    <div *ngIf="osmEnabled" style="display: inline-block">
                        <input type="text" pInputText [(ngModel)]="osmOpacityString"
                               class="w-full slider-input" tabindex="0"/>
                        <p-slider [(ngModel)]="osmOpacityValue" (ngModelChange)="updateOSMOverlay()"
                                  class="w-full" tabindex="-1">
                        </p-slider>
                    </div>
                </div>
                <p-divider></p-divider>

                <div *ngIf="!mapItems.size" style="margin-top: 0.75em">No maps loaded.</div>
                <div *ngIf="mapItems.size" class="maps-container">
                    <div *ngFor="let mapItem of mapItems | keyvalue" class="map-container">
                        <span class="font-bold white-space-nowrap map-header">
                            {{ mapItem.key }}
                        </span>
                        <div *ngFor="let mapLayer of mapItem.value.layers | keyvalue: unordered">
                            <div *ngIf="mapLayer.value.type != 'SourceData'" class="flex-container">
                                <div class="font-bold white-space-nowrap"
                                    style="margin-left: 0.5em; display: flex; align-items: center;">
                                    <span onEnterClick class="material-icons" style="font-size: 1.5em; cursor: pointer"
                                      tabindex="0"
                                        (click)="showLayersToggleMenu($event, mapItem.key, mapLayer.key)">more_vert</span>
                                    <div style="cursor: pointer; display: inline-block" (click)="mapLayer.value.visible = !mapLayer.value.visible; toggleLayer(mapItem.key, mapLayer.key)">
                                        <span>
                                            <p-checkbox [(ngModel)]="mapLayer.value.visible"
                                                        (ngModelChange)="toggleLayer(mapItem.key, mapLayer.key)"
                                                        [binary]="true"
                                                        [inputId]="mapLayer.key" 
                                                        [name]="mapLayer.key" tabindex="0"/>
                                            <label [for]="mapLayer.key" style="margin-left: 0.5em; cursor: pointer">{{mapLayer.key}}</label>
                                        </span>
                                    </div>
                                </div>
                                <div class="layer-controls">
                                    <p-button onEnterClick (click)="toggleTileBorders(mapItem.key, mapLayer.key)"
                                            label="" pTooltip="Toggle tile borders" tooltipPosition="bottom"
                                            [style]="{'padding-left': '0', 'padding-right': '0'}" tabindex="0">
                                        <span class="material-icons"
                                            style="font-size: 1.2em; margin: 0 auto;">{{ mapLayer.value.tileBorders ? 'select_all' : 'deselect' }}</span>
                                    </p-button>
                                    <p-button onEnterClick *ngIf="mapLayer.value.coverage.length"
                                            (click)="focus(mapLayer.value.coverage[0], $event)"
                                            label="" pTooltip="Focus on layer" tooltipPosition="bottom"
                                            [style]="{'padding-left': '0', 'padding-right': '0'}" tabindex="0">
                                        <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">loupe</span>
                                    </p-button>
                                    <p-inputNumber [(ngModel)]="mapLayer.value.level"
                                                (ngModelChange)="onLayerLevelChanged($event, mapItem.key, mapLayer.key)"
                                                [showButtons]="true" [min]="0" [max]="15"
                                                buttonLayout="horizontal" spinnerMode="horizontal" inputId="horizontal"
                                                decrementButtonClass="p-button-secondary"
                                                incrementButtonClass="p-button-secondary"
                                                incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus"
                                                pTooltip="Change zoom level" tooltipPosition="bottom" tabindex="0">
                                    </p-inputNumber>
                                </div>
                                <input class="level-indicator" type="text" pInputText [disabled]="true"
                                   [(ngModel)]="mapLayer.value.level"/>
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
                    <div *ngFor="let style of styleService.styles | keyvalue: unordered">
                        <div class="flex-container">
                            <div class="font-bold white-space-nowrap"
                                 style="margin-left: 0.5em; display: flex; align-items: center;">
                                <span onEnterClick *ngIf="style.value.options.length" class="material-icons"
                                      [ngClass]="{'rotated-icon': !style.value.params.showOptions || !style.value.params.visible, 
                                                  'disabled': !style.value.params.visible}"
                                      style="font-size: 1.5em; margin-left: -0.75em; margin-right: -0.25em; cursor: pointer"
                                      (click)="expandStyle(style.key)" tabindex="0">
                                    expand_more
                                </span>
                                <span onEnterClick class="material-icons"
                                      style="font-size: 1.5em; cursor: pointer"
                                      (click)="showStylesToggleMenu($event, style.key)" tabindex="0">
                                    more_vert
                                </span>
                                <div onEnterClick style="cursor: pointer; display: inline-block" 
                                     (click)="style.value.params.visible = !style.value.params.visible; applyStyleConfig(style.value)" tabindex="0">
                                    <span>
                                        <p-checkbox [(ngModel)]="style.value.params.visible"
                                                    (ngModelChange)="applyStyleConfig(style.value)" 
                                                    [binary]="true"
                                                    [inputId]="style.key" 
                                                    [name]="style.key" />
                                        <label [for]="style.key" style="margin-left: 0.5em; cursor: pointer">{{style.key}}</label>
                                    </span>
                                </div>
                            </div>
                            <div class="layer-controls style-controls">
                                <p-button onEnterClick *ngIf="style.value.imported" (click)="removeStyle(style.key)"
                                          icon="pi pi-trash"
                                          label="" pTooltip="Remove style"
                                          tooltipPosition="bottom" tabindex="0">
                                </p-button>
                                <p-button onEnterClick *ngIf="!style.value.imported" (click)="resetStyle(style.key)"
                                          icon="pi pi-refresh"
                                          label="" pTooltip="Reload style from disk"
                                          tooltipPosition="bottom" tabindex="0">
                                </p-button>
                                <p-button onEnterClick (click)="showStyleEditor(style.key)"
                                          icon="pi pi-file-edit"
                                          label="" pTooltip="Edit style"
                                          tooltipPosition="bottom" tabindex="0">
                                </p-button>
                            </div>
                        </div>
                        <div *ngIf="style.value.options.length && style.value.params.showOptions && style.value.params.visible">
                            <div *ngFor="let option of style.value.options"
                                 style="margin-left: 2.25em; align-items: center; font-size: 0.9em; margin-top: 0.25em">
                                <span onEnterClick class="material-icons"
                                      style="font-size: 1.5em; cursor: pointer"
                                      (click)="showOptionsToggleMenu($event, style.value, option.id)" tabindex="0">
                                    more_vert
                                </span>
                                <div style="font-style: oblique; cursor: pointer; display: inline-block" 
                                     (click)="style.value.params.options[option.id] = !style.value.params.options[option.id]; applyStyleConfig(style.value)" tabindex="0">
                                    <span style="font-style: oblique">
                                        <p-checkbox [(ngModel)]="style.value.params.options[option.id]"
                                                    (ngModelChange)="applyStyleConfig(style.value)" 
                                                    [binary]="true"
                                                    [inputId]="'option_' + style.key + '_' + option.id" 
                                                    [name]="option.id" />
                                        <label [for]="style.key + option.id" style="margin-left: 0.5em; cursor: pointer">{{option.label}}</label>
                                    </span>
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
                    <div class="styles-import">
                        <p-fileupload #styleUploader onEnterClick mode="basic" name="demo[]" chooseIcon="pi pi-upload"
                            accept=".yaml" maxFileSize="1048576" fileLimit="1" multiple="false"
                            customUpload="true" (uploadHandler)="importStyle($event)" [auto]="true"
                            class="import-dialog" pTooltip="Import style" tooltipPosition="bottom"
                            chooseLabel="Import Style" tabindex="0" />
                    </div>
                </div>
            </p-fieldset>
        </p-dialog>
        <p-menu #menu [model]="toggleMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <p-button onEnterClick (click)="showLayerDialog()" label="" class="layers-button" tooltipPosition="right"
                  pTooltip="{{layerDialogVisible ? 'Hide map layers' : 'Show map layers'}}"
                  icon="{{layerDialogVisible ? 'pi pi-times' : 'pi pi-images'}}" tabindex="0">
        </p-button>
        <p-dialog header="Style Editor" [(visible)]="editorService.styleEditorVisible" [modal]="false" #editorDialog
                  class="editor-dialog">
            <editor></editor>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                    <p-button (click)="applyEditedStyle()" label="Apply" icon="pi pi-check"
                              [disabled]="!sourceWasModified"></p-button>
                    <p-button (click)="closeEditorDialog($event)"
                              [label]='this.sourceWasModified ? "Discard" : "Cancel"'
                              icon="pi pi-times"></p-button>
                    <div style="display: flex; flex-direction: column; align-content: center; justify-content: center; color: silver; width: 18em; font-size: 1em;">
                        <div>Press <span style="color: grey">Ctrl-S/Cmd-S</span> to save changes</div>
                        <div>Press <span style="color: grey">Esc</span> to quit without saving</div>
                    </div>
                </div>
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                    <p-button (click)="exportStyle(styleService.selectedStyleIdForEditing)"
                              [disabled]="sourceWasModified" label="Export" icon="pi pi-file-export"
                              [style]="{margin: '0 0.5em'}">
                    </p-button>
                    <p-button (click)="openStyleHelp()" label="Help" icon="pi pi-book"></p-button>
                </div>
            </div>
        </p-dialog>
        <p-dialog header="Warning!" [(visible)]="warningDialogVisible" [modal]="true" #warningDialog>
            <p>You have already edited the style data. Do you really want to discard the changes?</p>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="discardStyleEdits()" label="Yes"></p-button>
                <p-button (click)="warningDialog.close($event)" label="No"></p-button>
            </div>
        </p-dialog>
        <datasources></datasources>
    `,
    styles: [`
        .disabled {
            pointer-events: none;
            opacity: 0.5;
        }
    `],
    standalone: false
})
export class MapPanelComponent {
    layerDialogVisible: boolean = false;
    warningDialogVisible: boolean = false;
    mapItems: Map<string, MapInfoItem> = new Map<string, MapInfoItem>();
    editedStyleSourceSubscription: Subscription = new Subscription();
    savedStyleSourceSubscription: Subscription = new Subscription();
    sourceWasModified: boolean = false;

    osmEnabled: boolean = true;
    osmOpacityValue: number = 30;

    @ViewChild('menu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('styleUploader') styleUploader: FileUpload | undefined;
    @ViewChild('editorDialog') editorDialog: Dialog | undefined;
    @ViewChild('mapLayerDialog') mapLayerDialog: Dialog | undefined;

    constructor(public mapService: MapService,
                private messageService: InfoMessageService,
                public styleService: StyleService,
                public parameterService: ParametersService,
                public keyboardService: KeyboardService,
                public editorService: EditorService,
                public dsService: DataSourcesService,
                private sidePanelService: SidePanelService) {
        this.keyboardService.registerShortcut('m', this.showLayerDialog.bind(this), true);

        this.parameterService.parameters.subscribe(parameters => {
            this.osmEnabled = parameters.osm;
            this.osmOpacityValue = parameters.osmOpacity;
        });
        this.mapService.maps.subscribe(
            mapItems => this.mapItems = mapItems
        );
        this.sidePanelService.observable().subscribe(activePanel => {
            if (activePanel != SidePanelState.MAPS) {
                this.layerDialogVisible = false;
            }
        });
        this.editorService.editedSaveTriggered.subscribe(_ => this.applyEditedStyle());
    }

    get osmOpacityString(): string {
        return 'Opacity: ' + this.osmOpacityValue;
    }

    // TODO: Refactor these into a generic solution
    showOptionsToggleMenu(event: MouseEvent, style: ErdblickStyle, optionId: string) {
        this.toggleMenu.toggle(event);
        this.toggleMenuItems = [
            {
                label: 'Toggle All off but This',
                command: () => {
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, id == optionId);
                    }
                    this.applyStyleConfig(style);
                    // this.mapService.update();
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, id != optionId);
                    }
                    this.applyStyleConfig(style);
                    // this.mapService.update();
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, false);
                    }
                    this.applyStyleConfig(style);
                    // this.mapService.update();
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, true);
                    }
                    this.applyStyleConfig(style);
                    // this.mapService.update();
                }
            }
        ];
    }

    showStylesToggleMenu(event: MouseEvent, styleId: string) {
        this.toggleMenu.toggle(event);
        this.toggleMenuItems = [
            {
                label: 'Toggle All off but This',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, styleId == id, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.update().then();
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, styleId != id, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.update().then();
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, false, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.update().then();
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    for (const id of this.styleService.styles.keys()) {
                        this.styleService.toggleStyle(id, true, true);
                    }
                    this.styleService.reapplyAllStyles();
                    this.mapService.update().then();
                }
            }
        ];
    }

    showLayersToggleMenu(event: MouseEvent, mapName: string, layerName: string) {
        this.toggleMenu.toggle(event);
        this.toggleMenuItems = [
            {
                label: 'Toggle All off but This',
                command: () => {
                    if (this.mapItems.has(mapName)) {
                        for (const id of this.mapItems.get(mapName)!.layers.keys()!) {
                            this.mapItems.get(mapName)!.layers.get(id)!.visible = id == layerName;
                            this.toggleLayer(mapName, layerName);
                        }
                    }
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    if (this.mapItems.has(mapName)) {
                        for (const id of this.mapItems.get(mapName)!.layers.keys()!) {
                            this.mapItems.get(mapName)!.layers.get(id)!.visible = id != layerName;
                            this.toggleLayer(mapName, layerName);
                        }
                    }
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    if (this.mapItems.has(mapName)) {
                        for (const id of this.mapItems.get(mapName)!.layers.keys()!) {
                            this.mapItems.get(mapName)!.layers.get(id)!.visible = false;
                            this.toggleLayer(mapName, layerName);
                        }
                    }
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    if (this.mapItems.has(mapName)) {
                        for (const id of this.mapItems.get(mapName)!.layers.keys()!) {
                            this.mapItems.get(mapName)!.layers.get(id)!.visible = true;
                            this.toggleLayer(mapName, layerName);
                        }
                    }
                }
            }
        ];
    }

    showLayerDialog() {
        this.layerDialogVisible = !this.layerDialogVisible;
        if (this.layerDialogVisible) {
            this.sidePanelService.panel = SidePanelState.MAPS;
        }
    }

    focus(coverage: number|CoverageRectItem, event?: any) {
        event?.stopPropagation();
        if (coverage.hasOwnProperty("min") && coverage.hasOwnProperty("max")) {
            let coverageStruct = coverage as CoverageRectItem;
            let minPos = coreLib.getTilePosition(BigInt(coverageStruct.min));
            let maxPos = coreLib.getTilePosition(BigInt(coverageStruct.max));
            this.mapService.moveToWgs84PositionTopic.next(
                {x: (minPos.x + maxPos.x) * .5, y: (minPos.y + maxPos.y) * .5}
            );
        }
        else {
            const position = coreLib.getTilePosition(BigInt(coverage as number));
            this.mapService.moveToWgs84PositionTopic.next(
                {x: position.x, y: position.y}
            );
        }
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

    expandStyle(styleId: string) {
        const style = this.styleService.styles.get(styleId)!;
        style.params.showOptions = !style.params.showOptions;
        this.applyStyleConfig(style, false);
    }

    applyStyleConfig(style: ErdblickStyle, redraw: boolean=true) {
        if (redraw) {
            this.styleService.reapplyStyle(style.id);
        }
        this.parameterService.setStyleConfig(style.id, style.params);
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
                    console.error(error);
                });
        }
    }

    removeStyle(styleId: string) {
        this.styleService.deleteStyle(styleId);
    }

    showStyleEditor(styleId: string) {
        this.styleService.selectedStyleIdForEditing = styleId;
        this.editorService.datasourcesEditorVisible = false;
        this.editorService.editableData = `${this.styleService.styles.get(styleId)?.source!}\n\n\n\n\n`
        this.editorService.readOnly = false;
        this.editorService.updateEditorState.next(true);
        this.editorService.styleEditorVisible = true;
        this.editedStyleSourceSubscription = this.editorService.editedStateData.subscribe(editedStyleSource => {
            this.sourceWasModified = !(editedStyleSource.replace(/\n+$/, '') == this.editorService.editableData.replace(/\n+$/, ''));
        });
        this.savedStyleSourceSubscription = this.styleService.styleEditedSaveTriggered.subscribe(_ => {
            this.applyEditedStyle();
        });
    }

    applyEditedStyle() {
        const styleId = this.styleService.selectedStyleIdForEditing;
        this.editorService.editableData = this.editorService.editedStateData.getValue();
        const styleData = this.editorService.editedStateData.getValue().replace(/\n+$/, '');
        if (!styleId) {
            this.messageService.showError(`No cached style ID found!`);
            return;
        }
        if (!styleData) {
            this.messageService.showError(`Cannot apply an empty style definition to style: ${styleId}!`);
            return;
        }
        if (!this.styleService.styles.has(styleId)) {
            this.messageService.showError(`Could not apply changes to style: ${styleId}. Failed to access!`)
            return;
        }
        this.styleService.setStyleSource(styleId, styleData);
        this.sourceWasModified = false;
    }

    closeEditorDialog(event: any) {
        if (this.editorDialog !== undefined) {
            if (this.sourceWasModified) {
                event.stopPropagation();
                this.warningDialogVisible = true;
            } else {
                this.warningDialogVisible = false;
                this.editorDialog.close(event);
            }
        }
        this.editedStyleSourceSubscription.unsubscribe();
        this.savedStyleSourceSubscription.unsubscribe();
    }

    discardStyleEdits() {
        this.editorService.updateEditorState.next(false);
        this.warningDialogVisible = false;
    }

    openStyleHelp() {
        window.open( "https://github.com/ndsev/erdblick?tab=readme-ov-file#style-definitions", "_blank");
    }

    unordered(a: KeyValue<string, any>, b: KeyValue<string, any>): number {
        return 0;
    }

    openDatasources() {
        this.editorService.styleEditorVisible = false;
        this.editorService.datasourcesEditorVisible = true;
    }
}
