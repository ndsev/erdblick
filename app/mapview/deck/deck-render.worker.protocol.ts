export const DECK_GEOMETRY_OUTPUT_ALL = 0;
export const DECK_GEOMETRY_OUTPUT_POINTS_ONLY = 1;
export const DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY = 2;

export type DeckGeometryOutputMode =
    typeof DECK_GEOMETRY_OUTPUT_ALL |
    typeof DECK_GEOMETRY_OUTPUT_POINTS_ONLY |
    typeof DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY;

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

export interface DeckWorkerInitMessage {
    type: "DeckWorkerInit";
}

export interface DeckWorkerReadyMessage {
    type: "DeckWorkerReady";
    scriptUrl: string;
}

export interface DeckWorkerTimings {
    deserializeMs: number;
    renderMs: number;
    totalMs: number;
}

export interface DeckPointBucketBuffers {
    positions: Float32Array;
    colors: Uint8Array;
    radii: Float32Array;
    featureIds: Uint32Array;
}

export interface DeckSurfaceBucketBuffers {
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    featureIds: Uint32Array;
}

export interface DeckPathBucketBuffers {
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    widths: Float32Array;
    featureIds: Uint32Array;
    dashArrays?: Float32Array;
}

export interface DeckGeometryBucketBuffers {
    pointWorld: DeckPointBucketBuffers;
    pointBillboard: DeckPointBucketBuffers;
    surface: DeckSurfaceBucketBuffers;
    pathWorld: DeckPathBucketBuffers;
    pathBillboard: DeckPathBucketBuffers;
    arrowWorld: DeckPathBucketBuffers;
    arrowBillboard: DeckPathBucketBuffers;
}

export interface DeckLowFiBundleBuffers extends DeckGeometryBucketBuffers {
    lod: number;
}

export interface DeckVisualizationBufferResult extends DeckGeometryBucketBuffers {
    coordinateOrigin: Float64Array;
    lowFiBundles: DeckLowFiBundleBuffers[];
    mergedPointFeatures: Record<string, any[]>;
}

export interface DeckTileRenderBuffers extends DeckVisualizationBufferResult {
    vertexCount: number;
    workerTimings?: DeckWorkerTimings;
}

export interface DeckTileRenderResult extends DeckVisualizationBufferResult {
    type: "DeckTileRenderResult";
    taskId: string;
    tileKey: string;
    vertexCount: number;
    timings?: DeckWorkerTimings;
    error?: string;
}

export type DeckWorkerInboundMessage = DeckTileRenderTask | DeckWorkerInitMessage;
export type DeckWorkerOutboundMessage = DeckTileRenderResult | DeckWorkerReadyMessage;
