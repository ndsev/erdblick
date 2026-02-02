import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import type {TileLayerParser} from "../../build/libs/core/erdblick-core";
import {TileVisualization} from "../mapview/tile.visualization.model";

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
export const MAP_TILE_STREAM_TYPE_END_OF_STREAM = 128;

export interface MapTileStreamStatusRequest {
    index: number;
    mapId: string;
    layerId: string;
    status: MapTileRequestStatus;
    statusText: string;
}

export interface MapTileStreamStatusPayload {
    type: string;
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
    mapId: string;
    layerId: string;
    tileId: number;
    state: TileLoadState;
    stateText?: string;
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
        this.resetCompletionPromise();
        if (this.parser) {
            this.parser.delete();
        }
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
        // Nothing to do if all requests are empty.
        if (tileLayerRequests.length === 0) {
            return;
        }

        const requestBody = {
            requests: tileLayerRequests,
            stringPoolOffsets: this.parser!.getFieldDictOffsets(),
        };

        const newRequestBody = JSON.stringify(requestBody);

        // Ensure that the new request is different from the previous one.
        if (this.lastTilesRequestBody === newRequestBody) {
            return;
        }
        this.lastTilesRequestBody = newRequestBody;
        try {
            this.sendRequest(requestBody);
            await this.waitForSend();
        } catch (err) {
            this.lastTilesRequestBody = null;
            console.error("Failed to send /tiles request.", err);
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
                this.handleMessage(event).catch(err => {
                    console.error("Tile stream message handler failed.", err);
                });
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

    private async handleMessage(event: MessageEvent) {
        const data = event.data;
        let bytes: Uint8Array;

        if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
        } else if (data instanceof Blob) {
            bytes = new Uint8Array(await data.arrayBuffer());
        } else {
            console.warn("Unexpected WebSocket message payload.");
            return;
        }

        if (bytes.length < MAP_TILE_STREAM_HEADER_SIZE) {
            console.warn("Tile stream frame too small.");
            return;
        }

        const type = bytes[6];
        if (type === MAP_TILE_STREAM_TYPE_END_OF_STREAM) {
            return;
        }

        const length = new DataView(bytes.buffer, bytes.byteOffset + 7, 4).getUint32(0, true);
        if (bytes.length !== MAP_TILE_STREAM_HEADER_SIZE + length) {
            console.warn("Tile stream frame size mismatch.");
        }

        if (type === MAP_TILE_STREAM_TYPE_STATUS) {
            const payloadBytes = bytes.slice(MAP_TILE_STREAM_HEADER_SIZE);
            const payloadText = this.decoder.decode(payloadBytes);
            try {
                const payload = JSON.parse(payloadText) as MapTileStreamStatusPayload;
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
            return;
        }

        if (type === MAP_TILE_STREAM_TYPE_LOAD_STATE) {
            const payloadBytes = bytes.slice(MAP_TILE_STREAM_HEADER_SIZE);
            const payloadText = this.decoder.decode(payloadBytes);
            try {
                const payload = JSON.parse(payloadText) as MapTileStreamLoadStatePayload;
                if (this.onLoadState) {
                    this.onLoadState(payload);
                }
            } catch (err) {
                console.error("Failed to parse /tiles load-state payload:", err);
            }
            return;
        }

        if (type === MAP_TILE_STREAM_TYPE_FIELDS) {
            uint8ArrayToWasm((wasmBuffer: any) => {
                this.parser.readFieldDictUpdate(wasmBuffer);
            }, bytes);
            if (this.onFields) {
                this.onFields(bytes);
            }
            return;
        }

        if (type === MAP_TILE_STREAM_TYPE_FEATURES) {
            if (this.onFeatures) {
                this.onFeatures(bytes.slice(MAP_TILE_STREAM_HEADER_SIZE));
            }
            return;
        }

        if (type === MAP_TILE_STREAM_TYPE_SOURCEDATA) {
            if (this.onSourceData) {
                this.onSourceData(bytes.slice(MAP_TILE_STREAM_HEADER_SIZE));
            }
            return;
        }

        if (this.onFrame) {
            this.onFrame(bytes, type);
        }
    }
}
