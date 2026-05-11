import type {FeatureTile} from "./features.model";

/** Describes a relation-member lookup that asks the backend to locate referenced features. */
export interface RelationLocateRequest {
    mapId: string;
    typeId: string;
    featureId: Array<string | number>;
}

/** Describes one resolved relation member as returned by the locate endpoint. */
export interface RelationLocateResolution {
    tileId: string;
    typeId: string;
    featureId: Array<string | number>;
}

/** Bundles relation lookup responses with the fetched tiles needed to inspect the resolved features. */
export interface RelationLocateResult {
    responses: RelationLocateResolution[][];
    tiles: FeatureTile[];
}
