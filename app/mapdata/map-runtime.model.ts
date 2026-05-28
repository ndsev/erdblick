import type {
    MapTileStreamSearchStatusPayload,
    MapTileStreamTransportCompressionStats
} from "./tilestream";
import type {FeatureTile} from "./features.model";
import type {
    FeatureSearchRenderStrategy,
    FeatureSearchScope,
    FeatureSearchStyleRule
} from "../shared/feature-search-state";

export interface SelectionTileRequest {
    remoteRequest: {
        mapId: string,
        layerId: string,
        tileIds: Array<number>
    };
    tileKey: string;
    /** Keep the request pending until the selected tile has enough stages for inspection. */
    resolveWhenInspectionComplete?: boolean;
    resolve: null | ((tile: FeatureTile) => void);
    reject: null | ((why: unknown) => void);
}

export interface BackendRequestProgress {
    done: number;
    total: number;
    allDone: boolean;
    requestId?: number;
}

export interface TileLoadingHudStats {
    backend: BackendRequestProgress;
    downstreamBytesPerSecond: number;
    pullResponses: number;
    pullGzipResponses: number;
    pullUncompressedBytes: number;
    pullCompressedBytesKnown: number;
    pullCompressionRatioPct: number | null;
    pullCompressionCoveragePct: number;
    features: number;
    vertices: number;
    parseQueueSize: number;
    renderQueueSize: number;
    frameTimeMs: number;
    viewportRenderSeconds: number;
}

export type TileDataChangeReason = "placeholder" | "loaded" | "evicted";

export interface TileDataChange {
    tileKey: string;
    tile: FeatureTile;
    reason: TileDataChangeReason;
}

export interface RequestedLayerProgressState {
    mapId: string;
    layerId: string;
    tileMaxRequestedStageByKey: Map<string, number>;
    stageCount: number;
}

export interface FeatureSearchDataPlaneRequest {
    searchId: string;
    query: string;
    scope: FeatureSearchScope;
    autoUpdate: boolean;
    updateSerial: number;
    generationSerial: number;
    paused: boolean;
    showResultsOnMap: boolean;
    pinColor: string;
    searchStyleRules: FeatureSearchStyleRule[];
    renderStrategy: FeatureSearchRenderStrategy;
    withFields: string[];
}

export interface SearchResultTileEntry {
    mapTileKey: string;
    featureId: string;
    resultIndex: number;
    position: {
        cartesian: {x: number, y: number, z: number};
        cartographic: {x: number, y: number, z: number} | null;
        cartographicRad?: {longitude: number, latitude: number, height: number} | null;
    };
    values?: unknown[];
    attributeIndex?: number;
    validityIndex?: number;
    validityCount?: number;
}

export interface TileSearchResultLayerLike {
    copyDiagnostics?(buffer: unknown): void;
    info?(): unknown;
    nodeId(): string;
    resultFields?(): unknown;
    resultEntries?(): unknown;
    numResults?(): unknown;
    tileId(): unknown;
    mapId(): string;
    layerId(): string;
    diagnostics?(): Uint8Array | null;
    delete?(): void;
}

export interface SearchResultTilePayload {
    searchId: string;
    refresh: number;
    mapId: string;
    layerId: string;
    tileId: bigint;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: bigint;
    resultCount: number;
    resultFields: string[];
    tilesConsidered?: number;
    tilesCompleted?: number;
    traces: Record<string, unknown> | null;
    diagnostics: Uint8Array | null;
    entries: SearchResultTileEntry[];
}

export interface SearchResultTileEvictedPayload {
    searchId: string;
    sourceTileKey: string;
}

export interface SearchLayerTileSet {
    mapId: string;
    layerId: string;
    tileIds: Set<number>;
    priorityTileIds: Set<number>;
}

export interface FeatureSearchTileState {
    mapId: string;
    layerId: string;
    tileId: number;
    sourceTileKey: string;
    refresh: number;
    priority: boolean;
    requested: boolean;
    completed: boolean;
}

export interface FeatureSearchTileRequest {
    mapId: string;
    layerId: string;
    tileIds: number[];
    priorityTileIds?: number[];
    searchId: string;
    refresh: number;
    searchQuery: string;
    searchScope: "feature" | "attribute";
    withFields?: string[];
}

export interface FeatureSearchAttributeScopeCandidate {
    attrName: string;
    attrLayerName: string;
    featureType: string;
    mapId: string;
    layerId: string;
}

export interface FeatureSearchStyleFieldCandidate {
    path: string;
    mapId: string;
    layerId: string;
    attrName?: string;
    featureType?: string;
}

export type SearchStatusPayload = MapTileStreamSearchStatusPayload;
export type TileStreamCompressionStats = MapTileStreamTransportCompressionStats;
