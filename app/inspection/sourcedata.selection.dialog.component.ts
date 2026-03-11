import {Component} from "@angular/core";
import {RightClickMenuService, SourceDataDropdownOption} from "../mapview/rightclickmenu.service";
import {MapDataService} from "../mapdata/map.service";
import {Color} from "../integrations/geo";

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
                <div class="main-dropdown">
                    <p-select *ngIf="!errorString && !showCustomTileIdInput"
                                [options]="tileIds"
                                [(ngModel)]="selectedTileId"
                                optionLabel="name"
                                scrollHeight="20em"
                                placeholder="Select a TileId"
                                (ngModelChange)="onTileIdChange($event)"
                                appendTo="body"/>
                    <input *ngIf="!errorString && showCustomTileIdInput" placeholder="Enter custom Tile ID" type="text" 
                           pInputText [(ngModel)]="customTileId" (ngModelChange)="onCustomTileIdChange($event)"/>
                    <p-button *ngIf="!errorString" (click)="toggleCustomTileIdInput()" class="osm-button"
                              icon="{{showCustomTileIdInput ? 'pi pi-times' : 'pi pi-plus'}}"
                              label="" [pTooltip]="showCustomTileIdInput ? 'Reset custom Tile ID' : 'Enter custom Tile ID'" tooltipPosition="bottom" tabindex="0">
                    </p-button>
                </div>
                
                <p-select *ngIf="!errorString"
                            [options]="mapIds"
                            [(ngModel)]="selectedMapId"
                            [disabled]="!mapIds.length"
                            optionLabel="name"
                            scrollHeight="20em"
                            [placeholder]="mapIds.length ? 'Select a MapId' : 'No associated maps found'"
                            (ngModelChange)="onMapIdChange($event)"
                            appendTo="body" />
                <p-select *ngIf="!errorString"
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
    styles: [``],
    standalone: false
})
export class SourceDataLayerSelectionDialogComponent {
    selectedTileId: SourceDataDropdownOption | undefined;
    selectedMapId: SourceDataDropdownOption | undefined;
    selectedSourceDataLayer: SourceDataDropdownOption | undefined;

    tileIds: SourceDataDropdownOption[] = [];
    mapIds: SourceDataDropdownOption[] = [];
    sourceDataLayers: SourceDataDropdownOption[] = [];

    mapIdsPerTileId: Map<bigint, SourceDataDropdownOption[]> = new Map<bigint, SourceDataDropdownOption[]>();
    sourceDataLayersPerMapId: Map<string, SourceDataDropdownOption[]> = new Map<string, SourceDataDropdownOption[]>();

    errorString: string = "";
    loading: boolean = true;
    customTileId: string = "";
    customMapId: string = "";
    showCustomTileIdInput: boolean = false;

    constructor(private mapService: MapDataService,
                public menuService: RightClickMenuService) {
        this.menuService.tileIdsForSourceData.subscribe(data => {
            this.tileIds = data;
            this.loading = !data.length;
            this.load();
        });
        this.menuService.customTileAndMapId.subscribe(([tileId, mapId]: [string, string]) => {
            this.load(tileId, mapId);
            this.menuService.tileSourceDataDialogVisible = true;
        });
    }

    load(customTileId: string = "", customMapId: string = "") {
        this.showCustomTileIdInput = customTileId.length > 0;
        this.customTileId = customTileId;
        this.customMapId = customMapId;
        this.resetSelectionState();
        this.loading = false;

        // Special case: There is a custom tile ID.
        if (customTileId) {
            this.onCustomTileIdChange(customTileId);
            return;
        }

        // Abort if no Tile IDs were provided by the menu service.
        if (!this.tileIds.length) {
            this.selectedTileId = undefined;
            this.errorString = "No tile IDs available for the clicked position!";
            this.menuService.tileOutline.next(null);
            return;
        }

        // Fill map IDs per tile ID.
        for (let i = 0; i < this.tileIds.length; i++) {
            const id = this.tileIds[i].id as bigint;
            const maps = this.mapService.findSourceDataMapsForTileId(id);
            this.tileIds[i]["disabled"] = !maps.length;
            this.mapIdsPerTileId.set(id, maps);
        }

        const tileIdSelection = this.menuService.preferredSourceDataTile(this.tileIds);
        if (tileIdSelection) {
            this.setCurrentTileId(tileIdSelection);
        } else {
            this.menuService.tileOutline.next(null);
        }
    }

    onCustomTileIdChange(tileIdString: string) {
        if (!tileIdString) {
            this.resetSelectionState();
            this.menuService.tileOutline.next(null);
            return;
        }

        const tileId = BigInt(tileIdString);
        const maps = this.mapService.findSourceDataMapsForTileId(tileId);
        this.mapIdsPerTileId.set(tileId, maps);
        this.setCurrentTileId({id: tileId, name: tileIdString});
    }

    private setCurrentTileId(tileId: SourceDataDropdownOption) {
        this.selectedTileId = tileId;
        this.onTileIdChange(tileId);
        this.restorePreferredMapSelection();

        if (this.mapIds.length) {
            if (!this.selectedMapId) {
                this.selectedMapId = this.mapIds[0];
            }
            this.onMapIdChange(this.selectedMapId);
            if (this.sourceDataLayers.length) {
                this.restorePreferredLayerSelection();
                if (this.selectedSourceDataLayer) {
                    this.onLayerIdChange(this.selectedSourceDataLayer);
                }
            }
        }
    }

    onTileIdChange(tileId: SourceDataDropdownOption) {
        this.selectedMapId = undefined;
        this.selectedSourceDataLayer = undefined;
        this.sourceDataLayers = [];
        this.menuService.outlineTile(BigInt(tileId.id), Color.HOTPINK);
        const mapIds = this.mapIdsPerTileId.get(tileId.id as bigint);
        if (mapIds !== undefined) {
            this.mapIds = mapIds.sort((a, b) => a.name.localeCompare(b.name));
            for (let i = 0; i < this.mapIds.length; i++) {
                const id = this.mapIds[i].id as string;
                const layers = this.mapService.findLayersForMapId(id);
                this.mapIds[i]["disabled"] = !layers.length;
                this.sourceDataLayersPerMapId.set(id, layers);
            }
        }
    }

    onMapIdChange(mapId: SourceDataDropdownOption) {
        this.selectedSourceDataLayer = undefined;
        const sourceDataLayers = this.sourceDataLayersPerMapId.get(mapId.id as string);
        if (sourceDataLayers !== undefined) {
            this.sourceDataLayers = sourceDataLayers;
        }
    }

    onLayerIdChange(_: SourceDataDropdownOption) {}

    requestSourceData() {
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
        this.close();
    }

    toggleCustomTileIdInput() {
        this.showCustomTileIdInput = !this.showCustomTileIdInput;
        if (!this.showCustomTileIdInput) {
            this.load();
        } else {
            this.resetSelectionState();
            this.customTileId = "";
        }
    }

    reset() {
        this.loading = true;
        this.resetSelectionState();
        this.showCustomTileIdInput = false;
        this.customTileId = "";
    }

    close() {
        this.menuService.tileSourceDataDialogVisible = false;
    }

    private resetSelectionState() {
        this.errorString = "";
        this.selectedTileId = undefined;
        this.selectedMapId = undefined;
        this.selectedSourceDataLayer = undefined;
        this.mapIds = [];
        this.sourceDataLayers = [];
        this.mapIdsPerTileId.clear();
        this.sourceDataLayersPerMapId.clear();
    }

    private restorePreferredMapSelection() {
        if (this.customMapId) {
            const mapSelection = this.mapIds.find(entry => entry.id == this.customMapId);
            if (mapSelection) {
                this.selectedMapId = mapSelection;
            } else {
                this.mapIds.unshift({ id: this.customMapId, name: this.customMapId });
            }
            return;
        }

        const savedMapId = this.menuService.lastInspectedTileSourceDataOption.getValue()?.mapId;
        if (!savedMapId) {
            return;
        }
        this.selectedMapId = this.mapIds.find(entry => entry.id == savedMapId);
    }

    private restorePreferredLayerSelection() {
        const savedLayerId = this.menuService.lastInspectedTileSourceDataOption.getValue()?.layerId;
        if (savedLayerId) {
            const layerSelection = this.sourceDataLayers.find(entry => entry.id == savedLayerId);
            if (layerSelection) {
                this.selectedSourceDataLayer = layerSelection;
                return;
            }
        }
        this.selectedSourceDataLayer = this.sourceDataLayers[0];
    }
}
