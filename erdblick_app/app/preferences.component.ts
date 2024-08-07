import {Component} from '@angular/core';
import {InfoMessageService} from "./info.service";
import {MapService} from "./map.service";
import {StyleService} from "./style.service";
import {InspectionService} from "./inspection.service";
import {MAX_NUM_TILES_TO_LOAD, MAX_NUM_TILES_TO_VISUALIZE, ParametersService} from "./parameters.service";

@Component({
    selector: 'pref-components',
    template: `
        <div class="bttn-container" [ngClass]="{'elevated': inspectionService.isInspectionPanelVisible }">
            <p-button (click)="openHelp()" icon="pi pi-question" label="" class="help-button" pTooltip="Help"
                      tooltipPosition="right"></p-button>
            <p-button (click)="showPreferencesDialog()" icon="pi pi-cog" label="" class="pref-button"
                      pTooltip="Preferences" tooltipPosition="right"></p-button>
        </div>
        <p-dialog header="Preferences" [(visible)]="dialogVisible" [position]="'center'"
                  [resizable]="false" [modal]="true" #pref class="pref-dialog">
            <!-- Label and input field for MAX_NUM_TILES_TO_LOAD -->
            <div class="slider-container">
                <label [for]="tilesToLoadInput">Max Tiles to Load:</label>
                <div style="display: inline-block">
                    <input class="tiles-input w-full" type="text" pInputText [(ngModel)]="tilesToLoadInput"/>
                    <p-slider [(ngModel)]="tilesToLoadInput" class="w-full" [min]="0" [max]="MAX_NUM_TILES_TO_LOAD"></p-slider>
                </div>
            </div>
            <!-- Label and input field for MAX_NUM_TILES_TO_VISUALIZE -->
            <div class="slider-container">
                <label [for]="tilesToVisualizeInput">Max Tiles to Visualize:</label>
                <div style="display: inline-block">
                    <input class="tiles-input w-full" type="text" pInputText [(ngModel)]="tilesToVisualizeInput"/>
                    <p-slider [(ngModel)]="tilesToVisualizeInput" class="w-full" [min]="0" [max]="MAX_NUM_TILES_TO_VISUALIZE"></p-slider>
                </div>
            </div>
            <!-- Apply button -->
            <p-button (click)="applyTileLimits()" label="Apply" icon="pi pi-check"></p-button>
            <p-divider></p-divider>
            <div class="button-container">
                <label>Storage for Viewer properties (URL):</label>
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
    styles: [`
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
        
        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `]
})
export class PreferencesComponent {

    tilesToLoadInput: number = 0;
    tilesToVisualizeInput: number = 0;

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
        this.mapService.update();
        this.messageService.showSuccess("Successfully updated tile limits!");
    }

    dialogVisible: boolean = false;
    showPreferencesDialog() {
        this.dialogVisible = true;
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

    protected readonly MAX_NUM_TILES_TO_LOAD = MAX_NUM_TILES_TO_LOAD;
    protected readonly MAX_NUM_TILES_TO_VISUALIZE = MAX_NUM_TILES_TO_VISUALIZE;
}
