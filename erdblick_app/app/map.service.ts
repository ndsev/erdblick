import {Injectable} from "@angular/core";
import {ErdblickModel} from "./erdblick.model";
import {StyleService} from "./style.service";
import {CoreService} from "./core.service";

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

    mapModel: ErdblickModel;
    tilesToLoadLimit: number = 0;
    tilesToVisualizeLimit: number = 0;

    constructor(public coreService: CoreService,
                public styleService: StyleService) {
        this.mapModel = new ErdblickModel(this.coreService.coreLib!, this.styleService);
        this.applyTileLimits(this.mapModel.maxLoadTiles, this.mapModel.maxVisuTiles);

        this.mapModel.mapInfoTopic.subscribe((mapItems: Map<string, MapInfoItem>) => {
            this.mapModel.availableMapItems.next(mapItems);
        });
    }

    applyTileLimits(tilesToLoadLimit: number, tilesToVisualizeLimit: number) {
        if (isNaN(tilesToLoadLimit) || isNaN(tilesToVisualizeLimit)) {
            return false;
        }

        this.tilesToLoadLimit = tilesToLoadLimit;
        this.tilesToVisualizeLimit = tilesToVisualizeLimit;
        if (this.mapModel) {
            this.mapModel.maxLoadTiles = this.tilesToLoadLimit;
            this.mapModel.maxVisuTiles = this.tilesToVisualizeLimit;
            this.mapModel.update();
        }

        console.log(`Max tiles to load set to ${this.tilesToLoadLimit}`);
        console.log(`Max tiles to visualize set to ${this.tilesToVisualizeLimit}`);
        return true;
    }
}