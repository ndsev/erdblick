import {Injectable} from "@angular/core";
import {ErdblickModel} from "./erdblick.model";
import {ErdblickView} from "./erdblick.view";
import {BehaviorSubject} from "rxjs";
import {MainModule as ErdblickCore} from '../../build/libs/core/erdblick-core';

export interface MapItemLayer extends Object {
    canRead: boolean;
    canWrite: boolean;
    coverage: Array<bigint>;
    featureTypes: Array<{name: string, uniqueIdCompositions: Array<Object>}>;
    layerId: string;
    type: string;
    version: {major: number, minor: number, patch: number};
    zoomLevels: Array<number>;
    level: number;
    visible: boolean;
}

export interface MapInfoItem extends Object {
    extraJsonAttachment: Object;
    layers: Map<string, MapItemLayer>;
    mapId: string;
    maxParallelJobs: number;
    nodeId: string;
    protocolVersion: {major: number, minor: number, patch: number};
    level: number;
    visible: boolean;
}

@Injectable({providedIn: 'root'})
export class MapService {

    mapModel: BehaviorSubject<ErdblickModel | null> = new BehaviorSubject<ErdblickModel | null>(null);
    mapView: ErdblickView | undefined;
    coreLib: ErdblickCore | undefined;
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

    reloadBuiltinStyle(styleId: string) {
        if (this.mapModel.getValue()) {
            this.mapModel.getValue()!.reloadStyle(styleId);
        }
    }

    reapplyStyle(styleId: string) {
        if (this.mapModel.getValue()) {
            this.mapModel.getValue()!.reapplyStyles([styleId]);
        }
    }

    loadImportedStyle(styleId: string) {
        if (this.mapModel.getValue()) {
            this.mapModel.getValue()!.cycleImportedStyle(styleId, false);
        }
    }

    removeImportedStyle(styleId: string) {
        if (this.mapModel.getValue()) {
            this.mapModel.getValue()!.cycleImportedStyle(styleId, true);
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