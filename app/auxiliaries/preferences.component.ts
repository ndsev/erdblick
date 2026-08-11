import {Component, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {Subscription} from "rxjs";
import {InfoMessageService} from "../shared/info.service";
import {MapViewStateService, ViewRecalculationReason} from "../mapview/map-view-state.service";
import {StyleService} from "../styledata/style.service";
import {
    ADVANCED_PREFERENCES_DIALOG_LAYOUT_ID,
    clampMapZoomStep,
    DEFAULT_DRILL_PICK_RADIUS,
    DEFAULT_MAP_ZOOM_STEP,
    MAX_DRILL_PICK_RADIUS,
    MAX_MAP_ZOOM_STEP,
    MAX_NUM_TILES_TO_LOAD,
    MAX_SIMULTANEOUS_INSPECTIONS,
    DEFAULT_LOCATION_SEARCH_RESULT_LIMIT,
    MAX_LOCATION_SEARCH_RESULT_LIMIT,
    PREFERENCES_DIALOG_LAYOUT_ID,
    MIN_MAP_ZOOM_STEP,
    MIN_DRILL_PICK_RADIUS,
    AppStateService,
    DEFAULT_LOW_FI_TILE_THRESHOLD,
    DEFAULT_RENDER_BLOCK_VERTEX_LIMIT,
    MAX_RENDER_BLOCK_VERTEX_LIMIT,
    MAX_TILE_SUBSET_RENDER_WORKER_COUNT,
    MAX_LOW_FI_TILE_THRESHOLD,
    MIN_RENDER_BLOCK_VERTEX_LIMIT,
    MIN_LOW_FI_TILE_THRESHOLD,
    AUTO_TILE_SUBSET_RENDER_WORKER_COUNT,
    clampRenderBlockVertexLimit,
    clampTileSubsetRenderWorkerCount,
    clampLowFiTileThreshold,
    type HoverLabelFieldConfig
} from "../shared/appstate.service";
import {
    getTileSubsetLayerRenderAutoWorkerCount
} from "../mapview/deck/tile-subset-layer-render.service";
import {DialogStackService} from "../shared/dialog-stack.service";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {environment} from "../environments/environment";
import {CoordinatesPolicyService} from "../coords/coordinates-policy.service";
import {FeatureSearchSchemaService} from "../mapdata/feature-search-schema.service";
import type {
    FeatureSearchStyleFieldCandidate
} from "../mapdata/map-runtime.model";

@Component({
    selector: 'preferences',
    template: `
        <app-dialog header="Preferences" [(visible)]="dialogVisible" [position]="'center'"
                    [resizable]="false" [modal]="false" [draggable]="true" #pref class="pref-dialog"
                    [persistLayout]="true" [layoutId]="dialogLayoutId"
                    (onShow)="onDialogShow()">
            <p-tabs value="general" class="preferences-tabs" data-testid="preferences-tabs" scrollable>
                <p-tablist>
                    <p-tab value="general" data-testid="preferences-tab-general">General</p-tab>
                    <p-tab value="inspection" data-testid="preferences-tab-inspection">Inspect & Search</p-tab>
                    <p-tab value="hover-labels" data-testid="preferences-tab-hover-labels">Hover Labels</p-tab>
                    <p-tab value="rendering" data-testid="preferences-tab-rendering">Rendering</p-tab>
                    <p-tab value="storage" data-testid="preferences-tab-storage">Storage</p-tab>
                </p-tablist>
                <p-tabpanels>
                    <p-tabpanel value="general">
                        <div class="slider-container">
                            <label [for]="mapZoomStepInput">Zoom Speed
                                <i class="pi pi-info-circle"
                                   pTooltip="Controls mouse-wheel zoom sensitivity and the Q/E / +/- zoom step."
                                   tooltipPosition="top"></i>
                            </label>
                            <div class="slider-controls">
                                <div style="display: inline-block">
                                    <input class="tiles-input w-full"
                                           type="text"
                                           pInputText
                                           [(ngModel)]="mapZoomStepInput"
                                           (ngModelChange)="onMapZoomStepInputChange($event)"
                                           (keydown.enter)="applyMapZoomStep()"/>
                                    <p-slider [(ngModel)]="mapZoomStepInput"
                                              (ngModelChange)="onMapZoomStepSliderChange($event)"
                                              class="w-full"
                                              [min]="MIN_MAP_ZOOM_STEP"
                                              [max]="MAX_MAP_ZOOM_STEP"
                                              [step]="0.05"></p-slider>
                                </div>
                                <p-button (click)="applyMapZoomStep()"
                                          label=""
                                          icon="pi pi-check"
                                          [disabled]="!mapZoomStepChanged"></p-button>
                            </div>
                        </div>
                        <p-divider></p-divider>
                        <div class="button-container">
                            <label>Dark Mode</label>
                            <p-selectButton [options]="darkModeOptions"
                                            [(ngModel)]="darkModeSetting"
                                            optionLabel="label"
                                            optionValue="value"
                                            (ngModelChange)="setDarkMode($event)"></p-selectButton>
                        </div>
                        <div class="button-container">
                            <label for="coordinates-enabled-setting">Show coordinates</label>
                            <p-toggleswitch inputId="coordinates-enabled-setting"
                                            data-testid="coordinates-enabled-setting"
                                            [ngModel]="coordinatesPolicy.effectiveEnabled"
                                            (ngModelChange)="coordinatesPolicy.requestEnabled($event)"/>
                        </div>
                        <div class="button-container">
                            <label>Collapse Dock automatically</label>
                            <p-toggleswitch [(ngModel)]="stateService.isDockAutoCollapsible"></p-toggleswitch>
                        </div>
                    </p-tabpanel>

                    <p-tabpanel value="inspection">
                        <div class="slider-container">
                            <label [for]="limitSimultaneousInspectionsInput">Max Inspections</label>
                            <div class="slider-controls">
                                <div style="display: inline-block">
                                    <input class="tiles-input w-full"
                                           type="text"
                                           pInputText
                                           [(ngModel)]="limitSimultaneousInspectionsInput"
                                           (ngModelChange)="onInspectionsLimitInputChange($event)"
                                           (keydown.enter)="applyInspectionsLimits()"/>
                                    <p-slider [(ngModel)]="limitSimultaneousInspectionsInput"
                                              (ngModelChange)="onInspectionsLimitSliderChange($event)"
                                              class="w-full"
                                              [min]="1"
                                              [max]="MAX_SIMULTANEOUS_INSPECTIONS"></p-slider>
                                </div>
                                <p-button (click)="applyInspectionsLimits()"
                                          label=""
                                          icon="pi pi-check"
                                          [disabled]="!inspectionsLimitChanged"></p-button>
                            </div>
                        </div>
                        <p-divider></p-divider>
                        <div class="slider-container">
                            <label for="drill-pick-radius-input">Drill Pick Radius (px)
                                <i class="pi pi-info-circle"
                                   pTooltip="Pixel radius used by feature drill-picking."
                                   tooltipPosition="top"></i>
                            </label>
                            <div class="slider-controls">
                                <div style="display: inline-block">
                                    <input id="drill-pick-radius-input"
                                           data-testid="drill-pick-radius-input"
                                           class="tiles-input w-full"
                                           type="text"
                                           pInputText
                                           [(ngModel)]="drillPickRadiusInput"
                                           (ngModelChange)="onDrillPickRadiusInputChange($event)"
                                           (keydown.enter)="applyDrillPickRadius()"/>
                                    <p-slider [(ngModel)]="drillPickRadiusInput"
                                              (ngModelChange)="onDrillPickRadiusSliderChange($event)"
                                              class="w-full"
                                              [min]="MIN_DRILL_PICK_RADIUS"
                                              [max]="MAX_DRILL_PICK_RADIUS"></p-slider>
                                </div>
                                <p-button (click)="applyDrillPickRadius()"
                                          data-testid="apply-drill-pick-radius"
                                          label=""
                                          icon="pi pi-check"
                                          [disabled]="!drillPickRadiusChanged"></p-button>
                            </div>
                        </div>
                        <p-divider></p-divider>
                        <div class="button-container">
                            <label>Expand inspection trees by default</label>
                            <p-toggleswitch [(ngModel)]="stateService.inspectionTreeExpandByDefault"></p-toggleswitch>
                        </div>
                        <div class="button-container value-presentation-container">
                            <label for="inspection-value-presentation">Inspection value bubbles</label>
                            <p-multiSelect inputId="inspection-value-presentation"
                                           class="value-presentation-select"
                                           [options]="inspectionValuePresentationOptions"
                                           [ngModel]="inspectionValuePresentationSelection"
                                           optionLabel="label"
                                           optionValue="value"
                                           [filter]="false"
                                           [showToggleAll]="false"
                                           [maxSelectedLabels]="1"
                                           selectedItemsLabel="{0} options"
                                           placeholder="Plain"
                                           appendTo="body"
                                           (ngModelChange)="onInspectionValuePresentationChange($event)">
                            </p-multiSelect>
                        </div>
                        <div class="button-container value-presentation-container">
                            <label for="source-data-default-columns">Source data columns</label>
                            <p-multiSelect inputId="source-data-default-columns"
                                           class="value-presentation-select"
                                           [options]="sourceDataColumnOptions"
                                           [ngModel]="sourceDataColumnSelection"
                                           optionLabel="label"
                                           optionValue="value"
                                           [filter]="false"
                                           [showToggleAll]="false"
                                           [maxSelectedLabels]="1"
                                           selectedItemsLabel="{0} columns"
                                           placeholder="Key and value only"
                                           appendTo="body"
                                           (ngModelChange)="onSourceDataColumnSelectionChange($event)">
                            </p-multiSelect>
                        </div>
                        <p-divider></p-divider>
                        <div class="slider-container">
                            <label [for]="locationSearchResultLimitInput">Location Matches</label>
                            <div class="slider-controls">
                                <div style="display: inline-block">
                                    <input class="tiles-input w-full"
                                           type="text"
                                           pInputText
                                           [(ngModel)]="locationSearchResultLimitInput"
                                           (ngModelChange)="onLocationSearchResultLimitInputChange($event)"
                                           (keydown.enter)="applyLocationSearchResultLimit()"/>
                                    <p-slider [(ngModel)]="locationSearchResultLimitInput"
                                              (ngModelChange)="onLocationSearchResultLimitSliderChange($event)"
                                              class="w-full"
                                              [min]="1"
                                              [max]="MAX_LOCATION_SEARCH_RESULT_LIMIT"></p-slider>
                                </div>
                                <p-button (click)="applyLocationSearchResultLimit()"
                                          label=""
                                          icon="pi pi-check"
                                          [disabled]="!locationSearchResultLimitChanged"></p-button>
                            </div>
                        </div>
                    </p-tabpanel>

                    <p-tabpanel value="hover-labels">
                        <div class="hover-label-preferences" data-testid="hover-label-preferences">
                            <div class="button-container">
                                <label for="hover-labels-enabled">Show hover labels</label>
                                <p-toggleswitch inputId="hover-labels-enabled"
                                                data-testid="hover-labels-enabled"
                                                [(ngModel)]="stateService.hoverLabelsEnabled">
                                </p-toggleswitch>
                            </div>
                            <p-divider></p-divider>
                            <section class="hover-label-options" aria-labelledby="hover-label-options-title">
                                <h3 id="hover-label-options-title">Feature fields</h3>
                                <div class="hover-label-field-list">
                                    @for (field of hoverLabelFields; track $index) {
                                        <div class="hover-label-field-row">
                                            <button type="button"
                                                    class="search-style-expression-toggle"
                                                    [class.search-style-expression-toggle-active]="field.customExpression"
                                                    [attr.aria-pressed]="field.customExpression"
                                                    title="Custom expression"
                                                    (click)="toggleHoverLabelExpressionMode($index)">
                                                *
                                            </button>
                                            @if (field.customExpression) {
                                                <simfil-expression-input
                                                    class="hover-label-expression"
                                                    [value]="field.expression"
                                                    (valueChange)="setHoverLabelExpression($index, $event)"
                                                    [singleLine]="true"
                                                    [completionOwnerId]="'hover-label-field-' + $index"
                                                    completionScope="feature"
                                                    [completionZIndex]="30050"
                                                    placeholder="SIMFIL expression">
                                                </simfil-expression-input>
                                            } @else {
                                                <p-select class="hover-label-expression"
                                                          [options]="hoverLabelFieldOptions"
                                                          [ngModel]="field.expression"
                                                          (ngModelChange)="setHoverLabelExpression($index, $event)"
                                                          optionLabel="label"
                                                          optionValue="value"
                                                          [filter]="true"
                                                          [virtualScroll]="true"
                                                          [virtualScrollItemSize]="36"
                                                          scrollHeight="20rem"
                                                          appendTo="body"
                                                          placeholder="Select field">
                                                </p-select>
                                            }
                                            <p-button icon="pi pi-times"
                                                      size="small"
                                                      severity="danger"
                                                      [outlined]="true"
                                                      pTooltip="Remove field"
                                                      tooltipPosition="bottom"
                                                      (click)="removeHoverLabelField($index)">
                                            </p-button>
                                        </div>
                                    }
                                </div>
                                <p-button icon="pi pi-plus"
                                          label="Add field"
                                          size="small"
                                          severity="secondary"
                                          [outlined]="true"
                                          (click)="addHoverLabelField()">
                                </p-button>
                                <div class="hover-label-notice">
                                    Values are projected without geometry while their map layers are visible. Hovering never starts a request.
                                </div>
                            </section>
                        </div>
                    </p-tabpanel>

                    <p-tabpanel value="rendering">
                        <div class="slider-container">
                            <label [for]="tilesToLoadInput">Max Tiles to Load
                                <i class="pi pi-info-circle"
                                   pTooltip="Caps how many visible map tiles may be requested and rendered at once. Lower values reduce load; higher values allow more tiles before throttling."
                                   tooltipPosition="top"></i>
                            </label>
                            <div class="slider-controls">
                                <div style="display: inline-block">
                                    <input class="tiles-input w-full"
                                           type="text"
                                           pInputText
                                           [(ngModel)]="tilesToLoadInput"
                                           (ngModelChange)="onTilesToLoadInputChange($event)"
                                           (keydown.enter)="applyTileLimits()"/>
                                    <p-slider [(ngModel)]="tilesToLoadInput"
                                              (ngModelChange)="onTilesToLoadSliderChange($event)"
                                              class="w-full"
                                              [min]="0"
                                              [max]="MAX_NUM_TILES_TO_LOAD"></p-slider>
                                </div>
                                <p-button (click)="applyTileLimits()"
                                          label=""
                                          icon="pi pi-check"
                                          [disabled]="!tilesToLoadChanged"></p-button>
                            </div>
                        </div>
                        <p-divider></p-divider>
                        <div class="button-container">
                            <label>Tile pull compression
                                <i class="pi pi-info-circle"
                                   pTooltip="Use only when the bandwith is low"
                                   tooltipPosition="top"></i>
                            </label>
                            <p-selectButton [options]="toggleOptions"
                                            [(ngModel)]="tilePullCompressionEnabledSetting"
                                            optionLabel="label"
                                            optionValue="value"
                                            (ngModelChange)="setTilePullCompressionEnabled($event)"></p-selectButton>
                        </div>
                        <div class="button-container">
                            <label>WebGL antialiasing
                                <i class="pi pi-info-circle"
                                   pTooltip="Recreates the map renderer. Keep disabled if WebGL context creation fails."
                                   tooltipPosition="top"></i>
                            </label>
                            <p-selectButton [options]="toggleOptions"
                                            [(ngModel)]="deckAntialiasingEnabledSetting"
                                            optionLabel="label"
                                            optionValue="value"
                                            (ngModelChange)="setDeckAntialiasingEnabled($event)"></p-selectButton>
                        </div>
                        <div class="slider-container">
                            <label for="low-fi-tile-threshold-input">High/Low-Fi Tile Threshold
                                <i class="pi pi-info-circle"
                                   pTooltip="Visible tile count where the view switches from high-fi to low-fi rendering. Higher values preserve detailed rendering longer but can cost more."
                                   tooltipPosition="top"></i>
                            </label>
                            <div class="slider-controls">
                                <div style="display: inline-block">
                                    <input id="low-fi-tile-threshold-input"
                                           class="tiles-input w-full"
                                           type="text"
                                           pInputText
                                           [(ngModel)]="lowFiTileThresholdInput"
                                           (ngModelChange)="onLowFiTileThresholdInputChange($event)"
                                           (keydown.enter)="applyLowFiTileThreshold()"/>
                                    <p-slider [(ngModel)]="lowFiTileThresholdInput"
                                              (ngModelChange)="onLowFiTileThresholdSliderChange($event)"
                                              class="w-full"
                                              [min]="MIN_LOW_FI_TILE_THRESHOLD"
                                              [max]="MAX_LOW_FI_TILE_THRESHOLD"></p-slider>
                                </div>
                                <p-button (click)="applyLowFiTileThreshold()"
                                          label=""
                                          icon="pi pi-check"
                                          [disabled]="!lowFiTileThresholdChanged"></p-button>
                            </div>
                        </div>
                        <p-divider></p-divider>
                        <div class="slider-container">
                            <label for="render-worker-count-input">Render Workers
                                <i class="pi pi-info-circle"
                                   pTooltip="Number of parallel TileSubsetLayer WASM workers. Zero selects half of the available logical CPUs automatically."
                                   tooltipPosition="top"></i>
                            </label>
                            <div class="slider-controls">
                                <div style="display: inline-block">
                                    <input id="render-worker-count-input"
                                           class="tiles-input w-full"
                                           type="text"
                                           pInputText
                                           [(ngModel)]="renderWorkerCountInput"
                                           (ngModelChange)="onRenderWorkerCountInputChange($event)"
                                           (keydown.enter)="applyRenderWorkerCount()"/>
                                    <p-slider [(ngModel)]="renderWorkerCountInput"
                                              (ngModelChange)="onRenderWorkerCountSliderChange($event)"
                                              class="w-full"
                                              [min]="AUTO_TILE_SUBSET_RENDER_WORKER_COUNT"
                                              [max]="MAX_TILE_SUBSET_RENDER_WORKER_COUNT"></p-slider>
                                    <small>{{ renderWorkerCountDescription }}</small>
                                </div>
                                <p-button (click)="applyRenderWorkerCount()"
                                          label=""
                                          icon="pi pi-check"
                                          [disabled]="!renderWorkerCountChanged"></p-button>
                            </div>
                        </div>
                        <div class="slider-container">
                            <label for="render-block-vertex-limit-input">Render Block Vertex Limit
                                <i class="pi pi-info-circle"
                                   pTooltip="Soft maximum source-geometry vertex count for a multi-tile Morton render block. A single tile is always allowed."
                                   tooltipPosition="top"></i>
                            </label>
                            <div class="slider-controls">
                                <div style="display: inline-block">
                                    <input id="render-block-vertex-limit-input"
                                           class="tiles-input w-full"
                                           type="text"
                                           pInputText
                                           [(ngModel)]="renderBlockVertexLimitInput"
                                           (ngModelChange)="onRenderBlockVertexLimitInputChange($event)"
                                           (keydown.enter)="applyRenderBlockVertexLimit()"/>
                                    <p-slider [(ngModel)]="renderBlockVertexLimitInput"
                                              (ngModelChange)="onRenderBlockVertexLimitSliderChange($event)"
                                              class="w-full"
                                              [min]="MIN_RENDER_BLOCK_VERTEX_LIMIT"
                                              [max]="MAX_RENDER_BLOCK_VERTEX_LIMIT"
                                              [step]="256"></p-slider>
                                </div>
                                <p-button (click)="applyRenderBlockVertexLimit()"
                                          label=""
                                          icon="pi pi-check"
                                          [disabled]="!renderBlockVertexLimitChanged"></p-button>
                            </div>
                        </div>
                        <div class="button-container">
                            <label>Debug Render Blocks
                                <i class="pi pi-info-circle"
                                   pTooltip="Draw the actual Morton block boundaries, tile count, and source-geometry vertex count."
                                   tooltipPosition="top"></i>
                            </label>
                            <p-toggleswitch
                                [(ngModel)]="stateService.debugRenderBlocks"></p-toggleswitch>
                        </div>
                        <div class="button-container">
                            <label>Stable Geometry While Navigating
                                <i class="pi pi-info-circle"
                                   pTooltip="Keep the currently installed Deck layers unchanged while the camera moves, then apply accumulated tile and buffer updates when navigation ends."
                                   tooltipPosition="top"></i>
                            </label>
                            <p-toggleswitch
                                [(ngModel)]="stateService.deferPresentationDuringInteraction"></p-toggleswitch>
                        </div>
                        <div class="button-container">
                            <label>Merge Render Blocks
                                <i class="pi pi-info-circle"
                                   pTooltip="Merge immutable Morton render blocks into larger Deck buffer pages. Disable this to compare direct per-block layers against buffer-arena consolidation."
                                   tooltipPosition="top"></i>
                            </label>
                            <p-toggleswitch
                                [(ngModel)]="stateService.renderBufferArenaEnabled"></p-toggleswitch>
                        </div>
                    </p-tabpanel>

                    <p-tabpanel value="storage">
                        <div class="button-container">
                            <label>Storage for Viewer properties and search history</label>
                            <p-button (click)="clearURLProperties()" label="Clear" icon="pi pi-trash"></p-button>
                        </div>
                        <div class="button-container">
                            <label>Storage for imported styles</label>
                            <p-button (click)="clearImportedStyles()" label="Clear" icon="pi pi-trash"></p-button>
                        </div>
                        <div class="button-container">
                            <label>Storage for modified built-in styles</label>
                            <p-button (click)="clearModifiedStyles()" label="Clear" icon="pi pi-trash"></p-button>
                        </div>
                        <p-divider></p-divider>
                        <div class="button-container">
                            <label>Advanced Preferences</label>
                            <p-button (click)="openAdvancedPreferences()"
                                      label="Advanced"
                                      icon="pi pi-sliders-h"></p-button>
                        </div>
                    </p-tabpanel>
                </p-tabpanels>
            </p-tabs>
            <div class="preferences-actions">
                <p-button (click)="pref.close($event)" label="Close" icon="pi pi-times"></p-button>
            </div>
        </app-dialog>
    `,
    standalone: false
})
/**
 * Hosts persisted viewer preferences and maps dialog controls to runtime state transitions.
 */
export class PreferencesComponent implements OnInit, OnDestroy {
    readonly dialogLayoutId = PREFERENCES_DIALOG_LAYOUT_ID;
    readonly advancedPreferencesDialogLayoutId = ADVANCED_PREFERENCES_DIALOG_LAYOUT_ID;

    @ViewChild('pref') preferencesDialog?: AppDialogComponent;

    tilesToLoadInput: number | string = 0;
    limitSimultaneousInspectionsInput: number | string = 0;
    drillPickRadiusInput: number | string = DEFAULT_DRILL_PICK_RADIUS;
    locationSearchResultLimitInput: number | string = DEFAULT_LOCATION_SEARCH_RESULT_LIMIT;
    tilePullCompressionEnabledSetting: boolean = false;
    deckAntialiasingEnabledSetting: boolean = true;
    lowFiTileThresholdInput: number | string = DEFAULT_LOW_FI_TILE_THRESHOLD;
    renderWorkerCountInput: number | string =
        AUTO_TILE_SUBSET_RENDER_WORKER_COUNT;
    renderBlockVertexLimitInput: number | string =
        DEFAULT_RENDER_BLOCK_VERTEX_LIMIT;
    mapZoomStepInput: number | string = DEFAULT_MAP_ZOOM_STEP;
    tilesToLoadChanged: boolean = false;
    inspectionsLimitChanged: boolean = false;
    drillPickRadiusChanged: boolean = false;
    locationSearchResultLimitChanged: boolean = false;
    lowFiTileThresholdChanged: boolean = false;
    renderWorkerCountChanged: boolean = false;
    renderBlockVertexLimitChanged: boolean = false;
    mapZoomStepChanged: boolean = false;
    toggleOptions = [
        {label: 'Off', value: false},
        {label: 'On', value: true}
    ];
    darkModeSetting: 'off' | 'on' | 'auto' = 'auto';
    darkModeOptions = [
        { label: 'Off', value: 'off' },
        { label: 'On', value: 'on' },
        { label: 'Auto', value: 'auto' }
    ];
    readonly inspectionValuePresentationOptions = [
        {label: "Vary Value Colors", value: "colors"},
        {label: "Vary Value Outlines", value: "outlines"},
        {label: "Vary Background Striping", value: "striping"}
    ];
    readonly sourceDataColumnOptions = [
        {label: "Address", value: "displayAddress"},
        {label: "Type", value: "schemaType"}
    ];
    inspectionValuePresentationSelection: string[] = [];
    sourceDataColumnSelection: string[] = [];
    hoverLabelFields: HoverLabelFieldConfig[] = [];
    hoverLabelFieldOptions: Array<{label: string; value: string}> = [{
        label: "Feature ID",
        value: "id"
    }];
    private mediaQueryList?: MediaQueryList;
    private readonly DARK_MODE_CLASS = 'erdblick-dark';
    private readonly DARK_MODE_KEY = 'ui.darkMode';
    private readonly PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';
    private handleSystemSchemeChange = (e: MediaQueryListEvent) => {
        if (this.darkModeSetting === 'auto') {
            this.updateDarkClass(e.matches);
        }
    };
    private subscriptions: Subscription[] = [];

    /** Subscribes dialog fields to persisted preference state and runtime services. */
    constructor(private messageService: InfoMessageService,
                public mapService: MapViewStateService,
                public styleService: StyleService,
                public stateService: AppStateService,
                public coordinatesPolicy: CoordinatesPolicyService,
                private searchSchema: FeatureSearchSchemaService,
                private dialogStack: DialogStackService) {
        this.subscriptions.push(this.stateService.tilesLoadLimitState.subscribe(limit => {
            this.tilesToLoadInput = limit;
        }));
        this.subscriptions.push(this.stateService.inspectionsLimitState.subscribe(limit => {
            this.limitSimultaneousInspectionsInput = limit;
        }));
        this.subscriptions.push(this.stateService.drillPickRadiusState.subscribe(radius => {
            this.drillPickRadiusInput = radius;
        }));
        this.subscriptions.push(this.stateService.locationSearchResultLimitState.subscribe(limit => {
            this.locationSearchResultLimitInput = limit;
        }));
        this.subscriptions.push(this.stateService.tilePullCompressionEnabledState.subscribe(enabled => {
            this.tilePullCompressionEnabledSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.deckAntialiasingEnabledState.subscribe(enabled => {
            this.deckAntialiasingEnabledSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.lowFiTileThresholdState.subscribe(threshold => {
            this.lowFiTileThresholdInput = threshold;
            this.updateLowFiTileThresholdChangeState();
        }));
        this.subscriptions.push(
            this.stateService.tileSubsetRenderWorkerCountState.subscribe(
                workerCount => {
                    this.renderWorkerCountInput = workerCount;
                    this.updateRenderWorkerCountChangeState();
                }
            ),
            this.stateService.renderBlockVertexLimitState.subscribe(
                vertexLimit => {
                    this.renderBlockVertexLimitInput = vertexLimit;
                    this.updateRenderBlockVertexLimitChangeState();
                }
            )
        );
        this.subscriptions.push(this.stateService.mapZoomStepState.subscribe(step => {
            this.mapZoomStepInput = step;
        }));
        this.subscriptions.push(this.stateService.inspectionValueVaryColorsState.subscribe(() => {
            this.syncInspectionValuePresentationSelection();
        }));
        this.subscriptions.push(this.stateService.inspectionValueVaryOutlinesState.subscribe(() => {
            this.syncInspectionValuePresentationSelection();
        }));
        this.subscriptions.push(this.stateService.inspectionValueVaryStripingState.subscribe(() => {
            this.syncInspectionValuePresentationSelection();
        }));
        this.subscriptions.push(this.stateService.sourceDataInspectionDefaultColumnsState.subscribe(columns => {
            this.sourceDataColumnSelection = [...columns];
        }));
        this.subscriptions.push(this.stateService.hoverLabelFieldsState.subscribe(fields => {
            this.hoverLabelFields = fields.map(field => ({...field}));
        }));
        this.syncInspectionValuePresentationSelection();
    }

    get dialogVisible(): boolean {
        return this.stateService.isDialogOpen(this.dialogLayoutId);
    }

    set dialogVisible(visible: boolean) {
        this.stateService.setDialogOpen(this.dialogLayoutId, visible);
    }

    get renderWorkerCountDescription(): string {
        const configured = clampTileSubsetRenderWorkerCount(
            this.renderWorkerCountInput
        );
        return configured === AUTO_TILE_SUBSET_RENDER_WORKER_COUNT
            ? `Auto (${getTileSubsetLayerRenderAutoWorkerCount()})`
            : `${configured} active worker${configured === 1 ? "" : "s"}`;
    }

    /** Keeps the multiselect value stable between change-detection passes. */
    private syncInspectionValuePresentationSelection(): void {
        const selection: string[] = [];
        if (this.stateService.inspectionValueVaryColors) {
            selection.push("colors");
        }
        if (this.stateService.inspectionValueVaryOutlines) {
            selection.push("outlines");
        }
        if (this.stateService.inspectionValueVaryStriping) {
            selection.push("striping");
        }
        if (selection.join("|") !== this.inspectionValuePresentationSelection.join("|")) {
            this.inspectionValuePresentationSelection = selection;
        }
    }

    /** Applies the compact inspection-value bubble presentation selection. */
    onInspectionValuePresentationChange(values: string[] | null | undefined): void {
        const nextValues = values ?? [];
        if (nextValues.join("|") === this.inspectionValuePresentationSelection.join("|")) {
            return;
        }
        this.inspectionValuePresentationSelection = [...nextValues];
        const selection = new Set(values ?? []);
        this.stateService.inspectionValueVaryColors = selection.has("colors");
        this.stateService.inspectionValueVaryOutlines = selection.has("outlines");
        this.stateService.inspectionValueVaryStriping = selection.has("striping");
    }

    /** Applies which optional SourceData columns new inspection panels show initially. */
    onSourceDataColumnSelectionChange(values: string[] | null | undefined): void {
        this.sourceDataColumnSelection = [...(values ?? [])];
        this.stateService.sourceDataInspectionDefaultColumns = this.sourceDataColumnSelection;
    }

    /** Restores the persisted dark-mode preference during component startup. */
    ngOnInit() {
        const saved = (localStorage.getItem(this.DARK_MODE_KEY) as 'off' | 'on' | 'auto' | null);
        this.darkModeSetting = saved ?? 'auto';
        this.applyDarkModeSetting(this.darkModeSetting);
    }

    /** Releases dialog-owned subscriptions and media-query listeners. */
    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
        this.cleanupMediaQueryListener();
    }

    /** Refreshes dialog fields from current state whenever the preferences dialog opens. */
    onDialogShow() {
        this.tilesToLoadInput = this.stateService.tilesLoadLimit;
        this.limitSimultaneousInspectionsInput = this.stateService.inspectionsLimit;
        this.drillPickRadiusInput = this.stateService.drillPickRadius;
        this.locationSearchResultLimitInput = this.stateService.locationSearchResultLimit;
        this.mapZoomStepInput = this.stateService.mapZoomStep;
        this.lowFiTileThresholdInput = this.stateService.lowFiTileThreshold;
        this.renderWorkerCountInput =
            this.stateService.tileSubsetRenderWorkerCount;
        this.renderBlockVertexLimitInput =
            this.stateService.renderBlockVertexLimit;
        this.tilesToLoadChanged = false;
        this.inspectionsLimitChanged = false;
        this.drillPickRadiusChanged = false;
        this.locationSearchResultLimitChanged = false;
        this.lowFiTileThresholdChanged = false;
        this.renderWorkerCountChanged = false;
        this.renderBlockVertexLimitChanged = false;
        this.mapZoomStepChanged = false;
        this.refreshHoverLabelFieldOptions();
        this.dialogStack.bringToFront(this.preferencesDialog);
    }

    /** Adds one schema-backed hover field without duplicating an existing picker value. */
    addHoverLabelField(): void {
        const selected = new Set(this.hoverLabelFields.map(field => field.expression));
        const expression = this.hoverLabelFieldOptions.find(option =>
            !selected.has(option.value))?.value ?? "";
        this.stateService.hoverLabelFields = [
            ...this.hoverLabelFields,
            {expression, customExpression: false}
        ];
    }

    /** Removes one ordered field from the map-hover overlay. */
    removeHoverLabelField(index: number): void {
        this.stateService.hoverLabelFields = this.hoverLabelFields.filter(
            (_field, fieldIndex) => fieldIndex !== index);
    }

    /** Switches one field between the schema picker and free-form SIMFIL editor. */
    toggleHoverLabelExpressionMode(index: number): void {
        this.stateService.hoverLabelFields = this.hoverLabelFields.map(
            (field, fieldIndex) => fieldIndex === index
                ? {...field, customExpression: !field.customExpression}
                : field);
    }

    /** Updates one hover-field expression while preserving row order and editor mode. */
    setHoverLabelExpression(index: number, expression: string): void {
        this.stateService.hoverLabelFields = this.hoverLabelFields.map(
            (field, fieldIndex) => fieldIndex === index
                ? {...field, expression: expression ?? ""}
                : field);
    }

    /** Loads unique scalar feature fields from the shared schema worker. */
    private refreshHoverLabelFieldOptions(): void {
        this.searchSchema.requestSearchStyleFields("true", "feature")
            .then(options => this.applyHoverLabelFieldOptions(options));
    }

    /** Merges per-layer schema candidates into the concise hover-field picker. */
    private applyHoverLabelFieldOptions(
        candidates: FeatureSearchStyleFieldCandidate[]
    ): void {
        const scalarKinds = new Set([
            "number",
            "integer",
            "string",
            "boolean",
            "enum"
        ]);
        const paths = new Set(candidates
            .filter(candidate => scalarKinds.has(candidate.valueKind))
            .map(candidate => candidate.path));
        this.hoverLabelFields.forEach(field => {
            if (!field.customExpression && field.expression) {
                paths.add(field.expression);
            }
        });
        paths.delete("id");
        this.hoverLabelFieldOptions = [
            {label: "Feature ID", value: "id"},
            ...[...paths].sort().map(path => ({label: path, value: path}))
        ];
    }

    /** Commits the pending tile-load limit after validating the numeric input. */
    applyTileLimits() {
        if (!this.tilesToLoadChanged) {
            return;
        }
        const limit = Number(this.tilesToLoadInput);
        if (!Number.isFinite(limit) || limit < 0) {
            this.messageService.showError("Please enter valid tile limits!");
            return;
        }
        this.tilesToLoadInput = limit;
        this.stateService.tilesLoadLimit = limit;
        this.tilesToLoadChanged = false;
        this.mapService.requestViewRecalculation(ViewRecalculationReason.TileLimit);
        this.messageService.showSuccess("Successfully updated tile limits!");
    }

    /** Clears persisted viewer state such as URL-backed properties and search history. */
    clearURLProperties() {
        this.stateService.resetStorage();
    }

    /** Removes all imported custom styles from memory and local storage. */
    clearImportedStyles() {
        const importedStyleIds = [...this.styleService.styles.entries()]
            .filter(([_, style]) => style.imported)
            .map(([styleId]) => styleId);
        for (const styleId of importedStyleIds) {
            this.styleService.deleteStyle(styleId, true);
        }
        this.styleService.clearStorageForImportedStyles();
    }

    /** Restores built-in styles by dropping locally modified overrides. */
    clearModifiedStyles() {
        for (let [styleId, style] of this.styleService.styles) {
            if (!style.imported && style.modified) {
                this.styleService.reloadStyle(styleId);
            }
        }
        this.styleService.clearStorageForBuiltinStyles();
    }

    /** Opens the separate advanced preferences dialog. */
    openAdvancedPreferences() {
        if (environment.visualizationOnly) {
            return;
        }
        this.stateService.openDialog(this.advancedPreferencesDialogLayoutId);
    }

    /** Toggles HTTP compression for `/interactive/payload` pull responses. */
    setTilePullCompressionEnabled(enabled: boolean) {
        this.tilePullCompressionEnabledSetting = enabled;
        this.stateService.tilePullCompressionEnabled = enabled;
    }

    /** Enables or disables WebGL antialiasing; map views recreate their renderer when this changes. */
    setDeckAntialiasingEnabled(enabled: boolean) {
        this.deckAntialiasingEnabledSetting = enabled;
        this.stateService.deckAntialiasingEnabled = enabled;
    }

    /** Applies the pending low-fi tile threshold after validating the input. */
    applyLowFiTileThreshold() {
        if (!this.lowFiTileThresholdChanged) {
            return;
        }
        const threshold = Number(this.lowFiTileThresholdInput);
        if (!Number.isFinite(threshold)
            || threshold < MIN_LOW_FI_TILE_THRESHOLD || threshold > MAX_LOW_FI_TILE_THRESHOLD) {
            this.messageService.showError(
                `Please enter a tile threshold between ${MIN_LOW_FI_TILE_THRESHOLD} and ${MAX_LOW_FI_TILE_THRESHOLD}.`);
            return;
        }
        const normalized = clampLowFiTileThreshold(threshold);
        this.lowFiTileThresholdInput = normalized;
        this.stateService.lowFiTileThreshold = normalized;
        this.lowFiTileThresholdChanged = false;
    }

    /** Applies zero-for-auto or one explicit subset-render worker count. */
    applyRenderWorkerCount() {
        if (!this.renderWorkerCountChanged) {
            return;
        }
        const workerCount = Number(this.renderWorkerCountInput);
        if (!Number.isInteger(workerCount) ||
            workerCount < AUTO_TILE_SUBSET_RENDER_WORKER_COUNT ||
            workerCount > MAX_TILE_SUBSET_RENDER_WORKER_COUNT) {
            this.messageService.showError(
                `Please enter a render worker count between ` +
                `${AUTO_TILE_SUBSET_RENDER_WORKER_COUNT} (Auto) and ` +
                `${MAX_TILE_SUBSET_RENDER_WORKER_COUNT}.`
            );
            return;
        }
        const normalized = clampTileSubsetRenderWorkerCount(workerCount);
        this.renderWorkerCountInput = normalized;
        this.stateService.tileSubsetRenderWorkerCount = normalized;
        this.renderWorkerCountChanged = false;
    }

    /** Applies the soft source-geometry vertex limit for aggregate blocks. */
    applyRenderBlockVertexLimit() {
        if (!this.renderBlockVertexLimitChanged) {
            return;
        }
        const vertexLimit = Number(this.renderBlockVertexLimitInput);
        if (!Number.isInteger(vertexLimit) ||
            vertexLimit < MIN_RENDER_BLOCK_VERTEX_LIMIT ||
            vertexLimit > MAX_RENDER_BLOCK_VERTEX_LIMIT) {
            this.messageService.showError(
                `Please enter a render block vertex limit between ` +
                `${MIN_RENDER_BLOCK_VERTEX_LIMIT} and ` +
                `${MAX_RENDER_BLOCK_VERTEX_LIMIT}.`
            );
            return;
        }
        const normalized = clampRenderBlockVertexLimit(vertexLimit);
        this.renderBlockVertexLimitInput = normalized;
        this.stateService.renderBlockVertexLimit = normalized;
        this.renderBlockVertexLimitChanged = false;
    }

    /** Applies a manually chosen map zoom step for wheel and keyboard deck interactions. */
    applyMapZoomStep() {
        if (!this.mapZoomStepChanged) {
            return;
        }
        const step = Number(this.mapZoomStepInput);
        if (!Number.isFinite(step) || step < MIN_MAP_ZOOM_STEP || step > MAX_MAP_ZOOM_STEP) {
            this.messageService.showError(`Please enter a zoom speed between ${MIN_MAP_ZOOM_STEP} and ${MAX_MAP_ZOOM_STEP}.`);
            return;
        }
        const clampedStep = clampMapZoomStep(step);
        this.mapZoomStepInput = clampedStep;
        this.stateService.mapZoomStep = clampedStep;
        this.mapZoomStepChanged = false;
    }

    /** Persists the dark-mode preference and updates the root document class immediately. */
    setDarkMode(setting: 'off' | 'on' | 'auto') {
        this.darkModeSetting = setting;
        localStorage.setItem(this.DARK_MODE_KEY, setting);
        this.applyDarkModeSetting(setting);
    }

    /** Applies explicit dark/light mode or follows the system color scheme in auto mode. */
    private applyDarkModeSetting(setting: 'off' | 'on' | 'auto') {
        if (setting === 'on') {
            this.cleanupMediaQueryListener();
            this.updateDarkClass(true);
            return;
        }

        if (setting === 'off') {
            this.cleanupMediaQueryListener();
            this.updateDarkClass(false);
            return;
        }

        // AUTO: follow system preference
        this.cleanupMediaQueryListener();
        this.mediaQueryList = window.matchMedia(this.PREFERS_DARK_QUERY);
        this.mediaQueryList.addEventListener('change', this.handleSystemSchemeChange);
        this.updateDarkClass(this.mediaQueryList.matches);
    }

    /** Adds or removes the viewer-wide dark-mode CSS class. */
    private updateDarkClass(isDark: boolean) {
        const root = document.documentElement;
        if (isDark) {
            root.classList.add(this.DARK_MODE_CLASS);
        } else {
            root.classList.remove(this.DARK_MODE_CLASS);
        }
    }

    /** Removes the active system color-scheme listener before reconfiguring it. */
    private cleanupMediaQueryListener() {
        if (this.mediaQueryList) {
            this.mediaQueryList.removeEventListener('change', this.handleSystemSchemeChange);
            this.mediaQueryList = undefined;
        }
    }

    /** Commits the simultaneous inspection limit after validating the pending input. */
    protected applyInspectionsLimits() {
        if (!this.inspectionsLimitChanged) {
            return;
        }
        const limit = Number(this.limitSimultaneousInspectionsInput);
        if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > MAX_SIMULTANEOUS_INSPECTIONS) {
            this.messageService.showError(`Please enter a valid inspections limit (1-${MAX_SIMULTANEOUS_INSPECTIONS})!`);
            return;
        }
        this.stateService.inspectionsLimit = limit;
        this.inspectionsLimitChanged = false;
        this.messageService.showSuccess("Successfully updated inspections limit!");
    }

    /** Commits the pixel radius used by point drill-picking. */
    protected applyDrillPickRadius() {
        if (!this.drillPickRadiusChanged) {
            return;
        }
        const radius = Number(this.drillPickRadiusInput);
        if (!Number.isFinite(radius) || !Number.isInteger(radius)
            || radius < MIN_DRILL_PICK_RADIUS || radius > MAX_DRILL_PICK_RADIUS) {
            this.messageService.showError(
                `Please enter a valid drill pick radius (${MIN_DRILL_PICK_RADIUS}-${MAX_DRILL_PICK_RADIUS})!`
            );
            return;
        }
        this.stateService.drillPickRadius = radius;
        this.drillPickRadiusChanged = false;
    }

    /** Commits the location result limit after validating the pending input. */
    protected applyLocationSearchResultLimit() {
        if (!this.locationSearchResultLimitChanged) {
            return;
        }
        const limit = Number(this.locationSearchResultLimitInput);
        if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > MAX_LOCATION_SEARCH_RESULT_LIMIT) {
            this.messageService.showError(`Please enter a valid location match limit (1-${MAX_LOCATION_SEARCH_RESULT_LIMIT})!`);
            return;
        }
        this.stateService.locationSearchResultLimit = limit;
        this.locationSearchResultLimitChanged = false;
    }

    /** Tracks slider edits for the tile-load limit without applying them immediately. */
    protected onTilesToLoadSliderChange(value: number) {
        this.tilesToLoadInput = value;
        this.tilesToLoadChanged = this.hasPendingNumericChange(value, this.stateService.tilesLoadLimit);
    }

    /** Tracks slider edits for the simultaneous inspection limit. */
    protected onInspectionsLimitSliderChange(value: number) {
        this.limitSimultaneousInspectionsInput = value;
        this.inspectionsLimitChanged = this.hasPendingNumericChange(value, this.stateService.inspectionsLimit);
    }

    /** Tracks slider edits for the point drill-pick radius. */
    protected onDrillPickRadiusSliderChange(value: number) {
        this.drillPickRadiusInput = value;
        this.drillPickRadiusChanged = this.hasPendingNumericChange(value, this.stateService.drillPickRadius);
    }

    /** Tracks slider edits for the location-search result limit. */
    protected onLocationSearchResultLimitSliderChange(value: number) {
        this.locationSearchResultLimitInput = value;
        this.locationSearchResultLimitChanged = this.hasPendingNumericChange(value, this.stateService.locationSearchResultLimit);
    }

    /** Tracks slider edits for the map zoom-step preference. */
    protected onMapZoomStepSliderChange(value: number) {
        this.mapZoomStepInput = value;
        this.mapZoomStepChanged = this.hasPendingNumericChange(value, this.stateService.mapZoomStep);
    }

    /** Tracks slider edits for the low-fi tile threshold. */
    protected onLowFiTileThresholdSliderChange(value: number) {
        this.lowFiTileThresholdInput = value;
        this.updateLowFiTileThresholdChangeState();
    }

    /** Tracks slider edits for the active render-worker count. */
    protected onRenderWorkerCountSliderChange(value: number) {
        this.renderWorkerCountInput = value;
        this.updateRenderWorkerCountChangeState();
    }

    /** Tracks slider edits for the aggregate render-block vertex limit. */
    protected onRenderBlockVertexLimitSliderChange(value: number) {
        this.renderBlockVertexLimitInput = value;
        this.updateRenderBlockVertexLimitChangeState();
    }

    /** Tracks free-form edits for the tile-load input. */
    protected onTilesToLoadInputChange(value: number | string) {
        this.tilesToLoadInput = value;
        this.tilesToLoadChanged = this.hasPendingNumericChange(value, this.stateService.tilesLoadLimit);
    }

    /** Tracks free-form edits for the inspection-limit input. */
    protected onInspectionsLimitInputChange(value: number | string) {
        this.limitSimultaneousInspectionsInput = value;
        this.inspectionsLimitChanged = this.hasPendingNumericChange(value, this.stateService.inspectionsLimit);
    }

    /** Tracks free-form edits for the point drill-pick radius. */
    protected onDrillPickRadiusInputChange(value: number | string) {
        this.drillPickRadiusInput = value;
        this.drillPickRadiusChanged = this.hasPendingNumericChange(value, this.stateService.drillPickRadius);
    }

    /** Tracks free-form edits for the location-search result limit. */
    protected onLocationSearchResultLimitInputChange(value: number | string) {
        this.locationSearchResultLimitInput = value;
        this.locationSearchResultLimitChanged = this.hasPendingNumericChange(value, this.stateService.locationSearchResultLimit);
    }

    /** Tracks free-form edits for the map zoom-step input. */
    protected onMapZoomStepInputChange(value: number | string) {
        this.mapZoomStepInput = value;
        this.mapZoomStepChanged = this.hasPendingNumericChange(value, this.stateService.mapZoomStep);
    }

    /** Tracks free-form edits for the low-fi tile threshold. */
    protected onLowFiTileThresholdInputChange(value: number | string) {
        this.lowFiTileThresholdInput = value;
        this.updateLowFiTileThresholdChangeState();
    }

    /** Tracks free-form edits for the active render-worker count. */
    protected onRenderWorkerCountInputChange(value: number | string) {
        this.renderWorkerCountInput = value;
        this.updateRenderWorkerCountChangeState();
    }

    /** Tracks free-form edits for the render-block vertex limit. */
    protected onRenderBlockVertexLimitInputChange(value: number | string) {
        this.renderBlockVertexLimitInput = value;
        this.updateRenderBlockVertexLimitChangeState();
    }

    /** Updates the dirty flag for the low-fi threshold control. */
    private updateLowFiTileThresholdChangeState(): void {
        const threshold = Number(this.lowFiTileThresholdInput);
        if (!Number.isFinite(threshold)
            || threshold < MIN_LOW_FI_TILE_THRESHOLD || threshold > MAX_LOW_FI_TILE_THRESHOLD) {
            this.lowFiTileThresholdChanged = true;
            return;
        }
        this.lowFiTileThresholdChanged =
            clampLowFiTileThreshold(threshold) !== this.stateService.lowFiTileThreshold;
    }

    /** Updates the dirty flag for the subset-render worker control. */
    private updateRenderWorkerCountChangeState(): void {
        const workerCount = Number(this.renderWorkerCountInput);
        if (!Number.isInteger(workerCount) ||
            workerCount < AUTO_TILE_SUBSET_RENDER_WORKER_COUNT ||
            workerCount > MAX_TILE_SUBSET_RENDER_WORKER_COUNT) {
            this.renderWorkerCountChanged = true;
            return;
        }
        this.renderWorkerCountChanged =
            clampTileSubsetRenderWorkerCount(workerCount) !==
            this.stateService.tileSubsetRenderWorkerCount;
    }

    /** Updates the dirty flag for the render-block vertex limit control. */
    private updateRenderBlockVertexLimitChangeState(): void {
        const vertexLimit = Number(this.renderBlockVertexLimitInput);
        if (!Number.isInteger(vertexLimit) ||
            vertexLimit < MIN_RENDER_BLOCK_VERTEX_LIMIT ||
            vertexLimit > MAX_RENDER_BLOCK_VERTEX_LIMIT) {
            this.renderBlockVertexLimitChanged = true;
            return;
        }
        this.renderBlockVertexLimitChanged =
            clampRenderBlockVertexLimit(vertexLimit) !==
            this.stateService.renderBlockVertexLimit;
    }

    /** Determines whether a numeric preference control still has an unapplied change. */
    private hasPendingNumericChange(value: number | string, currentValue: number): boolean {
        if (typeof value === "string" && value.trim().length === 0) {
            return true;
        }
        const parsedValue = Number(value);
        return !Number.isFinite(parsedValue) || parsedValue !== currentValue;
    }

    protected readonly MAX_NUM_TILES_TO_LOAD = MAX_NUM_TILES_TO_LOAD;
    protected readonly MAX_SIMULTANEOUS_INSPECTIONS = MAX_SIMULTANEOUS_INSPECTIONS;
    protected readonly MIN_DRILL_PICK_RADIUS = MIN_DRILL_PICK_RADIUS;
    protected readonly MAX_DRILL_PICK_RADIUS = MAX_DRILL_PICK_RADIUS;
    protected readonly MAX_LOCATION_SEARCH_RESULT_LIMIT = MAX_LOCATION_SEARCH_RESULT_LIMIT;
    protected readonly MIN_MAP_ZOOM_STEP = MIN_MAP_ZOOM_STEP;
    protected readonly MAX_MAP_ZOOM_STEP = MAX_MAP_ZOOM_STEP;
    protected readonly MIN_LOW_FI_TILE_THRESHOLD = MIN_LOW_FI_TILE_THRESHOLD;
    protected readonly MAX_LOW_FI_TILE_THRESHOLD = MAX_LOW_FI_TILE_THRESHOLD;
    protected readonly AUTO_TILE_SUBSET_RENDER_WORKER_COUNT =
        AUTO_TILE_SUBSET_RENDER_WORKER_COUNT;
    protected readonly MAX_TILE_SUBSET_RENDER_WORKER_COUNT =
        MAX_TILE_SUBSET_RENDER_WORKER_COUNT;
    protected readonly MIN_RENDER_BLOCK_VERTEX_LIMIT =
        MIN_RENDER_BLOCK_VERTEX_LIMIT;
    protected readonly MAX_RENDER_BLOCK_VERTEX_LIMIT =
        MAX_RENDER_BLOCK_VERTEX_LIMIT;
}
