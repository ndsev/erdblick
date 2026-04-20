export const DECK_GEOMETRY_OUTPUT_ALL = 0;
export const DECK_GEOMETRY_OUTPUT_POINTS_ONLY = 1;
export const DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY = 2;

export type DeckGeometryOutputMode =
    typeof DECK_GEOMETRY_OUTPUT_ALL |
    typeof DECK_GEOMETRY_OUTPUT_POINTS_ONLY |
    typeof DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY;

/** Inbound worker task that contains every staged tile/style input needed for buffer generation. */
export interface DeckTileRenderTask {
    type: "DeckTileRenderTask";
    taskId: string;
    viewIndex: number;
    tileKey: string;
    tileStageBlobs: Uint8Array[];
    fieldDictBlob: Uint8Array;
    dataSourceInfoBlob: Uint8Array;
    nodeId: string;
    mapName: string;
    styleSource: string;
    styleOptions: Record<string, boolean | number | string>;
    highlightModeValue: number;
    fidelityValue: number;
    highFidelityStage: number;
    maxLowFiLod: number;
    outputMode: DeckGeometryOutputMode;
    featureIdSubset: string[];
    mergeCountSnapshot: Record<string, number>;
}

/** Handshake message sent from the main thread to bootstrap the render worker. */
export interface DeckWorkerInitMessage {
    type: "DeckWorkerInit";
}

/** Handshake response that exposes the worker script URL for blob-based worker fan-out. */
export interface DeckWorkerReadyMessage {
    type: "DeckWorkerReady";
    scriptUrl: string;
}

/** Timing breakdown reported by the worker for diagnostics and regression tracking. */
export interface DeckWorkerTimings {
    deserializeMs: number;
    renderMs: number;
    totalMs: number;
}

/** Packed deck point-bucket buffers emitted by the worker. */
export interface DeckPointBucketBuffers {
    positions: Float32Array;
    colors: Uint8Array;
    radii: Float32Array;
    depthTests: Uint8Array;
    featureAddresses: Uint32Array;
}

/** Packed deck surface-bucket buffers emitted by the worker. */
export interface DeckSurfaceBucketBuffers {
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    depthTests: Uint8Array;
    featureAddresses: Uint32Array;
}

/** Packed deck path/arrow buffers emitted by the worker. */
export interface DeckPathBucketBuffers {
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    widths: Float32Array;
    depthTests: Uint8Array;
    featureAddresses: Uint32Array;
    dashArrays?: Float32Array;
}

/** Expanded label datum used because deck text layers consume object arrays rather than packed buffers. */
export interface DeckLabelDatum {
    featureAddress: number;
    position: {x: number, y: number, z: number};
    text: string;
    fillColor: [number, number, number, number];
    outlineColor: [number, number, number, number];
    outlineWidth: number;
    scale: number;
    pixelOffset?: [number, number];
    billboard: boolean;
    depthTest?: boolean;
}

/** Full set of geometry buckets for one rendered tile or low-fi LOD bundle. */
export interface DeckGeometryBucketBuffers {
    pointWorld: DeckPointBucketBuffers;
    pointBillboard: DeckPointBucketBuffers;
    labelWorld: DeckLabelDatum[];
    labelBillboard: DeckLabelDatum[];
    surface: DeckSurfaceBucketBuffers;
    pathWorld: DeckPathBucketBuffers;
    pathBillboard: DeckPathBucketBuffers;
    arrowWorld: DeckPathBucketBuffers;
    arrowBillboard: DeckPathBucketBuffers;
}

/** One low-fidelity bundle emitted in addition to the high-fidelity/default geometry buffers. */
export interface DeckLowFiBundleBuffers extends DeckGeometryBucketBuffers {
    lod: number;
}

/** Geometry output shared by worker results before transport-specific metadata is added. */
export interface DeckVisualizationBufferResult extends DeckGeometryBucketBuffers {
    coordinateOrigin: Float64Array;
    lowFiBundles: DeckLowFiBundleBuffers[];
    mergedPointFeatures: Record<string, any[]>;
}

/** Main-thread-friendly view of a worker result after message unpacking and timing normalization. */
export interface DeckTileRenderBuffers extends DeckVisualizationBufferResult {
    vertexCount: number;
    workerTimings?: DeckWorkerTimings;
}

/** Worker-to-main-thread render result message. */
export interface DeckTileRenderResult extends DeckVisualizationBufferResult {
    type: "DeckTileRenderResult";
    taskId: string;
    tileKey: string;
    vertexCount: number;
    timings?: DeckWorkerTimings;
    error?: string;
}

/** All messages accepted by the worker. */
export type DeckWorkerInboundMessage = DeckTileRenderTask | DeckWorkerInitMessage;
/** All messages emitted by the worker. */
export type DeckWorkerOutboundMessage = DeckTileRenderResult | DeckWorkerReadyMessage;
