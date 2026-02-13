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
}

export interface DeckWorkerInitMessage {
    type: "DeckWorkerInit";
}

export interface DeckWorkerReadyMessage {
    type: "DeckWorkerReady";
    scriptUrl: string;
}

export interface DeckPathRenderResult {
    type: "DeckPathRenderResult";
    taskId: string;
    tileKey: string;
    positions: ArrayBuffer;
    startIndices: ArrayBuffer;
    colors: ArrayBuffer;
    widths: ArrayBuffer;
    error?: string;
}

export type DeckWorkerInboundMessage = DeckPathRenderTask | DeckWorkerInitMessage;
export type DeckWorkerOutboundMessage = DeckPathRenderResult | DeckWorkerReadyMessage;
