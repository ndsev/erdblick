export interface DeckPathRenderTask {
    type: "DeckPathRenderTask";
    taskId: string;
    viewIndex: number;
    tileKey: string;
    tileBlob: Uint8Array;
    fieldDictBlob: Uint8Array;
    dataSourceInfoBlob: Uint8Array;
    nodeId: string;
    mapName: string;
    styleSource: string;
    styleOptions: Record<string, boolean | number | string>;
    highlightModeValue: number;
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

export interface DeckPathRenderResult {
    type: "DeckPathRenderResult";
    taskId: string;
    tileKey: string;
    vertexCount: number;
    pointPositions: ArrayBuffer;
    pointColors: ArrayBuffer;
    pointRadii: ArrayBuffer;
    pointFeatureIds: ArrayBuffer;
    coordinateOrigin: ArrayBuffer;
    positions: ArrayBuffer;
    startIndices: ArrayBuffer;
    colors: ArrayBuffer;
    widths: ArrayBuffer;
    featureIds: ArrayBuffer;
    dashArrays: ArrayBuffer;
    dashOffsets: ArrayBuffer;
    arrowPositions: ArrayBuffer;
    arrowStartIndices: ArrayBuffer;
    arrowColors: ArrayBuffer;
    arrowWidths: ArrayBuffer;
    arrowFeatureIds: ArrayBuffer;
    mergedPointFeatures: Record<string, any[]>;
    timings?: DeckWorkerTimings;
    error?: string;
}

export type DeckWorkerInboundMessage = DeckPathRenderTask | DeckWorkerInitMessage;
export type DeckWorkerOutboundMessage = DeckPathRenderResult | DeckWorkerReadyMessage;
