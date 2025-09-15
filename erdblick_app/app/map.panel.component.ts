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
                                    </ng-template>
                                    <ng-template let-node pTemplate="Map">
                                        <p-menu #metadataMenu [model]="metadataMenusEntries.get(node.mapId)" [popup]="true"
                                                appendTo="body"/>
                                        <div class="flex-container">
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
                                                  tabindex="0" (click)="showLayersToggleMenu($event, node.mapId, node.layerId)">
                                                more_vert
                                            </span>
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
                                                  tabindex="0" (click)="showLayersToggleMenu($event, node.mapId, node.layerId)">
                                                more_vert
                                            </span>
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
            <style-panel></style-panel>
        </p-dialog>
        <p-menu #menu [model]="toggleMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <p-button onEnterClick (click)="showLayerDialog()" label="" class="layers-button"
                  tooltipPosition="right" pTooltip="{{layerDialogVisible ? 'Hide map layers' : 'Show map layers'}}"
                  icon="{{layerDialogVisible ? 'pi pi-times' : 'pi pi-images'}}" tabindex="0">
        </p-button>
        <pref-components></pref-components>
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
    mapsCollapsed: boolean = false;

    osmEnabled: boolean = true;
    osmOpacityValue: number = 30;

    @ViewChild('menu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('mapLayerDialog') mapLayerDialog: Dialog | undefined;

    mapGroupsVisibility: Map<string, [boolean, boolean]> = new Map<string, [boolean, boolean]>();
    metadataMenusEntries: Map<string, {label: string, command: () => void }[]> = new Map();

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
            for (const [groupId, group] of mapGroups) {
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
