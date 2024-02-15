import {Injectable} from "@angular/core";
import {ErdblickModel} from "./erdblick.model";
import {ErdblickView} from "./erdblick.view";
import {BehaviorSubject} from "rxjs";

export interface ErdblickMap {
    coverage: BigInt;
    level: number;
    mapLayers: Array<ErdblickLayer>;
    visible: boolean;
}

export interface ErdblickLayer {
    name: string;
    coverage: BigInt;
    level: number;
    visible: boolean;
}

@Injectable({providedIn: 'root'})
export class MapService {

    mapModel: BehaviorSubject<ErdblickModel | null> = new BehaviorSubject<ErdblickModel | null>(null);
    mapView: ErdblickView | undefined;
    coreLib: any;
    osmEnabled: boolean = true;
    osmOpacityValue: number = 30;

    constructor() { }

    collectCameraOrientation() {
        if (this.mapView !== undefined) {
            return {
                heading: this.mapView.viewer.camera.heading,
                pitch: this.mapView.viewer.camera.pitch,
                roll: this.mapView.viewer.camera.roll
            };
        }
        return null;
    }

    collectCameraPosition() {
        if (this.mapView !== undefined) {
            return {
                x: this.mapView.viewer.camera.position.x,
                y: this.mapView.viewer.camera.position.y,
                z: this.mapView.viewer.camera.position.z
            };
        }
        return null;
    }

    reloadStyle() {
        if (this.mapModel.getValue()) {
            this.mapModel.getValue()!.reloadStyle();
        }
    }
}