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
export const MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT = 6;
export const MAP_TILE_STREAM_TYPE_END_OF_STREAM = 128;
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

export interface MapTileStreamRequestContextPayload {
    type: string;
    requestId: number;
    clientId?: number;
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
    private pullClientId: number | null = null;
    private pullControllers: AbortController[] = [];
    private readonly pullParallelism: number = 2;
    private readonly pullWaitMs: number = 25000;
    private readonly pullRetryDelayMs: number = 50;
    private readonly pullBatchMaxBytesCap: number = 5 * 1024 * 1024;
    private readonly pullBatchMinBytes: number = 64 * 1024;
    private readonly pullDownstreamEwmaAlpha: number = 0.2;
    private pullCompressionEnabled: boolean = false;
    private downstreamBytesPerSecondEwma: number = 512 * 1024;
    private totalPullResponses: number = 0;
    private totalPullGzipResponses: number = 0;
    private totalUncompressedBytes: number = 0;
    private knownCompressedBytes: number = 0;
    private knownCompressedUncompressedBytes: number = 0;
    private responsesWithKnownCompressedBytes: number = 0;

    onFrame: ((frame: Uint8Array, type: number) => void) | null = null;
    onFeatures: ((payload: Uint8Array) => void) | null = null;
    onSourceData: ((payload: Uint8Array) => void) | null = null;
    onFields: ((frame: Uint8Array) => void) | null = null;
    onStatus: ((status: MapTileStreamStatusPayload) => void) | null = null;
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
        this.pullClientId = null;
        this.stopPullLoops();
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

    setPullCompressionEnabled(enabled: boolean) {
        this.pullCompressionEnabled = !!enabled;
    }

    get isFrameProcessingPaused(): boolean {
        return this.frameProcessingPaused;
    }

    getDownstreamBytesPerSecond(): number {
        return this.downstreamBytesPerSecondEwma;
    }

    getPendingFrameQueueSize(): number {
        return this.frameQueue.length;
    }

    getTransportCompressionStats(): MapTileStreamTransportCompressionStats {
        const ratioPct = this.knownCompressedUncompressedBytes > 0
            ? (this.knownCompressedBytes / this.knownCompressedUncompressedBytes) * 100
            : null;
        const savingsPct = ratioPct === null ? null : 100 - ratioPct;
        const coveragePct = this.totalUncompressedBytes > 0
            ? (this.knownCompressedUncompressedBytes / this.totalUncompressedBytes) * 100
            : 0;
        return {
            totalPullResponses: this.totalPullResponses,
            totalPullGzipResponses: this.totalPullGzipResponses,
            totalUncompressedBytes: this.totalUncompressedBytes,
            knownCompressedBytes: this.knownCompressedBytes,
            knownCompressedUncompressedBytes: this.knownCompressedUncompressedBytes,
            responsesWithKnownCompressedBytes: this.responsesWithKnownCompressedBytes,
            compressionRatioPct: ratioPct,
            compressionSavingsPct: savingsPct,
            knownCompressedCoveragePct: coveragePct,
        };
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
                    this.pullClientId = null;
                    this.stopPullLoops();
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
            while (this.frameQueue.length) {
                const data = this.frameQueue.shift()!;
                try {
                    await this.handleMessage(data);
                    ++handledMessages;
                } catch (err) {
                    console.error("Tile stream message handler failed.", err);
                }
                if (Date.now() - startTime > this.frameTimeBudgetMs) {
                    break;
                }
            }
        } finally {
            this.processingFrameQueue = false;
        }

        if (this.frameQueue.length) {
            this.scheduleFrameProcessing(0);
        }
    }

    private async handleMessage(data: ArrayBuffer | Blob): Promise<void> {
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

        let offset = 0;
        while (offset + MAP_TILE_STREAM_HEADER_SIZE <= bytes.length) {
            const type = bytes[offset + 6];
            const payloadLength = new DataView(
                bytes.buffer,
                bytes.byteOffset + offset + 7,
                4).getUint32(0, true);
            const frameEnd = offset + MAP_TILE_STREAM_HEADER_SIZE + payloadLength;
            if (frameEnd > bytes.length) {
                console.warn("Tile stream frame size mismatch.");
                return;
            }

            const frameBytes = bytes.subarray(offset, frameEnd);
            await this.handleFrame(frameBytes, type);
            offset = frameEnd;
        }

        if (offset !== bytes.length) {
            console.warn("Tile stream frame alignment mismatch.");
        }
    }

    private async handleFrame(bytes: Uint8Array, type: number): Promise<void> {
        if (type === MAP_TILE_STREAM_TYPE_END_OF_STREAM) {
            return;
        }
        try {
            if (type === MAP_TILE_STREAM_TYPE_STATUS) {
                const payloadBytes = bytes.slice(MAP_TILE_STREAM_HEADER_SIZE);
                const payloadText = this.decoder.decode(payloadBytes);
                try {
                    const payload = JSON.parse(payloadText) as MapTileStreamStatusPayload;
                    if (!this.matchesCurrentRequest(payload.requestId)) {
                        return;
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
                return;
            }

            if (type === MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT) {
                const payloadBytes = bytes.slice(MAP_TILE_STREAM_HEADER_SIZE);
                const payloadText = this.decoder.decode(payloadBytes);
                try {
                    const payload = JSON.parse(payloadText) as MapTileStreamRequestContextPayload;
                    if (payload.type === MAP_TILE_STREAM_REQUEST_CONTEXT_TYPE && Number.isFinite(payload.requestId)) {
                        this.supportsRequestContextFrames = true;
                        this.incomingRequestId = Math.max(0, Math.floor(payload.requestId));
                        if (Number.isFinite(payload.clientId)) {
                            const nextClientId = Math.max(1, Math.floor(Number(payload.clientId)));
                            if (this.pullClientId !== nextClientId) {
                                this.pullClientId = nextClientId;
                                this.startPullLoops();
                            } else if (!this.pullControllers.length) {
                                this.startPullLoops();
                            }
                        }
                    }
                } catch (err) {
                    console.error("Failed to parse /tiles request-context payload:", err);
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
        } catch (err) {
            console.error("Tile stream message handler failed.", err);
        }
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

    private startPullLoops() {
        this.stopPullLoops();
        if (this.pullClientId === null) {
            return;
        }
        for (let i = 0; i < this.pullParallelism; ++i) {
            const controller = new AbortController();
            this.pullControllers.push(controller);
            this.runPullLoop(controller).catch(err => {
                if (!controller.signal.aborted) {
                    console.error("Tile pull loop failed.", err);
                }
            });
        }
    }

    private stopPullLoops() {
        for (const controller of this.pullControllers) {
            controller.abort();
        }
        this.pullControllers = [];
    }

    private async runPullLoop(controller: AbortController) {
        while (!controller.signal.aborted) {
            const clientId = this.pullClientId;
            if (clientId === null) {
                return;
            }

            try {
                const startedAt = performance.now();
                const response = await fetch(this.resolvePullUrl(clientId), {
                    method: "GET",
                    cache: "no-store",
                    signal: controller.signal,
                });

                if (controller.signal.aborted) {
                    return;
                }

                if (response.status === 200) {
                    const body = await response.arrayBuffer();
                    if (controller.signal.aborted) {
                        return;
                    }
                    this.recordPullTransportSample(response, body.byteLength);
                    const elapsedMs = Math.max(1, performance.now() - startedAt);
                    this.recordDownstreamSample(body.byteLength, elapsedMs);
                    this.enqueueFrame(body);
                    continue;
                }

                if (response.status === 204) {
                    continue;
                }

                if (response.status === 410) {
                    if (this.pullClientId === clientId) {
                        this.pullClientId = null;
                        this.stopPullLoops();
                    }
                    return;
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    return;
                }
            }

            await this.delay(this.pullRetryDelayMs, controller.signal);
        }
    }

    private resolvePullUrl(clientId: number): string {
        const base = (typeof document !== "undefined" && document.baseURI)
            ? document.baseURI
            : window.location.href;
        const normalizedPath = this.path.replace(/\/+$/, "");
        const pullUrl = new URL(`${normalizedPath}/next`, base);
        pullUrl.searchParams.set("clientId", String(clientId));
        pullUrl.searchParams.set("waitMs", String(this.pullWaitMs));
        pullUrl.searchParams.set("maxBytes", String(this.currentPullMaxBytes()));
        pullUrl.searchParams.set("compress", this.pullCompressionEnabled ? "1" : "0");
        return pullUrl.toString();
    }

    private currentPullMaxBytes(): number {
        const estimated = Math.max(this.pullBatchMinBytes, Math.floor(this.downstreamBytesPerSecondEwma));
        return Math.min(this.pullBatchMaxBytesCap, estimated);
    }

    private recordDownstreamSample(bytes: number, elapsedMs: number) {
        if (bytes <= 0 || elapsedMs <= 0) {
            return;
        }
        const bytesPerSecond = bytes * 1000 / elapsedMs;
        if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
            return;
        }
        this.downstreamBytesPerSecondEwma = this.pullDownstreamEwmaAlpha * bytesPerSecond
            + (1 - this.pullDownstreamEwmaAlpha) * this.downstreamBytesPerSecondEwma;
    }

    private recordPullTransportSample(response: Response, uncompressedBytes: number) {
        this.totalPullResponses += 1;
        this.totalUncompressedBytes += Math.max(0, uncompressedBytes);
        if (this.hasGzipContentEncoding(response)) {
            this.totalPullGzipResponses += 1;
        }

        const compressedBytes = this.extractCompressedBodyBytes(response);
        if (compressedBytes === null) {
            return;
        }
        this.responsesWithKnownCompressedBytes += 1;
        this.knownCompressedBytes += compressedBytes;
        this.knownCompressedUncompressedBytes += Math.max(0, uncompressedBytes);
    }

    private hasGzipContentEncoding(response: Response): boolean {
        const header = response.headers.get("content-encoding");
        if (!header) {
            return false;
        }
        return header.toLowerCase().includes("gzip");
    }

    private extractCompressedBodyBytes(response: Response): number | null {
        const preferredHeader = this.parseNonNegativeIntegerHeader(response.headers.get("x-mapget-compressed-bytes"));
        if (preferredHeader !== null) {
            return preferredHeader;
        }
        return this.parseNonNegativeIntegerHeader(response.headers.get("content-length"));
    }

    private parseNonNegativeIntegerHeader(rawValue: string | null): number | null {
        if (!rawValue) {
            return null;
        }
        const parsed = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
            return null;
        }
        return parsed;
    }

    private async delay(ms: number, signal: AbortSignal): Promise<void> {
        if (signal.aborted || ms <= 0) {
            return;
        }
        await new Promise<void>(resolve => {
            const timeout = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timeout);
                signal.removeEventListener("abort", onAbort);
                resolve();
            };
            signal.addEventListener("abort", onAbort, {once: true});
        });
    }
}
