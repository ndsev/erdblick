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
export const MAP_TILE_STREAM_TYPE_SEARCH_RESULTS = 7;
export const MAP_TILE_STREAM_TYPE_END_OF_STREAM = 128;
export const MAP_TILE_STREAM_REQUEST_CONTEXT_TYPE = "mapget.tiles.request-context";
export const MAP_TILE_STREAM_SEARCH_STATUS_TYPE = "mapget.search.status";
const TARGET_TILE_REQUEST_CHUNK_BYTES = 1024 * 1024;
const MAX_TILE_REQUEST_MESSAGE_BYTES = 9 * 1024 * 1024;

export interface MapTileStreamStatusRequest {
    index: number;
    mapId: string;
    layerId: string;
    status: MapTileRequestStatus;
    statusText: string;
    noDataSourceReason?: string;
}

export interface MapTileStreamStatusPayload {
    type: string;
    requestId?: number;
    allDone: boolean;
    requests: MapTileStreamStatusRequest[];
    message?: string;
}

export interface MapTileStreamSearchStatusPayload {
    type: typeof MAP_TILE_STREAM_SEARCH_STATUS_TYPE;
    searchId: string;
    refresh?: number;
    requestKey?: string;
    mapId?: string;
    layerId?: string;
    state: string;
    tilesQueued?: number;
    tilesLoaded?: number;
    tilesSearched?: number;
    matches?: number;
    chunksEmitted?: number;
    error?: string;
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

interface TileRequestChunk {
    index: number;
    isLast: boolean;
}

interface TileRequestPayload {
    requests: any[];
    stringPoolOffsets?: unknown;
    requestId?: number;
    chunk?: TileRequestChunk;
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

export interface MapTileStreamDebugState {
    isOpen: boolean;
    awaitingCompletion: boolean;
    latestRequestedRequestId: number | null;
    incomingRequestId: number | null;
    supportsRequestContextFrames: boolean;
    pullClientId: number | null;
    pendingFrameQueueSize: number;
    frameProcessingPaused: boolean;
    pullCompressionEnabled: boolean;
    pullBatchMaxBytesBudget: number;
    downstreamBytesPerSecondEwma: number;
    totalPullResponses: number;
    totalPullGzipResponses: number;
    lastStatusPayload: Pick<MapTileStreamStatusPayload, 'requestId' | 'allDone' | 'message'> & {
        requestCount: number;
    } | null;
}

/**
 * WebSocket client for `/tiles` plus the optional `/tiles/next` pull loop.
 * It hides frame parsing, request chunking, status tracking, and adaptive pull budgeting
 * behind callback-style hooks that `MapDataService` can consume from outside Angular.
 */
export class MapTileStreamClient {
    private socket: WebSocket | null = null;
    private connecting: Promise<void> | null = null;
    private readonly decoder = new TextDecoder();
    private readonly encoder = new TextEncoder();
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
    private readonly pullBatchMaxBytesCap: number = 64 * 1024 * 1024;
    private readonly pullBatchMinBytes: number = 64 * 1024;
    private readonly pullDownstreamEwmaAlpha: number = 0.2;
    private pullCompressionEnabled: boolean = false;
    private downstreamBytesPerSecondEwma: number = 512 * 1024;
    private pullBatchMaxBytesBudget: number = 512 * 1024;
    private totalPullResponses: number = 0;
    private totalPullGzipResponses: number = 0;
    private totalUncompressedBytes: number = 0;
    private knownCompressedBytes: number = 0;
    private knownCompressedUncompressedBytes: number = 0;
    private responsesWithKnownCompressedBytes: number = 0;

    onFrame: ((frame: Uint8Array, type: number) => void) | null = null;
    onFeatures: ((payload: Uint8Array) => void) | null = null;
    onSourceData: ((payload: Uint8Array) => void) | null = null;
    onSearchResults: ((payload: Uint8Array) => void) | null = null;
    onFields: ((frame: Uint8Array) => void) | null = null;
    onStatus: ((status: MapTileStreamStatusPayload) => void) | null = null;
    onSearchStatus: ((status: MapTileStreamSearchStatusPayload) => void) | null = null;
    onError: ((event: Event) => void) | null = null;
    onClose: ((event: CloseEvent) => void) | null = null;

    /** Creates the parser and remembers the relative backend path for websocket and pull calls. */
    constructor(private path: string = "tiles") {
        this.parser = new coreLib.TileLayerParser();
    }

    /** Registers the callback that receives feature payload frames without the transport header. */
    withFeaturesCallback(callback: (payload: Uint8Array) => void) {
        this.onFeatures = callback;
        return this;
    }

    /** Registers the callback that receives source-data payload frames without the transport header. */
    withSourceDataCallback(callback: (payload: Uint8Array) => void) {
        this.onSourceData = callback;
        return this;
    }

    /** Registers the callback that receives search-result payload frames without the transport header. */
    withSearchResultsCallback(callback: (payload: Uint8Array) => void) {
        this.onSearchResults = callback;
        return this;
    }

    /** Registers the callback that receives field-dictionary update frames. */
    withFieldsCallback(callback: (frame: Uint8Array) => void) {
        this.onFields = callback;
        return this;
    }

    /** Registers the callback that receives parsed `/tiles` status payloads. */
    withStatusCallback(callback: (status: MapTileStreamStatusPayload) => void) {
        this.onStatus = callback;
        return this;
    }

    /** Registers the callback that receives parsed server-side search status payloads. */
    withSearchStatusCallback(callback: (status: MapTileStreamSearchStatusPayload) => void) {
        this.onSearchStatus = callback;
        return this;
    }

    /** Registers a websocket error callback. */
    withErrorCallback(callback: (event: Event) => void) {
        this.onError = callback;
        return this;
    }

    /** Registers a websocket close callback. */
    withCloseCallback(callback: (event: CloseEvent) => void) {
        this.onClose = callback;
        return this;
    }

    /** Seeds the parser with datasource info from JSON text. */
    setDataSourceInfoJson(json: string) {
        const buffer = new TextEncoder().encode(json);
        return this.setDataSourceInfoBuffer(buffer);
    }

    /** Seeds the parser with datasource info from a serialized buffer. */
    setDataSourceInfoBuffer(buffer: Uint8Array) {
        uint8ArrayToWasm((wasmBuffer: any) => {
            this.parser.setDataSourceInfo(wasmBuffer);
        }, buffer);
        return this;
    }

    /** Returns true while the websocket connection is open. */
    isOpen(): boolean {
        return this.socket?.readyState === WebSocket.OPEN;
    }

    /** Closes the websocket, ignoring close failures from already-dead sockets. */
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

    /** Tears down websocket, pull loops, parser state, and any pending completion promise. */
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

    /** Drops queued frames that have not yet been handed to the parser or render pipeline. */
    clearPendingFrames() {
        console.log(`Clearing ${this.frameQueue.length} frames.`)
        this.frameQueue = [];
    }

    /** Pauses or resumes frame handling so the rest of the app can shed load temporarily. */
    setFrameProcessingPaused(paused: boolean) {
        this.frameProcessingPaused = paused;
        if (!paused && this.frameQueue.length) {
            this.scheduleFrameProcessing(0);
        }
    }

    /** Enables or disables gzip-aware `/tiles/next` pull requests. */
    setPullCompressionEnabled(enabled: boolean) {
        this.pullCompressionEnabled = !!enabled;
    }

    /** Exposes whether queued websocket frames are currently held back. */
    get isFrameProcessingPaused(): boolean {
        return this.frameProcessingPaused;
    }

    /** Returns the EWMA downstream throughput used to size future pull batches. */
    getDownstreamBytesPerSecond(): number {
        return this.downstreamBytesPerSecondEwma;
    }

    /** Returns the number of queued websocket frames waiting to be processed. */
    getPendingFrameQueueSize(): number {
        return this.frameQueue.length;
    }

    /** Returns aggregated compression metrics for `/tiles/next` responses. */
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

    /** Returns a compact snapshot of pull-loop and websocket state for CI diagnostics. */
    getDebugState(): MapTileStreamDebugState {
        return {
            isOpen: this.isOpen(),
            awaitingCompletion: this.awaitingCompletion,
            latestRequestedRequestId: this.latestRequestedRequestId,
            incomingRequestId: this.incomingRequestId,
            supportsRequestContextFrames: this.supportsRequestContextFrames,
            pullClientId: this.pullClientId,
            pendingFrameQueueSize: this.frameQueue.length,
            frameProcessingPaused: this.frameProcessingPaused,
            pullCompressionEnabled: this.pullCompressionEnabled,
            pullBatchMaxBytesBudget: this.pullBatchMaxBytesBudget,
            downstreamBytesPerSecondEwma: this.downstreamBytesPerSecondEwma,
            totalPullResponses: this.totalPullResponses,
            totalPullGzipResponses: this.totalPullGzipResponses,
            lastStatusPayload: this.lastStatusPayload
                ? {
                    requestId: this.lastStatusPayload.requestId,
                    allDone: this.lastStatusPayload.allDone,
                    message: this.lastStatusPayload.message,
                    requestCount: this.lastStatusPayload.requests.length
                }
                : null
        };
    }

    /** Sends an arbitrary JSON-compatible request body, mostly for tests and auxiliary calls. */
    sendRequest(body: object | string) {
        const payload = typeof body === "string" ? body : JSON.stringify(body);
        return this.sendSerializedRequests([payload]);
    }

    /** Sends one or more pre-serialized request payloads and resets completion tracking. */
    private sendSerializedRequests(payloads: string[]) {
        this.awaitingCompletion = true;
        this.lastStatusPayload = null;
        this.resetCompletionPromise();
        this.lastRequestPromise = this.connect()
            .then(() => {
                if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                    throw new Error("WebSocket is not open.");
                }
                for (const payload of payloads) {
                    this.socket.send(payload);
                }
            })
            .catch(err => {
                this.rejectCompletion(err);
                throw err;
            });
        return this;
    }

    /**
     * Sends the current logical `/tiles` request if it differs from the last one.
     * Large requests are chunked across multiple websocket messages but still share one request id.
     */
    async updateRequest(tileLayerRequests: any[]) {
        const stringPoolOffsets = this.parser!.getFieldDictOffsets();
        const requestBodyBase = {
            requests: tileLayerRequests,
            stringPoolOffsets,
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
        try {
            const requestPayloads = this.buildRequestPayloads(
                tileLayerRequests,
                stringPoolOffsets,
                requestId);
            this.sendSerializedRequests(requestPayloads);
            await this.waitForSend();
            return true;
        } catch (err) {
            this.lastTilesRequestBody = null;
            this.latestRequestedRequestId = previousRequestId;
            console.error("Failed to send /tiles request.", err);
            return false;
        }
    }

    /**
     * Splits oversized `/tiles` requests at request-group boundaries so the backend can process
     * each map/layer/level group independently without reassembly.
     */
    private buildRequestPayloads(
        tileLayerRequests: any[],
        stringPoolOffsets: unknown,
        requestId: number): string[]
    {
        // Chunk only between complete request groups. map.service keeps these
        // groups disjoint by map/layer/tile-level, so the server can schedule
        // each chunk immediately while keeping one logical request id.
        const singlePayload = JSON.stringify({
            requests: tileLayerRequests,
            stringPoolOffsets,
            requestId,
        } satisfies TileRequestPayload);
        if (this.byteLength(singlePayload) <= TARGET_TILE_REQUEST_CHUNK_BYTES) {
            return [singlePayload];
        }

        const chunks: TileRequestPayload[] = [];
        let currentRequests: any[] = [];
        let nextChunkIndex = 0;

        const makeChunk = (requests: any[], index: number, isLast: boolean): TileRequestPayload => ({
            requests,
            requestId,
            chunk: {index, isLast},
            ...(index === 0 ? {stringPoolOffsets} : {}),
        });

        const finalizeCurrentChunk = () => {
            if (!currentRequests.length) {
                return;
            }
            chunks.push(makeChunk(currentRequests, nextChunkIndex++, false));
            currentRequests = [];
        };

        for (const request of tileLayerRequests) {
            const candidateRequests = [...currentRequests, request];
            const currentChunkIndex = nextChunkIndex;
            const candidatePayload = JSON.stringify(makeChunk(candidateRequests, currentChunkIndex, false));
            if (currentRequests.length
                && this.byteLength(candidatePayload) > TARGET_TILE_REQUEST_CHUNK_BYTES) {
                finalizeCurrentChunk();
            }

            currentRequests.push(request);
            const currentPayload = JSON.stringify(makeChunk(currentRequests, nextChunkIndex, false));
            if (currentRequests.length === 1
                && this.byteLength(currentPayload) > MAX_TILE_REQUEST_MESSAGE_BYTES) {
                throw new Error(
                    `Single /tiles request group exceeds ${MAX_TILE_REQUEST_MESSAGE_BYTES} bytes; refusing to send it.`);
            }
        }
        finalizeCurrentChunk();

        if (chunks.length === 0) {
            return [singlePayload];
        }

        chunks[chunks.length - 1].chunk!.isLast = true;
        return chunks.map(chunk => JSON.stringify(chunk));
    }

    /** Measures the UTF-8 payload size that matters for websocket message limits. */
    private byteLength(payload: string): number {
        return this.encoder.encode(payload).byteLength;
    }

    /** Waits until the most recent send attempt either completed or failed. */
    async waitForSend(): Promise<void> {
        if (this.lastRequestPromise) {
            await this.lastRequestPromise;
        }
    }

    /** Waits for the backend to report completion of the latest logical `/tiles` request. */
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

    /** Convenience wrapper that waits for completion and then destroys the transport. */
    async waitAndDestroy(): Promise<MapTileStreamStatusPayload> {
        try {
            return await this.waitForCompletion();
        } finally {
            this.destroy();
        }
    }

    /** Opens the websocket once and reuses an in-flight connection attempt for concurrent callers. */
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

    /** Lazily allocates the promise resolved by the final `/tiles` status frame. */
    private ensureCompletionPromise(): Promise<MapTileStreamStatusPayload> {
        if (!this.completionPromise) {
            this.completionPromise = new Promise((resolve, reject) => {
                this.completionResolve = resolve;
                this.completionReject = reject;
            });
        }
        return this.completionPromise;
    }

    /** Clears the cached completion promise and its resolve/reject callbacks. */
    private resetCompletionPromise() {
        this.completionPromise = null;
        this.completionResolve = null;
        this.completionReject = null;
    }

    /** Resolves the outstanding completion promise and caches the terminal status payload. */
    private resolveCompletion(payload: MapTileStreamStatusPayload) {
        this.awaitingCompletion = false;
        this.lastStatusPayload = payload;
        if (this.completionResolve) {
            this.completionResolve(payload);
        }
        this.resetCompletionPromise();
    }

    /** Rejects the outstanding completion promise after a transport-level failure. */
    private rejectCompletion(error: unknown) {
        this.awaitingCompletion = false;
        if (this.completionReject) {
            this.completionReject(error);
        }
        this.resetCompletionPromise();
    }

    /** Resolves the websocket URL relative to the current document and upgrades HTTP to WS. */
    private resolveUrl(): string {
        const url = new URL(this.path, document.baseURI);
        if (url.protocol === "http:") {
            url.protocol = "ws:";
        } else if (url.protocol === "https:") {
            url.protocol = "wss:";
        }
        return url.toString();
    }

    /** Queues a raw websocket message for budgeted processing on the next timer tick. */
    private enqueueFrame(data: ArrayBuffer | Blob) {
        this.frameQueue.push(data);
        if (this.frameProcessingPaused) {
            return;
        }
        this.scheduleFrameProcessing(0);
    }

    /** Schedules frame processing if no timer is already pending. */
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

    /** Drains queued websocket messages until the per-tick frame budget is exhausted. */
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

    /** Normalizes websocket messages to byte arrays and iterates over packed transport frames. */
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

    /** Dispatches one parsed transport frame to the parser, callbacks, or completion tracking. */
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
                    if (payload.type === MAP_TILE_STREAM_SEARCH_STATUS_TYPE) {
                        if (this.onSearchStatus) {
                            this.onSearchStatus(payload as unknown as MapTileStreamSearchStatusPayload);
                        }
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

            if (type === MAP_TILE_STREAM_TYPE_SEARCH_RESULTS) {
                if (this.onSearchResults) {
                    this.onSearchResults(bytes.slice(MAP_TILE_STREAM_HEADER_SIZE));
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

    /** Filters stale status/context frames that belong to an older logical request id. */
    private matchesCurrentRequest(requestId: number | undefined): boolean {
        if (this.latestRequestedRequestId === null) {
            return true;
        }
        if (requestId === undefined) {
            return true;
        }
        return requestId === this.latestRequestedRequestId;
    }

    /** Restarts the background pull loops when the server advertises pull-based delivery. */
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

    /** Aborts every active `/tiles/next` pull loop. */
    private stopPullLoops() {
        for (const controller of this.pullControllers) {
            controller.abort();
        }
        this.pullControllers = [];
    }

    /** Long-polls `/tiles/next` until the server reports the request is gone or the controller aborts. */
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

    /** Builds the `/tiles/next` URL with the current adaptive batch size and compression flags. */
    private resolvePullUrl(clientId: number): string {
        const normalizedPath = this.path.replace(/\/+$/, "");
        const pullUrl = new URL(`${normalizedPath}/next`, document.baseURI);
        pullUrl.searchParams.set("clientId", String(clientId));
        pullUrl.searchParams.set("waitMs", String(this.pullWaitMs));
        pullUrl.searchParams.set("maxBytes", String(this.currentPullMaxBytes()));
        pullUrl.searchParams.set("compress", this.pullCompressionEnabled ? "1" : "0");
        return pullUrl.toString();
    }

    /** Returns the currently advertised `maxBytes` budget for the next pull response. */
    private currentPullMaxBytes(): number {
        return this.pullBatchMaxBytesBudget;
    }

    /** Monotonically raises the pull batch budget toward the observed downstream throughput. */
    private updatePullMaxBytes(estimatedBytesPerSecond: number) {
        const estimated = Math.max(this.pullBatchMinBytes, Math.floor(estimatedBytesPerSecond));
        this.pullBatchMaxBytesBudget = Math.min(
            this.pullBatchMaxBytesCap,
            Math.max(this.pullBatchMaxBytesBudget, estimated));
    }

    /** Feeds an EWMA throughput estimate from observed pull response sizes and durations. */
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
        this.updatePullMaxBytes(this.downstreamBytesPerSecondEwma);
    }

    /** Updates aggregate compression counters from a completed pull response. */
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

    /** Returns true when the response body was transferred with gzip content encoding. */
    private hasGzipContentEncoding(response: Response): boolean {
        const header = response.headers.get("content-encoding");
        if (!header) {
            return false;
        }
        return header.toLowerCase().includes("gzip");
    }

    /** Extracts the compressed transfer size from preferred custom headers or `content-length`. */
    private extractCompressedBodyBytes(response: Response): number | null {
        const preferredHeader = this.parseNonNegativeIntegerHeader(response.headers.get("x-mapget-compressed-bytes"));
        if (preferredHeader !== null) {
            return preferredHeader;
        }
        return this.parseNonNegativeIntegerHeader(response.headers.get("content-length"));
    }

    /** Parses integer response headers while rejecting negative and malformed values. */
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

    /** Abort-aware timeout used by the pull loop retry path. */
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
