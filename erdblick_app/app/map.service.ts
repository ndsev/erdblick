import {Injectable} from "@angular/core";
import {ErdblickModel} from "./erdblick.model";
import {ErdblickView} from "./erdblick.view";
import {BehaviorSubject} from "rxjs";

export interface ErdblickMap {
    mapName: string;
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
    tilesToLoadLimit: number = 0;
    tilesToVisualizeLimit: number = 0;

    constructor() {}

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

    reloadStyle(styleId: string) {
        if (this.mapModel.getValue()) {
            this.mapModel.getValue()!.reloadStyle(styleId);
        }
    }

    reapplyStyle(styleId: string) {
        if (this.mapModel.getValue()) {
            this.mapModel.getValue()!.reapplyStyles([styleId]);
        }
    }

    applyTileLimits(tilesToLoadLimit: number, tilesToVisualizeLimit: number) {
        if (isNaN(tilesToLoadLimit) || isNaN(tilesToVisualizeLimit)) {
            return false;
        }

        this.tilesToLoadLimit = tilesToLoadLimit;
        this.tilesToVisualizeLimit = tilesToVisualizeLimit;
        if (this.mapModel.getValue()) {
            this.mapModel.getValue()!.maxLoadTiles = this.tilesToLoadLimit;
            this.mapModel.getValue()!.maxVisuTiles = this.tilesToVisualizeLimit;
            this.mapModel.getValue()!.update();
        }

        console.log(`Max tiles to load set to ${this.tilesToLoadLimit}`);
        console.log(`Max tiles to visualize set to ${this.tilesToVisualizeLimit}`);
        return true;
    }
}