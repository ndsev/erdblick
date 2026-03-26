import type {FeatureTile} from "./features.model";

export interface RelationLocateRequest {
    mapId: string;
    typeId: string;
    featureId: Array<string | number>;
}

export interface RelationLocateResolution {
    tileId: string;
    typeId: string;
    featureId: Array<string | number>;
}

export interface RelationLocateResult {
    responses: RelationLocateResolution[][];
    tiles: FeatureTile[];
}
