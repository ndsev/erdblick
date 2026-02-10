import {Component, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {Subscription} from "rxjs";
import {InfoMessageService} from "../shared/info.service";
import {MapDataService} from "../mapdata/map.service";
import {StyleService} from "../styledata/style.service";
import {MAX_NUM_TILES_TO_LOAD, MAX_NUM_TILES_TO_VISUALIZE, MAX_SIMULTANEOUS_INSPECTIONS, AppStateService} from "../shared/appstate.service";
import {Dialog} from "primeng/dialog";
import {DialogStackService} from "../shared/dialog-stack.service";

@Component({
    selector: 'preferences',
    template: `
        <p-dialog header="Preferences" [(visible)]="stateService.preferencesDialogVisible" [position]="'center'"
                  [resizable]="false" [modal]="false" [draggable]="true" #pref class="pref-dialog"
                  (onShow)="onDialogShow()">
            <!-- Label and input field for MAX_NUM_TILES_TO_LOAD -->
            <div class="slider-container">
                <label [for]="tilesToLoadInput">Max Tiles to Load:</label>
                <div style="display: inline-block">
                    <input class="tiles-input w-full" type="text" pInputText [(ngModel)]="tilesToLoadInput" (keydown.enter)="applyTileLimits()"/>
                    <p-slider [(ngModel)]="tilesToLoadInput" class="w-full" [min]="0" [max]="MAX_NUM_TILES_TO_LOAD"></p-slider>
                </div>
            </div>
            <!-- Label and input field for MAX_NUM_TILES_TO_VISUALIZE -->
            <div class="slider-container">
                <label [for]="tilesToVisualizeInput">Max Tiles to Visualize:</label>
                <div style="display: inline-block">
                    <input class="tiles-input w-full" type="text" pInputText [(ngModel)]="tilesToVisualizeInput" (keydown.enter)="applyTileLimits()"/>
                    <p-slider [(ngModel)]="tilesToVisualizeInput" class="w-full" [min]="0" [max]="MAX_NUM_TILES_TO_VISUALIZE"></p-slider>
                </div>
            </div>
            <!-- Apply button -->
            <p-button (click)="applyTileLimits()" label="Apply" icon="pi pi-check"></p-button>
            <p-divider></p-divider>
            <div class="slider-container">
                <label [for]="limitSimultaneousInspectionsInput">Max Inspections:</label>
                <div style="display: inline-block">
                    <input class="tiles-input w-full" type="text" pInputText [(ngModel)]="limitSimultaneousInspectionsInput" (keydown.enter)="applyInspectionsLimits()"/>
                    <p-slider [(ngModel)]="limitSimultaneousInspectionsInput" class="w-full" [min]="0" [max]="MAX_SIMULTANEOUS_INSPECTIONS"></p-slider>
                </div>
            </div>
            <p-button (click)="applyInspectionsLimits()" label="Apply" icon="pi pi-check"></p-button>
            <p-divider></p-divider>
            <div class="button-container">
                <label>Dark Mode:</label>
                <p-selectButton [options]="darkModeOptions" [(ngModel)]="darkModeSetting" optionLabel="label" optionValue="value" (ngModelChange)="setDarkMode($event)"></p-selectButton>
            </div>
            <div class="button-container">
                <label>Collapse Dock automatically:</label>
                <p-toggleswitch [(ngModel)]="stateService.isDockAutoCollapsible" />
            </div>
            <p-divider></p-divider>
            <div class="button-container">
                <label>Storage for Viewer properties and search history:</label>
                <p-button (click)="clearURLProperties()" label="Clear" icon="pi pi-trash"></p-button>
            </div>
            <div class="button-container">
                <label>Storage for imported styles:</label>
                <p-button (click)="clearImportedStyles()" label="Clear" icon="pi pi-trash"></p-button>
            </div>
            <div class="button-container">
                <label>Storage for modified built-in styles:</label>
                <p-button (click)="clearModifiedStyles()" label="Clear" icon="pi pi-trash"></p-button>
            </div>
            <p-divider></p-divider>
            <p-button (click)="pref.close($event)" label="Close" icon="pi pi-times"></p-button>
        </p-dialog>
    `,
    styles: [
        `
            .slider-container {
                display: flex;
                justify-content: space-between;
                align-items: center;
                width: 29em;
                margin: 1em 0;
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

    @ViewChild('pref') preferencesDialog?: Dialog;

    tilesToLoadInput: number = 0;
    tilesToVisualizeInput: number = 0;
    limitSimultaneousInspectionsInput: number = 0;
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
        this.subscriptions.push(this.stateService.tilesVisualizeLimitState.subscribe(limit => {
            this.tilesToVisualizeInput = limit;
        }));
        this.subscriptions.push(this.stateService.inspectionsLimitState.subscribe(limit => {
            this.limitSimultaneousInspectionsInput = limit;
        }));
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
        this.dialogStack.bringToFront(this.preferencesDialog);
    }

    applyTileLimits() {
        if (isNaN(this.tilesToLoadInput) || isNaN(this.tilesToVisualizeInput) ||
            this.tilesToLoadInput < 0 || this.tilesToVisualizeInput < 0) {
            this.messageService.showError("Please enter valid tile limits!");
            return;
        }
        this.stateService.tilesLoadLimit = Number(this.tilesToLoadInput);
        this.stateService.tilesVisualizeLimit = Number(this.tilesToVisualizeInput);
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

    }

    protected readonly MAX_NUM_TILES_TO_LOAD = MAX_NUM_TILES_TO_LOAD;
    protected readonly MAX_NUM_TILES_TO_VISUALIZE = MAX_NUM_TILES_TO_VISUALIZE;
    protected readonly MAX_SIMULTANEOUS_INSPECTIONS = MAX_SIMULTANEOUS_INSPECTIONS;
}
