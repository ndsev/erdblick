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

export interface DeckLowFiBundleResult {
    lod: number;
    pointPositions: ArrayBuffer;
    pointColors: ArrayBuffer;
    pointRadii: ArrayBuffer;
    pointFeatureIds: ArrayBuffer;
    pointBillboards: ArrayBuffer;
    surfacePositions: ArrayBuffer;
    surfaceStartIndices: ArrayBuffer;
    surfaceColors: ArrayBuffer;
    surfaceFeatureIds: ArrayBuffer;
    positions: ArrayBuffer;
    startIndices: ArrayBuffer;
    colors: ArrayBuffer;
    widths: ArrayBuffer;
    featureIds: ArrayBuffer;
    billboards: ArrayBuffer;
    dashArrays: ArrayBuffer;
    dashOffsets: ArrayBuffer;
    arrowPositions: ArrayBuffer;
    arrowStartIndices: ArrayBuffer;
    arrowColors: ArrayBuffer;
    arrowWidths: ArrayBuffer;
    arrowFeatureIds: ArrayBuffer;
    arrowBillboards: ArrayBuffer;
}

export interface DeckTileRenderResult {
    type: "DeckTileRenderResult";
    taskId: string;
    tileKey: string;
    vertexCount: number;
    pointPositions: ArrayBuffer;
    pointColors: ArrayBuffer;
    pointRadii: ArrayBuffer;
    pointFeatureIds: ArrayBuffer;
    pointBillboards: ArrayBuffer;
    coordinateOrigin: ArrayBuffer;
    surfacePositions: ArrayBuffer;
    surfaceStartIndices: ArrayBuffer;
    surfaceColors: ArrayBuffer;
    surfaceFeatureIds: ArrayBuffer;
    positions: ArrayBuffer;
    startIndices: ArrayBuffer;
    colors: ArrayBuffer;
    widths: ArrayBuffer;
    featureIds: ArrayBuffer;
    billboards: ArrayBuffer;
    dashArrays: ArrayBuffer;
    dashOffsets: ArrayBuffer;
    arrowPositions: ArrayBuffer;
    arrowStartIndices: ArrayBuffer;
    arrowColors: ArrayBuffer;
    arrowWidths: ArrayBuffer;
    arrowFeatureIds: ArrayBuffer;
    arrowBillboards: ArrayBuffer;
    lowFiBundles: DeckLowFiBundleResult[];
    mergedPointFeatures: Record<string, any[]>;
    timings?: DeckWorkerTimings;
    error?: string;
}

export type DeckWorkerInboundMessage = DeckTileRenderTask | DeckWorkerInitMessage;
export type DeckWorkerOutboundMessage = DeckTileRenderResult | DeckWorkerReadyMessage;
