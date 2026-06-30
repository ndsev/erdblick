import {Component, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {Subscription} from "rxjs";
import {InfoMessageService} from "../shared/info.service";
import {MapViewStateService, ViewRecalculationReason} from "../mapview/map-view-state.service";
import {StyleService} from "../styledata/style.service";
import {
    ADVANCED_PREFERENCES_DIALOG_LAYOUT_ID,
    clampMapZoomStep,
    DEFAULT_MAP_ZOOM_STEP,
    MAX_MAP_ZOOM_STEP,
    MAX_NUM_TILES_TO_LOAD,
    MAX_SIMULTANEOUS_INSPECTIONS,
    MAX_DECK_STYLE_WORKERS,
    DEFAULT_LOCATION_SEARCH_RESULT_LIMIT,
    MAX_LOCATION_SEARCH_RESULT_LIMIT,
    PREFERENCES_DIALOG_LAYOUT_ID,
    MIN_MAP_ZOOM_STEP,
    AppStateService,
    DEFAULT_DECK_STYLE_WORKER_COUNT
} from "../shared/appstate.service";
import {DialogStackService} from "../shared/dialog-stack.service";
import {getDeckRenderAutoWorkerCount} from "../mapview/deck/deck-render.worker.pool";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {environment} from "../environments/environment";
import {
    DEFAULT_HIGH_FIDELITY_TILE_THRESHOLD,
    DEFAULT_LOW_FIDELITY_TILE_THRESHOLD,
    MAX_LOW_FI_TILE_THRESHOLD,
    MIN_LOW_FI_TILE_THRESHOLD,
    normalizeLowFiTileThresholds
} from "../shared/low-fi-tile-thresholds";

@Component({
    selector: 'preferences',
    template: `
        <app-dialog header="Preferences" [(visible)]="dialogVisible" [position]="'center'"
                    [resizable]="false" [modal]="false" [draggable]="true" #pref class="pref-dialog"
                    [persistLayout]="true" [layoutId]="dialogLayoutId"
                    (onShow)="onDialogShow()">
            <!-- Label and input field for MAX_NUM_TILES_TO_LOAD -->
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
            <div class="button-container">
                <label>Expand inspection trees by default</label>
                <p-toggleswitch [(ngModel)]="stateService.inspectionTreeExpandByDefault"></p-toggleswitch>
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
            <p-divider></p-divider>
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
                <label>Tile pull compression
                    <i class="pi pi-info-circle" pTooltip="Use only when the bandwith is low" tooltipPosition="top"></i>
                </label>
                <p-selectButton [options]="toggleOptions"
                                [(ngModel)]="tilePullCompressionEnabledSetting"
                                optionLabel="label"
                                optionValue="value"
                                (ngModelChange)="setTilePullCompressionEnabled($event)"></p-selectButton>
            </div>
            <div class="button-container">
                <label>Threaded tile rendering</label>
                <p-selectButton [options]="toggleOptions"
                                [(ngModel)]="deckThreadedRenderingEnabledSetting"
                                optionLabel="label"
                                optionValue="value"
                                (ngModelChange)="setDeckThreadedRenderingEnabled($event)"></p-selectButton>
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
            <div class="button-container">
                <label>Pin low-fi rendering to max LOD</label>
                <p-selectButton [options]="toggleOptions"
                                [(ngModel)]="pinLowFiToMaxLodSetting"
                                optionLabel="label"
                                optionValue="value"
                                (ngModelChange)="setPinLowFiToMaxLod($event)"></p-selectButton>
            </div>
            <div class="slider-container">
                <label [for]="highFidelityTileThresholdInput">High-Fi Tile Threshold
                    <i class="pi pi-info-circle"
                       pTooltip="Visible tile count used as the upper high-fidelity anchor. Higher values keep detailed rendering active for denser views but can cost more."
                       tooltipPosition="top"></i>
                </label>
                <div class="slider-controls">
                    <div style="display: inline-block">
                        <input class="tiles-input w-full"
                               type="text"
                               pInputText
                               [(ngModel)]="highFidelityTileThresholdInput"
                               (ngModelChange)="onHighFidelityTileThresholdInputChange($event)"
                               (keydown.enter)="applyLowFiTileThresholds()"/>
                        <p-slider [(ngModel)]="highFidelityTileThresholdInput"
                                  (ngModelChange)="onHighFidelityTileThresholdSliderChange($event)"
                                  class="w-full"
                                  [min]="MIN_LOW_FI_TILE_THRESHOLD"
                                  [max]="MAX_LOW_FI_TILE_THRESHOLD"></p-slider>
                    </div>
                </div>
            </div>
            <div class="slider-container">
                <label [for]="lowFidelityTileThresholdInput">Low-Fi Tile Threshold
                    <i class="pi pi-info-circle"
                       pTooltip="Visible tile count used as the low-fidelity anchor. Lower values switch to low-fi rendering sooner; higher values preserve detail longer."
                       tooltipPosition="top"></i>
                </label>
                <div class="slider-controls">
                    <div style="display: inline-block">
                        <input class="tiles-input w-full"
                               type="text"
                               pInputText
                               [(ngModel)]="lowFidelityTileThresholdInput"
                               (ngModelChange)="onLowFidelityTileThresholdInputChange($event)"
                               (keydown.enter)="applyLowFiTileThresholds()"/>
                        <p-slider [(ngModel)]="lowFidelityTileThresholdInput"
                                  (ngModelChange)="onLowFidelityTileThresholdSliderChange($event)"
                                  class="w-full"
                                  [min]="MIN_LOW_FI_TILE_THRESHOLD"
                                  [max]="MAX_LOW_FI_TILE_THRESHOLD"></p-slider>
                    </div>
                    <p-button (click)="toggleLowFiThresholdLink()"
                              label=""
                              icon="pi pi-link"
                              severity="secondary"
                              [outlined]="!lowFiThresholdsLinked"
                              [pTooltip]="lowFiThresholdsLinked ? 'Unlink thresholds' : 'Link thresholds'"
                              tooltipPosition="top"></p-button>
                    <p-button (click)="applyLowFiTileThresholds()"
                              label=""
                              icon="pi pi-check"
                              [disabled]="!lowFiTileThresholdsChanged"></p-button>
                </div>
            </div>
            <div class="button-container">
                <label>Render worker count override
                    <i class="pi pi-info-circle" pTooltip="Use only when there are rendering issues"
                       tooltipPosition="top"></i>
                </label>
                <p-toggleswitch [(ngModel)]="deckStyleWorkersOverrideSetting"
                                [disabled]="!deckThreadedRenderingEnabledSetting"
                                (ngModelChange)="setDeckStyleWorkersOverride($event)"/>
            </div>
            <div class="slider-container">
                <label [for]="deckStyleWorkersCountInput">Worker count</label>
                <div class="slider-controls">
                    <div style="display: inline-block">
                        <input class="tiles-input w-full"
                               type="text"
                               pInputText
                               [(ngModel)]="deckStyleWorkersCountInput"
                               (ngModelChange)="onDeckStyleWorkersCountInputChange($event)"
                               [disabled]="!deckThreadedRenderingEnabledSetting || !deckStyleWorkersOverrideSetting"
                               (keydown.enter)="applyDeckStyleWorkersCount()"/>
                        <p-slider [(ngModel)]="deckStyleWorkersCountInput"
                                  (ngModelChange)="onDeckStyleWorkersCountSliderChange($event)"
                                  class="w-full"
                                  [disabled]="!deckThreadedRenderingEnabledSetting || !deckStyleWorkersOverrideSetting"
                                  [min]="1"
                                  [max]="MAX_DECK_STYLE_WORKERS"></p-slider>
                    </div>
                    <p-button (click)="applyDeckStyleWorkersCount()"
                              label=""
                              icon="pi pi-check"
                              [disabled]="!deckThreadedRenderingEnabledSetting || !deckStyleWorkersOverrideSetting || !deckStyleWorkersCountChanged">
                    </p-button>
                </div>
            </div>
            <p-divider></p-divider>
            <div class="button-container">
                <label>Dark Mode</label>
                <p-selectButton [options]="darkModeOptions" [(ngModel)]="darkModeSetting" optionLabel="label"
                                optionValue="value" (ngModelChange)="setDarkMode($event)"></p-selectButton>
            </div>
            <div class="button-container">
                <label>Collapse Dock automatically</label>
                <p-toggleswitch [(ngModel)]="stateService.isDockAutoCollapsible"></p-toggleswitch>
            </div>
            <p-divider></p-divider>
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
            <div class="button-container">
                <label>Advanced Preferences</label>
                <p-button (click)="openAdvancedPreferences()" label="Advanced" icon="pi pi-sliders-h"></p-button>
            </div>
            <p-button (click)="pref.close($event)" label="Close" icon="pi pi-times"></p-button>
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
    locationSearchResultLimitInput: number | string = DEFAULT_LOCATION_SEARCH_RESULT_LIMIT;
    tilePullCompressionEnabledSetting: boolean = false;
    deckThreadedRenderingEnabledSetting: boolean = true;
    deckAntialiasingEnabledSetting: boolean = false;
    pinLowFiToMaxLodSetting: boolean = false;
    highFidelityTileThresholdInput: number | string = DEFAULT_HIGH_FIDELITY_TILE_THRESHOLD;
    lowFidelityTileThresholdInput: number | string = DEFAULT_LOW_FIDELITY_TILE_THRESHOLD;
    lowFiThresholdsLinked: boolean = false;
    deckStyleWorkersOverrideSetting: boolean = false;
    deckStyleWorkersCountInput: number | string = DEFAULT_DECK_STYLE_WORKER_COUNT;
    mapZoomStepInput: number | string = DEFAULT_MAP_ZOOM_STEP;
    tilesToLoadChanged: boolean = false;
    inspectionsLimitChanged: boolean = false;
    locationSearchResultLimitChanged: boolean = false;
    lowFiTileThresholdsChanged: boolean = false;
    deckStyleWorkersCountChanged: boolean = false;
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
                private dialogStack: DialogStackService) {
        this.subscriptions.push(this.stateService.tilesLoadLimitState.subscribe(limit => {
            this.tilesToLoadInput = limit;
        }));
        this.subscriptions.push(this.stateService.inspectionsLimitState.subscribe(limit => {
            this.limitSimultaneousInspectionsInput = limit;
        }));
        this.subscriptions.push(this.stateService.locationSearchResultLimitState.subscribe(limit => {
            this.locationSearchResultLimitInput = limit;
        }));
        this.subscriptions.push(this.stateService.tilePullCompressionEnabledState.subscribe(enabled => {
            this.tilePullCompressionEnabledSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.deckThreadedRenderingEnabledState.subscribe(enabled => {
            this.deckThreadedRenderingEnabledSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.deckAntialiasingEnabledState.subscribe(enabled => {
            this.deckAntialiasingEnabledSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.pinLowFiToMaxLodState.subscribe(enabled => {
            this.pinLowFiToMaxLodSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.highFidelityTileThresholdState.subscribe(threshold => {
            this.highFidelityTileThresholdInput = threshold;
            this.updateLowFiTileThresholdChangeState();
        }));
        this.subscriptions.push(this.stateService.lowFidelityTileThresholdState.subscribe(threshold => {
            this.lowFidelityTileThresholdInput = threshold;
            this.updateLowFiTileThresholdChangeState();
        }));
        this.subscriptions.push(this.stateService.deckStyleWorkersOverrideState.subscribe(enabled => {
            this.deckStyleWorkersOverrideSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.deckStyleWorkersCountState.subscribe(count => {
            this.deckStyleWorkersCountInput = count;
        }));
        this.subscriptions.push(this.stateService.mapZoomStepState.subscribe(step => {
            this.mapZoomStepInput = step;
        }));
        this.syncDeckStyleWorkersCountToAutoIfNeeded();
    }

    get dialogVisible(): boolean {
        return this.stateService.isDialogOpen(this.dialogLayoutId);
    }

    set dialogVisible(visible: boolean) {
        this.stateService.setDialogOpen(this.dialogLayoutId, visible);
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
        this.syncDeckStyleWorkersCountToAutoIfNeeded();
        this.tilesToLoadInput = this.stateService.tilesLoadLimit;
        this.limitSimultaneousInspectionsInput = this.stateService.inspectionsLimit;
        this.locationSearchResultLimitInput = this.stateService.locationSearchResultLimit;
        this.deckStyleWorkersCountInput = this.stateService.deckStyleWorkersCount;
        this.mapZoomStepInput = this.stateService.mapZoomStep;
        this.highFidelityTileThresholdInput = this.stateService.highFidelityTileThreshold;
        this.lowFidelityTileThresholdInput = this.stateService.lowFidelityTileThreshold;
        this.tilesToLoadChanged = false;
        this.inspectionsLimitChanged = false;
        this.locationSearchResultLimitChanged = false;
        this.lowFiTileThresholdsChanged = false;
        this.deckStyleWorkersCountChanged = false;
        this.mapZoomStepChanged = false;
        this.dialogStack.bringToFront(this.preferencesDialog);
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

    /** Enables or disables threaded Deck rendering. */
    setDeckThreadedRenderingEnabled(enabled: boolean) {
        this.deckThreadedRenderingEnabledSetting = enabled;
        this.stateService.deckThreadedRenderingEnabled = enabled;
        this.syncDeckStyleWorkersCountToAutoIfNeeded();
    }

    /** Enables or disables WebGL antialiasing; map views recreate their renderer when this changes. */
    setDeckAntialiasingEnabled(enabled: boolean) {
        this.deckAntialiasingEnabledSetting = enabled;
        this.stateService.deckAntialiasingEnabled = enabled;
    }

    /** Controls whether low-fidelity rendering stays pinned to the highest requested LOD. */
    setPinLowFiToMaxLod(enabled: boolean) {
        this.pinLowFiToMaxLodSetting = enabled;
        this.stateService.pinLowFiToMaxLod = enabled;
    }

    /** Toggles synchronized editing for the high-/low-fi threshold pair. */
    toggleLowFiThresholdLink() {
        this.lowFiThresholdsLinked = !this.lowFiThresholdsLinked;
        if (this.lowFiThresholdsLinked) {
            this.lowFidelityTileThresholdInput = this.highFidelityTileThresholdInput;
            this.updateLowFiTileThresholdChangeState();
        }
    }

    /** Applies the pending high-/low-fi tile thresholds after validating both inputs. */
    applyLowFiTileThresholds() {
        if (!this.lowFiTileThresholdsChanged) {
            return;
        }
        const high = Number(this.highFidelityTileThresholdInput);
        const low = Number(this.lowFidelityTileThresholdInput);
        if (!Number.isFinite(high) || !Number.isFinite(low)
            || high < MIN_LOW_FI_TILE_THRESHOLD || high > MAX_LOW_FI_TILE_THRESHOLD
            || low < MIN_LOW_FI_TILE_THRESHOLD || low > MAX_LOW_FI_TILE_THRESHOLD) {
            this.messageService.showError(
                `Please enter tile thresholds between ${MIN_LOW_FI_TILE_THRESHOLD} and ${MAX_LOW_FI_TILE_THRESHOLD}.`);
            return;
        }
        const normalized = normalizeLowFiTileThresholds(high, low);
        this.highFidelityTileThresholdInput = normalized.highFidelityTileThreshold;
        this.lowFidelityTileThresholdInput = normalized.lowFidelityTileThreshold;
        this.stateService.lowFidelityTileThreshold = normalized.lowFidelityTileThreshold;
        this.stateService.highFidelityTileThreshold = normalized.highFidelityTileThreshold;
        this.lowFiTileThresholdsChanged = false;
        this.mapService.requestViewRecalculation(ViewRecalculationReason.FidelityThreshold);
    }

    /** Enables or disables the explicit Deck render-worker count override. */
    setDeckStyleWorkersOverride(enabled: boolean) {
        this.deckStyleWorkersOverrideSetting = enabled;
        this.stateService.deckStyleWorkersOverride = enabled;
        this.syncDeckStyleWorkersCountToAutoIfNeeded();
    }

    /** Applies a manually chosen Deck render-worker count when overrides are enabled. */
    applyDeckStyleWorkersCount() {
        if (!this.deckThreadedRenderingEnabledSetting || !this.deckStyleWorkersOverrideSetting || !this.deckStyleWorkersCountChanged) {
            return;
        }
        const count = Number(this.deckStyleWorkersCountInput);
        if (!Number.isInteger(count) || count < 1 || count > MAX_DECK_STYLE_WORKERS) {
            this.messageService.showError(`Please enter a worker count between 1 and ${MAX_DECK_STYLE_WORKERS}.`);
            return;
        }
        this.deckStyleWorkersCountInput = count;
        this.stateService.deckStyleWorkersCount = count;
        this.deckStyleWorkersCountChanged = false;
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

    /** Tracks slider edits for the location-search result limit. */
    protected onLocationSearchResultLimitSliderChange(value: number) {
        this.locationSearchResultLimitInput = value;
        this.locationSearchResultLimitChanged = this.hasPendingNumericChange(value, this.stateService.locationSearchResultLimit);
    }

    /** Tracks slider edits for the Deck render-worker count override. */
    protected onDeckStyleWorkersCountSliderChange(value: number) {
        this.deckStyleWorkersCountInput = value;
        this.deckStyleWorkersCountChanged = this.hasPendingNumericChange(value, this.stateService.deckStyleWorkersCount);
    }

    /** Tracks slider edits for the map zoom-step preference. */
    protected onMapZoomStepSliderChange(value: number) {
        this.mapZoomStepInput = value;
        this.mapZoomStepChanged = this.hasPendingNumericChange(value, this.stateService.mapZoomStep);
    }

    /** Tracks slider edits for the high-fidelity tile threshold. */
    protected onHighFidelityTileThresholdSliderChange(value: number) {
        this.highFidelityTileThresholdInput = value;
        if (this.lowFiThresholdsLinked) {
            this.lowFidelityTileThresholdInput = value;
        }
        this.updateLowFiTileThresholdChangeState();
    }

    /** Tracks slider edits for the low-fidelity tile threshold. */
    protected onLowFidelityTileThresholdSliderChange(value: number) {
        this.lowFidelityTileThresholdInput = value;
        if (this.lowFiThresholdsLinked) {
            this.highFidelityTileThresholdInput = value;
        }
        this.updateLowFiTileThresholdChangeState();
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

    /** Tracks free-form edits for the location-search result limit. */
    protected onLocationSearchResultLimitInputChange(value: number | string) {
        this.locationSearchResultLimitInput = value;
        this.locationSearchResultLimitChanged = this.hasPendingNumericChange(value, this.stateService.locationSearchResultLimit);
    }

    /** Tracks free-form edits for the Deck render-worker count input. */
    protected onDeckStyleWorkersCountInputChange(value: number | string) {
        this.deckStyleWorkersCountInput = value;
        this.deckStyleWorkersCountChanged = this.hasPendingNumericChange(value, this.stateService.deckStyleWorkersCount);
    }

    /** Tracks free-form edits for the map zoom-step input. */
    protected onMapZoomStepInputChange(value: number | string) {
        this.mapZoomStepInput = value;
        this.mapZoomStepChanged = this.hasPendingNumericChange(value, this.stateService.mapZoomStep);
    }

    /** Tracks free-form edits for the high-fidelity tile threshold. */
    protected onHighFidelityTileThresholdInputChange(value: number | string) {
        this.highFidelityTileThresholdInput = value;
        if (this.lowFiThresholdsLinked) {
            this.lowFidelityTileThresholdInput = value;
        }
        this.updateLowFiTileThresholdChangeState();
    }

    /** Tracks free-form edits for the low-fidelity tile threshold. */
    protected onLowFidelityTileThresholdInputChange(value: number | string) {
        this.lowFidelityTileThresholdInput = value;
        if (this.lowFiThresholdsLinked) {
            this.highFidelityTileThresholdInput = value;
        }
        this.updateLowFiTileThresholdChangeState();
    }

    /** Updates the shared dirty flag for the high-/low-fi threshold controls. */
    private updateLowFiTileThresholdChangeState(): void {
        const high = Number(this.highFidelityTileThresholdInput);
        const low = Number(this.lowFidelityTileThresholdInput);
        if (!Number.isFinite(high) || !Number.isFinite(low)
            || high < MIN_LOW_FI_TILE_THRESHOLD || high > MAX_LOW_FI_TILE_THRESHOLD
            || low < MIN_LOW_FI_TILE_THRESHOLD || low > MAX_LOW_FI_TILE_THRESHOLD) {
            this.lowFiTileThresholdsChanged = true;
            return;
        }
        const normalized = normalizeLowFiTileThresholds(
            this.highFidelityTileThresholdInput,
            this.lowFidelityTileThresholdInput);
        const current = this.stateService.lowFiTileThresholds;
        this.lowFiTileThresholdsChanged =
            normalized.highFidelityTileThreshold !== current.highFidelityTileThreshold ||
            normalized.lowFidelityTileThreshold !== current.lowFidelityTileThreshold;
    }

    /** Determines whether a numeric preference control still has an unapplied change. */
    private hasPendingNumericChange(value: number | string, currentValue: number): boolean {
        if (typeof value === "string" && value.trim().length === 0) {
            return true;
        }
        const parsedValue = Number(value);
        return !Number.isFinite(parsedValue) || parsedValue !== currentValue;
    }

    /** Mirrors the automatically chosen worker count into the UI when override mode is disabled. */
    private syncDeckStyleWorkersCountToAutoIfNeeded(): void {
        if (this.stateService.deckStyleWorkersOverride) {
            return;
        }
        const autoCount = getDeckRenderAutoWorkerCount();
        this.deckStyleWorkersCountInput = autoCount;
        this.deckStyleWorkersCountChanged = false;
        if (this.stateService.deckStyleWorkersCount !== autoCount) {
            this.stateService.deckStyleWorkersCount = autoCount;
        }
    }

    protected readonly MAX_NUM_TILES_TO_LOAD = MAX_NUM_TILES_TO_LOAD;
    protected readonly MAX_SIMULTANEOUS_INSPECTIONS = MAX_SIMULTANEOUS_INSPECTIONS;
    protected readonly MAX_LOCATION_SEARCH_RESULT_LIMIT = MAX_LOCATION_SEARCH_RESULT_LIMIT;
    protected readonly MAX_DECK_STYLE_WORKERS = MAX_DECK_STYLE_WORKERS;
    protected readonly MIN_MAP_ZOOM_STEP = MIN_MAP_ZOOM_STEP;
    protected readonly MAX_MAP_ZOOM_STEP = MAX_MAP_ZOOM_STEP;
    protected readonly MIN_LOW_FI_TILE_THRESHOLD = MIN_LOW_FI_TILE_THRESHOLD;
    protected readonly MAX_LOW_FI_TILE_THRESHOLD = MAX_LOW_FI_TILE_THRESHOLD;
}
