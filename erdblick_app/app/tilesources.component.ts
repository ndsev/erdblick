import {Component} from "@angular/core";
import {ParametersService} from "./parameters.service";
import {RightClickMenuService} from "./rightclickmenu.service";
import {MapService} from "./map.service";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";
import {InspectionService} from "./inspection.service";


@Component({
    selector: 'tilesources',
    template: `
        <p-dialog header="Inspect Tile Source Data" [(visible)]="menuService.tileSourceDataDialogVisible" [modal]="false"
                  (onHide)="reset()" [style]="{'min-height': '14em', 'min-width': '36em'}">
            <div *ngIf="loading" style="display:flex; justify-content: center">
                <p-progressSpinner ariaLabel="loading"/>
            </div>
            <div *ngIf="!loading" class="tilesource-options">
                <p *ngIf="errorString">{{ errorString }}</p>
                <p-dropdown *ngIf="!errorString"
                            [options]="tileIds"
                            [(ngModel)]="selectedTileId"
                            optionLabel="name"
                            placeholder="Select a TileId"
                            (ngModelChange)="onTileIdChange($event)"
                            appendTo="body"/>
                <p-dropdown *ngIf="!errorString"
                            [options]="mapIds"
                            [(ngModel)]="selectedMapId"
                            [disabled]="!mapIds.length"
                            optionLabel="name"
                            [placeholder]="mapIds.length ? 'Select a MapId' : 'No associated maps found'"
                            (ngModelChange)="onMapIdChange($event)"
                            appendTo="body" />
                <p-dropdown *ngIf="!errorString"
                            [options]="sourceDataLayers" 
                            [(ngModel)]="selectedSourceDataLayer" 
                            [disabled]="!sourceDataLayers.length" 
                            optionLabel="name" 
                            placeholder="Select a SourceDataLayer"
                            [placeholder]="mapIds.length ? 'Select a SourceDataLayer' : 'No associated source data layers found'"
                            appendTo="body" />
                <div style="display: flex; flex-direction: row; gap: 0.5em">
                    <p-button *ngIf="!errorString" (click)="requestSourceData()" label="Load" icon="pi pi-check"></p-button>
                    <p-button (click)="close()" label="Close" icon="pi pi-times"></p-button>
                </div>
            </div>
        </p-dialog>
    `,
    styles: [``]
})
export class TileSourceDataComponent {
    selectedTileId: any | undefined;
    tileIds: any[] = [];
    selectedSourceDataLayer: any | undefined;
    sourceDataLayers: any[] = [];
    selectedMapId: any | undefined;
    mapIds: any[] = [];
    errorString: string = "";
    loading: boolean = true;

    constructor(private parameterService: ParametersService,
                private mapService: MapService,
                private inspectionService: InspectionService,
                public menuService: RightClickMenuService) {
        this.menuService.tileIdsReady.subscribe(ready => {
            if (ready) {
                this.load();
            }
            this.loading = !ready;
        });
    }

    load() {
        const tileIds = this.parameterService.tileIdsForSourceData;
        if (tileIds.length) {
            this.tileIds = tileIds;
        } else {
            this.tileIds = [];
            this.selectedTileId = undefined;
            this.errorString = "No tile IDs available for the clicked position!";
        }
        this.mapIds = [];
        this.sourceDataLayers = [];
    }

    onTileIdChange(tileId: any) {
        this.selectedMapId = undefined;
        this.selectedSourceDataLayer = undefined;
        const maps = new Set<string>();
        for (const featureTile of this.mapService.loadedTileLayers.values()) {
            if (featureTile.tileId == tileId.id) {
                maps.add(featureTile.mapName);
            }
        }
        this.mapIds = [...maps].map(mapId => ({ id: mapId, name: mapId }));
        this.sourceDataLayers = [];
    }

    onMapIdChange(mapId: any) {
        // Reset sourceDataLayer selection
        this.selectedSourceDataLayer = undefined;

        // Update sourceDataLayers based on the selected mapId
        const map = this.mapService.maps.getValue().get(mapId.id);
        if (map) {
            const dataLayers = new Set<string>();
            for (const layer of map.layers.values()) {
                if (layer.type == "SourceData") {
                    dataLayers.add(layer.layerId);
                }
            }
            this.sourceDataLayers = [...dataLayers].map(layerId => ({
                id: layerId,
                name: SourceDataPanelComponent.layerNameForLayerId(layerId)
            }));
        }
    }

    requestSourceData() {
        this.inspectionService.isInspectionPanelVisible = true;
        this.inspectionService.selectedSourceData.next({
            tileId: Number(this.selectedTileId.id),
            layerId: String(this.selectedSourceDataLayer.id),
            mapId: String(this.selectedMapId.id)
        });
        this.close();
    }

    reset() {
        this.loading = true;
        this.errorString = "";
        this.selectedTileId = undefined;
        this.selectedMapId = undefined;
        this.selectedSourceDataLayer = undefined;
    }

    close() {
        this.menuService.tileSourceDataDialogVisible = false;
    }
}