import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import type {TileLayerParser} from "../../build/libs/core/erdblick-core";

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
export const MAP_TILE_STREAM_TYPE_LOAD_STATE = 5;
export const MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT = 6;
export const MAP_TILE_STREAM_TYPE_END_OF_STREAM = 128;
export const MAP_TILE_STREAM_FLOW_GRANT_TYPE = "mapget.tiles.flow-grant";
export const MAP_TILE_STREAM_REQUEST_CONTEXT_TYPE = "mapget.tiles.request-context";

export interface MapTileStreamStatusRequest {
    index: number;
    mapId: string;
    layerId: string;
    status: MapTileRequestStatus;
    statusText: string;
}

export interface MapTileStreamStatusPayload {
    type: string;
    requestId?: number;
    allDone: boolean;
    requests: MapTileStreamStatusRequest[];
    message?: string;
}
export enum TileLoadState {
    LoadingQueued = 0,
    BackendFetching = 1,
    BackendConverting = 2,

    Error = 128,            // Only used by erdblick
    RenderingQueued = 129,  // Only used by erdblick
    Ok = 130,               // Only used by erdblick
}

export interface MapTileStreamLoadStatePayload {
    type: string;
    requestId?: number;
    mapId: string;
    layerId: string;
    tileId: number;
    stage?: number;
    state: TileLoadState;
    stateText?: string;
}

export interface MapTileStreamRequestContextPayload {
    type: string;
    requestId: number;
}

export class MapTileStreamClient {
    private socket: WebSocket | null = null;
    private connecting: Promise<void> | null = null;
    private readonly decoder = new TextDecoder();
    public parser: TileLayerParser;
    private lastRequestPromise: Promise<void> | null = null;
    private awaitingCompletion: boolean = false;
    private completionPromise: Promise<MapTileStreamStatusPayload> | null = null;
    private completionResolve: ((payload: MapTileStreamStatusPayload) => void) | null = null;
    private completionReject: ((error: unknown) => void) | null = null;
    private lastStatusPayload: MapTileStreamStatusPayload | null = null;
    private lastTilesRequestBody: string | null = null;
    private nextRequestId: number = 1;
    private latestRequestedRequestId: number | null = null;
    private incomingRequestId: number | null = null;
    private supportsRequestContextFrames: boolean = false;
    private frameQueue: Array<ArrayBuffer | Blob> = [];
    private frameQueueTimer: ReturnType<typeof setTimeout> | null = null;
    private processingFrameQueue: boolean = false;
    private frameProcessingPaused: boolean = false;
    private readonly frameTimeBudgetMs: number = 10;
    private readonly flowControlEnabled: boolean = true;

    onFrame: ((frame: Uint8Array, type: number) => void) | null = null;
    onFeatures: ((payload: Uint8Array) => void) | null = null;
    onSourceData: ((payload: Uint8Array) => void) | null = null;
    onFields: ((frame: Uint8Array) => void) | null = null;
    onStatus: ((status: MapTileStreamStatusPayload) => void) | null = null;
    onLoadState: ((payload: MapTileStreamLoadStatePayload) => void) | null = null;
    onError: ((event: Event) => void) | null = null;
    onClose: ((event: CloseEvent) => void) | null = null;

    constructor(private path: string = "tiles") {
        this.parser = new coreLib.TileLayerParser();
    }

    withFeaturesCallback(callback: (payload: Uint8Array) => void) {
        this.onFeatures = callback;
        return this;
    }

    withSourceDataCallback(callback: (payload: Uint8Array) => void) {
        this.onSourceData = callback;
        return this;
    }

    withFieldsCallback(callback: (frame: Uint8Array) => void) {
        this.onFields = callback;
        return this;
    }

    withStatusCallback(callback: (status: MapTileStreamStatusPayload) => void) {
        this.onStatus = callback;
        return this;
    }

    withLoadStateCallback(callback: (payload: MapTileStreamLoadStatePayload) => void) {
        this.onLoadState = callback;
        return this;
    }

    withErrorCallback(callback: (event: Event) => void) {
        this.onError = callback;
        return this;
    }

    withCloseCallback(callback: (event: CloseEvent) => void) {
        this.onClose = callback;
        return this;
    }

    setDataSourceInfoJson(json: string) {
        const buffer = new TextEncoder().encode(json);
        return this.setDataSourceInfoBuffer(buffer);
    }

    setDataSourceInfoBuffer(buffer: Uint8Array) {
        uint8ArrayToWasm((wasmBuffer: any) => {
            this.parser.setDataSourceInfo(wasmBuffer);
        }, buffer);
        return this;
    }

    isOpen(): boolean {
        return this.socket?.readyState === WebSocket.OPEN;
    }

    close(code?: number, reason?: string) {
        if (!this.socket) {
            return;
        }
        try {
            this.socket.close(code, reason);
        } catch (_err) {
            // Ignore close errors.
        }
    }

    destroy() {
        this.close(1000, "done");
        this.awaitingCompletion = false;
        this.lastRequestPromise = null;
        this.lastStatusPayload = null;
        this.latestRequestedRequestId = null;
        this.incomingRequestId = null;
        this.supportsRequestContextFrames = false;
        this.clearPendingFrames();
        this.resetCompletionPromise();
        if (this.parser) {
            this.parser.delete();
        }
    }

    clearPendingFrames() {
        console.log(`Clearing ${this.frameQueue.length} frames.`)
        this.frameQueue = [];
    }

    setFrameProcessingPaused(paused: boolean) {
        this.frameProcessingPaused = paused;
        if (!paused && this.frameQueue.length) {
            this.scheduleFrameProcessing(0);
        }
    }

    get isFrameProcessingPaused(): boolean {
        return this.frameProcessingPaused;
    }

    sendRequest(body: object | string) {
        this.awaitingCompletion = true;
        this.lastStatusPayload = null;
        this.resetCompletionPromise();
        this.lastRequestPromise = this.connect()
            .then(() => {
                if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                    throw new Error("WebSocket is not open.");
                }
                const payload = typeof body === "string" ? body : JSON.stringify(body);
                this.socket.send(payload);
            })
            .catch(err => {
                this.rejectCompletion(err);
                throw err;
            });
        return this;
    }

    async updateRequest(tileLayerRequests: any) {
        const requestBodyBase = {
            flowControl: this.flowControlEnabled,
            requests: tileLayerRequests,
            stringPoolOffsets: this.parser!.getFieldDictOffsets(),
        };

        const newRequestBody = JSON.stringify(requestBodyBase);

        // Ensure that the new request is different from the previous one.
        if (this.lastTilesRequestBody === newRequestBody) {
            return false;
        }
        this.lastTilesRequestBody = newRequestBody;
        const previousRequestId = this.latestRequestedRequestId;
        const requestId = this.nextRequestId++;
        this.latestRequestedRequestId = requestId;
        const requestBody = {
            ...requestBodyBase,
            requestId,
        };
        try {
            this.sendRequest(requestBody);
            await this.waitForSend();
            return true;
        } catch (err) {
            this.lastTilesRequestBody = null;
            this.latestRequestedRequestId = previousRequestId;
            console.error("Failed to send /tiles request.", err);
            return false;
        }
    }

    async waitForSend(): Promise<void> {
        if (this.lastRequestPromise) {
            await this.lastRequestPromise;
        }
    }

    async waitForCompletion(): Promise<MapTileStreamStatusPayload> {
        if (this.lastRequestPromise) {
            await this.lastRequestPromise;
        }
        if (!this.awaitingCompletion) {
            return this.lastStatusPayload ?? {
                type: "mapget.tiles.status",
                allDone: true,
                requests: [],
            };
        }
        return this.ensureCompletionPromise();
    }

    async waitAndDestroy(): Promise<MapTileStreamStatusPayload> {
        try {
            return await this.waitForCompletion();
        } finally {
            this.destroy();
        }
    }

    async connect(): Promise<void> {
        if (this.socket?.readyState === WebSocket.OPEN) {
            return;
        }
        if (this.socket?.readyState === WebSocket.CONNECTING && this.connecting) {
            return this.connecting;
        }

        this.connecting = new Promise((resolve, reject) => {
            const url = this.resolveUrl();
            const socket = new WebSocket(url);
            socket.binaryType = "arraybuffer";
            this.socket = socket;

            socket.onopen = () => {
                this.connecting = null;
                resolve();
            };
            socket.onerror = (event) => {
                if (this.socket !== socket) {
                    return;
                }
                if (this.connecting) {
                    this.connecting = null;
                    reject(event);
                }
                if (this.onError) {
                    this.onError(event);
                }
                if (this.awaitingCompletion) {
                    this.rejectCompletion(event);
                }
            };
            socket.onclose = (event) => {
                if (this.connecting) {
                    this.connecting = null;
                    reject(event);
                }
                const isCurrent = this.socket === socket;
                if (isCurrent) {
                    this.socket = null;
                }
                if (isCurrent) {
                    if (this.onClose) {
                        this.onClose(event);
                    }
                    if (this.awaitingCompletion) {
                        this.rejectCompletion(event);
                    }
                }
            };
            socket.onmessage = (event) => {
                if (this.socket !== socket) {
                    return;
                }
                this.enqueueFrame(event.data);
            };
        });

        return this.connecting;
    }

    private ensureCompletionPromise(): Promise<MapTileStreamStatusPayload> {
        if (!this.completionPromise) {
            this.completionPromise = new Promise((resolve, reject) => {
                this.completionResolve = resolve;
                this.completionReject = reject;
            });
        }
        return this.completionPromise;
    }

    private resetCompletionPromise() {
        this.completionPromise = null;
        this.completionResolve = null;
        this.completionReject = null;
    }

    private resolveCompletion(payload: MapTileStreamStatusPayload) {
        this.awaitingCompletion = false;
        this.lastStatusPayload = payload;
        if (this.completionResolve) {
            this.completionResolve(payload);
        }
        this.resetCompletionPromise();
    }

    private rejectCompletion(error: unknown) {
        this.awaitingCompletion = false;
        if (this.completionReject) {
            this.completionReject(error);
        }
        this.resetCompletionPromise();
    }

    private resolveUrl(): string {
        const base = (typeof document !== "undefined" && document.baseURI)
            ? document.baseURI
            : window.location.href;
        const url = new URL(this.path, base);
        if (url.protocol === "http:") {
            url.protocol = "ws:";
        } else if (url.protocol === "https:") {
            url.protocol = "wss:";
        }
        return url.toString();
    }

    private enqueueFrame(data: ArrayBuffer | Blob) {
        this.frameQueue.push(data);
        if (this.frameProcessingPaused) {
            return;
        }
        this.scheduleFrameProcessing(0);
    }

    private scheduleFrameProcessing(delayMs: number) {
        if (this.frameProcessingPaused) {
            return;
        }
        if (this.frameQueueTimer) {
            return;
        }
        this.frameQueueTimer = setTimeout(() => {
            this.frameQueueTimer = null;
            this.processFrameQueue().catch(err => {
                console.error("Tile stream message handler failed.", err);
            });
        }, delayMs);
    }

    private async processFrameQueue() {
        if (this.processingFrameQueue || this.frameProcessingPaused) {
            return;
        }
        this.processingFrameQueue = true;
        try {
            const startTime = Date.now();
            let handledMessages = 0;
            let grantFrames = 0;
            while (this.frameQueue.length) {
                const data = this.frameQueue.shift()!;
                try {
                    const flowAccounting = await this.handleMessage(data);
                    if (flowAccounting.isFlowControlledDataFrame) {
                        grantFrames += 1;
                    }
                    ++handledMessages;
                } catch (err) {
                    console.error("Tile stream message handler failed.", err);
                }
                if (Date.now() - startTime > this.frameTimeBudgetMs) {
                    break;
                }
            }
            this.sendFlowGrant(grantFrames);
        } finally {
            this.processingFrameQueue = false;
        }

        if (this.frameQueue.length) {
            this.scheduleFrameProcessing(0);
        }
    }

    private async handleMessage(data: ArrayBuffer | Blob): Promise<{ isFlowControlledDataFrame: boolean; }> {
        let bytes: Uint8Array;

        if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
        } else if (data instanceof Blob) {
            bytes = new Uint8Array(await data.arrayBuffer());
        } else {
            console.warn("Unexpected WebSocket message payload.");
            return {isFlowControlledDataFrame: false};
        }

        if (bytes.length < MAP_TILE_STREAM_HEADER_SIZE) {
            console.warn("Tile stream frame too small.");
            return {isFlowControlledDataFrame: false};
        }

        const type = bytes[6];
        const isFlowControlledDataFrame = this.isFlowControlledDataFrameType(type);
        if (type === MAP_TILE_STREAM_TYPE_END_OF_STREAM) {
            return {isFlowControlledDataFrame};
        }

        try {
            const length = new DataView(bytes.buffer, bytes.byteOffset + 7, 4).getUint32(0, true);
            if (bytes.length !== MAP_TILE_STREAM_HEADER_SIZE + length) {
                console.warn("Tile stream frame size mismatch.");
            }

            if (type === MAP_TILE_STREAM_TYPE_STATUS) {
                const payloadBytes = bytes.slice(MAP_TILE_STREAM_HEADER_SIZE);
                const payloadText = this.decoder.decode(payloadBytes);
                try {
                    const payload = JSON.parse(payloadText) as MapTileStreamStatusPayload;
                    if (!this.matchesCurrentRequest(payload.requestId)) {
                        return {isFlowControlledDataFrame};
                    }
                    if (this.onStatus) {
                        this.onStatus(payload);
                    }
                    if (payload.allDone && this.awaitingCompletion) {
                        this.resolveCompletion(payload);
                    } else if (payload.allDone) {
                        this.lastStatusPayload = payload;
                    }
                } catch (err) {
                    console.error("Failed to parse /tiles status payload:", err);
                }
                return {isFlowControlledDataFrame};
            }

            if (type === MAP_TILE_STREAM_TYPE_LOAD_STATE) {
                const payloadBytes = bytes.slice(MAP_TILE_STREAM_HEADER_SIZE);
                const payloadText = this.decoder.decode(payloadBytes);
                try {
                    const payload = JSON.parse(payloadText) as MapTileStreamLoadStatePayload;
                    if (!this.matchesCurrentRequest(payload.requestId)) {
                        return {isFlowControlledDataFrame};
                    }
                    if (this.onLoadState) {
                        this.onLoadState(payload);
                    }
                } catch (err) {
                    console.error("Failed to parse /tiles load-state payload:", err);
                }
                return {isFlowControlledDataFrame};
            }

            if (type === MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT) {
                const payloadBytes = bytes.slice(MAP_TILE_STREAM_HEADER_SIZE);
                const payloadText = this.decoder.decode(payloadBytes);
                try {
                    const payload = JSON.parse(payloadText) as MapTileStreamRequestContextPayload;
                    if (payload.type === MAP_TILE_STREAM_REQUEST_CONTEXT_TYPE && Number.isFinite(payload.requestId)) {
                        this.supportsRequestContextFrames = true;
                        this.incomingRequestId = Math.max(0, Math.floor(payload.requestId));
                    }
                } catch (err) {
                    console.error("Failed to parse /tiles request-context payload:", err);
                }
                return {isFlowControlledDataFrame};
            }

            if (type === MAP_TILE_STREAM_TYPE_FIELDS) {
                uint8ArrayToWasm((wasmBuffer: any) => {
                    this.parser.readFieldDictUpdate(wasmBuffer);
                }, bytes);
                if (this.onFields) {
                    this.onFields(bytes);
                }
                return {isFlowControlledDataFrame};
            }

            if (type === MAP_TILE_STREAM_TYPE_FEATURES) {
                if (this.onFeatures) {
                    this.onFeatures(bytes.slice(MAP_TILE_STREAM_HEADER_SIZE));
                }
                return {isFlowControlledDataFrame};
            }

            if (type === MAP_TILE_STREAM_TYPE_SOURCEDATA) {
                if (this.onSourceData) {
                    this.onSourceData(bytes.slice(MAP_TILE_STREAM_HEADER_SIZE));
                }
                return {isFlowControlledDataFrame};
            }

            if (this.onFrame) {
                this.onFrame(bytes, type);
            }
        } catch (err) {
            console.error("Tile stream message handler failed.", err);
        }
        return {isFlowControlledDataFrame};
    }

    private isFlowControlledDataFrameType(type: number): boolean {
        return type === MAP_TILE_STREAM_TYPE_FIELDS
            || type === MAP_TILE_STREAM_TYPE_FEATURES
            || type === MAP_TILE_STREAM_TYPE_SOURCEDATA;
    }

    private matchesCurrentRequest(requestId: number | undefined): boolean {
        if (this.latestRequestedRequestId === null) {
            return true;
        }
        if (requestId === undefined) {
            return true;
        }
        return requestId === this.latestRequestedRequestId;
    }

    private sendFlowGrant(frames: number) {
        if (!this.flowControlEnabled) {
            return;
        }
        if (frames <= 0) {
            return;
        }
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const payload = {
            type: MAP_TILE_STREAM_FLOW_GRANT_TYPE,
            frames: Math.max(0, Math.floor(frames)),
        };
        try {
            this.socket.send(JSON.stringify(payload));
        } catch (err) {
            console.warn("Failed to send /tiles flow grant.", err);
        }
    }
}
