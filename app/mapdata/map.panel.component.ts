import {Component, ViewChild} from "@angular/core";
import {MapInfoService} from "./map-info.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {
    AppStateService,
    DEFAULT_TILE_GRID_COLOR,
    DEFAULT_TILE_GRID_OPACITY,
    SelectedSourceData,
    TileGridMode,
    tileGridMaxLevel
} from "../shared/appstate.service";
import {coreLib} from "../integrations/wasm";
import {MenuItem, TreeNode} from "primeng/api";
import {Menu} from "primeng/menu";
import {Popover} from "primeng/popover";
import {KeyboardService} from "../shared/keyboard.service";
import {AppModeService} from "../shared/app-mode.service";
import {
    CoverageRectItem,
    dataSourceCatalogStatus,
    filterMapTreeNodes,
    layerPresetNode,
    layerStyleOptions,
    LayerPresetNode,
    MapInfoItem,
    MapTreeViewNode,
    removeGroupPrefix,
    StyleOptionNode
} from "./map.tree.model";
import {
    BehaviorSubject,
    combineLatest,
    distinctUntilChanged,
    filter,
    map,
    Observable,
    of,
    startWith,
    Subscription,
    switchMap,
    timer
} from "rxjs";
import {GeoMath, Rectangle} from "../integrations/geo";
import {DialogStackService} from "../shared/dialog-stack.service";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {
    AppConfigService,
    BackgroundLayerConfig,
    WMS_BACKGROUND_EXPERIMENTAL_TOOLTIP
} from "../shared/app-config.service";
import {FeatureSearchService} from "../search/feature.search.service";
import type {FeatureSearchMapLayerRef} from "../shared/feature-search-state";
import {InfoMessageService} from "../shared/info.service";
import {StyleEditorRequestService} from "../styledata/style-editor-request.service";
import {StyleService} from "../styledata/style.service";
import {
    MapPresetService,
    NO_PRESET_ID
} from "../styledata/map-preset.service";

/** One rendered select option in the per-view background-layer dropdown. */
interface BackgroundLayerOption {
    label: string;
    value: string | null;
    disabled: boolean;
    experimental: boolean;
}

/** Searchable metadata-layer choice shown by a map node. */
interface MetadataLayerOption {
    label: string;
    mapTileKey: string;
}

/** Map-tree data projected for display without changing the canonical map or datasource state. */
interface MapPanelTreeView {
    size: number;
    nodesByView: MapTreeViewNode[][];
}

/** Mirrors PrimeNG TreeTable's default delay so rapid typing produces one applied map filter. */
const MAP_FILTER_DELAY_MS = 300;

@Component({
    selector: 'map-panel',
    template: `
        <app-dialog #mapLayerDialog class="map-layer-dialog" data-testid="map-layer-dialog" header=""
                  [visible]="layerDialogVisible"
                  (visibleChange)="setMapsPanelVisible($event)"
                  [position]="'left'" [draggable]="false" [resizable]="false" 
                  (onShow)="onMapLayerDialogShow()"
                  [style]="{ 'max-height': '100%', 
                  'border-top-left-radius': '0 !important',
                  'border-bottom-left-radius': '0 !important' }">
            <p-button class="close-maps-button" icon="pi pi-times" severity="secondary" (click)="closeMapsPanel()"
                      (mousedown)="$event.stopPropagation()"/>
            <ng-container *ngIf="mapTreeView$ | async as mapTreeView">
            <div class="map-filter" data-testid="map-filter">
                <p-iconfield class="input-container">
                    <p-inputicon class="pi pi-filter"/>
                    <input class="filter-input" data-testid="map-filter-input" type="text" pInputText
                           placeholder="Filter maps, layers, and options"
                           aria-label="Filter maps, layers, and options"
                           [ngModel]="mapFilterText"
                           (ngModelChange)="updateMapFilter($event)"
                           (keydown.escape)="clearMapFilter(); $event.stopPropagation()"/>
                    @if (mapFilterText) {
                        <i onEnterClick class="pi pi-times clear-icon" data-testid="map-filter-clear"
                           role="button" tabindex="0" aria-label="Clear map filter"
                           (click)="clearMapFilter()"></i>
                    }
                </p-iconfield>
            </div>
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
                                            <div class="tile-grid-level-row" [ngClass]="{'disabled': !tileBordersEnabled[index]}">
                                                <label [for]="'tile-grid-level-' + index">Level</label>
                                                <div class="tile-grid-level-controls">
                                                    <p-inputNumber [ngModel]="displayTileGridLevel(index)"
                                                                   (ngModelChange)="onTileGridLevelChanged(index, $event)"
                                                                   [showButtons]="true"
                                                                   [min]="0"
                                                                   [max]="maxTileGridLevel(tileGridModes[index])"
                                                                   buttonLayout="horizontal"
                                                                   spinnerMode="horizontal"
                                                                   [inputId]="'tile-grid-level-' + index"
                                                                   decrementButtonClass="p-button-secondary"
                                                                   incrementButtonClass="p-button-secondary"
                                                                   incrementButtonIcon="pi pi-plus"
                                                                   decrementButtonIcon="pi pi-minus"
                                                                   pTooltip="Change grid level"
                                                                   tooltipPosition="bottom"
                                                                   [disabled]="!tileBordersEnabled[index]"
                                                                   [attr.data-testid]="getTileGridLevelTestId(index)"
                                                                   tabindex="0"/>
                                                    <p-button onEnterClick
                                                              (click)="toggleTileGridAutoLevel(index)"
                                                              [styleClass]="tileGridAutoLevels[index] ? 'map-controls-button p-button-success' : 'map-controls-button p-button-secondary'"
                                                              [style]="{'min-width': '3.75em', 'padding-left': '0.35em', 'padding-right': '0.35em'}"
                                                              label="AUTO"
                                                              pTooltip="Automatically select the grid level"
                                                              tooltipPosition="bottom"
                                                              [disabled]="!tileBordersEnabled[index]"
                                                              [attr.data-testid]="getTileGridAutoLevelTestId(index)"
                                                              tabindex="0"/>
                                                </div>
                                            </div>
                                            <div class="tile-grid-appearance-row" [ngClass]="{'disabled': !tileBordersEnabled[index]}">
                                                <p-colorpicker class="tile-grid-color-picker"
                                                               [ngModel]="tileGridColors[index]"
                                                               (ngModelChange)="setTileGridColor(index, $event)"
                                                               format="hex"
                                                               appendTo="body"
                                                               [overlayOptions]="{autoZIndex: true, baseZIndex: 30010}"
                                                               [disabled]="!tileBordersEnabled[index]"
                                                               [attr.data-testid]="getTileGridColorTestId(index)"/>
                                                <span class="tile-grid-opacity-value">{{ tileGridOpacities[index] }}%</span>
                                                <p-slider class="tile-grid-opacity-slider"
                                                          [ngModel]="tileGridOpacities[index]"
                                                          (ngModelChange)="setTileGridOpacity(index, $event)"
                                                          orientation="horizontal"
                                                          [min]="0"
                                                          [max]="100"
                                                          [disabled]="!tileBordersEnabled[index]"
                                                          [attr.data-testid]="getTileGridOpacityTestId(index)"
                                                          tabindex="-1"/>
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
                            @if (mapAccordionValue.includes(index)) {
                            @if (!mapTreeView.size) {
                                    <div class="map-tree-message">
                                        No maps loaded.
                                    </div>
                            } @else if (!mapTreeView.nodesByView[index]?.length) {
                                <div class="map-tree-message" data-testid="map-filter-empty">
                                    No matching maps, layers, presets, or options.
                                </div>
                            } @else {
                            <div class="maps-container">
                                <p-tree [value]="mapTreeView.nodesByView[index]" [trackBy]="trackMapTreeNode"
                                        (onNodeExpand)="updateMapTreeNodeExpansion($event.node, true)"
                                        (onNodeCollapse)="updateMapTreeNodeExpansion($event.node, false)"
                                        [attr.data-testid]="'map-tree-' + index">
                                    <!-- Template for Group nodes -->
                                    <ng-template let-node pTemplate="Group">
                                        <div class="flex-container map-group-row">
                                            <span class="checkbox-entry map-tree-title">
                                                <span onEnterClick class="material-symbols-outlined menu-toggler" tabindex="0"
                                                      (click)="showLayersToggleMenu($event, index, node.id+'/', '')">
                                                    more_vert
                                                </span>
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
                                        <p-popover #metadataPopover
                                                   styleClass="metadata-layer-popover"
                                                   [baseZIndex]="30000"
                                                   appendTo="body">
                                            <p-listbox class="metadata-layer-listbox"
                                                       [options]="metadataLayerOptions.get(node.id) ?? []"
                                                       optionLabel="label"
                                                       [filter]="true"
                                                       filterBy="label"
                                                       filterPlaceHolder="Search metadata"
                                                       ariaFilterLabel="Search metadata"
                                                       emptyFilterMessage="No matching metadata"
                                                       scrollHeight="min(24rem, calc(100vh - 10rem))"
                                                       [ngModel]="null"
                                                       (onChange)="inspectMetadataLayer($event.value, metadataPopover)">
                                                <ng-template let-option pTemplate="item">
                                                    <span class="metadata-layer-option"
                                                          [title]="option.label">{{ option.label }}</span>
                                                </ng-template>
                                            </p-listbox>
                                        </p-popover>
                                        <div class="flex-container map-tree-row"
                                             [ngClass]="{'has-datasource-status': dataSourceStatus(node.info) !== 'ready'}">
                                            <span class="checkbox-entry map-tree-title">
                                                @if (dataSourceStatus(node.info) !== 'ready') {
                                                    <span class="datasource-status"
                                                          [ngClass]="dataSourceStatusClass(node.info)"
                                                          [style.--datasource-progress]="dataSourceProgressIndicator(node.info)"
                                                          [pTooltip]="dataSourceStatusTooltip(node.info)"
                                                          tooltipPosition="bottom">
                                                    </span>
                                                }
                                                <span onEnterClick class="material-symbols-outlined menu-toggler" tabindex="0"
                                                      (click)="showLayersToggleMenu($event, index, node.id, '')">
                                                        more_vert
                                                </span>
                                                <p-checkbox [(ngModel)]="node.visible[index]"
                                                            (click)="$event.stopPropagation()"
                                                            (ngModelChange)="toggleLayer(index, node.id, '', node.visible[index])"
                                                            [binary]="true"
                                                            [disabled]="dataSourceStatus(node.info) !== 'ready'"
                                                            [inputId]="index + '_' + node.id"
                                                            [name]="index + '_' + node.id" tabindex="0"/>
                                                <label [for]="index + '_' + node.id"
                                                       [ngClass]="{'disabled-label': dataSourceStatus(node.info) !== 'ready'}">
                                                    {{ removeGroupPrefix(node.id) }}
                                                </label>
                                            </span>
                                            <div class="map-controls">
                                                @if (node.mapPresets.length > 0) {
                                                    <p-select class="map-preset-select"
                                                              [options]="mapPresetOptionsForView(node.id, index)"
                                                              [ngModel]="node.selectedMapPresetIds[index]"
                                                              (ngModelChange)="selectMapPreset(node.id, index, $event)"
                                                              optionLabel="label"
                                                              optionValue="value"
                                                              optionDisabled="disabled"
                                                              appendTo="body"
                                                              [disabled]="dataSourceStatus(node.info) !== 'ready'"
                                                              [attr.aria-label]="'Map preset for ' + node.id"/>
                                                }
                                                <p-button onEnterClick (click)="focus($event, index, mapCoverage(node.id))"
                                                          label="" pTooltip="Focus on map" tooltipPosition="bottom"
                                                          [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                          tabindex="0"
                                                          *ngIf="mapCoverage(node.id).length">
                                                    <span class="material-symbols-outlined"
                                                          style="font-size: 1.2em; margin: 0 auto;">center_focus_strong</span>
                                                        </p-button>
                                                        <p-button onEnterClick (click)="metadataPopover.toggle($event)" label=""
                                                                  pTooltip="{{!metadataLayerOptions.get(node.id)?.length ? 'No metadata available' : 'Request service metadata'}}"
                                                                  tooltipPosition="bottom"
                                                                  [style]="{'padding-left': '0', 'padding-right': '0'}"
                                                                  tabindex="0"
                                                                  [disabled]="!metadataLayerOptions.get(node.id)?.length">
                                                    <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">
                                                        data_object
                                                    </span>
                                                </p-button>
                                            </div>
                                        </div>
                                    </ng-template>
                                    <!-- Template for Feature Layer nodes -->
                                    <ng-template let-node pTemplate="Features">
                                        <div *ngIf="node.type != 'SourceData'" class="flex-container map-layer-row">
                                            <div class="font-bold white-space-nowrap layer-tree-title">
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
                                                      style="font-size: 1.2em; margin: 0 auto;">
                                                        center_focus_strong
                                                    </span>
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
                                    <!-- Template for the leading layer-preset control. -->
                                    <ng-template let-node pTemplate="Preset">
                                        <div class="style-preset-row"
                                             [attr.data-testid]="stylePresetRowTestId(node, index)">
                                            <p-select class="style-preset-select"
                                                      [options]="node.selectOptions"
                                                      [ngModel]="node.selectedPresetKeys[index]"
                                                      (ngModelChange)="selectLayerPreset(node, index, $event)"
                                                      optionLabel="label"
                                                      optionValue="value"
                                                      appendTo="body"
                                                      [disabled]="node.presets.length === 0"
                                                      [attr.aria-label]="'Layer preset for ' + node.layerId"/>
                                            @if (node.selectedPresetKeys[index]) {
                                                @if (!isMapPresetProjection(node, index)) {
                                                    <p-button onEnterClick
                                                              class="style-preset-expand-button"
                                                              [attr.data-testid]="stylePresetExpandTestId(node, index)"
                                                              [pTooltip]="node.expandedPresetOptions[index]
                                                                  ? 'Hide preset options'
                                                                  : 'Show preset options'"
                                                              tooltipPosition="bottom"
                                                              (click)="toggleStylePresetOptions($event, node, index)">
                                                        <span class="material-symbols-outlined">
                                                            {{ node.expandedPresetOptions[index] ? "unfold_less" : "unfold_more" }}
                                                        </span>
                                                    </p-button>
                                                }
                                                @for (styleId of selectedPresetStyleIds(node, index); track styleId) {
                                                    <p-button onEnterClick
                                                              class="style-option-edit-button"
                                                              [attr.data-testid]="stylePresetEditButtonTestId(node, index, styleId)"
                                                              pTooltip="Edit style sheet"
                                                              tooltipPosition="bottom"
                                                              (click)="openPresetStyleSheet($event, styleId)">
                                                        <span class="material-symbols-outlined">brush</span>
                                                    </p-button>
                                                }
                                            }
                                        </div>
                                    </ng-template>
                                    <!-- Template for boolean style option nodes -->
                                    <ng-template let-node pTemplate="Bool">
                                        <div class="map-option-row"
                                             [class.style-option-group-highlight]="isStyleOptionGroupActive(node, index)"
                                             [attr.data-style-option-group]="styleOptionGroupKey(node, index)"
                                             (mouseenter)="activateStyleOptionGroup(node, index)"
                                             (mouseleave)="deactivateStyleOptionGroup($event, node, index)"
                                             (focusin)="activateStyleOptionGroup(node, index)"
                                             (focusout)="deactivateStyleOptionGroup($event, node, index)">
                                        <span class="checkbox-entry oblique"
                                              [ngClass]="{'disabled': !mapService.maps.getMapLayerVisibility(index, node.mapId, node.layerId)}">
                                            <p-checkbox
                                                    [attr.data-testid]="styleOptionCheckboxTestId(node, index)"
                                                    [(ngModel)]="node.value[index]"
                                                    (ngModelChange)="updateStyleOption(node, index)"
                                                    [binary]="true"
                                                    [inputId]="index + '_' + node.key"
                                                    [name]="index + '_' + node.key"/>
                                            <label [for]="index + '_' + node.key">{{ node.info.label }}</label>
                                        </span>
                                        @if (node.firstInStyleGroup) {
                                            <p-button onEnterClick class="style-option-edit-button"
                                                      [attr.data-testid]="styleOptionEditButtonTestId(node, index)"
                                                      (click)="openStyleSheet($event, node)"
                                                      pTooltip="Edit style sheet"
                                                      tooltipPosition="bottom"
                                                      tabindex="0">
                                                <span class="material-symbols-outlined">brush</span>
                                            </p-button>
                                        }
                                        </div>
                                    </ng-template>
                                    <!-- TODO: Add Templates for String/Color Options, and ignore internal ones. -->
                                </p-tree>
                            </div>
                            }
                            }
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
            </ng-container>
        </app-dialog>
        <p-menu #menu [model]="toggleMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}"></p-menu>
    `,
    standalone: false
})
/**
 * Renders the maps-and-layers panel and translates its UI controls into map-service and
 * app-state updates for the active views, including tile-grid and background-layer controls.
 */
export class MapPanelComponent {
    protected readonly wmsExperimentalTooltip = WMS_BACKGROUND_EXPERIMENTAL_TOOLTIP;

    mapFilterText = "";
    private readonly mapFilterTextChanges = new BehaviorSubject("");
    private readonly appliedMapFilterTextChanges = this.mapFilterTextChanges.pipe(
        map(filterText => filterText.trim()),
        switchMap(filterText => filterText
            ? timer(MAP_FILTER_DELAY_MS).pipe(map(() => filterText))
            : of(filterText)
        ),
        distinctUntilChanged()
    );
    private readonly stylePresetProjectionChanges = new BehaviorSubject(0);
    readonly mapTreeView$: Observable<MapPanelTreeView> = combineLatest([
        this.mapService.maps$,
        this.appliedMapFilterTextChanges,
        this.styleService.styleGroups,
        this.stateService.numViewsState,
        this.mapPresetService.presets$,
        this.stateService.layerPresetSelectionState.appState,
        this.stateService.mapPresetSelectionState.appState,
        this.stylePresetProjectionChanges,
        this.mapService.layerStateChanged.pipe(
            filter(reason => reason === "visibility"),
            startWith("visibility")
        )
    ]).pipe(
        map(([mapTree, filterText, _styleGroups, numViews]) => ({
            size: mapTree.size,
            nodesByView: Array.from(
                {length: numViews},
                (_, viewIndex) => filterMapTreeNodes(mapTree.nodes, filterText, viewIndex))
        }))
    );

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
    tileGridAutoLevels: boolean[] = [false];
    tileGridColors: string[] = [DEFAULT_TILE_GRID_COLOR];
    tileGridOpacities: number[] = [DEFAULT_TILE_GRID_OPACITY];
    activeStyleOptionGroup: string | null = null;

    syncedOptions: boolean[] = [];
    layerDialogVisible: boolean = false;

    @ViewChild('menu') toggleMenu!: Menu;
    toggleMenuItems: MenuItem[] | undefined;

    @ViewChild('mapLayerDialog') mapLayerDialog: AppDialogComponent | undefined;

    metadataLayerOptions = new Map<string, MetadataLayerOption[]>();

    /** Subscribes the panel UI to map, app-state, and dialog-stack updates. */
    constructor(public mapService: MapInfoService,
                private readonly viewState: MapViewStateService,
                public appModeService: AppModeService,
                public stateService: AppStateService,
                public keyboardService: KeyboardService,
                private readonly configService: AppConfigService,
                private readonly dialogStack: DialogStackService,
                private readonly featureSearchService: FeatureSearchService,
                private readonly infoMessageService: InfoMessageService,
                private readonly styleEditorRequestService: StyleEditorRequestService,
                private readonly mapPresetService: MapPresetService,
                private readonly styleService: StyleService) {
        this.keyboardService.registerShortcut('m', this.toggleLayerDialog.bind(this), true);

        this.subscriptions.push(
            // Rebuild metadata menus recursively and prune when needed.
            this.mapService.maps$.subscribe(mapTree => {
                this.metadataLayerOptions.clear();
                for (const [_, mapItem] of mapTree.maps) {
                    this.metadataLayerOptions.set(
                        mapItem.id,
                        this.mapService.findLayersForMapId(mapItem.id, true)
                            .map(layer => ({
                                label: layer.name,
                                mapTileKey: coreLib.getSourceDataLayerKey(mapItem.id, layer.id, 0)
                            }))
                    );
                }
                const numViews = this.stateService.numViews;
                this.tileBordersEnabled = Array.from({length: numViews}, (_, index) =>
                    this.mapService.maps.getViewTileBorderState(index));
                this.tileGridModes = Array.from({length: numViews}, (_, index) =>
                    this.mapService.maps.getViewTileGridMode(index));
                this.refreshTileGridControls();
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
                this.refreshTileGridControls();
                this.refreshBackgroundControls();
                while (this.mapsCollapsed.length < this.viewIndices.length) {
                    this.mapsCollapsed.push(false);
                }
                if (this.mapsCollapsed.length > this.viewIndices.length) {
                    this.mapsCollapsed.length = this.viewIndices.length;
                }
                this.syncedOptions = this.viewIndices.map(viewIndex => this.viewState.isSyncOptionsForViewEnabled(viewIndex));
            })
        );

        this.subscriptions.push(
            this.stateService.layerSyncOptionsState.appState.subscribe(_ => {
                const numViews = this.stateService.numViews;
                this.syncedOptions = Array.from({length: numViews}, (_, viewIndex) =>
                    this.viewState.isSyncOptionsForViewEnabled(viewIndex));
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
                this.refreshTileGridControls();
            })
        );

        this.subscriptions.push(
            this.stateService.viewTileGridLevelState.appState.subscribe(_ => this.refreshTileGridControls())
        );
        this.subscriptions.push(
            this.stateService.viewTileGridAutoLevelState.appState.subscribe(_ => this.refreshTileGridControls())
        );
        this.subscriptions.push(
            this.stateService.viewTileGridColorState.appState.subscribe(_ => this.refreshTileGridControls())
        );
        this.subscriptions.push(
            this.stateService.viewTileGridOpacityState.appState.subscribe(_ => this.refreshTileGridControls())
        );

        this.subscriptions.push(
            this.stateService.mapsOpenState.subscribe(isOpen => this.layerDialogVisible = isOpen)
        );
    }

    /** Brings the floating maps dialog to the top of the dialog stack when shown. */
    onMapLayerDialogShow() {
        this.dialogStack.bringToFront(this.mapLayerDialog);
    }

    /** Applies one presentation filter to the map trees rendered for every view. */
    updateMapFilter(filterText: string) {
        this.mapFilterText = filterText;
        this.mapFilterTextChanges.next(filterText);
    }

    /** Clears the session-local map-tree filter and restores the canonical tree presentation. */
    clearMapFilter() {
        this.updateMapFilter("");
    }

    /** Keeps PrimeNG tree components attached to the same logical nodes across filter projections. */
    readonly trackMapTreeNode = (
        _index: number,
        node: MapTreeViewNode
    ): string => node.key;

    /** Persists normal tree expansion while keeping filtered projection expansion temporary. */
    updateMapTreeNodeExpansion(node: TreeNode, expanded: boolean): void {
        if (!this.mapFilterText.trim() && node.key !== undefined) {
            this.mapService.maps.setNodeExpanded(node.key, expanded);
        }
    }

    /** Refreshes independent tile-grid controls from their per-view AppState values. */
    private refreshTileGridControls(): void {
        const numViews = this.stateService.numViews;
        this.tileGridAutoLevels = Array.from({length: numViews}, (_, index) =>
            this.mapService.maps.getViewTileGridAutoLevel(index));
        this.tileGridColors = Array.from({length: numViews}, (_, index) =>
            this.mapService.maps.getViewTileGridColor(index));
        this.tileGridOpacities = Array.from({length: numViews}, (_, index) =>
            this.mapService.maps.getViewTileGridOpacity(index));
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
        const selectedMapLayers = this.featureSearchMapLayersForMenuScope(mapId, layerId);
        this.toggleMenuItems = [
            {
                label: 'Toggle All Off But This',
                command: () => {
                    for (const layer of this.mapService.maps.allFeatureLayers()) {
                        this.viewState.setMapLayerVisibility(viewIndex, layer.mapId, layer.id, layer.mapId.startsWith(mapId) && (!layerId || layer.id === layerId));
                    }
                }
            },
            {
                label: 'Toggle All On But This',
                command: () => {
                    for (const layer of this.mapService.maps.allFeatureLayers()) {
                        this.viewState.setMapLayerVisibility(viewIndex, layer.mapId, layer.id, !layer.mapId.startsWith(mapId) || !!(layerId && layer.id !== layerId));
                    }
                }
            },
            {
                label: 'Toggle All Off',
                command: () => {
                    for (const layer of this.mapService.maps.allFeatureLayers()) {
                        this.viewState.setMapLayerVisibility(viewIndex, layer.mapId, layer.id, false);
                    }
                }
            },
            {
                label: 'Toggle All On',
                command: () => {
                    for (const layer of this.mapService.maps.allFeatureLayers()) {
                        this.viewState.setMapLayerVisibility(viewIndex, layer.mapId, layer.id, true);
                    }
                }
            },
            {separator: true},
            {
                label: this.featureSearchMenuLabel(mapId, layerId, selectedMapLayers.length),
                icon: 'pi pi-search',
                disabled: selectedMapLayers.length === 0,
                command: () => {
                    this.startScopedFeatureSearch(viewIndex, selectedMapLayers);
                }
            }
        ];
    }

    /** Collects feature layers covered by one maps-panel row, preserving tree order and excluding SourceData. */
    private featureSearchMapLayersForMenuScope(mapId: string, layerId: string): FeatureSearchMapLayerRef[] {
        const isExactMap = this.mapService.maps.maps.has(mapId);
        const result: FeatureSearchMapLayerRef[] = [];
        for (const layer of this.mapService.maps.allFeatureLayers()) {
            const mapMatches = isExactMap ? layer.mapId === mapId : layer.mapId.startsWith(mapId);
            if (!mapMatches || (layerId && layer.id !== layerId)) {
                continue;
            }
            result.push({mapId: layer.mapId, layerId: layer.id});
        }
        return result;
    }

    /** Labels the row-scoped feature-search action for map, group, and layer rows. */
    private featureSearchMenuLabel(mapId: string, layerId: string, layerCount: number): string {
        if (!layerCount) {
            return "No Feature Layers to Search";
        }
        if (layerId) {
            return "Search Features in This Layer";
        }
        return this.mapService.maps.maps.has(mapId)
            ? "Search Features in This Map"
            : "Search Features in This Group";
    }

    /** Starts a feature search scoped to the selected maps-panel row and current view. */
    private startScopedFeatureSearch(viewIndex: number, selectedMapLayers: FeatureSearchMapLayerRef[]): void {
        if (!selectedMapLayers.length) {
            return;
        }
        this.featureSearchService.run("true", {
            selectedMapLayers,
            selectedMapLayersManual: true,
            selectedViewIndices: [viewIndex]
        });
        this.infoMessageService.showInfo(
            selectedMapLayers.length === 1
                ? "Started search in selected layer"
                : `Started search in ${selectedMapLayers.length} selected layers`
        );
    }

    /** Toggles the visibility of the maps panel dialog. */
    toggleLayerDialog() {
        this.setMapsPanelVisible(!this.layerDialogVisible);
    }

    /** Moves the target view camera to the coverage bounds represented by one tree node. */
    focus(event: any, viewIndex: number, coverages: (number | CoverageRectItem)[]) {
        event.stopPropagation();
        let tileIds = coverages.map(coverage => {
            return coverage.hasOwnProperty("min") && coverage.hasOwnProperty("max") ?
                [Number((coverage as CoverageRectItem).min), Number((coverage as CoverageRectItem).max)] :
                [Number(coverage as number)]
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
        this.viewState.moveToRectangleTopic.next(
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

    /** Collects full map coverage from the canonical tree, independent of the filtered presentation. */
    mapCoverage(mapId: string): (number | CoverageRectItem)[] {
        const mapNode = this.mapService.maps.maps.get(mapId);
        if (!mapNode) {
            return [];
        }
        const coverage: (number | CoverageRectItem)[] = [];
        for (const child of mapNode.children) {
            coverage.push(...child.info.coverage);
        }
        return coverage;
    }

    /** Writes the current background-layer selection and opacity for one view back into app state. */
    updateBackgroundLayer(viewIndex: number) {
        if (this.backgroundLayerIds[viewIndex] !== null) {
            this.lastEnabledBackgroundLayerIds[viewIndex] = this.backgroundLayerIds[viewIndex];
        }
        this.stateService.setBackgroundState(viewIndex, this.backgroundLayerIds[viewIndex], this.backgroundOpacityValue[viewIndex]);
        this.viewState.syncBackgroundSettings(viewIndex);
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

    /** Opens the selected tile-zero metadata layer and closes its picker. */
    inspectMetadataLayer(option: MetadataLayerOption | null, popover: Popover): void {
        if (!option) {
            return;
        }
        this.stateService.setSelection({
            mapTileKey: option.mapTileKey
        } as SelectedSourceData);
        popover.hide();
    }

    /** Sets the visibility of one map or layer entry for a specific view. */
    toggleLayer(viewIndex: number, mapName: string, layerName: string = "", state: boolean) {
        this.viewState.setMapLayerVisibility(viewIndex, mapName, layerName, state);
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

    /** Returns the stable test id for one tile-grid level input. */
    getTileGridLevelTestId(viewIndex: number): string {
        return `tile-grid-level-${viewIndex}`;
    }

    /** Returns the stable test id for one tile-grid auto-level button. */
    getTileGridAutoLevelTestId(viewIndex: number): string {
        return `tile-grid-auto-level-${viewIndex}`;
    }

    /** Returns the stable test id for one tile-grid colour picker. */
    getTileGridColorTestId(viewIndex: number): string {
        return `tile-grid-color-${viewIndex}`;
    }

    /** Returns the stable test id for one tile-grid opacity slider. */
    getTileGridOpacityTestId(viewIndex: number): string {
        return `tile-grid-opacity-${viewIndex}`;
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
        this.viewState.setViewTileBorderVisibility(viewIndex, enabled);
        this.tileBordersEnabled[viewIndex] = this.mapService.maps.getViewTileBorderState(viewIndex);
    }

    /** Sets the tile-grid overlay labeling mode. */
    setTileGridMode(viewIndex: number, mode: TileGridMode) {
        this.tileGridModes[viewIndex] = mode;
        this.viewState.setViewTileGridMode(viewIndex, mode);
        this.refreshTileGridControls();
    }

    /** Returns the highest grid level supported by one coordinate mode. */
    maxTileGridLevel(mode: TileGridMode): number {
        return tileGridMaxLevel(mode);
    }

    /** Applies a manually chosen grid level and disables automatic level selection. */
    onTileGridLevelChanged(viewIndex: number, level: number | null): void {
        if (level === null || !Number.isFinite(level)) {
            return;
        }
        if (this.viewState.isViewTileGridAutoLevelEnabled(viewIndex)) {
            this.viewState.setViewTileGridAutoLevel(viewIndex, false);
        }
        this.viewState.setViewTileGridLevel(viewIndex, Math.max(0, Math.floor(level)));
        this.refreshTileGridControls();
    }

    /** Toggles automatic viewport-based level selection for one grid. */
    toggleTileGridAutoLevel(viewIndex: number): void {
        const nextState = !this.viewState.isViewTileGridAutoLevelEnabled(viewIndex);
        this.viewState.setViewTileGridAutoLevel(viewIndex, nextState);
        this.refreshTileGridControls();
    }

    /** Returns the grid level currently shown or rendered for one view. */
    displayTileGridLevel(viewIndex: number): number {
        return this.viewState.getEffectiveViewTileGridLevel(viewIndex);
    }

    /** Sets the line-grid RGB colour for one view. */
    setTileGridColor(viewIndex: number, color: string): void {
        this.viewState.setViewTileGridColor(viewIndex, color);
        this.refreshTileGridControls();
    }

    /** Sets the line-grid opacity percentage for one view. */
    setTileGridOpacity(viewIndex: number, opacity: number | null): void {
        if (opacity === null) {
            return;
        }
        this.viewState.setViewTileGridOpacity(viewIndex, opacity);
        this.refreshTileGridControls();
    }

    /** Returns the view/layer-qualified identity of one stylesheet option group. */
    styleOptionGroupKey(node: StyleOptionNode, viewIndex: number): string {
        return `${viewIndex}:${node.mapId}:${node.layerId}:${node.styleOptionGroupId}`;
    }

    /** Marks every option from the hovered or focused stylesheet group as active. */
    activateStyleOptionGroup(node: StyleOptionNode, viewIndex: number): void {
        this.activeStyleOptionGroup = this.styleOptionGroupKey(node, viewIndex);
    }

    /** Clears the group unless pointer or focus moved to another row in the same group. */
    deactivateStyleOptionGroup(event: MouseEvent | FocusEvent, node: StyleOptionNode, viewIndex: number): void {
        const groupKey = this.styleOptionGroupKey(node, viewIndex);
        const relatedTarget = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
        const relatedGroup = relatedTarget?.closest<HTMLElement>(".map-option-row")?.dataset["styleOptionGroup"];
        if (relatedGroup !== groupKey && this.activeStyleOptionGroup === groupKey) {
            this.activeStyleOptionGroup = null;
        }
    }

    /** Returns whether one rendered option belongs to the current hover or focus group. */
    isStyleOptionGroupActive(node: StyleOptionNode, viewIndex: number): boolean {
        return this.activeStyleOptionGroup === this.styleOptionGroupKey(node, viewIndex);
    }

    /** Requests the existing guarded style editor for a map option's stylesheet. */
    openStyleSheet(event: Event, node: StyleOptionNode): void {
        event.preventDefault();
        event.stopPropagation();
        this.styleEditorRequestService.open(node.styleId);
    }

    /** Returns the stable editor-button test id for one style group in one view. */
    styleOptionEditButtonTestId(node: StyleOptionNode, viewIndex: number): string {
        const suffix = `${node.mapId}-${node.layerId}-${node.styleOptionGroupId}`
            .replace(/[^a-zA-Z0-9_-]+/g, "-");
        return `style-option-edit-${viewIndex}-${suffix}`;
    }

    /** Returns a stable selector for one concrete option checkbox. */
    styleOptionCheckboxTestId(node: StyleOptionNode, viewIndex: number): string {
        const suffix = `${node.mapId}-${node.layerId}-${node.styleId}-${node.id}`
            .replace(/[^a-zA-Z0-9_-]+/g, "-");
        return `style-option-${viewIndex}-${suffix}`;
    }

    /** Applies a manually chosen layer level and disables auto-level for that layer. */
    onLayerLevelChanged(level: number | null, viewIndex: number, mapName: string, layerName: string) {
        if (level === null || !Number.isFinite(level)) {
            return;
        }
        if (this.viewState.isMapLayerAutoLevelEnabled(viewIndex, mapName, layerName)) {
            this.viewState.setMapLayerAutoLevel(viewIndex, mapName, layerName, false);
        }
        this.viewState.setMapLayerLevel(viewIndex, mapName, layerName, Math.max(0, Math.floor(level)));
    }

    /** Toggles automatic level selection for one layer in one view. */
    toggleLayerAutoLevel(viewIndex: number, mapName: string, layerName: string) {
        const nextState = !this.viewState.isMapLayerAutoLevelEnabled(viewIndex, mapName, layerName);
        this.viewState.setMapLayerAutoLevel(viewIndex, mapName, layerName, nextState);
    }

    /** Returns the effective display level, substituting the auto-level result when needed. */
    displayMapLayerLevel(viewIndex: number, mapName: string, layerName: string, fallbackLevel: number) {
        if (!this.viewState.isMapLayerAutoLevelEnabled(viewIndex, mapName, layerName)) {
            return fallbackLevel;
        }
        return this.viewState.getEffectiveMapLayerLevel(viewIndex, mapName, layerName);
    }

    /** Returns the catalog startup status for a map tree entry. */
    dataSourceStatus(mapInfo: MapInfoItem) {
        return dataSourceCatalogStatus(mapInfo);
    }

    /** Maps datasource startup status to the small connectivity indicator class. */
    dataSourceStatusClass(mapInfo: MapInfoItem): string {
        return dataSourceCatalogStatus(mapInfo);
    }

    /** Returns a concise datasource status tooltip for ready, initializing, and failed entries. */
    dataSourceStatusTooltip(mapInfo: MapInfoItem): string {
        return this.mapService.dataSourceStatusText(mapInfo);
    }

    /** Returns the CSS percentage used by the datasource loading pie indicator. */
    dataSourceProgressIndicator(mapInfo: MapInfoItem): string {
        const progress = this.mapService.dataSourceProgressPercent(mapInfo);
        return progress === null ? "0%" : `${progress}%`;
    }

    /** Persists a style option change and triggers visualization refresh for the affected view. */
    updateStyleOption(node: StyleOptionNode, viewIndex: number) {
        this.mapService.applyStyleOptionChange(node, viewIndex);
    }

    /** Applies one embedded preset only to options in its owning style sheet. */
    selectLayerPreset(node: LayerPresetNode, viewIndex: number, presetKey: string): void {
        const normalizedKey = presetKey || NO_PRESET_ID;
        const preset = node.presets.find(candidate => candidate.key === normalizedKey);
        const layer = this.mapService.maps.getFeatureLayer(node.mapId, node.layerId);
        if (!normalizedKey) {
            this.mapService.maps.setLayerPresetSelection(viewIndex, node.mapId, node.layerId, null);
            this.mapService.applyPresetChanges([], viewIndex, [{mapId: node.mapId, layerId: node.layerId}]);
            this.stylePresetProjectionChanges.next(this.stylePresetProjectionChanges.getValue() + 1);
            return;
        }
        if (!preset || !layer) {
            this.mapService.maps.setLayerPresetSelection(viewIndex, node.mapId, node.layerId, null);
            this.stylePresetProjectionChanges.next(this.stylePresetProjectionChanges.getValue() + 1);
            return;
        }

        const options = layerStyleOptions(layer);
        const changedOptions: StyleOptionNode[] = [];
        for (const value of preset.values) {
            const option = options.find(candidate =>
                candidate.styleId === preset.styleId && candidate.id === value.optionId);
            if (option && option.value[viewIndex] !== value.value) {
                option.value[viewIndex] = value.value;
                changedOptions.push(option);
            }
        }
        this.mapService.maps.setLayerPresetSelection(viewIndex, node.mapId, node.layerId, preset.ref);
        this.mapService.applyPresetChanges(
            changedOptions, viewIndex, [{mapId: node.mapId, layerId: node.layerId}]);
        this.stylePresetProjectionChanges.next(this.stylePresetProjectionChanges.getValue() + 1);
    }

    /** Applies every component of one map-level composition as a single style-option transaction. */
    selectMapPreset(mapId: string, viewIndex: number, presetId: string): void {
        const map = this.mapService.maps.maps.get(mapId);
        const normalizedId = presetId || NO_PRESET_ID;
        if (!map || !normalizedId) {
            this.mapService.maps.setMapPresetSelection(viewIndex, mapId, null);
            this.mapService.maps.reconcilePresetSelections();
            this.stylePresetProjectionChanges.next(this.stylePresetProjectionChanges.getValue() + 1);
            return;
        }
        const preset = map.mapPresets.find(candidate => candidate.id === normalizedId);
        const components = preset
            ? this.mapService.maps.resolveMapPresetComponents(map, preset)
            : undefined;
        if (!preset || !components
            || (this.syncedOptions[viewIndex]
                && this.mapService.maps.mapPresetHasSyncConflict(map, preset))) {
            this.mapService.maps.setMapPresetSelection(viewIndex, mapId, null);
            if (preset && this.syncedOptions[viewIndex]) {
                this.infoMessageService.showError(
                    `Map preset '${preset.name}' conflicts with synchronized layer options.`);
            }
            this.stylePresetProjectionChanges.next(this.stylePresetProjectionChanges.getValue() + 1);
            return;
        }

        const changedOptions: StyleOptionNode[] = [];
        for (const component of components) {
            for (const value of component.preset.values) {
                const option = layerStyleOptions(component.layer).find(candidate =>
                    candidate.styleId === component.preset.styleId && candidate.id === value.optionId);
                if (option && option.value[viewIndex] !== value.value) {
                    option.value[viewIndex] = value.value;
                    changedOptions.push(option);
                }
            }
            this.mapService.maps.setLayerPresetSelection(
                viewIndex,
                mapId,
                component.layer.id,
                component.preset.ref);
        }
        this.mapService.maps.setMapPresetSelection(viewIndex, mapId, preset.id);
        this.mapService.applyPresetChanges(
            changedOptions,
            viewIndex,
            components.map(component => ({mapId, layerId: component.layer.id})));
        this.stylePresetProjectionChanges.next(this.stylePresetProjectionChanges.getValue() + 1);
    }

    /** Disables map compositions that contradict the current view's layer-sync mode. */
    mapPresetOptionsForView(mapId: string, viewIndex: number): Array<{
        label: string;
        value: string;
        disabled?: boolean;
    }> {
        const map = this.mapService.maps.maps.get(mapId);
        if (!map || !this.syncedOptions[viewIndex]) {
            return map?.mapPresetOptions ?? [];
        }
        return map.mapPresetOptions.map(option => {
            const preset = map.mapPresets.find(candidate => candidate.id === option.value);
            return {
                ...option,
                disabled: !!preset && this.mapService.maps.mapPresetHasSyncConflict(map, preset)
            };
        });
    }

    /** Toggles projection of editable options owned by the current preset. */
    toggleStylePresetOptions(event: Event, node: LayerPresetNode, viewIndex: number): void {
        event.preventDefault();
        event.stopPropagation();
        this.mapService.maps.setLayerPresetExpanded(
            viewIndex,
            node.mapId,
            node.layerId,
            !node.expandedPresetOptions[viewIndex]);
        this.stylePresetProjectionChanges.next(this.stylePresetProjectionChanges.getValue() + 1);
    }

    /** Returns whether a parent map preset is intentionally projecting only this row. */
    isMapPresetProjection(node: LayerPresetNode, viewIndex: number): boolean {
        return this.mapService.maps.getFeatureLayer(node.mapId, node.layerId)
            ?.projectPresetOnly[viewIndex] === true;
    }

    /** Returns the distinct style sheets owned by the selected preset for editor shortcuts. */
    selectedPresetStyleIds(node: LayerPresetNode, viewIndex: number): string[] {
        const preset = node.presets.find(candidate => candidate.key === node.selectedPresetKeys[viewIndex]);
        return preset ? [preset.styleId] : [];
    }

    /** Opens one style sheet from the preset row's retained edit shortcut. */
    openPresetStyleSheet(event: Event, styleId: string): void {
        event.preventDefault();
        event.stopPropagation();
        this.styleEditorRequestService.open(styleId);
    }

    /** Returns the stable test id for one layer/view preset row. */
    stylePresetRowTestId(node: LayerPresetNode, viewIndex: number): string {
        return `style-preset-${viewIndex}-${this.stylePresetTestIdSuffix(node)}`;
    }

    /** Returns the stable test id for one preset owned-option expansion control. */
    stylePresetExpandTestId(node: LayerPresetNode, viewIndex: number): string {
        return `style-preset-expand-${viewIndex}-${this.stylePresetTestIdSuffix(node)}`;
    }

    /** Returns the stable test id for one preset-row stylesheet shortcut. */
    stylePresetEditButtonTestId(node: LayerPresetNode, viewIndex: number, styleId: string): string {
        const styleSuffix = styleId.replace(/[^a-zA-Z0-9_-]+/g, "-");
        return `style-preset-edit-${viewIndex}-${this.stylePresetTestIdSuffix(node)}-${styleSuffix}`;
    }

    /** Produces a DOM-safe suffix from one concrete preset row identity. */
    private stylePresetTestIdSuffix(node: LayerPresetNode): string {
        return `${node.mapId}-${node.layerId}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
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
        const nextState = !this.viewState.isSyncOptionsForViewEnabled(viewIndex);
        this.viewState.setSyncOptionsForView(viewIndex, nextState);
        const numViews = this.stateService.numViews;
        this.syncedOptions = Array.from({length: numViews}, (_, index) =>
            this.viewState.isSyncOptionsForViewEnabled(index));
    }

    /** Closes the maps panel through shared app state. */
    protected closeMapsPanel() {
        this.setMapsPanelVisible(false);
    }

    /** Keeps direct PrimeNG dialog closes, Escape, shortcuts, and the main-bar button in one state path. */
    protected setMapsPanelVisible(isVisible: boolean) {
        this.layerDialogVisible = isVisible;
        if (this.stateService.mapsOpenState.getValue() !== isVisible) {
            this.stateService.mapsOpenState.next(isVisible);
        }
    }

    protected readonly removeGroupPrefix = removeGroupPrefix;
}
