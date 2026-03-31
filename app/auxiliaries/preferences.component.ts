import {Component, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {Subscription} from "rxjs";
import {InfoMessageService} from "../shared/info.service";
import {MapDataService} from "../mapdata/map.service";
import {StyleService} from "../styledata/style.service";
import {
    MAX_NUM_TILES_TO_LOAD,
    MAX_SIMULTANEOUS_INSPECTIONS,
    MAX_DECK_STYLE_WORKERS,
    AppStateService,
    DEFAULT_DECK_STYLE_WORKER_COUNT
} from "../shared/appstate.service";
import {DialogStackService} from "../shared/dialog-stack.service";
import {getDeckRenderAutoWorkerCount} from "../mapview/deck/deck-render.worker.pool";
import {AppDialogComponent} from "../shared/app-dialog.component";

@Component({
    selector: 'preferences',
    template: `
        <app-dialog header="Preferences" [(visible)]="stateService.preferencesDialogVisible" [position]="'center'"
                  [resizable]="false" [modal]="false" [draggable]="true" #pref class="pref-dialog"
                  [persistLayout]="true" [layoutId]="'preferences-dialog'"
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
                <label>Render worker count override 
                    <i class="pi pi-info-circle" pTooltip="Use only when there are rendering issues" tooltipPosition="top"></i>
                </label>
                <p-toggleswitch [(ngModel)]="deckStyleWorkersOverrideSetting"
                                [disabled]="!deckThreadedRenderingEnabledSetting"
                                (ngModelChange)="setDeckStyleWorkersOverride($event)" />
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
                <p-selectButton [options]="darkModeOptions" [(ngModel)]="darkModeSetting" optionLabel="label" optionValue="value" (ngModelChange)="setDarkMode($event)"></p-selectButton>
            </div>
            <div class="button-container">
                <label>Collapse Dock automatically</label>
                <p-toggleswitch [(ngModel)]="stateService.isDockAutoCollapsible"/>
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
export class PreferencesComponent implements OnInit, OnDestroy {

    @ViewChild('pref') preferencesDialog?: AppDialogComponent;

    tilesToLoadInput: number | string = 0;
    limitSimultaneousInspectionsInput: number | string = 0;
    tilePullCompressionEnabledSetting: boolean = false;
    deckThreadedRenderingEnabledSetting: boolean = true;
    pinLowFiToMaxLodSetting: boolean = false;
    deckStyleWorkersOverrideSetting: boolean = false;
    deckStyleWorkersCountInput: number | string = DEFAULT_DECK_STYLE_WORKER_COUNT;
    tilesToLoadChanged: boolean = false;
    inspectionsLimitChanged: boolean = false;
    deckStyleWorkersCountChanged: boolean = false;
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
        this.subscriptions.push(this.stateService.deckStyleWorkersOverrideState.subscribe(enabled => {
            this.deckStyleWorkersOverrideSetting = enabled;
        }));
        this.subscriptions.push(this.stateService.deckStyleWorkersCountState.subscribe(count => {
            this.deckStyleWorkersCountInput = count;
        }));
        this.syncDeckStyleWorkersCountToAutoIfNeeded();
    }

    ngOnInit() {
        const saved = (localStorage.getItem(this.DARK_MODE_KEY) as 'off' | 'on' | 'auto' | null);
        this.darkModeSetting = saved ?? 'auto';
        this.applyDarkModeSetting(this.darkModeSetting);
    }

    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
        this.cleanupMediaQueryListener();
    }

    onDialogShow() {
        this.syncDeckStyleWorkersCountToAutoIfNeeded();
        this.tilesToLoadInput = this.stateService.tilesLoadLimit;
        this.limitSimultaneousInspectionsInput = this.stateService.inspectionsLimit;
        this.deckStyleWorkersCountInput = this.stateService.deckStyleWorkersCount;
        this.tilesToLoadChanged = false;
        this.inspectionsLimitChanged = false;
        this.deckStyleWorkersCountChanged = false;
        this.dialogStack.bringToFront(this.preferencesDialog);
    }

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

    clearURLProperties() {
        this.stateService.resetStorage();
    }

    clearImportedStyles() {
        for (let styleId of this.styleService.styles.keys()) {
            if (this.styleService.styles.get(styleId)!.imported) {
                this.styleService.deleteStyle(styleId, true);
            }
        }
        this.styleService.clearStorageForImportedStyles();
    }

    clearModifiedStyles() {
        for (let [styleId, style] of this.styleService.styles) {
            if (!style.imported && style.modified) {
                this.styleService.reloadStyle(styleId);
            }
        }
        this.styleService.clearStorageForBuiltinStyles();
    }

    setTilePullCompressionEnabled(enabled: boolean) {
        this.tilePullCompressionEnabledSetting = enabled;
        this.stateService.tilePullCompressionEnabled = enabled;
    }

    setDeckThreadedRenderingEnabled(enabled: boolean) {
        this.deckThreadedRenderingEnabledSetting = enabled;
        this.stateService.deckThreadedRenderingEnabled = enabled;
        this.syncDeckStyleWorkersCountToAutoIfNeeded();
    }

    setPinLowFiToMaxLod(enabled: boolean) {
        this.pinLowFiToMaxLodSetting = enabled;
        this.stateService.pinLowFiToMaxLod = enabled;
    }

    setDeckStyleWorkersOverride(enabled: boolean) {
        this.deckStyleWorkersOverrideSetting = enabled;
        this.stateService.deckStyleWorkersOverride = enabled;
        this.syncDeckStyleWorkersCountToAutoIfNeeded();
    }

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

    setDarkMode(setting: 'off' | 'on' | 'auto') {
        this.darkModeSetting = setting;
        localStorage.setItem(this.DARK_MODE_KEY, setting);
        this.applyDarkModeSetting(setting);
    }

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

    private updateDarkClass(isDark: boolean) {
        const root = document.documentElement;
        if (isDark) {
            root.classList.add(this.DARK_MODE_CLASS);
        } else {
            root.classList.remove(this.DARK_MODE_CLASS);
        }
    }

    private cleanupMediaQueryListener() {
        if (this.mediaQueryList) {
            this.mediaQueryList.removeEventListener('change', this.handleSystemSchemeChange);
            this.mediaQueryList = undefined;
        }
    }

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

    protected onTilesToLoadSliderChange(value: number) {
        this.tilesToLoadInput = value;
        this.tilesToLoadChanged = this.hasPendingNumericChange(value, this.stateService.tilesLoadLimit);
    }

    protected onInspectionsLimitSliderChange(value: number) {
        this.limitSimultaneousInspectionsInput = value;
        this.inspectionsLimitChanged = this.hasPendingNumericChange(value, this.stateService.inspectionsLimit);
    }

    protected onDeckStyleWorkersCountSliderChange(value: number) {
        this.deckStyleWorkersCountInput = value;
        this.deckStyleWorkersCountChanged = this.hasPendingNumericChange(value, this.stateService.deckStyleWorkersCount);
    }

    protected onTilesToLoadInputChange(value: number | string) {
        this.tilesToLoadInput = value;
        this.tilesToLoadChanged = this.hasPendingNumericChange(value, this.stateService.tilesLoadLimit);
    }

    protected onInspectionsLimitInputChange(value: number | string) {
        this.limitSimultaneousInspectionsInput = value;
        this.inspectionsLimitChanged = this.hasPendingNumericChange(value, this.stateService.inspectionsLimit);
    }

    protected onDeckStyleWorkersCountInputChange(value: number | string) {
        this.deckStyleWorkersCountInput = value;
        this.deckStyleWorkersCountChanged = this.hasPendingNumericChange(value, this.stateService.deckStyleWorkersCount);
    }

    private hasPendingNumericChange(value: number | string, currentValue: number): boolean {
        if (typeof value === "string" && value.trim().length === 0) {
            return true;
        }
        const parsedValue = Number(value);
        return !Number.isFinite(parsedValue) || parsedValue !== currentValue;
    }

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
}
