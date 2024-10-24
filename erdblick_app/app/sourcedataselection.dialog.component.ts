import {Component} from "@angular/core";
import {ParametersService} from "./parameters.service";
import {RightClickMenuService, SourceDataDropdownOption} from "./rightclickmenu.service";
import {MapService} from "./map.service";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";
import {InspectionService} from "./inspection.service";
import {Color} from "./cesium";

@Component({
    selector: 'sourcedatadialog',
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
                            scrollHeight="20em"
                            placeholder="Select a TileId"
                            (ngModelChange)="onTileIdChange($event)"
                            appendTo="body"/>
                <p-dropdown *ngIf="!errorString"
                            [options]="mapIds"
                            [(ngModel)]="selectedMapId"
                            [disabled]="!mapIds.length"
                            optionLabel="name"
                            scrollHeight="20em"
                            [placeholder]="mapIds.length ? 'Select a MapId' : 'No associated maps found'"
                            (ngModelChange)="onMapIdChange($event)"
                            appendTo="body" />
                <p-dropdown *ngIf="!errorString"
                            [options]="sourceDataLayers" 
                            [(ngModel)]="selectedSourceDataLayer" 
                            [disabled]="!sourceDataLayers.length" 
                            optionLabel="name" 
                            scrollHeight="20em"
                            placeholder="Select a SourceDataLayer"
                            [placeholder]="mapIds.length ? 'Select a SourceDataLayer' : 'No associated source data layers found'"
                            (ngModelChange)="onLayerIdChange($event)"
                            appendTo="body" />
                <div style="display: flex; flex-direction: row; gap: 0.5em">
                    <p-button *ngIf="!errorString" (click)="requestSourceData()" label="Ok" icon="pi pi-check"></p-button>
                    <p-button (click)="close()" label="Close" icon="pi pi-times"></p-button>
                </div>
            </div>
        </p-dialog>
    `,
    styles: [``]
})
export class SourceDataLayerSelectionDialogComponent {
    selectedTileId: SourceDataDropdownOption | undefined;
    tileIds: SourceDataDropdownOption[] = [];
    selectedSourceDataLayer: SourceDataDropdownOption | undefined;
    sourceDataLayers: SourceDataDropdownOption[] = [];
    sourceDataLayersMap: Map<string, SourceDataDropdownOption[]> = new Map<string, SourceDataDropdownOption[]>();
    selectedMapId: SourceDataDropdownOption | undefined;
    mapIdsMap: Map<bigint, SourceDataDropdownOption[]> = new Map<bigint, SourceDataDropdownOption[]>();
    mapIds: SourceDataDropdownOption[] = [];
    errorString: string = "";
    loading: boolean = true;

    constructor(private parameterService: ParametersService,
                private mapService: MapService,
                private inspectionService: InspectionService,
                public menuService: RightClickMenuService) {
        this.menuService.tileIdsForSourceData.subscribe(data => {
            this.tileIds = data;
            this.loading = !data.length;
            this.load();
        });
    }

    load() {
        if (this.tileIds.length) {
            for (let i = 0; i < this.tileIds.length; i++) {
                const id = this.tileIds[i].id as bigint;
                const maps = this.findMapsForTileId(id);
                this.tileIds[i]["disabled"] = !maps.length;
                this.mapIdsMap.set(id, maps);
            }
        } else {
            this.selectedTileId = undefined;
            this.loading = false;
            this.errorString = "No tile IDs available for the clicked position!";
        }
        this.mapIds = [];
        this.sourceDataLayers = [];
        this.selectedTileId = this.tileIds.find(element => !element.disabled);
        if (this.selectedTileId !== undefined) {
            this.onTileIdChange(this.selectedTileId);
            if (this.mapIds.length) {
                this.selectedMapId = this.mapIds[0];
                this.onMapIdChange(this.selectedMapId);
                if (this.sourceDataLayers.length) {
                    this.selectedSourceDataLayer = this.sourceDataLayers[0];
                    this.onLayerIdChange(this.selectedSourceDataLayer);
                }
            }
        }
    }

    findMapsForTileId(tileId: bigint) {
        const maps = new Set<string>();
        for (const featureTile of this.mapService.loadedTileLayers.values()) {
            if (featureTile.tileId == tileId) {
                maps.add(featureTile.mapName);
            }
        }
        return [...maps].map(mapId => ({ id: mapId, name: mapId }));
    }

    onTileIdChange(tileId: SourceDataDropdownOption) {
        this.selectedMapId = undefined;
        this.selectedSourceDataLayer = undefined;
        this.sourceDataLayers = [];
        // TODO: Fix this.
        //   Consider just drawing a tile box rectangle without visualising the tile.
        // for (const featureTile of this.mapService.loadedTileLayers.values()) {
        //     if (featureTile.tileId == tileId.id as bigint) {
        //         this.mapService.setSpecialTileBorder(tileId.id as bigint, Color.HOTPINK);
        //     }
        // }
        const mapIds = this.mapIdsMap.get(tileId.id as bigint);
        if (mapIds !== undefined) {
            this.mapIds = mapIds.sort((a, b) => a.name.localeCompare(b.name));
            for (let i = 0; i < this.mapIds.length; i++) {
                const id = this.mapIds[i].id as string;
                const layers = this.findLayersForMapId(id);
                this.mapIds[i]["disabled"] = !layers.length;
                this.sourceDataLayersMap.set(id, layers);
            }
        }
    }

    findLayersForMapId(mapId: string) {
        const map = this.mapService.maps.getValue().get(mapId);
        if (map) {
            const dataLayers = new Set<string>();
            for (const layer of map.layers.values()) {
                if (layer.type == "SourceData") {
                    dataLayers.add(layer.layerId);
                }
            }
            return [...dataLayers].map(layerId => ({
                id: layerId,
                name: SourceDataPanelComponent.layerNameForLayerId(layerId)
            }));
        }
        return [];
    }

    onMapIdChange(mapId: SourceDataDropdownOption) {
        this.selectedSourceDataLayer = undefined;
        const sourceDataLayers = this.sourceDataLayersMap.get(mapId.id as string);
        if (sourceDataLayers !== undefined) {
            this.sourceDataLayers = sourceDataLayers;
        }
    }

    onLayerIdChange(layerId: SourceDataDropdownOption) {
        if (this.selectedTileId === undefined ||
            this.selectedMapId === undefined ||
            this.selectedSourceDataLayer === undefined) {
            return;
        }
        this.menuService.lastInspectedTileSourceDataOption.next({
            tileId: Number(this.selectedTileId.id),
            mapId: String(this.selectedMapId.id),
            layerId: String(this.selectedSourceDataLayer.id)
        });
    }

    requestSourceData() {
        this.inspectionService.loadSourceDataInspection(
            Number(this.selectedTileId?.id),
            String(this.selectedMapId?.id),
            String(this.selectedSourceDataLayer?.id)
        );
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