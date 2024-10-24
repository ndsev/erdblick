import {Injectable} from "@angular/core";
import {MenuItem} from "primeng/api";
import {BehaviorSubject, Subject} from "rxjs";
import {InspectionService} from "./inspection.service";

export interface SourceDataDropdownOption {
    id: bigint | string,
    name: string,
    disabled?: boolean
}

@Injectable()
export class RightClickMenuService {

    menuItems: MenuItem[];
    tileSourceDataDialogVisible: boolean = false;
    lastInspectedTileSourceDataOption: BehaviorSubject<{tileId: number, mapId: string, layerId: string} | null> =
        new BehaviorSubject<{tileId: number, mapId: string, layerId: string} | null>(null);
    tileIdsForSourceData: Subject<SourceDataDropdownOption[]> = new Subject<SourceDataDropdownOption[]>();

    constructor(private inspectionService: InspectionService) {
        this.menuItems = [{
            label: 'Inspect Source Data for Tile',
            icon: 'pi pi-database',
            command: () => {
                this.tileSourceDataDialogVisible = true;
            }
        }];

        this.lastInspectedTileSourceDataOption.subscribe(lastInspectedTileSourceData => {
            if (lastInspectedTileSourceData) {
                this.updateMenuForLastInspectedSourceData(lastInspectedTileSourceData);
            } else if (this.menuItems.length > 1) {
                this.menuItems.shift();
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

        if (this.menuItems.length > 1) {
            this.menuItems[0] = menuItem;
        } else {
            this.menuItems.unshift(menuItem);
        }
    }
}