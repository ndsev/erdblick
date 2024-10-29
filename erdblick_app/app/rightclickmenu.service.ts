import {Injectable} from "@angular/core";
import {MenuItem} from "primeng/api";
import {BehaviorSubject, Subject} from "rxjs";
import {InspectionService} from "./inspection.service";
import {Entity} from "./cesium";

export interface SourceDataDropdownOption {
    id: bigint | string,
    name: string,
    disabled?: boolean
}

@Injectable()
export class RightClickMenuService {

    menuItems: BehaviorSubject<MenuItem[]> = new BehaviorSubject<MenuItem[]>([]);
    tileSourceDataDialogVisible: boolean = false;
    lastInspectedTileSourceDataOption: BehaviorSubject<{tileId: number, mapId: string, layerId: string} | null> =
        new BehaviorSubject<{tileId: number, mapId: string, layerId: string} | null>(null);
    tileIdsForSourceData: Subject<SourceDataDropdownOption[]> = new Subject<SourceDataDropdownOption[]>();
    tileOutiline: Subject<object | null> = new Subject<object | null>();
    customTileAndMapId: Subject<[string, string]> = new Subject<[string, string]>();

    constructor(private inspectionService: InspectionService) {
        this.menuItems.next([{
            label: 'Inspect Source Data for Tile',
            icon: 'pi pi-database',
            command: () => {
                this.tileSourceDataDialogVisible = true;
            }
        }]);

        this.lastInspectedTileSourceDataOption.subscribe(lastInspectedTileSourceData => {
            const items = this.menuItems.getValue();
            if (lastInspectedTileSourceData) {
                this.updateMenuForLastInspectedSourceData(lastInspectedTileSourceData);
            } else if (items.length > 1) {
                items.shift();
                this.menuItems.next(items);
            }
        });
    }

    private updateMenuForLastInspectedSourceData(sourceDataParams: {tileId: number, mapId: string, layerId: string}) {
        const menuItem = {
            label: 'Inspect Last Selected Source Data',
            icon: 'pi pi-database',
            command: () => {
                this.inspectionService.loadSourceDataInspection(
                    sourceDataParams.tileId,
                    sourceDataParams.mapId,
                    sourceDataParams.layerId
                );
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