import {Injectable} from "@angular/core";
import {MenuItem} from "primeng/api";
import {BehaviorSubject, Subject} from "rxjs";
import {Color, HeightReference, Rectangle} from "../integrations/geo";
import {coreLib} from "../integrations/wasm";
import {AppStateService, SelectedSourceData} from "../shared/appstate.service";

export interface SourceDataDropdownOption {
    id: bigint | string,
    name: string,
    disabled?: boolean
    tileLevel?: number;
}

export interface TileOutlinePayload {
    rectangle: {
        coordinates: {
            west: number;
            south: number;
            east: number;
            north: number;
        };
        [key: string]: unknown;
    };
}

@Injectable()
export class RightClickMenuService {

    menuItems: BehaviorSubject<MenuItem[]> = new BehaviorSubject<MenuItem[]>([]);
    tileSourceDataDialogVisible: boolean = false;
    preferredTileIdForSourceData: bigint | null = null;
    lastInspectedTileSourceDataOption: BehaviorSubject<{tileId: number, mapId: string, layerId: string} | null> =
        new BehaviorSubject<{tileId: number, mapId: string, layerId: string} | null>(null);
    tileIdsForSourceData: Subject<SourceDataDropdownOption[]> = new Subject<SourceDataDropdownOption[]>();
    tileOutline: Subject<TileOutlinePayload | null> = new Subject<TileOutlinePayload | null>();
    customTileAndMapId: Subject<[string, string]> = new Subject<[string, string]>();

    constructor(private stateService: AppStateService) {
        this.menuItems.next([{
            label: 'Inspect Source Data for Tile',
            icon: 'pi pi-database',
            command: () => {
                this.tileSourceDataDialogVisible = true;
            }
        }]);

        this.tileIdsForSourceData.subscribe(tileIds => {
            const items = this.menuItems.getValue();
            const lastOption = this.lastInspectedTileSourceDataOption.getValue();
            if (lastOption) {
                const tileId = this.preferredSourceDataTile(tileIds);
                if (tileId) {
                    this.updateMenuForLastInspectedSourceData({
                        tileId: tileId.id as bigint,
                        mapId: lastOption.mapId,
                        layerId: lastOption.layerId
                    });
                    return;
                }
            }

            if (items.length > 1) {
                items.shift();
                this.menuItems.next(items);
            }
        });
    }

    preferredSourceDataTile(tileIds: SourceDataDropdownOption[]): SourceDataDropdownOption | undefined {
        if (this.preferredTileIdForSourceData !== null) {
            const preferredTile = tileIds.find(tileId => tileId.id === this.preferredTileIdForSourceData && !tileId.disabled);
            if (preferredTile) {
                return preferredTile;
            }
        }

        const lastOption = this.lastInspectedTileSourceDataOption.getValue();
        if (lastOption) {
            const level = coreLib.getTileLevel(BigInt(lastOption.tileId));
            const matchingTile = tileIds.find(tileId => tileId.tileLevel === level && !tileId.disabled);
            if (matchingTile) {
                return matchingTile;
            }
        }

        for (let index = tileIds.length - 1; index >= 0; index--) {
            const tileId = tileIds[index];
            if (!tileId.disabled) {
                return tileId;
            }
        }
        return undefined;
    }

    outlineTile(tileId: bigint, color: Color = Color.HOTPINK) {
        const tileBox = coreLib.getTileBox(tileId);
        this.tileOutline.next({
            rectangle: {
                coordinates: Rectangle.fromDegrees(...tileBox),
                height: HeightReference.CLAMP_TO_GROUND,
                material: color.withAlpha(0.2),
                outline: true,
                outlineWidth: 3.,
                outlineColor: color
            }
        });
    }

    private updateMenuForLastInspectedSourceData(sourceDataParams: {tileId: bigint, mapId: string, layerId: string}) {
        const menuItem = {
            label: 'Inspect Source Data with Last Layer',
            icon: 'pi pi-database',
            command: () => {
                this.stateService.setSelection({
                    mapTileKey: coreLib.getSourceDataLayerKey(sourceDataParams.mapId, sourceDataParams.layerId, sourceDataParams.tileId)
                } as SelectedSourceData);
            }
        };
        const items = this.menuItems.getValue();
        if (items.length > 1) {
            items[0] = menuItem;
        } else {
            items.unshift(menuItem);
        }
        this.menuItems.next(items);
    }
}
