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

export enum MapTileLoadState {
    LoadingQueued = 0,
    BackendFetching = 1,
    BackendConverting = 2,
}

export interface MapTileStreamLoadStatePayload {
    type: string;
    mapId: string;
    layerId: string;
    tileId: number;
    state: MapTileLoadState;
    stateText?: string;
}

export class MapTileStreamClient {
    private socket: WebSocket | null = null;
    private connecting: Promise<void> | null = null;
    private readonly decoder = new TextDecoder();

    onFrame: ((frame: Uint8Array, type: number) => void) | null = null;
    onStatus: ((status: MapTileStreamStatusPayload) => void) | null = null;
    onLoadState: ((payload: MapTileStreamLoadStatePayload) => void) | null = null;
    onError: ((event: Event) => void) | null = null;
    onClose: ((event: CloseEvent) => void) | null = null;

    constructor(private path: string = "tiles") {
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

    async sendRequest(body: object | string): Promise<void> {
        await this.connect();
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket is not open.");
        }
        const payload = typeof body === "string" ? body : JSON.stringify(body);
        this.socket.send(payload);
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
                if (isCurrent && this.onClose) {
                    this.onClose(event);
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

        if (this.onFrame) {
            this.onFrame(bytes, type);
        }
    }
}
