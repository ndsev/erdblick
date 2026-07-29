/** UI-facing result entry projected from one TileSubsetLayer channel. */
export interface SearchResultTileEntry {
    mapTileKey: string;
    featureId: string;
    resultIndex: number;
    position?: {
        cartesian: {x: number; y: number; z: number};
        cartographic: {x: number; y: number; z: number} | null;
        cartographicRad?: {
            longitude: number;
            latitude: number;
            height: number;
        } | null;
    };
    values?: unknown[];
    attributeIndex?: number;
    validityIndex?: number;
    validityCount?: number;
}

/** Compact list-ingestion payload derived from an immutable search subset. */
export interface SearchResultTilePayload {
    searchId: string;
    refresh: number;
    mapId: string;
    layerId: string;
    tileId: number;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: number;
    requestOrder: number;
    resultCount: number;
    resultFields: string[];
    tilesConsidered?: number;
    tilesCompleted?: number;
    layerBlob: Uint8Array;
    diagnostics: Uint8Array | null;
    entries: SearchResultTileEntry[];
    entryOffset?: number;
    entriesComplete?: boolean;
}

/** Schema-backed candidate indicating that a query can run in attribute scope. */
export interface FeatureSearchAttributeScopeCandidate {
    attrName: string;
    attrLayerName: string;
    featureType: string;
    mapId: string;
    layerId: string;
}

export type FeatureSearchStyleValueKind =
    | "number"
    | "integer"
    | "string"
    | "boolean"
    | "enum"
    | "object"
    | "array"
    | "unknown";

/** Schema-backed result-value field candidate for search-result style rules. */
export interface FeatureSearchStyleFieldCandidate {
    path: string;
    mapId: string;
    layerId: string;
    attrName?: string;
    attrLayerName?: string;
    featureType?: string;
    valueKind: FeatureSearchStyleValueKind;
    enumValues: string[];
    numericRange?: {min: number; max: number};
}
