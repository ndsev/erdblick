import {StyleSourceRef, StyleValidationIssue} from "../../styledata/style-validation.model";

/** Render every deck geometry family the wasm renderer can emit. */
export const DECK_GEOMETRY_OUTPUT_ALL = 0;
/** Restrict wasm output to point-like geometry so point-only passes skip heavy mesh work. */
export const DECK_GEOMETRY_OUTPUT_POINTS_ONLY = 1;
/** Restrict wasm output to non-point geometry for split point-vs-rest render passes. */
export const DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY = 2;

/** Discriminated set of geometry-output modes understood by both main thread and worker. */
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
    nodeId: string;
    mapName: string;
    layerName: string;
    styleSource: string;
    styleSourceRef: StyleSourceRef;
    styleOptions: Record<string, boolean | number | string>;
    highlightModeValue: number;
    fidelityValue: number;
    highFidelityStage: number;
    maxLowFiLod: number;
    outputMode: DeckGeometryOutputMode;
    featureIdSubset: string[];
    mergeCountSnapshot: Record<string, number>;
}

/** Supplies datasource metadata to a render worker once per map before tile tasks reference it. */
export interface DeckWorkerDataSourceInfoMessage {
    type: "DeckWorkerDataSourceInfo";
    mapName: string;
    dataSourceInfoBlob: Uint8Array;
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

/** Packed deck GLTF-node buffers emitted by wasm rendering. */
export interface DeckGltfBucketBuffers {
    nodeIndices: Uint32Array;
    colors: Uint8Array;
    depthTests: Uint8Array;
    featureAddresses: Uint32Array;
}

/** Packed simplified GLTF picking-proxy buffers emitted by wasm rendering. */
export interface DeckGltfPickProxyBucketBuffers {
    positions: Float32Array;
    startIndices: Uint32Array;
    nodeIndices: Uint32Array;
    featureAddresses: Uint32Array;
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
    gltfNodes: DeckGltfBucketBuffers;
    gltfPickProxies: DeckGltfPickProxyBucketBuffers;
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
    styleIssues?: StyleValidationIssue[];
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
export type DeckWorkerInboundMessage =
    DeckTileRenderTask |
    DeckWorkerDataSourceInfoMessage |
    DeckWorkerInitMessage;
/** All messages emitted by the worker. */
export type DeckWorkerOutboundMessage = DeckTileRenderResult | DeckWorkerReadyMessage;
