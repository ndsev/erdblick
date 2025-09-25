import {Component, ViewChild} from "@angular/core";
import {CoverageRectItem, MapService, removeGroupPrefix, MapInfoItem} from "./map.service";
import {AppStateService} from "../shared/appstate.service";
import {Dialog} from "primeng/dialog";
import {KeyValue} from "@angular/common";
import {coreLib} from "../integrations/wasm";
import {SidePanelService, SidePanelState} from "../shared/sidepanel.service";
import {MenuItem} from "primeng/api";
import {Menu} from "primeng/menu";
import {KeyboardService} from "../shared/keyboard.service";
import {EditorService} from "../shared/editor.service";
import {InspectionService} from "../inspection/inspection.service";
import {AppModeService} from "../shared/app-mode.service";


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
                                            <p-checkbox [ngModel]="isGroupAnyVisible(node)"
                                                        (click)="$event.stopPropagation()"
                                                        (ngModelChange)="toggleGroup(node.groupId)"
                                                        [binary]="true"
                                                        [inputId]="node.groupId"
                                                        [name]="node.groupId" tabindex="0"/>
                                            <label [for]="node.groupId" style="margin-left: 0.5em; cursor: pointer">
                                                {{ removeGroupPrefix(node.groupId) }}
                                            </label>
                                        </span>
                                    </ng-template>
                                    <ng-template let-node pTemplate="Map">
                                        <p-menu #metadataMenu [model]="metadataMenusEntries.get(node.mapId)"
                                                [popup]="true"
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
                                                   style="margin-left: 0.5em; cursor: pointer">{{ removeGroupPrefix(node.mapId) }}</label>
                                        </span>
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
                                                 style="display: flex; align-items: center;">
                                                <span onEnterClick class="material-icons menu-toggler" tabindex="0"
                                                      (click)="showLayersToggleMenu($event, node.mapId, node.layerId)">
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
                                                          label="" pTooltip="Toggle tile borders"
                                                          tooltipPosition="bottom"
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
                                                    <span class="material-icons"
                                                          style="font-size: 1.2em; margin: 0 auto;">loupe</span>
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
                                            <span onEnterClick class="material-icons menu-toggler"
                                                  tabindex="0"
                                                  (click)="showLayersToggleMenu($event, node.mapId, node.layerId)">
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
        <div class="main-button-controls" (mouseleave)="isMainButtonHovered = false"
             [ngClass]="{'hovered': isMainButtonHovered}">
            <p-button onEnterClick class="layers-button" (mouseenter)="isMainButtonHovered = true"
                      (click)="isMainButtonHovered = false; showLayerDialog()"
                      tooltipPosition="right" pTooltip="{{layerDialogVisible ? 'Hide map layers' : 'Show map layers'}}"
                      label="" tabindex="0">
                <span *ngIf="!layerDialogVisible" class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
                    stacks
                </span>
                <span *ngIf="layerDialogVisible" class="material-icons" style="font-size: 1.2em; margin: 0 auto;">
                    close
                </span>
            </p-button>
            <div class="pref-buttons" *ngIf="!appModeService.isVisualizationOnly">
                <pref-components *ngIf="!appModeService.isVisualizationOnly"></pref-components>
            </div>
        </div>
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
    isMainButtonHovered: boolean = false;
    layerDialogVisible: boolean = false;
    mapsCollapsed: boolean = false;

    osmEnabled: boolean = true;
    osmOpacityValue: number = 30;

    @ViewChild('menu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('mapLayerDialog') mapLayerDialog: Dialog | undefined;

    metadataMenusEntries: Map<string, { label: string, command: () => void }[]> = new Map();
    private _reinitializingAfterPrune: boolean = false;

    constructor(public mapService: MapService,
                public appModeService: AppModeService,
                public parameterService: AppStateService,
                public keyboardService: KeyboardService,
                public editorService: EditorService,
                private inspectionService: InspectionService,
                private sidePanelService: SidePanelService) {
        this.keyboardService.registerShortcut('m', this.showLayerDialog.bind(this), true);

        this.parameterService.osmEnabledState.subscribe(enabled => {
            this.osmEnabled = enabled;
        });
        this.parameterService.osmOpacityState.subscribe(opacity => {
            this.osmOpacityValue = opacity;
        });
        // Rebuild metadata menus recursively and prune when needed.
        this.mapService.mapGroups.subscribe(mapGroups => {
            this.metadataMenusEntries.clear();
            const collectMaps = (node: any) => {
                if (!node) return;
                if (node.type === 'Group') {
                    for (const child of node.children) collectMaps(child);
                } else {
                    const mapItem = node;
                    this.metadataMenusEntries.set(
                        mapItem.mapId,
                        this.inspectionService.findLayersForMapId(mapItem.mapId, true)
                            .map(layer => ({
                                label: layer.name,
                                command: () => this.inspectionService.loadSourceDataInspectionForService(mapItem.mapId, layer.id)
                            }))
                    );
                }
            };

            const allLeafMaps: MapInfoItem[] = [];
            for (const [_, group] of mapGroups) {
                collectMaps(group);
                allLeafMaps.push(...this.collectLeafMaps(group));
            }
            // If all layers were pruned (complete maps config change), reinitialize default maps once
            if (allLeafMaps.length > 0 && this.parameterService.pruneMapLayerConfig(allLeafMaps)) {
                if (!this._reinitializingAfterPrune) {
                    this._reinitializingAfterPrune = true;
                    try {
                        this.mapService.processMapsUpdate();
                    } finally {
                        this._reinitializingAfterPrune = false;
                    }
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
        } else {
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
        this.parameterService.osmEnabledState.next(this.osmEnabled);
        this.parameterService.osmOpacityState.next(this.osmOpacityValue);
    }

    toggleTileBorders(mapName: string, layerName: string) {
        this.mapService.toggleLayerTileBorderVisibility(mapName, layerName);
    }

    toggleLayer(mapName: string, layerName: string = "") {
        this.mapService.toggleMapLayerVisibility(mapName, layerName);
    }

    unordered(a: KeyValue<string, any>, b: KeyValue<string, any>): number {
        return 0;
    }

    openDatasources() {
        this.editorService.styleEditorVisible = false;
        this.editorService.datasourcesEditorVisible = true;
    }

    toggleMap(mapId: string) {
        if (!mapId) {
            return;
        }
        this.mapService.toggleMapLayerVisibility(mapId);
    }

    toggleGroup(groupId: string) {
        if (!groupId || groupId === 'ungrouped') {
            return;
        }
        const root = this.mapService.mapGroups.getValue();
        const group = this.findMapGroupById(root, groupId);
        if (!group) return;
        // Recompute current visibility at the time of click (derived): any descendant map visible
        const currentVisible = this.collectLeafMaps(group).some(m => m.visible);
        const target = !currentVisible;
        const mapIds = this.collectMapIds(group);
        for (const mapId of mapIds) {
            this.mapService.toggleMapLayerVisibility(mapId, "", target, true);
        }
        this.mapService.processMapsUpdate();
        this.mapService.update().then();
    }

    private findMapGroupById(groups: Map<string, any>, groupId: string): any {
        for (const [id, group] of groups) {
            if (id === groupId || group.groupId === groupId) return group;
            const found = this.findInGroupChildren(group, groupId);
            if (found) return found;
        }
        return undefined;
    }

    private findInGroupChildren(group: any, groupId: string): any {
        if (!group || !group.children) return undefined;
        for (const child of group.children) {
            if (child.type === 'Group') {
                if (child.groupId === groupId) return child;
                const found = this.findInGroupChildren(child, groupId);
                if (found) return found;
            }
        }
        return undefined;
    }

    private collectMapIds(group: any): string[] {
        const ids: string[] = [];
        if (!group || !group.children) return ids;
        for (const child of group.children) {
            if (child.type === 'Group') {
                ids.push(...this.collectMapIds(child));
            } else {
                ids.push(child.mapId);
            }
        }
        return ids;
    }

    private collectLeafMaps(group: any): MapInfoItem[] {
        const maps: MapInfoItem[] = [];
        if (!group || !group.children) return maps;
        for (const child of group.children) {
            if (child.type === 'Group') {
                maps.push(...this.collectLeafMaps(child));
            } else {
                maps.push(child as MapInfoItem);
            }
        }
        return maps;
    }

    isGroupAnyVisible(group: any): boolean {
        return this.collectLeafMaps(group).some(m => m.visible);
    }

    protected readonly removeGroupPrefix = removeGroupPrefix;
}
