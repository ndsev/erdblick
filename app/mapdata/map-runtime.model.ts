import type {
    MapTileStreamSearchStatusPayload,
    MapTileStreamTransportCompressionStats
} from "./tilestream";
import type {FeatureTile} from "./features.model";

/** Promise-backed request used when selection/inspection pins a tile outside the viewport. */
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

/** Aggregate backend request progress reported by the `/tiles` websocket. */
export interface BackendRequestProgress {
    done: number;
    total: number;
    allDone: boolean;
    requestId?: number;
}

/** Single diagnostics snapshot consumed by the tile-loading HUD. */
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

/** Canonical map-tile cache key produced by the native TileLayerParser/core helpers. */
export type MapTileKey = string;

/** Fine-grained tile-data lifecycle event for consumers that need the concrete tile instance. */
export type TileDataChangeReason = "placeholder" | "loaded" | "evicted";

/** Payload for feature-tile data updates and evictions. */
export interface TileDataChange {
    tileKey: MapTileKey;
    tile: FeatureTile;
    reason: TileDataChangeReason;
}

/** Per-layer stage request bookkeeping used by progress UI and high-fidelity inspection checks. */
export interface RequestedLayerProgressState {
    mapId: string;
    layerId: string;
    tileMaxRequestedStageByKey: Map<string, number>;
    stageCount: number;
}

/** UI-facing point/result entry extracted from a streamed TileSearchResultLayer. */
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

/** Narrow TypeScript shape for native TileSearchResultLayer bindings used by stream parsing. */
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

/** Compact frontend payload emitted when a search result tile arrives. */
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

/** Payload emitted when a search result tile leaves the runtime cache. */
export interface SearchResultTileEvictedPayload {
    searchId: string;
    sourceTileKey: MapTileKey;
}

/** Internal render-invalidation payload for a removed high-fidelity search-result tile. */
export interface SearchResultTileRemovedPayload {
    searchId: string;
    sourceTileKey: MapTileKey;
}

/** Visible source-tile coverage for one map/layer pair. */
export interface SearchLayerTileSet {
    mapId: string;
    layerId: string;
    tileIds: Set<number>;
    priorityTileIds: Set<number>;
}

/** Concrete server-side search request embedded in the next `/tiles` update. */
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

/** Schema-backed candidate indicating that a query can run in attribute scope. */
export interface FeatureSearchAttributeScopeCandidate {
    attrName: string;
    attrLayerName: string;
    featureType: string;
    mapId: string;
    layerId: string;
}

/** Schema-backed result-value field candidate for search-result style rules. */
export interface FeatureSearchStyleFieldCandidate {
    path: string;
    mapId: string;
    layerId: string;
    attrName?: string;
    featureType?: string;
}

/** Re-export of the native search status payload type used by feature-search UI state. */
export type SearchStatusPayload = MapTileStreamSearchStatusPayload;

/** Re-export of transport compression statistics exposed by the websocket client. */
export type TileStreamCompressionStats = MapTileStreamTransportCompressionStats;
