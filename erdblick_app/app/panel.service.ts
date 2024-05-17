import {Injectable} from "@angular/core";
import {BehaviorSubject} from "rxjs";

@Injectable({providedIn: 'root'})
export class SidePanelService {
    public static MAPS = "maps-panel"
    public static SEARCH = "search-panel"
    public static NONE = "none"

    activeSidePanel = new BehaviorSubject<string>(SidePanelService.NONE);
}
