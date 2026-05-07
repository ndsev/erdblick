import {Component, ViewChild} from "@angular/core";
import {MapDataService} from "./map.service";
import {AppStateService, SelectedSourceData, TileGridMode} from "../shared/appstate.service";
import {coreLib} from "../integrations/wasm";
import {MenuItem} from "primeng/api";
import {Menu} from "primeng/menu";
import {Popover} from "primeng/popover";
import {KeyboardService} from "../shared/keyboard.service";
import {AppModeService} from "../shared/app-mode.service";
import {CoverageRectItem, removeGroupPrefix, StyleOptionNode} from "./map.tree.model";
import {Subscription} from "rxjs";
import {GeoMath, Rectangle} from "../integrations/geo";
import {DialogStackService} from "../shared/dialog-stack.service";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {
    AppConfigService,
    BackgroundLayerConfig,
    WMS_BACKGROUND_EXPERIMENTAL_TOOLTIP
} from "../shared/app-config.service";

/** One rendered select option in the per-view background-layer dropdown. */
interface BackgroundLayerOption {
    label: string;
    value: string | null;
    disabled: boolean;
    experimental: boolean;
}


@Component({
    selector: 'map-panel',
    template: `
        <app-dialog #mapLayerDialog class="map-layer-dialog" data-testid="map-layer-dialog" header="" [(visible)]="layerDialogVisible"
                  [position]="'left'" [draggable]="false" [resizable]="false" 
                  (onShow)="onMapLayerDialogShow()"
                  [style]="{ 'max-height': '100%', 
                  'border-top-left-radius': '0 !important',
                  'border-bottom-left-radius': '0 !important' }">
            <p-button class="close-maps-button" icon="pi pi-times" severity="secondary" (click)="closeMapsPanel()"
                      (mousedown)="$event.stopPropagation()"/>
            <p-accordion data-testid="map-tabs" [(value)]="mapAccordionValue" [multiple]="true">
                @for (index of viewIndices; track index) {
                    <p-accordion-panel class="map-tab" [value]="index" [attr.data-testid]="getMapTabTestId(index)">
                        <p-accordion-header>
                            <div class="maps-header">
                                <div class="maps-view-title">
                                    @if (stateService.numViews > 1) {
                                        <p-tag severity="info" [rounded]="true">
                                            @if (index < 1) {
                                                <div>
                                                    <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
                                                        splitscreen_left
                                                    </span>
                                                    <span>Left</span>
                                                </div>
                                            } @else {
                                                <div>
                                                    <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
                                                        splitscreen_right
                                                    </span>
                                                    <span>Right</span>
                                                </div>
                                            }
                                        </p-tag>
                                    }
                                    <span>Maps</span>
                                </div>
                                <div class="maps-config">
                                    <p-button onEnterClick (click)="syncOptionsForView($event, index)"
                                              [styleClass]="syncedOptions[index] ? 'map-controls-button p-button-success' : 'map-controls-button p-button-primary'"
                                              [style]="{'padding-left': '0', 'padding-right': '0'}"
                                              icon="" label="" pTooltip="Sync visualization options in this view"
                                              tooltipPosition="bottom" tabindex="0">
                                        <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
                                            {{ syncedOptions[index] ? "sync" : "sync_disabled" }}
                                        </span>
                                    </p-button>
                                    <p-button onEnterClick (click)="toggleTileGridPopover($event, tileGridPopover)"
                                              (mousedown)="$event.stopPropagation()"
                                              [attr.data-testid]="getTileGridButtonTestId(index)"
                                              [styleClass]="tileBordersEnabled[index] ? 'map-controls-button p-button-success' : 'map-controls-button p-button-primary'"
                                              [style]="{'padding-left': '0', 'padding-right': '0'}"
                                              icon="" label="" pTooltip="Configure tile grid"
                                              tooltipPosition="bottom" tabindex="0">
                                        <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
                                            {{ tileBordersEnabled[index] ? "border_outer" : "border_clear" }}
                                        </span>
                                    </p-button>
                                    <p-button onEnterClick (click)="toggleBackgroundPopover($event, backgroundPopover)"
                                              (mousedown)="$event.stopPropagation()"
                                              class="background-opacity-button"
                                              [attr.data-testid]="getBackgroundButtonTestId(index)"
                                              [styleClass]="backgroundLayerIds[index] !== null ? 'map-controls-button p-button-success' : 'map-controls-button p-button-primary'"
                                              [style]="{'padding-left': '0', 'padding-right': '0'}"
                                              icon="" label="" pTooltip="Configure background layer"
                                              tooltipPosition="bottom" tabindex="0">
                                        <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
                                            opacity
                                        </span>
                                    </p-button>
                                    @if (viewIndices.length > 1) {
                                        <p-button onEnterClick (click)="removeView($event, index)" class="close-view-button"
                                                  icon="pi pi-times" label="" pTooltip="Remove the view from comparison"
                                                  [styleClass]="'map-controls-button p-button-secondary'"
                                                  tooltipPosition="bottom" tabindex="0" [disabled]="index < 1">
                                        </p-button>
                                    }
                                    <p-popover #tileGridPopover [baseZIndex]="30000">
                                        <div class="tile-grid-popover" [attr.data-testid]="getTileGridPopoverTestId(index)">
                                            <div class="tile-grid-toggle-row">
                                                <label [for]="'tile-grid-enabled-' + index">Tile Grid</label>
                                                <p-toggleswitch [ngModel]="tileBordersEnabled[index]"
                                                                (ngModelChange)="setViewTileBorders(index, $event)"
                                                                [inputId]="'tile-grid-enabled-' + index"
                                                                [attr.data-testid]="getTileGridEnabledTestId(index)"/>
                                            </div>
                                            <div class="tile-grid-mode-row" [ngClass]="{'disabled': !tileBordersEnabled[index]}">
                                                <span>Mode</span>
                                                <div class="tile-grid-radio-group">
                                                    <div class="tile-grid-radio-option">
                                                        <p-radiobutton [ngModel]="tileGridModes[index]"
                                                                       (ngModelChange)="setTileGridMode(index, $event)"
                                                                       value="nds"
                                                                       [name]="'tile-grid-mode-' + index"
                                                                       [inputId]="'tile-grid-mode-nds-' + index"
                                                                       [disabled]="!tileBordersEnabled[index]"
                                                                       [attr.data-testid]="getTileGridModeTestId(index, 'nds')"/>
                                                        <label [for]="'tile-grid-mode-nds-' + index">NDS</label>
                                                    </div>
                                                    <div class="tile-grid-radio-option">
                                                        <p-radiobutton [ngModel]="tileGridModes[index]"
                                                                       (ngModelChange)="setTileGridMode(index, $event)"
                                                                       value="xyz"
                                                                       [name]="'tile-grid-mode-' + index"
                                                                       [inputId]="'tile-grid-mode-xyz-' + index"
                                                                       [disabled]="!tileBordersEnabled[index]"
                                                                       [attr.data-testid]="getTileGridModeTestId(index, 'xyz')"/>
                                                        <label [for]="'tile-grid-mode-xyz-' + index">XYZ</label>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </p-popover>
                                    <p-popover #backgroundPopover [baseZIndex]="30000">
                                        <div class="background-settings-popover" [attr.data-testid]="getBackgroundPopoverTestId(index)">
                                            <div class="background-toggle-row">
                                                <label [for]="'background-enabled-' + index">Background</label>
                                                <p-toggleswitch [ngModel]="isBackgroundEnabled(index)"
                                                                (ngModelChange)="setBackgroundEnabled(index, $event)"
                                                                [inputId]="'background-enabled-' + index"
                                                                [attr.data-testid]="getBackgroundEnabledTestId(index)"/>
                                            </div>
                                            <p-select class="background-layer-select"
                                                      [attr.data-testid]="getBackgroundSelectTestId(index)"
                                                      [options]="backgroundOptions[index]"
                                                      [(ngModel)]="backgroundLayerIds[index]"
                                                      (ngModelChange)="updateBackgroundLayer(index)"
                                                      optionLabel="label"
                                                      optionValue="value"
                                                      optionDisabled="disabled"
                                                      [disabled]="!isBackgroundEnabled(index) || !backgroundOptions[index]?.length"
                                                      placeholder="Select Background"
                                                      appendTo="body"
                                                      tabindex="0">
                                                <ng-template let-option pTemplate="selectedItem">
                                                    <div class="background-option">
                                                        <span class="background-option-label">{{ option?.label ?? 'Select Background' }}</span>
                                                        @if (option?.experimental) {
                                                            <span class="background-badges">
                                                                <p-tag severity="warn" value="EXPERIMENTAL" />
                                                            </span>
                                                        }
                                                    </div>
                                                </ng-template>
                                                <ng-template let-option pTemplate="item">
                                                    <div class="background-option">
                                                        <span class="background-option-label">{{ option.label }}</span>
                                                        @if (option.experimental) {
                                                            <span class="background-badges">
                                                                <p-tag severity="warn" value="EXPERIMENTAL" />
                                                                <span class="material-symbols-outlined background-info"
                                                                      [pTooltip]="wmsExperimentalTooltip"
                                                                      tooltipPosition="bottom">info</span>
                                                            </span>
                                                        }
                                                    </div>
                                                </ng-template>
                                            </p-select>
                                            @if (backgroundDetails[index]) {
                                                <div class="background-details">
                                                    <span class="material-symbols-outlined background-info">info</span>
                                                    <span>{{ backgroundDetails[index] }}</span>
                                                </div>
                                            }
                                            @if (backgroundLayerIds[index] !== null) {
                                                <div class="background-opacity-row">
                                                    <span class="background-opacity-value">{{ backgroundOpacityValue[index] }}%</span>
                                                    <p-slider [(ngModel)]="backgroundOpacityValue[index]"
                                                              (ngModelChange)="updateBackgroundLayer(index)"
                                                              orientation="horizontal"
                                                              class="background-opacity-slider"
                                                              [attr.data-testid]="getBackgroundOpacitySliderTestId(index)"
                                                              tabindex="-1">
                                                    </p-slider>
                                                </div>
                                            }
                                        </div>
                                    </p-popover>
                                </div>
                            </div>
                        </p-accordion-header>

                        <p-accordion-content>
                            <ng-container *ngIf="mapService.maps$ | async as mapGroups">
                                @if (!mapGroups.size) {
                                    <div style="margin-top: 0.75em">
                                        No maps loaded.
                                    </div>
                                } @else {
                                    
                                }
                           
                            <div *ngIf="mapGroups.size" class="maps-container">
                                <p-tree [value]="mapGroups.nodes">
                                    <!-- Template for Group nodes -->
                                    <ng-template let-node pTemplate="Group">
                                        <div class="font-bold white-space-nowrap"
                                             style="display: flex; align-items: center;">
                                        <span onEnterClick class="material-symbols-outlined menu-toggler" tabindex="0"
                                              (click)="showLayersToggleMenu($event, index, node.id+'/', '')">
                                            more_vert
                                        </span>
                                            <span class="checkbox-entry">
                                            <p-checkbox [ngModel]="node.visible[index]"
                                                        (click)="$event.stopPropagation()"
                                                        (ngModelChange)="toggleLayer(index, node.id, '', !node.visible[index])"
                                                        [binary]="true"
                                                        [inputId]="index + '_' + node.id"
                                                        [name]="index + '_' + node.id" tabindex="0"/>
                                            <label [for]="index + '_' + node.id">{{ removeGroupPrefix(node.id) }}</label>
                                        </span>
                                        </div>
                                    </ng-template>
                                    <!-- Template for Map nodes -->
                                    <ng-template let-node pTemplate="Map">
                                        <p-menu #metadataMenu [model]="metadataMenusEntries.get(node.id)"
                                                [popup]="true"
                                                appendTo="body"/>
                                        <div class="flex-container">
                                    <span class="checkbox-entry">
                                        <span onEnterClick class="material-symbols-outlined menu-toggler" tabindex="0"
                                              (click)="showLayersToggleMenu($event, index, node.id, '')">
                                                more_vert
                                        </span>
                                        <p-checkbox [(ngModel)]="node.visible[index]"
                                                    (click)="$event.stopPropagation()"
                                                    (ngModelChange)="toggleLayer(index, node.id, '', node.visible[index])"
                                                    [binary]="true"
                                                    [inputId]="index + '_' + node.id"
                                                    [name]="index + '_' + node.id" tabindex="0"/>
                                        <label [for]="index + '_' + node.id">{{ removeGroupPrefix(node.id) }}</label>
                                    </span>
                                            <div class="map-controls">
                                                <p-button onEnterClick (click)="focus($event, index, flatCoverage(node))"
                                                          label="" pTooltip="Focus on map" tooltipPosition="bottom"
                                                          [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                          tabindex="0"
                                                          *ngIf="flatCoverage(node).length">
                                            <span class="material-symbols-outlined"
                                                  style="font-size: 1.2em; margin: 0 auto;">center_focus_strong</span>
                                                </p-button>
                                                <p-button onEnterClick (click)="metadataMenu.toggle($event)" label=""
                                                          pTooltip="{{!metadataMenusEntries.get(node.id)?.length ? 'No metadata available' : 'Request service metadata'}}"
                                                          tooltipPosition="bottom"
                                                          [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                          tabindex="0"
                                                          [disabled]="!metadataMenusEntries.get(node.id)?.length">
                                            <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
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
                                            <span onEnterClick class="material-symbols-outlined menu-toggler" tabindex="0"
                                                  (click)="showLayersToggleMenu($event, index, node.mapId, node.id)">
                                                more_vert
                                            </span>
                                                <span class="checkbox-entry">
                                                <p-checkbox [(ngModel)]="node.viewConfig[index].visible"
                                                            (click)="$event.stopPropagation()"
                                                            (ngModelChange)="toggleLayer(index, node.mapId, node.id, node.viewConfig[index].visible)"
                                                            [binary]="true"
                                                            [inputId]="index + '_' + node.key"
                                                            [name]="index + '_' + node.key" tabindex="0"/>
                                                <label [for]="index + '_' + node.key">{{ node.id }}</label>
                                            </span>
                                            </div>
                                            <div class="tree-node-controls">
                                                <p-button onEnterClick *ngIf="node.info.coverage.length"
                                                          (click)="focus($event, index, node.info.coverage)"
                                                          label="" pTooltip="Focus on layer" tooltipPosition="bottom"
                                                          [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                          tabindex="0">
                                            <span class="material-symbols-outlined"
                                                  style="font-size: 1.2em; margin: 0 auto;">center_focus_strong</span>
                                                </p-button>
                                                <p-inputNumber [ngModel]="displayMapLayerLevel(index, node.mapId, node.id, node.viewConfig[index].level)"
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
                                                <p-button onEnterClick
                                                          (click)="toggleLayerAutoLevel(index, node.mapId, node.id)"
                                                          [styleClass]="node.viewConfig[index].autoLevel ? 'map-controls-button p-button-success' : 'map-controls-button p-button-secondary'"
                                                          [style]="{'min-width': '3.75em', 'padding-left': '0.35em', 'padding-right': '0.35em'}"
                                                          label="AUTO"
                                                          pTooltip="Automatically select the layer level"
                                                          tooltipPosition="bottom"
                                                          tabindex="0">
                                                </p-button>
                                            </div>
                                            <input class="level-indicator" type="text" pInputText [disabled]="true"
                                                   [ngModel]="displayMapLayerLevel(index, node.mapId, node.id, node.viewConfig[index].level)"/>
                                        </div>
                                    </ng-template>
                                    <!-- Template for boolean style option nodes -->
                                    <ng-template let-node pTemplate="Bool">
                                        <div style="display: flex; align-items: center;">
                                        <span class="checkbox-entry oblique"
                                              [ngClass]="{'disabled': !mapService.maps.getMapLayerVisibility(index, node.mapId, node.layerId)}">
                                            <p-checkbox
                                                    [(ngModel)]="node.value[index]"
                                                    (ngModelChange)="updateStyleOption(node, index)"
                                                    [binary]="true"
                                                    [inputId]="index + '_' + node.key"
                                                    [name]="index + '_' + node.key"/>
                                            <label [for]="index + '_' + node.key">{{ node.info.label }}</label>
                                        </span>
                                        </div>
                                    </ng-template>
                                    
                                </p-tree>
                            </div>
                            </ng-container>
                        </p-accordion-content>
                    </p-accordion-panel>
                }
            </p-accordion>
            @if (viewIndices.length < 2) {
                <p-button onEnterClick class="add-view-button" data-testid="add-view-button" (click)="addView()" icon="" label="Add View"
                          pTooltip="Add split view for comparison" tooltipPosition="bottom" tabindex="0">
                        <span class="material-symbols-outlined" style="margin: 0 auto;">
                            add_column_right
                        </span>
                </p-button>
            }
        </app-dialog>
        <p-menu #menu [model]="toggleMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}"></p-menu>
    `,
    styles: [`
        .disabled {
            pointer-events: none;
            opacity: 0.5;
        }

    `],
    standalone: false
})
/**
 * Renders the maps-and-layers panel and translates its UI controls into map-service and
 * app-state updates for the active views, including tile-grid and background-layer controls.
 */
export class MapPanelComponent {
    protected readonly wmsExperimentalTooltip = WMS_BACKGROUND_EXPERIMENTAL_TOOLTIP;

    subscriptions: Subscription[] = [];
    viewIndices: number[] = [];
    mapAccordionValue: number[] = [0];

    mapsCollapsed: boolean[] = [];

    backgroundLayerIds: Array<string | null> = [null];
    backgroundOpacityValue: number[] = [100];
    backgroundOptions: BackgroundLayerOption[][] = [[]];
    backgroundDetails: string[] = [""];
    lastEnabledBackgroundLayerIds: Array<string | null> = [];
    tileBordersEnabled: boolean[] = [];
    tileGridModes: TileGridMode[] = [];

    syncedOptions: boolean[] = [];
    layerDialogVisible: boolean = false;

    @ViewChild('menu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('mapLayerDialog') mapLayerDialog: AppDialogComponent | undefined;

    metadataMenusEntries: Map<string, { label: string, command: () => void }[]> = new Map();

    /** Subscribes the panel UI to map, app-state, and dialog-stack updates. */
    constructor(public mapService: MapDataService,
                public appModeService: AppModeService,
                public stateService: AppStateService,
                public keyboardService: KeyboardService,
                private readonly configService: AppConfigService,
                private readonly dialogStack: DialogStackService) {
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
                const numViews = this.stateService.numViews;
                this.tileBordersEnabled = Array.from({length: numViews}, (_, index) =>
                    this.mapService.maps.getViewTileBorderState(index));
                this.tileGridModes = Array.from({length: numViews}, (_, index) =>
                    this.mapService.maps.getViewTileGridMode(index));
            })
        );

        this.subscriptions.push(
            this.stateService.numViewsState.subscribe(numViews => {
                const previousViewIndices = new Set(this.viewIndices);
                this.viewIndices = Array.from({length: numViews}, (_, i) => i);
                const validViewIndices = new Set(this.viewIndices);
                this.mapAccordionValue = this.mapAccordionValue.filter(index => validViewIndices.has(index));
                for (const viewIndex of this.viewIndices) {
                    if (!previousViewIndices.has(viewIndex) && !this.mapAccordionValue.includes(viewIndex)) {
                        this.mapAccordionValue.push(viewIndex);
                    }
                }
                if (numViews === 1) {
                    this.mapAccordionValue = [0];
                }
                this.tileBordersEnabled = [];
                this.tileGridModes = [];
                this.viewIndices.forEach(viewIndex => {
                    this.tileBordersEnabled.push(this.mapService.maps.getViewTileBorderState(viewIndex));
                    this.tileGridModes.push(this.mapService.maps.getViewTileGridMode(viewIndex));
                });
                this.refreshBackgroundControls();
                while (this.mapsCollapsed.length < this.viewIndices.length) {
                    this.mapsCollapsed.push(false);
                }
                if (this.mapsCollapsed.length > this.viewIndices.length) {
                    this.mapsCollapsed.length = this.viewIndices.length;
                }
                this.syncedOptions = this.viewIndices.map(viewIndex => this.mapService.isSyncOptionsForViewEnabled(viewIndex));
            })
        );

        this.subscriptions.push(
            this.stateService.layerSyncOptionsState.appState.subscribe(_ => {
                const numViews = this.stateService.numViews;
                this.syncedOptions = Array.from({length: numViews}, (_, viewIndex) =>
                    this.mapService.isSyncOptionsForViewEnabled(viewIndex));
            })
        );

        this.subscriptions.push(
            this.stateService.backgroundState.appState.subscribe(_ => this.refreshBackgroundControls())
        );

        this.subscriptions.push(
            this.stateService.mode2dState.appState.subscribe(_ => this.refreshBackgroundControls())
        );

        this.subscriptions.push(
            this.configService.config$.subscribe(_ => this.refreshBackgroundControls())
        );

        this.subscriptions.push(
            this.stateService.viewTileBordersState.appState.subscribe(_ => {
                const numViews = this.stateService.numViews;
                this.tileBordersEnabled = Array.from({length: numViews}, (_, index) =>
                    this.stateService.viewTileBordersState.getValue(index));
            })
        );

        this.subscriptions.push(
            this.stateService.viewTileGridModeState.appState.subscribe(_ => {
                const numViews = this.stateService.numViews;
                this.tileGridModes = Array.from({length: numViews}, (_, index) =>
                    this.stateService.viewTileGridModeState.getValue(index));
            })
        );

        this.subscriptions.push(
            this.stateService.mapsOpenState.subscribe(isOpen => this.layerDialogVisible = isOpen)
        );
    }

    /** Brings the floating maps dialog to the top of the dialog stack when shown. */
    onMapLayerDialogShow() {
        this.dialogStack.bringToFront(this.mapLayerDialog);
    }

    /** Rebuilds the background dropdown contents and resolved per-view selection state. */
    private refreshBackgroundControls() {
        const numViews = this.stateService.numViews;
        const backgroundLayers = this.configService.getBackgroundLayers();
        const defaultBackgroundLayerId = this.configService.getDefaultBackgroundLayerId();

        this.backgroundLayerIds = Array.from({length: numViews}, (_, index) =>
            this.stateService.resolveBackgroundState(index, backgroundLayers, defaultBackgroundLayerId).layerId);
        this.backgroundOpacityValue = Array.from({length: numViews}, (_, index) =>
            this.stateService.getBackgroundOpacity(index));
        this.backgroundOptions = Array.from({length: numViews}, (_, index) =>
            this.createBackgroundOptions(index, backgroundLayers));
        this.backgroundDetails = Array.from({length: numViews}, (_, index) =>
            this.backgroundDetailText(index, backgroundLayers));
        this.backgroundLayerIds.forEach((layerId, index) => {
            if (layerId !== null) {
                this.lastEnabledBackgroundLayerIds[index] = layerId;
            }
        });
        this.lastEnabledBackgroundLayerIds.length = numViews;
    }

    /** Builds the background-layer dropdown options for one view, including 3D WMS gating. */
    private createBackgroundOptions(viewIndex: number, backgroundLayers: readonly BackgroundLayerConfig[]): BackgroundLayerOption[] {
        const is2d = this.stateService.mode2dState.getValue(viewIndex);
        return backgroundLayers.map(layer => ({
            label: layer.name,
            value: layer.id,
            disabled: !is2d && layer.type === "wms",
            experimental: layer.type === "wms"
        }));
    }

    /** Summarizes attribution and capability notes for the currently selected background layer. */
    private backgroundDetailText(viewIndex: number, backgroundLayers: readonly BackgroundLayerConfig[]): string {
        const selectedLayer = backgroundLayers.find(layer => layer.id === this.backgroundLayerIds[viewIndex]);
        if (!selectedLayer) {
            return "";
        }
        const details: string[] = [];
        if (selectedLayer.type === "wms") {
            details.push(WMS_BACKGROUND_EXPERIMENTAL_TOOLTIP);
        }
        if (selectedLayer?.type === "wms" && !this.stateService.mode2dState.getValue(viewIndex)) {
            details.push("WMS backgrounds are currently limited to 2D views.");
        }
        if (selectedLayer.attribution) {
            details.push(selectedLayer.attribution);
        }
        return details.join(' • ');
    }

    /** Opens the bulk layer-toggle menu for one map or layer row. */
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
                        this.mapService.setMapLayerVisibility(viewIndex, layer.mapId, layer.id, true);
                    }
                }
            }
        ];
    }

    /** Toggles the visibility of the maps panel dialog. */
    toggleLayerDialog() {
        this.layerDialogVisible = !this.layerDialogVisible;
    }

    /** Moves the target view camera to the coverage bounds represented by one tree node. */
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
            {
                targetView: viewIndex,
                rectangle: {
                    west: GeoMath.toDegrees(targetRect!.west),
                    south: GeoMath.toDegrees(targetRect!.south),
                    east: GeoMath.toDegrees(targetRect!.east),
                    north: GeoMath.toDegrees(targetRect!.north),
                }
            }
        );
    }

    /** Flattens one tree node's direct child coverage rectangles into a single array. */
    flatCoverage(node: any): (number | CoverageRectItem)[] {
        if (!node || !node.children) {
            return [];
        }
        const coverage: (number | CoverageRectItem)[] = [];
        for (const child of node.children) {
            if (child.info && Array.isArray(child.info.coverage)) {
                coverage.push(...child.info.coverage);
            }
        }
        return coverage;
    }

    /** Writes the current background-layer selection and opacity for one view back into app state. */
    updateBackgroundLayer(viewIndex: number) {
        if (this.backgroundLayerIds[viewIndex] !== null) {
            this.lastEnabledBackgroundLayerIds[viewIndex] = this.backgroundLayerIds[viewIndex];
        }
        this.stateService.setBackgroundState(viewIndex, this.backgroundLayerIds[viewIndex], this.backgroundOpacityValue[viewIndex]);
        this.mapService.syncBackgroundSettings(viewIndex);
    }

    /** Returns whether the selected view currently has a background layer enabled. */
    isBackgroundEnabled(viewIndex: number): boolean {
        return this.backgroundLayerIds[viewIndex] !== null;
    }

    /** Enables or disables the selected view background while remembering the last active layer id locally. */
    setBackgroundEnabled(viewIndex: number, enabled: boolean) {
        if (!enabled) {
            if (this.backgroundLayerIds[viewIndex] !== null) {
                this.lastEnabledBackgroundLayerIds[viewIndex] = this.backgroundLayerIds[viewIndex];
            }
            this.backgroundLayerIds[viewIndex] = null;
            this.updateBackgroundLayer(viewIndex);
            return;
        }

        const restoredLayerId = this.lastEnabledBackgroundLayerIds[viewIndex];
        const restoredOption = this.backgroundOptions[viewIndex]?.find(option =>
            option.value === restoredLayerId && !option.disabled);
        const fallbackOption = this.backgroundOptions[viewIndex]?.find(option => !option.disabled);
        this.backgroundLayerIds[viewIndex] = restoredOption?.value ?? fallbackOption?.value ?? null;
        this.updateBackgroundLayer(viewIndex);
    }

    /** Opens or closes the popup tile-grid controls for the selected view. */
    toggleTileGridPopover(event: MouseEvent, popover: Popover) {
        event.stopPropagation();
        popover.toggle(event);
    }

    /** Opens or closes the popup background controls for the selected view. */
    toggleBackgroundPopover(event: MouseEvent, popover: Popover) {
        event.stopPropagation();
        popover.toggle(event);
    }

    /** Sets the visibility of one map or layer entry for a specific view. */
    toggleLayer(viewIndex: number, mapName: string, layerName: string = "", state: boolean) {
        this.mapService.setMapLayerVisibility(viewIndex, mapName, layerName, state);
    }

    /** Returns the stable test id for one map tab. */
    getMapTabTestId(viewIndex: number): string {
        return `map-tab-${viewIndex}`;
    }

    /** Returns the stable test id for one background-layer selector. */
    getBackgroundSelectTestId(viewIndex: number): string {
        return `background-select-${viewIndex}`;
    }

    /** Returns the stable test id for one background enable switch. */
    getBackgroundEnabledTestId(viewIndex: number): string {
        return `background-enabled-${viewIndex}`;
    }

    /** Returns the stable test id for one tile-grid toolbar button. */
    getTileGridButtonTestId(viewIndex: number): string {
        return `tile-grid-button-${viewIndex}`;
    }

    /** Returns the stable test id for one tile-grid popover. */
    getTileGridPopoverTestId(viewIndex: number): string {
        return `tile-grid-popover-${viewIndex}`;
    }

    /** Returns the stable test id for one tile-grid enable switch. */
    getTileGridEnabledTestId(viewIndex: number): string {
        return `tile-grid-enabled-${viewIndex}`;
    }

    /** Returns the stable test id for one tile-grid mode option. */
    getTileGridModeTestId(viewIndex: number, mode: TileGridMode): string {
        return `tile-grid-mode-${mode}-${viewIndex}`;
    }

    /** Returns the stable test id for one background toolbar button. */
    getBackgroundButtonTestId(viewIndex: number): string {
        return `background-button-${viewIndex}`;
    }

    /** Returns the stable test id for one background settings popover. */
    getBackgroundPopoverTestId(viewIndex: number): string {
        return `background-popover-${viewIndex}`;
    }

    /** Returns the stable test id for one background opacity slider. */
    getBackgroundOpacitySliderTestId(viewIndex: number): string {
        return `background-opacity-slider-${viewIndex}`;
    }

    /** Sets per-view tile-border visualization. */
    setViewTileBorders(viewIndex: number, enabled: boolean) {
        this.mapService.setViewTileBorderVisibility(viewIndex, enabled);
        this.tileBordersEnabled[viewIndex] = this.mapService.maps.getViewTileBorderState(viewIndex);
    }

    /** Sets the tile-grid overlay labeling mode. */
    setTileGridMode(viewIndex: number, mode: TileGridMode) {
        this.tileGridModes[viewIndex] = mode;
        this.mapService.setViewTileGridMode(viewIndex, mode);
    }

    /** Applies a manually chosen layer level and disables auto-level for that layer. */
    onLayerLevelChanged(level: number | null, viewIndex: number, mapName: string, layerName: string) {
        if (level === null || !Number.isFinite(level)) {
            return;
        }
        if (this.mapService.isMapLayerAutoLevelEnabled(viewIndex, mapName, layerName)) {
            this.mapService.setMapLayerAutoLevel(viewIndex, mapName, layerName, false);
        }
        this.mapService.setMapLayerLevel(viewIndex, mapName, layerName, Math.max(0, Math.floor(level)));
    }

    /** Toggles automatic level selection for one layer in one view. */
    toggleLayerAutoLevel(viewIndex: number, mapName: string, layerName: string) {
        const nextState = !this.mapService.isMapLayerAutoLevelEnabled(viewIndex, mapName, layerName);
        this.mapService.setMapLayerAutoLevel(viewIndex, mapName, layerName, nextState);
    }

    /** Returns the effective display level, substituting the auto-level result when needed. */
    displayMapLayerLevel(viewIndex: number, mapName: string, layerName: string, fallbackLevel: number) {
        if (!this.mapService.isMapLayerAutoLevelEnabled(viewIndex, mapName, layerName)) {
            return fallbackLevel;
        }
        return this.mapService.getEffectiveMapLayerLevel(viewIndex, mapName, layerName);
    }

    /** Persists a style option change and triggers visualization refresh for the affected view. */
    updateStyleOption(node: StyleOptionNode, viewIndex: number) {
        this.stateService.setStyleOptionValues(node.mapId, node.layerId, node.shortStyleId, node.id, node.value);
        this.mapService.styleOptionChangedTopic.next([node, viewIndex]);
    }

    /** Adds another synchronized map view up to the current supported limit. */
    addView() {
        // Limit the increment for now since we do not yet support more than 2 views
        if (this.stateService.numViews < 2) {
            this.stateService.numViews += 1;
        }
    }

    /** Removes one view, keeping at least a single map view alive. */
    removeView(event: MouseEvent, index: number) {
        event.stopPropagation();
        // Right now we just decrement, but for more than 2 views we should consider the actual indices
        // We cannot have fewer views than at least 1
        if (this.stateService.numViews > 1) {
            this.viewIndices.pop();
            this.stateService.numViews -= 1;
        }
    }

    /** Toggles option synchronization for the selected view. */
    syncOptionsForView(event: Event, viewIndex: number) {
        event.stopPropagation();
        const nextState = !this.mapService.isSyncOptionsForViewEnabled(viewIndex);
        this.mapService.setSyncOptionsForView(viewIndex, nextState);
        const numViews = this.stateService.numViews;
        this.syncedOptions = Array.from({length: numViews}, (_, index) =>
            this.mapService.isSyncOptionsForViewEnabled(index));
    }

    /** Closes the maps panel through shared app state. */
    protected closeMapsPanel() {
        this.stateService.mapsOpenState.next(false);
    }

    protected readonly removeGroupPrefix = removeGroupPrefix;
}
