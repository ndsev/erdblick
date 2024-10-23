import {Injectable} from "@angular/core";
import {MenuItem} from "primeng/api";
import {BehaviorSubject} from "rxjs";

@Injectable()
export class RightClickMenuService {

    menuItems: MenuItem[];
    tileIdsReady: BehaviorSubject<boolean> = new BehaviorSubject(false);
    tileSourceDataDialogVisible: boolean = false;

    constructor() {
        this.menuItems = [{
            label: 'Tile Source Data',
            icon: 'pi pi-database',
            command: () => {
                this.tileSourceDataDialogVisible = true;
            }
        }];
    }
}