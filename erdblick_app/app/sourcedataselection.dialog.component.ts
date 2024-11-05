import {Component} from "@angular/core";
import {ParametersService} from "./parameters.service";
import {RightClickMenuService, SourceDataDropdownOption} from "./rightclickmenu.service";
import {MapService} from "./map.service";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";
import {InspectionService} from "./inspection.service";
import {CallbackProperty, Color, HeightReference, Rectangle} from "./cesium";
import {coreLib} from "./wasm";

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
                    <p-dropdown *ngIf="!errorString && !showCustomTileIdInput"
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

    constructor(private mapService: MapService,
                private inspectionService: InspectionService,
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
        this.mapIds = [];
        this.sourceDataLayers = [];
        this.loading = false;
        this.menuService.tileOutiline.next(null);

        // Special case: There is a custom tile ID.
        if (customTileId) {
            this.onCustomTileIdChange(customTileId);
            return;
        }

        // Abort if no Tile IDs were provided by the menu service.
        if (!this.tileIds.length) {
            this.selectedTileId = undefined;
            this.errorString = "No tile IDs available for the clicked position!";
            return;
        }

        // Fill map IDs per tile ID.
        for (let i = 0; i < this.tileIds.length; i++) {
            const id = this.tileIds[i].id as bigint;
            const maps = [...this.findMapsForTileId(id)];
            this.tileIds[i]["disabled"] = !maps.length;
            this.mapIdsPerTileId.set(id, maps);
        }

        // Pre-select the tile ID.
        let tileIdSelection = this.tileIds.find(element =>
            !element.disabled && [...this.mapService.tileLayersForTileId(element.id as bigint)]
        );
        if (tileIdSelection) {
            this.setCurrentTileId(tileIdSelection);
        }
    }

    *findMapsForTileId(tileId: bigint): Generator<SourceDataDropdownOption> {
        const level = coreLib.getTileLevel(tileId);
        for (const [_, mapInfo] of this.mapService.maps.getValue().entries()) {
            for (const [_, layerInfo] of mapInfo.layers.entries()) {
                if (layerInfo.type == "SourceData") {
                    if (!layerInfo.zoomLevels.length || layerInfo.zoomLevels.includes(level)) {
                        yield { id: mapInfo.mapId, name: mapInfo.mapId };
                        break;
                    }
                }
            }
        }
    }

    onCustomTileIdChange(tileIdString: string) {
        if (!tileIdString) {
            this.mapIds = [];
            this.sourceDataLayers = [];
            return;
        }

        const tileId = BigInt(tileIdString);
        const maps = [...this.findMapsForTileId(tileId)];
        this.mapIdsPerTileId.set(tileId, maps);
        this.setCurrentTileId({id: tileId, name: tileIdString});
    }

    private setCurrentTileId(tileId: SourceDataDropdownOption) {
        this.selectedTileId = tileId;
        this.onTileIdChange(tileId);

        if (this.customMapId) {
            let mapSelection = this.mapIds.find(entry => entry.id == this.customMapId);
            if (mapSelection) {
                this.selectedMapId = mapSelection;
            }
            else {
                this.mapIds.unshift({ id: this.customMapId, name: this.customMapId });
            }
        }

        if (this.mapIds.length) {
            if (!this.selectedMapId) {
                this.selectedMapId = this.mapIds[0];
            }
            this.onMapIdChange(this.selectedMapId);
            if (this.sourceDataLayers.length) {
                this.selectedSourceDataLayer = this.sourceDataLayers[0];
                this.onLayerIdChange(this.selectedSourceDataLayer);
            }
        }
    }

    onTileIdChange(tileId: SourceDataDropdownOption) {
        this.selectedMapId = undefined;
        this.selectedSourceDataLayer = undefined;
        this.sourceDataLayers = [];
        this.outlineTheTileBox(BigInt(tileId.id), Color.HOTPINK);
        const mapIds = this.mapIdsPerTileId.get(tileId.id as bigint);
        if (mapIds !== undefined) {
            this.mapIds = mapIds.sort((a, b) => a.name.localeCompare(b.name));
            for (let i = 0; i < this.mapIds.length; i++) {
                const id = this.mapIds[i].id as string;
                const layers = this.findLayersForMapId(id);
                this.mapIds[i]["disabled"] = !layers.length;
                this.sourceDataLayersPerMapId.set(id, layers);
            }
        }
    }

    outlineTheTileBox(tileId: bigint, color: Color) {
        this.menuService.tileOutiline.next(null);
        const tileBox = coreLib.getTileBox(tileId);
        const entity = {
            rectangle: {
                coordinates: Rectangle.fromDegrees(...tileBox),
                height: HeightReference.CLAMP_TO_GROUND,
                material: Color.TRANSPARENT,
                outlineWidth: 2,
                outline: true,
                outlineColor: color.withAlpha(0.5)
            }
        }
        this.menuService.tileOutiline.next(entity);
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
                name: this.inspectionService.layerNameForSourceDataLayerId(layerId)
            }));
        }
        return [];
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
            this.errorString = "";
            this.mapIds = [];
            this.sourceDataLayers = [];
            this.selectedTileId = undefined;
            this.selectedMapId = undefined;
            this.selectedSourceDataLayer = undefined;
            this.customTileId = "";
        }
    }

    reset() {
        this.loading = true;
        this.errorString = "";
        this.selectedTileId = undefined;
        this.selectedMapId = undefined;
        this.selectedSourceDataLayer = undefined;
        this.mapIds = [];
        this.sourceDataLayers = [];
        this.showCustomTileIdInput = false;
        this.customTileId = "";
    }

    close() {
        this.menuService.tileSourceDataDialogVisible = false;
    }
}