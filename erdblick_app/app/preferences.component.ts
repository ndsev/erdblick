import {Component, OnInit, QueryList, ViewChildren} from '@angular/core';
import {ErdblickView} from "./erdblick.view";
import {ErdblickModel} from "./erdblick.model";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
import {HttpClient} from "@angular/common/http";
import libErdblickCore, {Feature} from '../../build/libs/core/erdblick-core';
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {InfoMessageService} from "./info.service";
import {JumpTargetService} from "./jump.service";
import {ErdblickLayer, ErdblickMap, MapService} from "./map.service";
import {ActivatedRoute, Params, Router} from "@angular/router";
import {Cartesian3} from "cesium";
import {StyleService} from "./style.service";
import {InspectionService} from "./inspection.service";
import {ParametersService} from "./parameters.service";

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
            <p-button (click)="pref.close($event)" label="Cancel" icon="pi pi-times"></p-button>
        </p-dialog>

        
    `,
    styles: [`
        .slider-container {
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 24em;
            margin: 1em 0;
        }
        
        .tiles-input {
            font-size: medium;
            text-align: center;
            width: 12em;
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

    constructor(private httpClient: HttpClient,
                private router: Router,
                private messageService: InfoMessageService,
                public mapService: MapService,
                public jumpToTargetService: JumpTargetService,
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
}
