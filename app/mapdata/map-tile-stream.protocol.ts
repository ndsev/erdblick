/**
 * Tile-stream framing values, message shapes and observable transport snapshots.
 * Data consumers can interpret deliveries without importing a network client;
 * connection lifetime and byte parsing remain in the client implementation.
 */
import { VIEWER_ACTION_CONTROL_FRAME_TYPE } from "../action/viewer-action-relay.contract";

export enum MapTileRequestStatus {
    Open = 0,
    Success = 1,
    NoDataSource = 2,
    Unauthorized = 3,
    Aborted = 4,
}

export const MAP_TILE_STREAM_HEADER_SIZE = 11;

export const MAP_TILE_STREAM_TYPE_FIELDS = 1;

export const MAP_TILE_STREAM_TYPE_FEATURES = 2;

export const MAP_TILE_STREAM_TYPE_SOURCEDATA = 3;

export const MAP_TILE_STREAM_TYPE_STATUS = 4;

export const MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT = 6;

export const MAP_TILE_STREAM_TYPE_SUBSETS = 7;

export const MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE = 8;

export const MAP_TILE_STREAM_TYPE_ACTION_CONTROL = VIEWER_ACTION_CONTROL_FRAME_TYPE;

export const MAP_TILE_STREAM_TYPE_INCOMING_RELATIONS = 10;

export const MAP_TILE_STREAM_TYPE_END_OF_STREAM = 128;

export const MAP_TILE_STREAM_REQUEST_CONTEXT_TYPE = "mapget.tiles.request-context";

export const MAP_TILE_STREAM_FILTER_STATUS_TYPE = "mapget.filter.status";

export interface MapTileStreamStatusRequest {
    index: number;
    mapId: string;
    layerId: string;
    status: MapTileRequestStatus;
    statusText: string;
    noDataSourceReason?: string;
}

export interface MapTileStreamStatusPayload {
    type: string;
    requestId?: number;
    allDone: boolean;
    requests: MapTileStreamStatusRequest[];
    message?: string;
}

export interface MapTileStreamFilterStatusPayload {
    type: typeof MAP_TILE_STREAM_FILTER_STATUS_TYPE;
    filterId: string;
    generation: number;
    mapId?: string;
    layerId?: string;
    sourceId?: string;
    state: string;
    outputTilesRequested?: number;
    sourceTilesQueued?: number;
    sourceTilesLoaded?: number;
    sourceTilesEvaluated?: number;
    outputTilesReady?: number;
    outputTilesEmitted?: number;
    entriesEmitted?: number;
    error?: string;
}

export enum TileLoadState {
    LoadingQueued = 0,
    BackendFetching = 1,
    BackendConverting = 2,

    Error = 128,            // Only used by erdblick
    RenderingQueued = 129,  // Only used by erdblick
    Ok = 130,               // Only used by erdblick
}

export interface MapTileStreamRequestContextPayload {
    type: string;
    requestId: number;
    clientId?: string;
    sourcesRevision?: number;
}

export interface MapTileStreamTransportCompressionStats {
    totalPullResponses: number;
    totalPullGzipResponses: number;
    totalUncompressedBytes: number;
    knownCompressedBytes: number;
    knownCompressedUncompressedBytes: number;
    responsesWithKnownCompressedBytes: number;
    compressionRatioPct: number | null;
    compressionSavingsPct: number | null;
    knownCompressedCoveragePct: number;
}

/** Lightweight datasource status object optionally embedded in a source-catalog change frame. */
export interface MapTileStreamSourceCatalogChangeSource {
    configIndex: number;
    status?: string;
    statusMessage?: string;
    progress?: number | null;
    retrying?: boolean;
}

/** Control payload emitted by mapget when datasource catalog state or structure changes. */
export interface MapTileStreamSourceCatalogChangePayload {
    type: "mapget.sources.changed";
    revision: number;
    reason?: string;
    source?: MapTileStreamSourceCatalogChangeSource;
}

/** Details from a VTLV frame header whose major/minor version cannot be decoded safely. */
export interface MapTileStreamProtocolMismatch {
    actual: {major: number; minor: number; patch: number};
    expected: {major: number; minor: number};
}

export interface MapTileStreamDebugState {
    isOpen: boolean;
    awaitingCompletion: boolean;
    activeWebSocketPath: string;
    activePullPath: string;
    usingLegacyWebSocketFallback: boolean;
    usingLegacyPullFallback: boolean;
    latestRequestedRequestId: number | null;
    incomingRequestId: number | null;
    supportsRequestContextFrames: boolean;
    pullClientId: string | null;
    sourcesRevision: number | null;
    pendingFrameQueueSize: number;
    frameProcessingPaused: boolean;
    pullCompressionEnabled: boolean;
    pullBatchMaxBytesBudget: number;
    downstreamBytesPerSecondEwma: number;
    totalPullResponses: number;
    totalPullGzipResponses: number;
    lastStatusPayload: Pick<MapTileStreamStatusPayload, 'requestId' | 'allDone' | 'message'> & {
        requestCount: number;
    } | null;
}
