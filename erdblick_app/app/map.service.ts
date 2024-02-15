import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import {ErdblickModel} from "./erdblick.model";
import {ErdblickView} from "./erdblick.view";

@Injectable({providedIn: 'root'})
export class MapService {

    mapModel: ErdblickModel | undefined;
    mapView: ErdblickView | undefined;
    coreLib: any;

    constructor() { }

    collectCameraInfo() {
        if (this.mapView !== undefined) {
            return {
                heading: this.mapView.viewer.camera.heading,
                pitch: this.mapView.viewer.camera.pitch,
                roll: this.mapView.viewer.camera.roll
            };
        }
        return null;
    }
}