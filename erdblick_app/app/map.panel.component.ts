import {Component, ViewChild} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {CoverageRectItem, GroupInfoItem, MapInfoItem, MapService} from "./map.service";
import {ErdblickStyle, StyleService} from "./style.service";
import {ParametersService} from "./parameters.service";
import {FileUpload} from "primeng/fileupload";
import {Subscription} from "rxjs";
import {Dialog} from "primeng/dialog";
import {KeyValue} from "@angular/common";
import {coreLib} from "./wasm";
import {SidePanelService, SidePanelState} from "./sidepanel.service";
import {MenuItem, TreeNode} from "primeng/api";
import {Menu} from "primeng/menu";
import {KeyboardService} from "./keyboard.service";
import {EditorService} from "./editor.service";
import {DataSourcesService} from "./datasources.service";
import {InspectionService} from "./inspection.service";


@Component({
    selector: 'map-panel',
    template: `
        <p-dialog #mapLayerDialog class="map-layer-dialog" header="" [(visible)]="layerDialogVisible"
                  [position]="'topleft'" [draggable]="false" [resizable]="false"
                  [style]="{ 'max-height': '100%', 
                  'border-top-left-radius': '0 !important',
                  'border-bottom-left-radius': '0 !important' }">
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
                           (input)="onOsmOpacityInput($event)"
                           (keydown.enter)="updateOSMOverlay()"
                           (blur)="updateOSMOverlay()"
                           class="w-full slider-input" tabindex="0"/>
                    <p-slider [(ngModel)]="osmOpacityValue" (ngModelChange)="updateOSMOverlay()"
                              class="w-full" tabindex="-1">
                    </p-slider>
                </div>
            </div>
            <p-fieldset class="map-tab" legend="Maps and Layers" [toggleable]="true" [(collapsed)]="mapsCollapsed">
                <ng-container *ngIf="mapService.mapGroups | async as mapGroups">
                    <div *ngIf="!mapGroups.size" style="margin-top: 0.75em">
                        No maps loaded.
                    </div>
                    <div *ngIf="mapGroups.size" class="maps-container">
                        <ng-container *ngFor="let group of mapGroups | keyvalue: unordered">
                            <div class="card" *ngIf="group.value.groupId != 'ungrouped'">
                                <p-tree [value]="[group.value]">
                                    <ng-template let-node pTemplate="Group">
                                        <div style="cursor: pointer; display: inline-block"
                                             (click)="$event.stopPropagation(); toggleGroup(node.groupId)">
                                        <span>
                                            <p-checkbox [ngModel]="mapGroupsVisibility.get(node.groupId)![0]"
                                                        (click)="$event.stopPropagation()"
                                                        (ngModelChange)="toggleGroup(node.groupId)"
                                                        [binary]="true"
                                                        [inputId]="node.groupId"
                                                        [name]="node.groupId" tabindex="0"/>
                                            <label [for]="node.groupId" style="margin-left: 0.5em; cursor: pointer">
                                                {{ node.groupId }}
                                            </label>
                                        </span>
                                        </div>
                                    </ng-template>
                                    <ng-template let-node pTemplate="Map">
                                        <p-menu #metadataMenu [model]="metadataMenusEntries.get(node.mapId)"
                                                [popup]="true"
                                                appendTo="body"/>
                                        <div class="flex-container">
                                            <div style="cursor: pointer; display: inline-block" (click)="node.visible = !node.visible; toggleMap(node.mapId)">
                                                <span>
                                                    <p-checkbox [(ngModel)]="node.visible"
                                                                (click)="$event.stopPropagation()"
                                                                (ngModelChange)="toggleMap(node.mapId)"
                                                                [binary]="true"
                                                                [inputId]="node.mapId"
                                                                [name]="node.mapId" tabindex="0"/>
                                                    <label [for]="node.mapId" style="margin-left: 0.5em; cursor: pointer">{{ node.mapId }}</label>
                                                </span>
                                            </div>
                                            <div class="map-controls">
                                                <p-button onEnterClick (click)="metadataMenu.toggle($event)" label=""
                                                          [pTooltip]="!metadataMenusEntries.get(node.mapId)?.length ? 'No metadata available' : 'Request service metadata'"
                                                          tooltipPosition="bottom"
                                                          [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                          tabindex="0"
                                                          [disabled]="!metadataMenusEntries.get(node.mapId)?.length">
                                                    <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">
                                                        data_object
                                                    </span>
                                                </p-button>
                                            </div>
                                        </div>
                                    </ng-template>
                                    <ng-template let-node pTemplate="Features">
                                        <div *ngIf="node.type != 'SourceData'" class="flex-container">
                                            <div class="font-bold white-space-nowrap"
                                                 style="margin-left: 0.5em; display: flex; align-items: center;">
                                <span onEnterClick class="material-icons" style="font-size: 1.5em; cursor: pointer"
                                      tabindex="0"
                                      (click)="showLayersToggleMenu($event, node.mapId, node.layerId)">more_vert</span>
                                                <div style="cursor: pointer; display: inline-block"
                                                     (click)="node.visible = !node.visible; toggleLayer(node.mapId, node.layerId)">
                                            <span>
                                            <p-checkbox [(ngModel)]="node.visible"
                                                        (click)="$event.stopPropagation()"
                                                        (ngModelChange)="toggleLayer(node.mapId, node.layerId)"
                                                        [binary]="true"
                                                        [inputId]="node.layerId"
                                                        [name]="node.layerId" tabindex="0"/>
                                            <label [for]="node.layerId"
                                                   style="margin-left: 0.5em; cursor: pointer">{{ node.layerId }}</label>
                                            </span>
                                                </div>
                                            </div>
                                            <div class="layer-controls">
                                                <p-button onEnterClick
                                                          (click)="toggleTileBorders(node.mapId, node.layerId)"
                                                          label="" pTooltip="Toggle tile borders" tooltipPosition="bottom"
                                                          [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                          tabindex="0">
                                            <span class="material-icons"
                                                  style="font-size: 1.2em; margin: 0 auto;">
                                                {{ node.tileBorders ? 'select_all' : 'deselect' }}
                                            </span>
                                                </p-button>
                                                <p-button onEnterClick *ngIf="node.coverage.length"
                                                          (click)="focus(node.coverage[0], $event)"
                                                          label="" pTooltip="Focus on layer" tooltipPosition="bottom"
                                                          [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                          tabindex="0">
                                                    <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">loupe</span>
                                                </p-button>
                                                <p-inputNumber [(ngModel)]="node.level"
                                                               (ngModelChange)="onLayerLevelChanged($event, node.mapId, node.layerId)"
                                                               [showButtons]="true" [min]="0" [max]="15"
                                                               buttonLayout="horizontal" spinnerMode="horizontal"
                                                               inputId="horizontal"
                                                               decrementButtonClass="p-button-secondary"
                                                               incrementButtonClass="p-button-secondary"
                                                               incrementButtonIcon="pi pi-plus"
                                                               decrementButtonIcon="pi pi-minus"
                                                               pTooltip="Change zoom level" tooltipPosition="bottom"
                                                               tabindex="0">
                                                </p-inputNumber>
                                            </div>
                                            <input class="level-indicator" type="text" pInputText [disabled]="true"
                                                   [(ngModel)]="node.level"/>
                                        </div>
                                    </ng-template>
                                </p-tree>
                            </div>
                        </ng-container>
                        <div class="card" *ngIf="mapGroups.has('ungrouped')">
                            <p-tree [value]="mapGroups.get('ungrouped')?.children">
                                <ng-template let-node pTemplate="Map">
                                    <p-menu #metadataMenu [model]="metadataMenusEntries.get(node.mapId)" [popup]="true"
                                            appendTo="body"/>
                                    <div class="flex-container">
                                        <div style="cursor: pointer; display: inline-block"
                                             (click)="node.visible = !node.visible; toggleMap(node.mapId)">
                                            <span>
                                                <p-checkbox [(ngModel)]="node.visible"
                                                            (click)="$event.stopPropagation()"
                                                            (ngModelChange)="toggleMap(node.mapId)"
                                                            [binary]="true"
                                                            [inputId]="node.mapId"
                                                            [name]="node.mapId" tabindex="0"/>
                                                <label [for]="node.mapId"
                                                       style="margin-left: 0.5em; cursor: pointer">{{ node.mapId }}</label>
                                            </span>
                                        </div>
                                        <div class="map-controls">
                                            <p-button onEnterClick (click)="metadataMenu.toggle($event)" label=""
                                                      [pTooltip]="!metadataMenusEntries.get(node.mapId)?.length ? 'No metadata available' : 'Request service metadata'"
                                                      tooltipPosition="bottom"
                                                      [style]="{'padding-left': '0', 'padding-right': '0'}" tabindex="0"
                                                      [disabled]="!metadataMenusEntries.get(node.mapId)?.length">
                                            <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">
                                                data_object
                                            </span>
                                            </p-button>
                                        </div>
                                    </div>
                                </ng-template>
                                <ng-template let-node pTemplate="Features">
                                    <div *ngIf="node.type != 'SourceData'" class="flex-container">
                                        <div class="font-bold white-space-nowrap"
                                             style="margin-left: 0.5em; display: flex; align-items: center;">
                                <span onEnterClick class="material-icons" style="font-size: 1.5em; cursor: pointer"
                                      tabindex="0"
                                      (click)="showLayersToggleMenu($event, node.mapId, node.layerId)">more_vert</span>
                                            <div style="cursor: pointer; display: inline-block"
                                                 (click)="node.visible = !node.visible; toggleLayer(node.mapId, node.layerId)">
                                            <span>
                                            <p-checkbox [(ngModel)]="node.visible"
                                                        (click)="$event.stopPropagation()"
                                                        (ngModelChange)="toggleLayer(node.mapId, node.layerId)"
                                                        [binary]="true"
                                                        [inputId]="node.layerId"
                                                        [name]="node.layerId" tabindex="0"/>
                                            <label [for]="node.layerId"
                                                   style="margin-left: 0.5em; cursor: pointer">{{ node.layerId }}</label>
                                            </span>
                                            </div>
                                        </div>
                                        <div class="layer-controls">
                                            <p-button onEnterClick
                                                      (click)="toggleTileBorders(node.mapId, node.layerId)"
                                                      label="" pTooltip="Toggle tile borders" tooltipPosition="bottom"
                                                      [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                      tabindex="0">
                                            <span class="material-icons"
                                                  style="font-size: 1.2em; margin: 0 auto;">
                                                {{ node.tileBorders ? 'select_all' : 'deselect' }}
                                            </span>
                                            </p-button>
                                            <p-button onEnterClick *ngIf="node.coverage.length"
                                                      (click)="focus(node.coverage[0], $event)"
                                                      label="" pTooltip="Focus on layer" tooltipPosition="bottom"
                                                      [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                      tabindex="0">
                                                <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">loupe</span>
                                            </p-button>
                                            <p-inputNumber [(ngModel)]="node.level"
                                                           (ngModelChange)="onLayerLevelChanged($event, node.mapId, node.layerId)"
                                                           [showButtons]="true" [min]="0" [max]="15"
                                                           buttonLayout="horizontal" spinnerMode="horizontal"
                                                           inputId="horizontal"
                                                           decrementButtonClass="p-button-secondary"
                                                           incrementButtonClass="p-button-secondary"
                                                           incrementButtonIcon="pi pi-plus"
                                                           decrementButtonIcon="pi pi-minus"
                                                           pTooltip="Change zoom level" tooltipPosition="bottom"
                                                           tabindex="0">
                                            </p-inputNumber>
                                        </div>
                                        <input class="level-indicator" type="text" pInputText [disabled]="true"
                                               [(ngModel)]="node.level"/>
                                    </div>
                                </ng-template>
                            </p-tree>
                        </div>
                    </div>
                </ng-container>
            </p-fieldset>
            <p-fieldset class="map-tab" legend="Styles" [toggleable]="true" [(collapsed)]="stylesCollapsed">
                <div *ngIf="!styleService.builtinStylesCount && !styleService.importedStylesCount">
                    No styles loaded.
                </div>
                <div class="styles-container">
                    <div *ngFor="let style of styleService.styles | keyvalue: unordered">
                        <p-tree [value]="[style.value]">
                            <ng-template let-node pTemplate="Style">
                                <div class="flex-container">
                                    <div class="font-bold white-space-nowrap" style="margin-left: 0.5em; display: flex; align-items: center;">
                                        <span onEnterClick class="material-icons"
                                              style="font-size: 1.5em; cursor: pointer"
                                              (click)="showStylesToggleMenu($event, node.id)" tabindex="0">
                                            more_vert
                                        </span>
                                        <div onEnterClick style="cursor: pointer; display: inline-block"
                                             (click)="node.params.visible = !node.params.visible; applyStyleConfig(node)"
                                             tabindex="0">
                                        <span>
                                            <p-checkbox [(ngModel)]="node.params.visible"
                                                        (click)="$event.stopPropagation()"
                                                        (ngModelChange)="applyStyleConfig(node)"
                                                        [binary]="true"
                                                        [inputId]="node.id"
                                                        [name]="node.id"/>
                                            <label [for]="node.id"
                                                   style="margin-left: 0.5em; cursor: pointer">{{ node.id }}</label>
                                        </span>
                                        </div>
                                    </div>
                                    <div class="layer-controls style-controls">
                                        <p-button onEnterClick *ngIf="node.imported" (click)="removeStyle(node.id)"
                                                  icon="pi pi-trash"
                                                  label="" pTooltip="Remove style"
                                                  tooltipPosition="bottom" tabindex="0">
                                        </p-button>
                                        <p-button onEnterClick *ngIf="!node.imported" (click)="resetStyle(node.id)"
                                                  icon="pi pi-refresh"
                                                  label="" pTooltip="Reload style from storage"
                                                  tooltipPosition="bottom" tabindex="0">
                                        </p-button>
                                        <p-button onEnterClick (click)="showStyleEditor(node.id)"
                                                  icon="pi pi-file-edit"
                                                  label="" pTooltip="Edit style"
                                                  tooltipPosition="bottom" tabindex="0">
                                        </p-button>
                                    </div>
                                </div>
                            </ng-template>
                            <ng-template let-node pTemplate="Bool">
                                <span onEnterClick class="material-icons"
                                      style="font-size: 1.5em; cursor: pointer"
                                      (click)="showOptionsToggleMenu($event, style.value, node.id)"
                                      [ngClass]="{'disabled': !style.value.params.visible}" tabindex="0">
                                    more_vert
                                </span>
                                <div style="font-style: oblique; cursor: pointer; display: inline-block"
                                     (click)="style.value.params.options[node.id] = style.value.params.options[node.id]; applyStyleConfig(style.value)"
                                     [ngClass]="{'disabled': style.value.params.visible}" tabindex="0">
                                    <span style="font-style: oblique">
                                        <p-checkbox [(ngModel)]="style.value.params.options[node.id]"
                                                    (ngModelChange)="applyStyleConfig(style.value)"
                                                    [binary]="true"
                                                    [inputId]="style.value.id + '_' + node.id"
                                                    [name]="style.value.id + '_' + node.id"/>
                                        <label [for]="style.value.id + '_' + node.id"
                                               style="margin-left: 0.5em; cursor: pointer">{{ node.label }}</label>
                                    </span>
                                </div>
                            </ng-template>
                        </p-tree>
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
                                      chooseLabel="Import Style" tabindex="0"/>
                    </div>
                </div>
            </p-fieldset>
        </p-dialog>
        <p-menu #menu [model]="toggleMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <p-button onEnterClick (click)="showLayerDialog()" label="" class="layers-button"
                  tooltipPosition="right" pTooltip="{{layerDialogVisible ? 'Hide map layers' : 'Show map layers'}}"
                  icon="{{layerDialogVisible ? 'pi pi-times' : 'pi pi-images'}}" tabindex="0">
        </p-button>
        <pref-components></pref-components>
        <p-dialog header="Style Editor" [(visible)]="editorService.styleEditorVisible" [modal]="false" #editorDialog
                  class="editor-dialog">
            <editor></editor>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; justify-content: space-between;">
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                    <p-button (click)="applyEditedStyle()" label="Apply" icon="pi pi-check"
                              [disabled]="!sourceWasModified"></p-button>
                    <p-button (click)="closeEditorDialog($event)"
                              [label]='sourceWasModified ? "Discard" : "Cancel"'
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
    editedStyleSourceSubscription: Subscription = new Subscription();
    savedStyleSourceSubscription: Subscription = new Subscription();
    sourceWasModified: boolean = false;
    mapsCollapsed: boolean = false;
    stylesCollapsed: boolean = false;

    osmEnabled: boolean = true;
    osmOpacityValue: number = 30;

    @ViewChild('menu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('styleUploader') styleUploader: FileUpload | undefined;
    @ViewChild('editorDialog') editorDialog: Dialog | undefined;
    @ViewChild('mapLayerDialog') mapLayerDialog: Dialog | undefined;

    mapGroupsVisibility: Map<string, [boolean, boolean]> = new Map<string, [boolean, boolean]>();
    metadataMenusEntries: Map<string, {label: string, command: () => void }[]> = new Map();

    // Trees
    mapsTree: TreeNode[] = [];
    mapsSelection: TreeNode[] = [];
    private prevMapsSelectionKeys: Set<string> = new Set<string>();

    stylesTree: TreeNode[] = [];
    stylesSelection: TreeNode[] = [];
    private prevStylesSelectionKeys: Set<string> = new Set<string>();

    constructor(public mapService: MapService,
                private messageService: InfoMessageService,
                public styleService: StyleService,
                public parameterService: ParametersService,
                public keyboardService: KeyboardService,
                public editorService: EditorService,
                public dsService: DataSourcesService,
                private inspectionService: InspectionService,
                private sidePanelService: SidePanelService) {
        this.keyboardService.registerShortcut('m', this.showLayerDialog.bind(this), true);

        this.parameterService.parameters.subscribe(parameters => {
            this.osmEnabled = parameters.osm;
            this.osmOpacityValue = parameters.osmOpacity;
        });
        // TODO: Use parameter service to store the state of the groups?
        this.mapService.mapGroups.subscribe(mapGroups => {
            for (const [groupId, group] of mapGroups.entries()) {
                if (groupId !== "ungrouped") {
                    const groupVisibility = group.children.some(mapItem => mapItem.visible);
                    const mapsVisibility = group.children.every(mapItem => mapItem.visible);
                    this.mapGroupsVisibility.set(groupId, [groupVisibility, mapsVisibility]);
                }
                group.children.forEach(mapItem => this.metadataMenusEntries.set(
                    mapItem.mapId,
                    this.inspectionService.findLayersForMapId(mapItem.mapId, true)
                        .map(layer => {
                            return {
                                label: layer.name,
                                command: () =>
                                    this.inspectionService.loadSourceDataInspectionForService(mapItem.mapId, layer.id)
                            }
                    })
                ));

                // If all layers were pruned (complete maps config change), reinitialize default maps
                if (this.parameterService.pruneMapLayerConfig(group.children)) {
                    this.mapService.processMapsUpdate();
                }
            }
        });
        this.sidePanelService.observable().subscribe(activePanel => {
            if (activePanel !== SidePanelState.MAPS && activePanel !== SidePanelState.SEARCH) {
                this.layerDialogVisible = false;
            }
        });
        this.editorService.editedSaveTriggered.subscribe(_ => this.applyEditedStyle());
    }

    get osmOpacityString(): string {
        return 'Opacity: ' + this.osmOpacityValue;
    }

    set osmOpacityString(value: string) {
        const match = value.match(/(\d+(?:\.\d+)?)/);
        if (match) {
            const numValue = parseFloat(match[1]);
            if (!isNaN(numValue) && numValue >= 0 && numValue <= 100) {
                this.osmOpacityValue = numValue;
            }
        }
    }

    onOsmOpacityInput(event: any) {
        const inputElement = event.target as HTMLInputElement;
        const value = inputElement.value;

        // Extract only numerical characters and decimal points
        const numericalOnly = value.replace(/[^0-9.]/g, '');
        let numValue = parseFloat(numericalOnly);

        // Validate and clamp the value
        if (isNaN(numValue) || numValue < 0) {
            numValue = 0;
        } else if (numValue > 100) {
            numValue = 100;
        }

        this.osmOpacityValue = numValue;
        // Always show "Opacity: X"
        const formattedValue = 'Opacity: ' + numValue;
        if (inputElement.value !== formattedValue) {
            inputElement.value = formattedValue;
            inputElement.dispatchEvent(new Event('input'));
        }

        this.updateOSMOverlay();
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
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, id != optionId);
                    }
                    this.applyStyleConfig(style);
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, false);
                    }
                    this.applyStyleConfig(style);
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    for (const id in style.params.options) {
                        this.styleService.toggleOption(style.id, id, true);
                    }
                    this.applyStyleConfig(style);
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
                    if (this.mapService.maps.getValue().has(mapName)) {
                        for (const id of this.mapService.maps.getValue().get(mapName)!.layers.keys()!) {
                            this.mapService.maps.getValue().get(mapName)!.layers.get(id)!.visible = id == layerName;
                            this.toggleLayer(mapName, layerName);
                        }
                    }
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    if (this.mapService.maps.getValue().has(mapName)) {
                        for (const id of this.mapService.maps.getValue().get(mapName)!.layers.keys()!) {
                            this.mapService.maps.getValue().get(mapName)!.layers.get(id)!.visible = id != layerName;
                            this.toggleLayer(mapName, layerName);
                        }
                    }
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    if (this.mapService.maps.getValue().has(mapName)) {
                        for (const id of this.mapService.maps.getValue().get(mapName)!.layers.keys()!) {
                            this.mapService.maps.getValue().get(mapName)!.layers.get(id)!.visible = false;
                            this.toggleLayer(mapName, layerName);
                        }
                    }
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    if (this.mapService.maps.getValue().has(mapName)) {
                        for (const id of this.mapService.maps.getValue().get(mapName)!.layers.keys()!) {
                            this.mapService.maps.getValue().get(mapName)!.layers.get(id)!.visible = true;
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

    focus(coverage: number | CoverageRectItem, event?: any) {
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
        this.updateGroupVisibilityForMap(mapName);
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

    removePrefix(mapId: string) {
        if (mapId.includes('/')) {
            const mapIdParts = mapId.split('/');
            return mapIdParts.slice(1).join('/');
        }
        return mapId;
    }

    toggleMap(mapId: string, groupId: string = "") {
        if (!mapId) {
            return;
        }
        if (groupId && groupId !== "ungrouped") {
            const state = this.mapGroupsVisibility.has(groupId) && this.mapGroupsVisibility.get(groupId)![0];
            this.mapService.toggleMapLayerVisibility(mapId, "", state)
            return;
        }
        this.mapService.toggleMapLayerVisibility(mapId);
        this.updateGroupVisibilityForMap(mapId);
    }

    toggleGroup(groupId: string) {
        if (!groupId || groupId === 'ungrouped') {
            return;
        }
        if (!this.mapGroupsVisibility.has(groupId)) {
            return;
        }
        if (!this.mapService.mapGroups.getValue().has(groupId)) {
            return;
        }
        const currentState = this.mapGroupsVisibility.get(groupId)!;
        currentState[0] = !currentState[0];
        this.mapGroupsVisibility.set(groupId, [currentState[0], currentState[0]]);
        this.mapService.mapGroups.getValue().get(groupId)!.children.forEach(mapItem => {
            this.toggleMap(mapItem.mapId, groupId);
        });
    }

    private updateGroupVisibilityForMap(mapId: string) {
        if (mapId.includes('/')) {
            const groupId = mapId.split('/')[0];
            if (this.mapService.mapGroups.getValue().has(groupId)) {
                const mapItems = this.mapService.mapGroups.getValue().get(groupId)!.children;
                const groupVisibility = mapItems.some(mapItem => mapItem.visible);
                const mapsVisibility = mapItems.every(mapItem => mapItem.visible);
                this.mapGroupsVisibility.set(groupId, [groupVisibility, mapsVisibility]);
            }
        }
    }
}
