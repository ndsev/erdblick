import {Component} from '@angular/core';
import {DebugWindow} from "./debugapi.component";
import {InfoMessageService} from "./info.service";
import {JumpTargetService} from "./jump.service";
import {MapService} from "./map.service";
import {StyleService} from "./style.service";
import {InspectionService} from "./inspection.service";
import {ParametersService} from "./parameters.service";
import {ActivatedRoute, Router} from "@angular/router";
import {of} from "rxjs";

// Redeclare window with extended interface
declare let window: DebugWindow;

export interface MapItemLayer extends Object {
    canRead: boolean;
    canWrite: boolean;
    coverage: number[];
    featureTypes: Object[];
    layerId: string;
    type: string;
    version: Object;
    zoomLevels: number[];
}

export interface MapInfoItem extends Object {
    extraJsonAttachment: Object;
    layers: Map<string, MapItemLayer>;
    mapId: string;
    maxParallelJobs: number;
    nodeId: string;
    protocolVersion: Map<string, number>;
}

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
                    <p-slider [(ngModel)]="tilesToLoadInput" class="w-full" [min]="0" [max]="maxLoadTiles"></p-slider>
                </div>
            </div>
            <!-- Label and input field for MAX_NUM_TILES_TO_VISUALIZE -->
            <div class="slider-container">
                <label [for]="tilesToVisualizeInput">Max Tiles to Visualize:</label>
                <div style="display: inline-block">
                    <input class="tiles-input w-full" type="text" pInputText [(ngModel)]="tilesToVisualizeInput"/>
                    <p-slider [(ngModel)]="tilesToVisualizeInput" class="w-full" [min]="0" [max]="maxVisuTiles"></p-slider>
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
    maxLoadTiles: number = 0;
    maxVisuTiles: number = 0;

    constructor(private messageService: InfoMessageService,
                private router: Router,
                private route: ActivatedRoute,
                public mapService: MapService,
                public styleService: StyleService,
                public inspectionService: InspectionService,
                public parametersService: ParametersService) {
        this.mapService.mapModel.subscribe(mapModel => {
            if (mapModel) {
                this.maxLoadTiles = this.tilesToLoadInput = mapModel.maxLoadTiles;
                this.maxVisuTiles = this.tilesToVisualizeInput = mapModel.maxVisuTiles;
            }
        });
    }

    applyTileLimits() {
        if (isNaN(this.tilesToLoadInput) || isNaN(this.tilesToVisualizeInput)) {
            this.messageService.showError("Please enter valid tile limits!");
            return;
        }
        const result = this.mapService.applyTileLimits(this.tilesToLoadInput, this.tilesToVisualizeInput);
        if (result) {
            this.messageService.showSuccess("Successfully updated tile limits!");
        } else {
            this.messageService.showError("Could not update tile limits!");
        }
    }

    dialogVisible: boolean = false;
    showPreferencesDialog() {
        this.dialogVisible = true;
    }

    openHelp() {
        window.open("https://developer.nds.live/tools/the-new-mapviewer/user-guide", "_blank");
    }

    clearURLProperties() {
        this.parametersService.clearStorage();
    }

    clearImportedStyles() {
        for (let styleId of this.styleService.styleData.keys()) {
            if (this.styleService.styleData.get(styleId)!.imported) {
                this.mapService.removeImportedStyle(styleId);
                this.styleService.availableStylesActivations.delete(styleId);
            }
        }
        this.styleService.clearStorageForImportedStyles();
    }

    clearModifiedStyles() {
        for (let styleId of this.styleService.styleData.keys()) {
            if (!this.styleService.styleData.get(styleId)!.imported) {
                this.mapService.reloadBuiltinStyle(styleId);
            }
        }
        this.styleService.clearStorageForBuiltinStyles();
    }
}
