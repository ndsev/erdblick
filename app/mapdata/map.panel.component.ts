import {Component, ViewChild} from "@angular/core";
import {MapDataService} from "./map.service";
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
import {CoverageRectItem, GroupTreeNode, MapTreeNode, removeGroupPrefix} from "./map.model";
import {map, Subscription} from "rxjs";


@Component({
    selector: 'map-panel',
    template: `
        <p-dialog #mapLayerDialog class="map-layer-dialog" header="" [(visible)]="layerDialogVisible"
                  [position]="'topleft'" [draggable]="false" [resizable]="false"
                  [style]="{ 'max-height': '100%', 
                  'border-top-left-radius': '0 !important',
                  'border-bottom-left-radius': '0 !important' }">
            <ng-container *ngFor="let index of viewIndices">
                <div class="osm-controls">
<!--                    <p-button onEnterClick (click)="openDatasources()" class="osm-button"-->
<!--                              icon="pi pi-server" label="" pTooltip="Open datasources configuration"-->
<!--                              tooltipPosition="bottom" tabindex="0">-->
<!--                    </p-button>-->
                    <span style="font-size: 0.9em">OSM Overlay:</span>
                    <p-button onEnterClick (click)="toggleOSMOverlay(index)" class="osm-button"
                              icon="{{osmEnabled[index] ? 'pi pi-eye' : 'pi pi-eye-slash'}}"
                              label="" pTooltip="Toggle OSM overlay" tooltipPosition="bottom" tabindex="0">
                    </p-button>
                    <div *ngIf="osmEnabled[index]" style="display: inline-block">
                        <input type="text" pInputText [(ngModel)]="osmOpacityValue[index]"
                               (input)="onOsmOpacityInput($event, index)"
                               (keydown.enter)="updateOSMOverlay(index)"
                               (blur)="updateOSMOverlay(index)"
                               class="w-full slider-input" tabindex="0"/>
                        <p-slider [(ngModel)]="osmOpacityValue[index]" (ngModelChange)="updateOSMOverlay(index)"
                                  class="w-full" tabindex="-1">
                        </p-slider>
                    </div>
                    <p-divider layout="vertical" styleClass="hidden md:flex"></p-divider>
                    <p-button *ngIf="!index" onEnterClick (click)="addView()" class="osm-button"
                              [disabled]="stateService.numViews === 2"
                              icon="pi pi-plus" label="" pTooltip="Add another view for comparison"
                              tooltipPosition="bottom" tabindex="0">
                    </p-button>
                    <p-button *ngIf="index" onEnterClick (click)="removeView(index)" class="osm-button"
                              icon="pi pi-times" label="" pTooltip="Remove the view from comparison"
                              tooltipPosition="bottom" tabindex="0">
                    </p-button>
                </div>
                <p-fieldset class="map-tab" legend="Maps and Layers" [toggleable]="true" [(collapsed)]="mapsCollapsed">
                    <ng-container *ngIf="mapService.maps | async as mapGroups">
                        <div *ngIf="!mapGroups.size" style="margin-top: 0.75em">
                            No maps loaded.
                        </div>
                        <div *ngIf="mapGroups.size" class="maps-container">
                            <p-tree [value]="mapGroups.nodes">
                                <ng-template let-node pTemplate="Group">
                                <span>
                                    <p-checkbox [ngModel]="node.visible[index]"
                                                (click)="$event.stopPropagation()"
                                                (ngModelChange)="toggleGroup(index, node.id)"
                                                [binary]="true"
                                                [inputId]="node.id"
                                                [name]="node.id" tabindex="0"/>
                                    <label [for]="node.id" style="margin-left: 0.5em; cursor: pointer">
                                        {{ removeGroupPrefix(node.id) }}
                                    </label>
                                </span>
                                </ng-template>
                                <ng-template let-node pTemplate="Map">
                                    <p-menu #metadataMenu [model]="metadataMenusEntries.get(node.id)"
                                            [popup]="true"
                                            appendTo="body"/>
                                    <div class="flex-container">
                                <span>
                                    <p-checkbox [(ngModel)]="node.visible[index]"
                                                (click)="$event.stopPropagation()"
                                                (ngModelChange)="toggleMap(index, node.id)"
                                                [binary]="true"
                                                [inputId]="node.id"
                                                [name]="node.id" tabindex="0"/>
                                    <label [for]="node.id"
                                           style="margin-left: 0.5em; cursor: pointer">{{ removeGroupPrefix(node.id) }}</label>
                                </span>
                                        <div class="map-controls">
                                            <p-button onEnterClick (click)="metadataMenu.toggle($event)" label=""
                                                      [pTooltip]="!metadataMenusEntries.get(node.id)?.length ? 'No metadata available' : 'Request service metadata'"
                                                      tooltipPosition="bottom"
                                                      [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                      tabindex="0"
                                                      [disabled]="!metadataMenusEntries.get(node.id)?.length">
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
                                              (click)="showLayersToggleMenu($event, index, node.mapId, node.id)">
                                            more_vert
                                        </span>
                                            <span>
                                        <p-checkbox [(ngModel)]="node.viewConfig[index].visible"
                                                    (click)="$event.stopPropagation()"
                                                    (ngModelChange)="toggleLayer(index, node.mapId, node.id)"
                                                    [binary]="true"
                                                    [inputId]="node.id"
                                                    [name]="node.id" tabindex="0"/>
                                        <label [for]="node.id"
                                               style="margin-left: 0.5em; cursor: pointer">{{ node.id }}</label>
                                        </span>
                                        </div>
                                        <div class="layer-controls">
                                            <p-button onEnterClick
                                                      (click)="toggleTileBorders(index, node.mapId, node.id)"
                                                      label="" pTooltip="Toggle tile borders"
                                                      tooltipPosition="bottom"
                                                      [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                      tabindex="0">
                                            <span class="material-icons"
                                                  style="font-size: 1.2em; margin: 0 auto;">
                                                {{ node.viewConfig[index].tileBorders ? 'select_all' : 'deselect' }}
                                            </span>
                                            </p-button>
                                            <p-button onEnterClick *ngIf="node.info.coverage.length"
                                                      (click)="focus(node.info.coverage[0], $event)"
                                                      label="" pTooltip="Focus on layer" tooltipPosition="bottom"
                                                      [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                      tabindex="0">
                                            <span class="material-icons"
                                                  style="font-size: 1.2em; margin: 0 auto;">loupe</span>
                                            </p-button>
                                            <p-inputNumber [(ngModel)]="node.viewConfig[index].level"
                                                           (ngModelChange)="onLayerLevelChanged($event, node.mapId, node.id)"
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
                                               [(ngModel)]="node.viewConfig[index].level"/>
                                    </div>
                                </ng-template>
                            </p-tree>
                        </div>
                    </ng-container>
                </p-fieldset>
            </ng-container>
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

    subscriptions: Subscription[] = [];
    viewIndices: number[] = [];

    isMainButtonHovered: boolean = false;
    layerDialogVisible: boolean = false;
    mapsCollapsed: boolean = false;

    osmEnabled: boolean[] = [true];
    osmOpacityValue: number[] = [30];

    @ViewChild('menu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('mapLayerDialog') mapLayerDialog: Dialog | undefined;

    metadataMenusEntries: Map<string, { label: string, command: () => void }[]> = new Map();
    private _reinitializingAfterPrune: boolean = false;

    constructor(public mapService: MapDataService,
                public appModeService: AppModeService,
                public stateService: AppStateService,
                public keyboardService: KeyboardService,
                public editorService: EditorService,
                private inspectionService: InspectionService,
                private sidePanelService: SidePanelService) {
        this.keyboardService.registerShortcut('m', this.showLayerDialog.bind(this), true);

        this.subscriptions.push(
            // Rebuild metadata menus recursively and prune when needed.
            this.mapService.maps.subscribe(mapGroups => {
                this.metadataMenusEntries.clear();
                const collectMaps = (node: any) => {
                    if (!node) {
                        return;
                    }
                    if (this.checkIsMapGroup(node)) {
                        for (const child of node.children) {
                            collectMaps(child);
                        }
                    } else {
                        const mapItem = node;
                        this.metadataMenusEntries.set(
                            mapItem.mapId,
                            this.inspectionService.findLayersForMapId(mapItem.mapId, true)
                                .map(layer => ({
                                    label: layer.name,
                                    command: () => {
                                        this.inspectionService.loadSourceDataInspectionForService(mapItem.mapId, layer.id)
                                    }
                                }))
                        );
                    }
                };

                // const allLeafMaps: MapInfoItem[] = [];
                // for (const [_, group] of mapGroups) {
                //     collectMaps(group);
                //     allLeafMaps.push(...this.collectLeafMaps(group));
                // }
                // // If all layers were pruned (complete maps config change), reinitialize default maps once
                // if (allLeafMaps.length > 0 && this.stateService.pruneMapLayerConfig(allLeafMaps)) {
                //     if (!this._reinitializingAfterPrune) {
                //         this._reinitializingAfterPrune = true;
                //         try {
                //             this.mapService.processMapsUpdate();
                //         } finally {
                //             this._reinitializingAfterPrune = false;
                //         }
                //     }
                // }
            })
        );

        this.subscriptions.push(
            this.sidePanelService.observable().subscribe(activePanel => {
                if (activePanel !== SidePanelState.MAPS && activePanel !== SidePanelState.SEARCH) {
                    this.layerDialogVisible = false;
                }
            })
        );

        this.subscriptions.push(
            this.stateService.numViewsState.subscribe(numViews => {
                this.osmEnabled = [];
                this.osmOpacityValue = [];
                this.viewIndices.forEach(viewIndex => {
                    this.osmEnabled.push(this.stateService.osmEnabledState.getValue(viewIndex));
                    this.osmOpacityValue.push(this.stateService.osmOpacityState.getValue(viewIndex));
                });
                setTimeout(() => {
                    this.viewIndices = Array.from({length: numViews}, (_, i) => i);
                }, 150);
            })
        );
    }

    onOsmOpacityInput(event: any, viewIndex: number) {
        const inputElement = event.target as HTMLInputElement;
        const value = inputElement.value;

        // Extract only numerical characters and decimal points
        const numericalOnly = value.replace(/[^0-9.]/g, '');
        let numValue = parseInt(numericalOnly);

        // Validate and clamp the value
        if (isNaN(numValue) || numValue < 0) {
            numValue = 0;
        } else if (numValue > 100) {
            numValue = 100;
        }

        this.osmOpacityValue[viewIndex] = numValue;
        // Always show "Opacity: X"
        const formattedValue = 'Opacity: ' + numValue;
        if (inputElement.value !== formattedValue) {
            inputElement.value = formattedValue;
            inputElement.dispatchEvent(new Event('input'));
        }

        this.updateOSMOverlay(viewIndex);
    }

    // TODO: Refactor these into a generic solution
    showLayersToggleMenu(event: MouseEvent, viewIndex: number, mapName: string, layerName: string) {
        this.toggleMenu.toggle(event);
        this.toggleMenuItems = [
            {
                label: 'Toggle All off but This',
                command: () => {
                    if (this.mapService.maps.getValue().maps.has(mapName)) {
                        for (const id of this.mapService.maps.getValue().maps.get(mapName)!.layers.keys()!) {
                            this.mapService.maps.getValue().maps.get(mapName)!.layers.get(id)!.viewConfig[viewIndex].visible = id == layerName;
                            this.toggleLayer(viewIndex, mapName, layerName);
                        }
                    }
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    if (this.mapService.maps.getValue().maps.has(mapName)) {
                        for (const id of this.mapService.maps.getValue().maps.get(mapName)!.layers.keys()!) {
                            this.mapService.maps.getValue().maps.get(mapName)!.layers.get(id)!.viewConfig[viewIndex].visible = id != layerName;
                            this.toggleLayer(viewIndex, mapName, layerName);
                        }
                    }
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    if (this.mapService.maps.getValue().maps.has(mapName)) {
                        for (const id of this.mapService.maps.getValue().maps.get(mapName)!.layers.keys()!) {
                            this.mapService.maps.getValue().maps.get(mapName)!.layers.get(id)!.viewConfig[viewIndex].visible = false;
                            this.toggleLayer(viewIndex, mapName, layerName);
                        }
                    }
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    if (this.mapService.maps.getValue().maps.has(mapName)) {
                        for (const id of this.mapService.maps.getValue().maps.get(mapName)!.layers.keys()!) {
                            this.mapService.maps.getValue().maps.get(mapName)!.layers.get(id)!.viewConfig[viewIndex].visible = true;
                            this.toggleLayer(viewIndex, mapName, layerName);
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
                {targetView: 0, x: (minPos.x + maxPos.x) * .5, y: (minPos.y + maxPos.y) * .5}
            );
        } else {
            const position = coreLib.getTilePosition(BigInt(coverage as number));
            this.mapService.moveToWgs84PositionTopic.next(
                {targetView: 0, x: position.x, y: position.y}
            );
        }
    }

    onLayerLevelChanged(event: Event, mapName: string, layerName: string) {
        this.mapService.setMapLayerLevel(0, mapName, layerName, Number(event.toString()));
    }

    toggleOSMOverlay(viewIndex: number) {
        this.osmEnabled[viewIndex] = !this.osmEnabled[viewIndex];
        this.updateOSMOverlay(viewIndex);
    }

    updateOSMOverlay(viewIndex: number) {
        this.stateService.osmEnabledState.next(viewIndex, this.osmEnabled[viewIndex]);
        this.stateService.osmOpacityState.next(viewIndex, this.osmOpacityValue[viewIndex]);
    }

    toggleTileBorders(viewIndex: number, mapName: string, layerName: string) {
        this.mapService.toggleLayerTileBorderVisibility(viewIndex, mapName, layerName);
    }

    toggleLayer(viewIndex: number, mapName: string, layerName: string = "") {
        this.mapService.toggleMapLayerVisibility(viewIndex, mapName, layerName);
    }

    unordered(a: KeyValue<string, any>, b: KeyValue<string, any>): number {
        return 0;
    }

    openDatasources() {
        this.editorService.styleEditorVisible = false;
        this.editorService.datasourcesEditorVisible = true;
    }

    toggleMap(viewIndex: number, mapId: string) {
        if (!mapId) {
            return;
        }
        this.mapService.toggleMapLayerVisibility(viewIndex, mapId);
    }

    toggleGroup(viewIndex: number, id: string) {
        if (!id || id === 'ungrouped') {
            return;
        }
        const rootGroups = this.mapService.maps.getValue().nodes;
        const group = this.findGroupById(rootGroups, id);
        if (!group || !this.checkIsMapGroup(group)) {
            return;
        }
        const target = !group.visible[viewIndex];
        const mapIds = this.collectMapIds(group);
        for (const id of mapIds) {
            this.mapService.toggleMapLayerVisibility(viewIndex, id, "", target, true);
        }
        this.mapService.maps.getValue().configureTreeParameters();
        this.mapService.update().then();
    }

    private checkIsMapGroup (e: any): e is GroupTreeNode {
        return e.type === "Group";
    }

    private findGroupById(elements: (GroupTreeNode | MapTreeNode)[], id: string): GroupTreeNode | MapTreeNode | undefined {
        for (const elem of elements) {
            if (elem.id === id) {
                return elem;
            }
            if (this.checkIsMapGroup(elem)) {
                const found = this.findGroupById(elem.children, id);
                if (found) return found;
            }
        }
        return undefined;
    }

    private collectMapIds(group: GroupTreeNode): string[] {
        const ids: string[] = [];
        if (!group || !group.children) {
            return ids;
        }
        for (const child of group.children) {
            if (this.checkIsMapGroup(child)) {
                ids.push(...this.collectMapIds(child));
            } else {
                ids.push(child.id);
            }
        }
        return ids;
    }

    protected readonly removeGroupPrefix = removeGroupPrefix;

    addView() {
        // Limit the increment for now since we do not yet support more than 2 views
        if (this.stateService.numViews < 2) {
            this.stateService.numViews += 1;
        }
    }

    removeView(index: number) {
        // Right now we just decrement, but for more than 2 views we should consider the actual indices
        // We cannot have fewer views than at least 1
        if (this.stateService.numViews > 1) {
            this.viewIndices.pop();
            this.stateService.numViews -= 1;
        }
    }
}
