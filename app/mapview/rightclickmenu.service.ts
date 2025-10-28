import {Injectable} from "@angular/core";
import {MenuItem} from "primeng/api";
import {BehaviorSubject, Subject} from "rxjs";
import {coreLib} from "../integrations/wasm";
import {AppStateService, SelectedSourceData} from "../shared/appstate.service";
import {EntityConstructorOptions} from "../integrations/cesium";

export interface SourceDataDropdownOption {
    id: bigint | string,
    name: string,
    disabled?: boolean
    tileLevel?: number;
}

@Injectable()
export class RightClickMenuService {

    menuItems: BehaviorSubject<MenuItem[]> = new BehaviorSubject<MenuItem[]>([]);
    tileSourceDataDialogVisible: boolean = false;
    lastInspectedTileSourceDataOption: BehaviorSubject<{tileId: number, mapId: string, layerId: string} | null> =
        new BehaviorSubject<{tileId: number, mapId: string, layerId: string} | null>(null);
    tileIdsForSourceData: Subject<SourceDataDropdownOption[]> = new Subject<SourceDataDropdownOption[]>();
    tileOutline: Subject<EntityConstructorOptions | null> = new Subject<EntityConstructorOptions | null>();
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
                const level = coreLib.getTileLevel(BigInt(lastOption.tileId));
                const tileId = tileIds.find(tileId => tileId.tileLevel === level);
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
