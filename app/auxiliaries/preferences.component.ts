import {Component, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {Subscription} from "rxjs";
import {InfoMessageService} from "../shared/info.service";
import {MapDataService} from "../mapdata/map.service";
import {StyleService} from "../styledata/style.service";
import {
    ADVANCED_PREFERENCES_DIALOG_LAYOUT_ID,
    clampMapZoomStep,
    DEFAULT_MAP_ZOOM_STEP,
    MAX_MAP_ZOOM_STEP,
    MAX_NUM_TILES_TO_LOAD,
    MAX_SIMULTANEOUS_INSPECTIONS,
    MAX_DECK_STYLE_WORKERS,
    PREFERENCES_DIALOG_LAYOUT_ID,
    MIN_MAP_ZOOM_STEP,
    AppStateService,
    DEFAULT_DECK_STYLE_WORKER_COUNT
} from "../shared/appstate.service";
import {DialogStackService} from "../shared/dialog-stack.service";
import {getDeckRenderAutoWorkerCount} from "../mapview/deck/deck-render.worker.pool";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {environment} from "../environments/environment";

@Component({
    selector: 'preferences',
    template: `
        <app-dialog header="Preferences" [(visible)]="dialogVisible" [position]="'center'"
                    [resizable]="false" [modal]="false" [draggable]="true" #pref class="pref-dialog"
                    [persistLayout]="true" [layoutId]="dialogLayoutId"
                    (onShow)="onDialogShow()">
            <!-- Label and input field for MAX_NUM_TILES_TO_LOAD -->
            <div class="slider-container">
                <label [for]="tilesToLoadInput">Max Tiles to Load</label>
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
                <label>Pin low-fi rendering to max LOD</label>
                <p-selectButton [options]="toggleOptions"
                                [(ngModel)]="pinLowFiToMaxLodSetting"
                                optionLabel="label"
                                optionValue="value"
                                (ngModelChange)="setPinLowFiToMaxLod($event)"></p-selectButton>
            </div>
            <div class="button-container">
                <label>GLTF debug: render full attachment</label>
                <p-selectButton [options]="toggleOptions"
                                [(ngModel)]="debugRenderFullGltfAttachmentSetting"
                                optionLabel="label"
                                optionValue="value"
                                (ngModelChange)="setDebugRenderFullGltfAttachment($event)"></p-selectButton>
            </div>
            <div class="button-container">
                <label>GLTF debug logging</label>
                <p-selectButton [options]="toggleOptions"
                                [(ngModel)]="debugGltfLoggingEnabledSetting"
                                optionLabel="label"
                                optionValue="value"
                                (ngModelChange)="setDebugGltfLoggingEnabled($event)"></p-selectButton>
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
    styles: [
        `
            .slider-container {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin: 0.5em 0;
                width: 100%;
            }

            .tiles-input {
                font-size: medium;
                text-align: center;
                width: 17em;
                padding: 0.5em;
            }

            @media only screen and (max-width: 56em) {
                .elevated {
                    bottom: 3.5em;
                    padding-bottom: 0;
                }
            }
        `
    ],
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
    tilePullCompressionEnabledSetting: boolean = false;
    deckThreadedRenderingEnabledSetting: boolean = true;
    pinLowFiToMaxLodSetting: boolean = false;
    debugRenderFullGltfAttachmentSetting: boolean = false;
    debugGltfLoggingEnabledSetting: boolean = false;
    deckStyleWorkersOverrideSetting: boolean = false;
    deckStyleWorkersCountInput: number | string = DEFAULT_DECK_STYLE_WORKER_COUNT;
    mapZoomStepInput: number | string = DEFAULT_MAP_ZOOM_STEP;
    tilesToLoadChanged: boolean = false;
    inspectionsLimitChanged: boolean = false;
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
                public mapService: MapDataService,
                public styleService: StyleService,
                public stateService: AppStateService,
                private dialogStack: DialogStackService) {
        this.subscriptions.push(this.stateService.tilesLoadLimitState.subscribe(limit => {
            this.tilesToLoadInput = limit;
        }));
        this.subscriptions.push(this.stateService.inspectionsLimitState.subscribe(limit => {
            this.limitSimultaneousInspectionsInput = limit;
        }));
        this.subscriptions.push(this.stateService.tilePullCompressionEnabledState.subscribe(enabled => {
            this.tilePullCompressionEnabledSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.deckThreadedRenderingEnabledState.subscribe(enabled => {
            this.deckThreadedRenderingEnabledSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.pinLowFiToMaxLodState.subscribe(enabled => {
            this.pinLowFiToMaxLodSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.debugRenderFullGltfAttachmentState.subscribe(enabled => {
            this.debugRenderFullGltfAttachmentSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.debugGltfLoggingEnabledState.subscribe(enabled => {
            this.debugGltfLoggingEnabledSetting = enabled;
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
        this.deckStyleWorkersCountInput = this.stateService.deckStyleWorkersCount;
        this.mapZoomStepInput = this.stateService.mapZoomStep;
        this.tilesToLoadChanged = false;
        this.inspectionsLimitChanged = false;
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
        this.mapService.scheduleUpdate();
        this.messageService.showSuccess("Successfully updated tile limits!");
    }

    /** Clears persisted viewer state such as URL-backed properties and search history. */
    clearURLProperties() {
        this.stateService.resetStorage();
    }

    /** Removes all imported custom styles from memory and local storage. */
    clearImportedStyles() {
        for (let styleId of this.styleService.styles.keys()) {
            if (this.styleService.styles.get(styleId)!.imported) {
                this.styleService.deleteStyle(styleId, true);
            }
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

    /** Toggles HTTP compression for `/tiles/next` pull responses. */
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

    /** Controls whether low-fidelity rendering stays pinned to the highest requested LOD. */
    setPinLowFiToMaxLod(enabled: boolean) {
        this.pinLowFiToMaxLodSetting = enabled;
        this.stateService.pinLowFiToMaxLod = enabled;
    }

    /** Enables or disables the GLTF full-attachment debug render path. */
    setDebugRenderFullGltfAttachment(enabled: boolean) {
        this.debugRenderFullGltfAttachmentSetting = enabled;
        this.stateService.debugRenderFullGltfAttachment = enabled;
    }

    /** Enables or disables verbose GLTF console diagnostics. */
    setDebugGltfLoggingEnabled(enabled: boolean) {
        this.debugGltfLoggingEnabledSetting = enabled;
        this.stateService.debugGltfLoggingEnabled = enabled;
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
    protected readonly MAX_DECK_STYLE_WORKERS = MAX_DECK_STYLE_WORKERS;
    protected readonly MIN_MAP_ZOOM_STEP = MIN_MAP_ZOOM_STEP;
    protected readonly MAX_MAP_ZOOM_STEP = MAX_MAP_ZOOM_STEP;
}
