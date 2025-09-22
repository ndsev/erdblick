import {Component} from '@angular/core';
import {InfoMessageService} from "./info.service";
import {MapService} from "./map.service";
import {StyleService} from "./style.service";
import {InspectionService} from "./inspection.service";
import {MAX_NUM_TILES_TO_LOAD, MAX_NUM_TILES_TO_VISUALIZE, ParametersService} from "./parameters.service";
import {OnDestroy, OnInit} from '@angular/core';

@Component({
    selector: 'pref-components',
    template: `
        <div class="bttn-container" [ngClass]="{'elevated': inspectionService.isInspectionPanelVisible }">
            <p-button (click)="openHelp()" icon="pi pi-question" label="" class="pref-button" pTooltip="Help"
                      tooltipPosition="right"></p-button>
            <p-button (click)="showPreferencesDialog()" icon="pi pi-cog" label="" class="pref-button"
                      pTooltip="Preferences" tooltipPosition="right"></p-button>
            <p-button (click)="showControlsDialog()" label="" class="pref-button"
                      pTooltip="Controls" tooltipPosition="right">
                <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">keyboard</span>
            </p-button>
            <p-button (click)="showStatsDialog()" label="" class="pref-button"
                      pTooltip="Statistics" tooltipPosition="right">
                <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">insights</span>
            </p-button>
        </div>
        <p-dialog header="Preferences" [(visible)]="dialogVisible" [position]="'center'"
                  [resizable]="false" [modal]="true" #pref class="pref-dialog">
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
            <div class="button-container">
                <label>Dark Mode:</label>
                <p-selectButton [options]="darkModeOptions" [(ngModel)]="darkModeSetting" optionLabel="label" optionValue="value" (ngModelChange)="setDarkMode($event)"></p-selectButton>
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
        <p-dialog header="Keyboard Controls" [(visible)]="controlsDialogVisible" [position]="'center'"
                  [resizable]="false" [modal]="true" #controls class="pref-dialog">
            <div class="keyboard-dialog">
                <ul class="keyboard-list">
                    <li>
                        <div class="key-multi">
                            <span class="key highlight">Ctrl</span>
                            <span class="key">K</span>
                        </div>
                        <div class="control-desc">Open Search</div>
                    </li>
                    <li>
                        <div class="key-multi">
                            <span class="key highlight">Ctrl</span>
                            <span class="key">J</span>
                        </div>
                        <div class="control-desc">Zoom to Target Feature</div>
                    </li>
                    <li>
                        <span class="key">M</span>
                        <div class="control-desc">Open Maps & Styles Panel</div>
                    </li>
                    <li>
                        <span class="key">W</span>
                        <div class="control-desc">Move Camera Up</div>
                    </li>
                    <li>
                        <span class="key">A</span>
                        <div class="control-desc">Move Camera Left</div>
                    </li>
                    <li>
                        <span class="key">S</span>
                        <div class="control-desc">Move Camera Down</div>
                    </li>
                    <li>
                        <span class="key">D</span>
                        <div class="control-desc">Move Camera Right</div>
                    </li>
                    <li>
                        <span class="key">Q</span>
                        <div class="control-desc">Zoom In</div>
                    </li>
                    <li>
                        <span class="key">E</span>
                        <div class="control-desc">Zoom Out</div>
                    </li>
                    <li>
                        <span class="key">R</span>
                        <div class="control-desc">Reset Camera Orientation</div>
                    </li>
                    <li>
                        <div class="key-multi">
                            <span class="key highlight">Ctrl</span>
                            <span class="key">X</span>
                        </div>
                        <div class="control-desc">Open Viewport Statistics</div>
                    </li>
                </ul>
            </div>
            <p-button (click)="controls.close($event)" label="Close" icon="pi pi-times"></p-button>
        </p-dialog>
    `,
    styles: [
        `
            .slider-container {
                display: flex;
                justify-content: space-between;
                align-items: center;
                width: 30em;
                margin: 1em 0;
            }

            .tiles-input {
                font-size: medium;
                text-align: center;
                width: 17em;
                padding: 0.5em;
            }

            .keyboard-dialog {
                width: 25em;
                text-align: center;
                background-color: var(--p-content-background);
            }

            h2 {
                font-size: 1.5em;
                color: #333;
                margin-bottom: 1em;
                font-weight: bold;
            }

            .keyboard-list {
                list-style-type: none;
                padding: 0;
            }

            .keyboard-list li {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 1em;
            }

            .keyboard-list li span {
                display: inline-block;
                background-color: var(--p-highlight-background);
                padding: 0.5em 0.75em;
                border-radius: 0.5em;
                color: var(--p-content-color);
                font-weight: bold;
                min-width: 4em;
                text-align: center;
            }

            .control-desc {
                color: var(--p-surface-500);
                font-size: 0.9em;
            }

            /* Keyboard key styling */
            .key {
                border-radius: 0.5em;
                background-color: #ffcc00;
                font-size: 1em;
                padding: 0.5em 0.75em;
                color: #333;
            }

            .key-multi {
                display: flex;
                gap: 0.25em;
            }

            .key-multi .key {
                background-color: #00bcd4;
                padding: 0.3em 0.6em;
            }

            .highlight {
                background-color: #ff5722;
                color: white;
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

    tilesToLoadInput: number = 0;
    tilesToVisualizeInput: number = 0;

    controlsDialogVisible = false;
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

    constructor(private messageService: InfoMessageService,
                public mapService: MapService,
                public styleService: StyleService,
                public inspectionService: InspectionService,
                public parametersService: ParametersService) {
        this.parametersService.parameters.subscribe(parameters => {
            this.tilesToLoadInput = parameters.tilesLoadLimit;
            this.tilesToVisualizeInput = parameters.tilesVisualizeLimit;
        });
    }

    ngOnInit() {
        const saved = (localStorage.getItem(this.DARK_MODE_KEY) as 'off' | 'on' | 'auto' | null);
        this.darkModeSetting = saved ?? 'auto';
        this.applyDarkModeSetting(this.darkModeSetting);
    }

    ngOnDestroy() {
        this.cleanupMediaQueryListener();
    }

    applyTileLimits() {
        if (isNaN(this.tilesToLoadInput) || isNaN(this.tilesToVisualizeInput) ||
            this.tilesToLoadInput < 0 || this.tilesToVisualizeInput < 0) {
            this.messageService.showError("Please enter valid tile limits!");
            return;
        }
        let parameters = this.parametersService.p();
        parameters.tilesLoadLimit = Number(this.tilesToLoadInput);
        parameters.tilesVisualizeLimit = Number(this.tilesToVisualizeInput);
        this.parametersService.parameters.next(parameters);
        this.mapService.update().then();
        this.messageService.showSuccess("Successfully updated tile limits!");
    }

    dialogVisible: boolean = false;
    showPreferencesDialog() {
        this.dialogVisible = true;
    }

    showControlsDialog() {
        this.controlsDialogVisible = true;
    }

    showStatsDialog() {
        this.mapService.statsDialogVisible = true;
        this.mapService.statsDialogNeedsUpdate.next();
    }

    openHelp() {
        window.open("https://developer.nds.live/tools/the-new-mapviewer/user-guide", "_blank");
    }

    clearURLProperties() {
        this.parametersService.resetStorage();
    }

    clearImportedStyles() {
        for (let styleId of this.styleService.styles.keys()) {
            if (this.styleService.styles.get(styleId)!.imported) {
                this.styleService.deleteStyle(styleId);
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

    protected readonly MAX_NUM_TILES_TO_LOAD = MAX_NUM_TILES_TO_LOAD;
    protected readonly MAX_NUM_TILES_TO_VISUALIZE = MAX_NUM_TILES_TO_VISUALIZE;
}
