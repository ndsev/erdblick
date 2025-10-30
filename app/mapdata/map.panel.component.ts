import {Component, ViewChild} from "@angular/core";
import {MapDataService} from "./map.service";
import {AppStateService, SelectedSourceData} from "../shared/appstate.service";
import {Dialog} from "primeng/dialog";
import {coreLib} from "../integrations/wasm";
import {MenuItem} from "primeng/api";
import {Menu} from "primeng/menu";
import {KeyboardService} from "../shared/keyboard.service";
import {AppModeService} from "../shared/app-mode.service";
import {CoverageRectItem, GroupTreeNode, MapTreeNode, removeGroupPrefix, StyleOptionNode} from "./map.tree.model";
import {Subscription} from "rxjs";
import {Rectangle} from "../integrations/cesium";


@Component({
    selector: 'map-panel',
    template: `
        <p-dialog #mapLayerDialog class="map-layer-dialog" header="" [(visible)]="layerDialogVisible"
                  [position]="'topleft'" [draggable]="false" [resizable]="false"
                  [style]="{ 'max-height': '100%', 
                  'border-top-left-radius': '0 !important',
                  'border-bottom-left-radius': '0 !important' }">
            <ng-container *ngFor="let index of viewIndices">
                <p-fieldset class="map-tab" legend="" [toggleable]="true" [(collapsed)]="mapsCollapsed[index]">
                    <ng-template #header>
                        <div style="display: flex; flex-direction: row; gap: 0.25em; align-items: center">
                            @if (stateService.numViews > 1) {
                                @if (index < 1) {
                                    <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
                                        splitscreen_left
                                    </span>
                                    <span class="font-bold">Maps Left View</span>
                                } @else {
                                    <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
                                        splitscreen_right
                                    </span>
                                    <span class="font-bold">Maps Right View</span>
                                    <p-button onEnterClick (click)="removeView($event, index)" class="close-view-button"
                                              icon="pi pi-times" label="" pTooltip="Remove the view from comparison"
                                              tooltipPosition="bottom" tabindex="0">
                                    </p-button>
                                }
                            } @else {
                                <span class="font-bold">Maps</span>
                            }
                        </div>
                    </ng-template>
                    <div class="map-config-controls">
                        <p-button onEnterClick (click)="syncOptionsForView(index)" class="map-controls-button"
                                  icon="" label="" pTooltip="Sync visualization options in this view"
                                  tooltipPosition="bottom" tabindex="0">
                            <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
                                {{ syncedOptions[index] ? "sync" : "sync_disabled" }}
                            </span>
                        </p-button>
                        <p-divider layout="vertical" styleClass="hidden md:flex"></p-divider>
                        <div class="osm-controls">
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
                        </div>
                    </div>

                    <ng-container *ngIf="mapService.maps$ | async as mapGroups">
                        <div *ngIf="!mapGroups.size" style="margin-top: 0.75em">
                            No maps loaded.
                        </div>
                        <div *ngIf="mapGroups.size" class="maps-container">
                            <p-tree [value]="mapGroups.nodes">
                                <!-- Template for Group nodes -->
                                <ng-template let-node pTemplate="Group">
                                    <div class="font-bold white-space-nowrap"
                                         style="display: flex; align-items: center;">
                                    <span onEnterClick class="material-icons menu-toggler" tabindex="0"
                                          (click)="showLayersToggleMenu($event, index, node.id+'/', '')">
                                        more_vert
                                    </span>
                                        <span>
                                        <p-checkbox [ngModel]="node.visible[index]"
                                                    (click)="$event.stopPropagation()"
                                                    (ngModelChange)="toggleLayer(index, node.id, '', !node.visible[index])"
                                                    [binary]="true"
                                                    [inputId]="node.id"
                                                    [name]="node.id" tabindex="0"/>
                                        <label [for]="node.id"
                                               style="margin-left: 0.5em; cursor: pointer">{{ removeGroupPrefix(node.id) }}</label>
                                    </span>
                                    </div>
                                </ng-template>
                                <!-- Template for Map nodes -->
                                <ng-template let-node pTemplate="Map">
                                    <p-menu #metadataMenu [model]="metadataMenusEntries.get(node.id)"
                                            [popup]="true"
                                            appendTo="body"/>
                                    <div class="flex-container">
                                    <span>
                                        <span onEnterClick class="material-icons menu-toggler" tabindex="0"
                                              (click)="showLayersToggleMenu($event, index, node.id, '')">
                                                more_vert
                                        </span>
                                        <p-checkbox [(ngModel)]="node.visible[index]"
                                                    (click)="$event.stopPropagation()"
                                                    (ngModelChange)="toggleLayer(index, node.id, '', node.visible[index])"
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
                                <!-- Template for Feature Layer nodes -->
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
                                                            (ngModelChange)="toggleLayer(index, node.mapId, node.id, node.viewConfig[index].visible)"
                                                            [binary]="true"
                                                            [inputId]="node.id"
                                                            [name]="node.id" tabindex="0"/>
                                                <label [for]="node.id"
                                                       style="margin-left: 0.5em; cursor: pointer">{{ node.id }}</label>
                                            </span>
                                        </div>
                                        <div class="tree-node-controls">
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
                                                      (click)="focus($event, index, node.info.coverage)"
                                                      label="" pTooltip="Focus on layer" tooltipPosition="bottom"
                                                      [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                      tabindex="0">
                                            <span class="material-icons"
                                                  style="font-size: 1.2em; margin: 0 auto;">loupe</span>
                                            </p-button>
                                            <p-inputNumber [(ngModel)]="node.viewConfig[index].level"
                                                           (ngModelChange)="onLayerLevelChanged($event, index, node.mapId, node.id)"
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
                                <!-- Template for boolean style option nodes -->
                                <ng-template let-node pTemplate="Bool">
                                    <div style="display: flex; align-items: center;">
                                        <span onEnterClick class="material-icons menu-toggler"
                                              (click)="$event.stopPropagation()"
                                              tabindex="0">
                                            more_vert
                                        </span>
                                        <span class="oblique"
                                              [ngClass]="{'disabled': !mapService.maps.getMapLayerVisibility(index, node.mapId, node.layerId)}">
                                            <p-checkbox
                                                    [(ngModel)]="node.value[index]"
                                                    (ngModelChange)="updateStyleOption(node, index)"
                                                    [binary]="true"
                                                    [inputId]="node.styleId + '_' + node.id"
                                                    [name]="node.styleId + '_' + node.id"/>
                                            <label [for]="node.styleId + '_' + node.id"
                                                   style="margin-left: 0.5em; cursor: pointer">{{ node.info.label }}</label>
                                        </span>
                                    </div>
                                </ng-template>
                                <!-- TODO: Add Templates for String/Color Options, and ignore internal ones. -->
                            </p-tree>
                        </div>
                    </ng-container>
                </p-fieldset>
                @if (viewIndices.length < 2) {
                    <p-button onEnterClick (click)="addView()" icon="" label="Add View"
                              pTooltip="Add split view for comparison" tooltipPosition="bottom" tabindex="0">
                        <span class="material-symbols-outlined" style="margin: 0 auto;">
                            add_column_right
                        </span>
                    </p-button>
                }
            </ng-container>
        </p-dialog>
        <p-menu #menu [model]="toggleMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <div class="main-button-controls" (mouseleave)="isMainButtonHovered = false"
             [ngClass]="{'hovered': isMainButtonHovered}">
            <p-button onEnterClick class="layers-button" (mouseenter)="isMainButtonHovered = true"
                      (click)="isMainButtonHovered = false; toggleLayerDialog()"
                      tooltipPosition="right"
                      pTooltip="{{layerDialogVisible ? 'Hide map layers' : 'Show map layers'}}"
                      label="" tabindex="0">
                <span *ngIf="!layerDialogVisible" class="material-symbols-outlined"
                      style="font-size: 1.2em; margin: 0 auto;">
                    stacks
                </span>
                <span *ngIf="layerDialogVisible" class="material-icons"
                      style="font-size: 1.2em; margin: 0 auto;">
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
    mapsCollapsed: boolean[] = [];

    osmEnabled: boolean[] = [true];
    osmOpacityValue: number[] = [30];

    syncedOptions: boolean[] = [];
    layerDialogVisible: boolean = false;

    @ViewChild('menu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('mapLayerDialog') mapLayerDialog: Dialog | undefined;

    metadataMenusEntries: Map<string, { label: string, command: () => void }[]> = new Map();
    private _reinitializingAfterPrune: boolean = false;

    constructor(public mapService: MapDataService,
                public appModeService: AppModeService,
                public stateService: AppStateService,
                public keyboardService: KeyboardService) {
        this.keyboardService.registerShortcut('m', this.toggleLayerDialog.bind(this), true);

        this.subscriptions.push(
            // Rebuild metadata menus recursively and prune when needed.
            this.mapService.maps$.subscribe(mapTree => {
                this.metadataMenusEntries.clear();
                for (const [_, mapItem] of mapTree.maps) {
                    this.metadataMenusEntries.set(
                        mapItem.id,
                        this.mapService.findLayersForMapId(mapItem.id, true)
                            .map(layer => ({
                                label: layer.name,
                                command: () => {
                                    this.stateService.setSelection({
                                        mapTileKey: coreLib.getSourceDataLayerKey(mapItem.id, layer.id, 0n)
                                    } as SelectedSourceData);
                                }
                            }))
                    );
                }
            })
        );

        this.subscriptions.push(
            this.stateService.numViewsState.subscribe(numViews => {
                this.osmEnabled = [];
                this.osmOpacityValue = [];
                const viewIndices = Array.from({length: numViews}, (_, i) => i);
                viewIndices.forEach(viewIndex => {
                    this.osmEnabled.push(this.stateService.osmEnabledState.getValue(viewIndex));
                    this.osmOpacityValue.push(this.stateService.osmOpacityState.getValue(viewIndex));
                });
                while (this.mapsCollapsed.length < viewIndices.length) {
                    this.mapsCollapsed.push(false);
                }
                while (this.syncedOptions.length < viewIndices.length) {
                    this.syncedOptions.push(false);
                }
                setTimeout(() => {
                    this.viewIndices = viewIndices;
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

    showLayersToggleMenu(event: MouseEvent, viewIndex: number, mapId: string, layerId: string) {
        this.toggleMenu.toggle(event);
        this.toggleMenuItems = [
            {
                label: 'Toggle All Off But This',
                command: () => {
                    for (const layer of this.mapService.maps.allFeatureLayers()) {
                        this.mapService.setMapLayerVisibility(viewIndex, layer.mapId, layer.id, layer.mapId.startsWith(mapId) && (!layerId || layer.id === layerId));
                    }
                }
            },
            {
                label: 'Toggle All On But This',
                command: () => {
                    for (const layer of this.mapService.maps.allFeatureLayers()) {
                        this.mapService.setMapLayerVisibility(viewIndex, layer.mapId, layer.id, !layer.mapId.startsWith(mapId) || !!(layerId && layer.id !== layerId));
                    }
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    for (const layer of this.mapService.maps.allFeatureLayers()) {
                        this.mapService.setMapLayerVisibility(viewIndex, layer.mapId, layer.id, false);
                    }
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    for (const layer of this.mapService.maps.allFeatureLayers()) {
                        this.mapService.setMapLayerVisibility(viewIndex, layer.mapId, layer.id, false);
                    }
                }
            }
        ];
    }

    showOptionsToggleMenu(event: MouseEvent, node: StyleOptionNode) {
        this.toggleMenu.toggle(event);
        /* this.toggleMenuItems = [
            {
                label: 'Toggle All off but This',
                command: () => {
                    const style = this.styleService.styles.get(styleId);
                    if (style === undefined || style === null) {
                        return;
                    }
                    // for (const id in style.params.options) {
                    //     this.styleService.toggleOption(style.id, id, id == optionId);
                    // }
                    this.applyStyleConfig(style.id);
                }
            },
            {
                label: 'Toggle All on but This',
                command: () => {
                    const style = this.styleService.styles.get(styleId);
                    if (style === undefined || style === null) {
                        return;
                    }
                    // for (const id in style.params.options) {
                    //     this.styleService.toggleOption(style.id, id, id != optionId);
                    // }
                    this.applyStyleConfig(style.id);
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    const style = this.styleService.styles.get(styleId);
                    if (style === undefined || style === null) {
                        return;
                    }
                    // for (const id in style.params.options) {
                    //     this.styleService.toggleOption(style.id, id, false);
                    // }
                    this.applyStyleConfig(style.id);
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    const style = this.styleService.styles.get(styleId);
                    if (style === undefined || style === null) {
                        return;
                    }
                    // for (const id in style.params.options) {
                    //     this.styleService.toggleOption(style.id, id, true);
                    // }
                    this.applyStyleConfig(style.id);
                }
            }
        ];
        */
    }

    toggleLayerDialog() {
        this.layerDialogVisible = !this.layerDialogVisible;
    }

    focus(event: any, viewIndex: number, coverages: (number | CoverageRectItem)[]) {
        event.stopPropagation();
        let tileIds = coverages.map(coverage => {
            return coverage.hasOwnProperty("min") && coverage.hasOwnProperty("max") ?
                [BigInt((coverage as CoverageRectItem).min), BigInt((coverage as CoverageRectItem).max)] :
                [BigInt(coverage as number)]
        }).flat();
        let targetRect: Rectangle | null = null;
        for (const tileId of tileIds) {
            const tileIdRect = Rectangle.fromDegrees(...coreLib.getTileBox(tileId));
            if (targetRect) {
                Rectangle.union(tileIdRect, targetRect, targetRect);
            } else {
                targetRect = tileIdRect;
            }
        }
        this.stateService.focusedView = viewIndex;
        this.mapService.moveToRectangleTopic.next(
            {targetView: viewIndex, rectangle: targetRect!}
        );
    }

    updateOSMOverlay(viewIndex: number) {
        this.stateService.osmEnabledState.next(viewIndex, this.osmEnabled[viewIndex]);
        this.stateService.osmOpacityState.next(viewIndex, this.osmOpacityValue[viewIndex]);
    }

    toggleOSMOverlay(viewIndex: number) {
        this.osmEnabled[viewIndex] = !this.osmEnabled[viewIndex];
        this.updateOSMOverlay(viewIndex);
    }

    toggleLayer(viewIndex: number, mapName: string, layerName: string = "", state: boolean) {
        this.mapService.setMapLayerVisibility(viewIndex, mapName, layerName, state);
    }

    toggleTileBorders(viewIndex: number, mapName: string, layerName: string) {
        this.mapService.toggleLayerTileBorderVisibility(viewIndex, mapName, layerName);
    }

    onLayerLevelChanged(event: Event, viewIndex: number, mapName: string, layerName: string) {
        this.mapService.setMapLayerLevel(viewIndex, mapName, layerName, Number(event.toString()));
    }

    updateStyleOption(node: StyleOptionNode, viewIndex: number) {
        this.stateService.setStyleOptionValues(node.mapId, node.layerId, node.shortStyleId, node.id, node.value);
        this.mapService.styleOptionChangedTopic.next([node, viewIndex]);
    }

    addView() {
        // Limit the increment for now since we do not yet support more than 2 views
        if (this.stateService.numViews < 2) {
            this.stateService.numViews += 1;
        }
    }

    removeView(event: MouseEvent, index: number) {
        event.stopPropagation();
        // Right now we just decrement, but for more than 2 views we should consider the actual indices
        // We cannot have fewer views than at least 1
        if (this.stateService.numViews > 1) {
            this.viewIndices.pop();
            this.stateService.numViews -= 1;
        }
    }

    protected readonly removeGroupPrefix = removeGroupPrefix;

    syncOptionsForView(viewIndex: number) {
        // TODO: Implement
    }
}
