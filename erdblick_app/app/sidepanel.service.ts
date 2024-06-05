import {Injectable} from "@angular/core";
import {BehaviorSubject} from "rxjs";

export enum SidePanelState {
    MAPS = "maps-panel",
    SEARCH = "search-panel",
    FEATURESEARCH = "feature-search",
    NONE = "none"
}

@Injectable({providedIn: 'root'})
export class SidePanelService {
    previousState: string = SidePanelState.NONE;
    private _activeSidePanel = new BehaviorSubject<string>(SidePanelState.NONE);

    get panel() {
        return this._activeSidePanel.getValue();
    }

    set panel(value: string) {
        this.previousState = this._activeSidePanel.getValue();
        this._activeSidePanel.next(value);
    }

    observable() {
        return this._activeSidePanel.asObservable();
    }
}
