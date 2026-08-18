import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import type {TileLayerParser} from "../../build/libs/core/erdblick-core";
import {FrameBudgetLoop} from "../shared/frame-budget-loop";

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
export const MAP_TILE_STREAM_TYPE_SUBSETS = 7;
export const MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE = 8;
export const MAP_TILE_STREAM_TYPE_END_OF_STREAM = 128;
export const MAP_TILE_STREAM_REQUEST_CONTEXT_TYPE = "mapget.tiles.request-context";
export const MAP_TILE_STREAM_FILTER_STATUS_TYPE = "mapget.filter.status";
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

export interface MapTileStreamFilterStatusPayload {
    type: typeof MAP_TILE_STREAM_FILTER_STATUS_TYPE;
    filterId: string;
    generation: number;
    mapId?: string;
    layerId?: string;
    sourceId?: string;
    state: string;
    outputTilesRequested?: number;
    sourceTilesQueued?: number;
    sourceTilesLoaded?: number;
    sourceTilesEvaluated?: number;
    outputTilesReady?: number;
    outputTilesEmitted?: number;
    entriesEmitted?: number;
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
    sourcesRevision?: number;
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

interface QueuedTransportFrame {
    bytes: Uint8Array;
    type: number;
    version: {major: number; minor: number; patch: number};
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

/** Lightweight datasource status object optionally embedded in a source-catalog change frame. */
export interface MapTileStreamSourceCatalogChangeSource {
    configIndex: number;
    status?: string;
    statusMessage?: string;
    progress?: number | null;
}

/** Control payload emitted by mapget when datasource catalog state or structure changes. */
export interface MapTileStreamSourceCatalogChangePayload {
    type: "mapget.sources.changed";
    revision: number;
    reason?: string;
    source?: MapTileStreamSourceCatalogChangeSource;
}

/** Details from a VTLV frame header whose major/minor version cannot be decoded safely. */
export interface MapTileStreamProtocolMismatch {
    actual: {major: number; minor: number; patch: number};
    expected: {major: number; minor: number};
}

export interface MapTileStreamDebugState {
    isOpen: boolean;
    awaitingCompletion: boolean;
    activeWebSocketPath: string;
    activePullPath: string;
    usingLegacyWebSocketFallback: boolean;
    usingLegacyPullFallback: boolean;
    latestRequestedRequestId: number | null;
    incomingRequestId: number | null;
    supportsRequestContextFrames: boolean;
    pullClientId: number | null;
    sourcesRevision: number | null;
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
 * WebSocket client for `/interactive` plus the optional `/interactive/payload` pull loop.
 * It hides frame parsing, request chunking, status tracking, and adaptive pull budgeting
 * behind callback-style hooks that `MapTileStreamService` can consume from outside Angular.
 */
export class MapTileStreamClient {
    private socket: WebSocket | null = null;
    private connecting: Promise<void> | null = null;
    private readonly decoder = new TextDecoder();
    private readonly encoder = new TextEncoder();
    private readonly protocolVersion: {major: number; minor: number};
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
    private frameProcessingPaused: boolean = false;
    private frameQueueEpoch = 0;
    private pendingFrameMessages = 0;
    private frameMessageChain: Promise<void> = Promise.resolve();
    private readonly frameLoop = new FrameBudgetLoop<QueuedTransportFrame>(
        frame => {
            this.dispatchFrame(frame);
            return true;
        },
        4,
        "task"
    );
    private pullClientId: number | null = null;
    private sourcesRevision: number | null = null;
    private pullControllers: AbortController[] = [];
    private readonly pullParallelism: number = 2;
    private readonly pullWaitMs: number = 25000;
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
    private activeStreamPath: string;
    private usingLegacyWebSocketFallback: boolean = false;
    private usingLegacyPullFallback: boolean = false;
    private readonly ownsParser: boolean;
    private protocolMismatchReported: boolean = false;
    private protocolMismatchActive: boolean = false;
    private transportFailureActive: boolean = false;
    /** Counts successful websocket connections so the first context frame can identify reconnects. */
    private openedSocketCount: number = 0;
    /** True until the current socket identifies its datasource-catalog revision. */
    private awaitingSocketSourcesRevision: boolean = false;

    onFrame: ((frame: Uint8Array, type: number) => void) | null = null;
    onFeatures: ((payload: Uint8Array) => void) | null = null;
    onSourceData: ((payload: Uint8Array) => void) | null = null;
    onSubsets: ((payload: Uint8Array) => void) | null = null;
    onFields: ((frame: Uint8Array) => void) | null = null;
    onStatus: ((status: MapTileStreamStatusPayload) => void) | null = null;
    onFilterStatus: ((status: MapTileStreamFilterStatusPayload) => void) | null = null;
    onSourceCatalogChanged: ((change: MapTileStreamSourceCatalogChangePayload) => void) | null = null;
    onSourcesRevisionChanged: ((revision: number, reconnected: boolean) => void) | null = null;
    onOpen: (() => void) | null = null;
    onError: ((event: Event) => void) | null = null;
    onClose: ((event: CloseEvent) => void) | null = null;
    onProtocolMismatch: ((mismatch: MapTileStreamProtocolMismatch) => void) | null = null;

    /** Creates or adopts the parser and remembers the relative backend path for websocket and pull calls. */
    constructor(private path: string = "/interactive", parser?: TileLayerParser) {
        this.activeStreamPath = path;
        this.ownsParser = !parser;
        this.parser = parser ?? new coreLib.TileLayerParser();
        // The parser and framing version come from the same mapget build in
        // WASM. Keeping a second TypeScript version inevitably drifts during
        // dependency upgrades and cannot describe what this client can parse.
        this.protocolVersion = {
            major: coreLib.tileLayerStreamProtocolMajor(),
            minor: coreLib.tileLayerStreamProtocolMinor()
        };
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

    /** Registers the callback that receives subset payload frames without the transport header. */
    withSubsetsCallback(callback: (payload: Uint8Array) => void) {
        this.onSubsets = callback;
        return this;
    }

    /** Registers the callback that receives field-dictionary update frames. */
    withFieldsCallback(callback: (frame: Uint8Array) => void) {
        this.onFields = callback;
        return this;
    }

    /** Registers the callback that receives parsed interactive-stream status payloads. */
    withStatusCallback(callback: (status: MapTileStreamStatusPayload) => void) {
        this.onStatus = callback;
        return this;
    }

    /** Registers the callback that receives parsed server-side search status payloads. */
    withFilterStatusCallback(callback: (status: MapTileStreamFilterStatusPayload) => void) {
        this.onFilterStatus = callback;
        return this;
    }

    /** Registers the callback that receives datasource-catalog invalidation control frames. */
    withSourceCatalogChangedCallback(callback: (change: MapTileStreamSourceCatalogChangePayload) => void) {
        this.onSourceCatalogChanged = callback;
        return this;
    }

    /** Registers revision updates and identifies the first context received after a websocket reconnect. */
    withSourcesRevisionChangedCallback(callback: (revision: number, reconnected: boolean) => void) {
        this.onSourcesRevisionChanged = callback;
        return this;
    }

    /** Extracts the lightweight datasource-status object from a source-catalog control frame. */
    private parseSourceCatalogChangeSource(source: unknown): MapTileStreamSourceCatalogChangeSource | undefined {
        if (typeof source !== "object" || source === null) {
            return undefined;
        }
        const sourceRecord = source as Record<string, unknown>;
        const configIndex = sourceRecord["configIndex"];
        const status = sourceRecord["status"];
        const statusMessage = sourceRecord["statusMessage"];
        const progress = sourceRecord["progress"];
        if (typeof configIndex !== "number"
            || !Number.isInteger(configIndex)
            || configIndex < 0) {
            return undefined;
        }
        return {
            configIndex,
            status: typeof status === "string" ? status : undefined,
            statusMessage: typeof statusMessage === "string" ? statusMessage : undefined,
            progress: typeof progress === "number" && Number.isFinite(progress)
                ? progress
                : null
        };
    }

    /** Registers a websocket error callback. */
    withErrorCallback(callback: (event: Event) => void) {
        this.onError = callback;
        return this;
    }

    /** Registers a websocket open callback. */
    withOpenCallback(callback: () => void) {
        this.onOpen = callback;
        return this;
    }

    /** Registers a websocket close callback. */
    withCloseCallback(callback: (event: CloseEvent) => void) {
        this.onClose = callback;
        return this;
    }

    /** Registers a VTLV protocol-mismatch callback. */
    withProtocolMismatchCallback(callback: (mismatch: MapTileStreamProtocolMismatch) => void) {
        this.onProtocolMismatch = callback;
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

    /**
     * Abort one ambiguous interactive transfer and let ordinary reconnect
     * create a fresh server-side session. No same-session parser repair is
     * attempted because payload bytes are not retained for retransmission.
     */
    failInteractiveConnection(message: string, error?: unknown): void {
        if (this.transportFailureActive || this.protocolMismatchActive) {
            return;
        }
        this.transportFailureActive = true;
        console.error(message, error);
        this.stopPullLoops();
        this.clearPendingFrames();
        this.rejectCompletion(
            error instanceof Error ? error : new Error(message)
        );
        this.close(1011, "interactive transport failure");
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
        this.sourcesRevision = null;
        this.openedSocketCount = 0;
        this.awaitingSocketSourcesRevision = false;
        this.stopPullLoops();
        this.clearPendingFrames();
        this.frameLoop.dispose();
        this.resetCompletionPromise();
        if (this.ownsParser && this.parser) {
            this.parser.delete();
        }
    }

    /** Drops queued frames that have not yet been handed to the parser or render pipeline. */
    clearPendingFrames() {
        this.frameQueueEpoch += 1;
        this.pendingFrameMessages = 0;
        this.frameLoop.clear();
    }

    /** Invalidates in-flight payloads after datasource dictionaries have been replaced. */
    resetAfterDataSourceInfoChange() {
        this.close(1000, "datasource info changed");
        this.clearPendingFrames();
        this.awaitingCompletion = false;
        this.lastRequestPromise = null;
        this.lastStatusPayload = null;
        this.lastTilesRequestBody = null;
        this.incomingRequestId = null;
        this.latestRequestedRequestId = this.nextRequestId++;
        this.pullClientId = null;
        this.stopPullLoops();
        this.resetCompletionPromise();
    }

    /** Pauses or resumes frame handling so the rest of the app can shed load temporarily. */
    setFrameProcessingPaused(paused: boolean) {
        this.frameProcessingPaused = paused;
        this.frameLoop.setPaused(paused);
    }

    /** Enables or disables gzip-aware `/interactive/payload` pull requests. */
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
        return this.pendingFrameMessages + this.frameLoop.length;
    }

    /** Returns the latest datasource catalog revision announced by request-context frames. */
    getSourcesRevision(): number | null {
        return this.sourcesRevision;
    }

    /** Stores the newest datasource-catalog revision and optionally notifies consumers. */
    private updateSourcesRevision(revision: number, notify: boolean, reconnected: boolean = false): void {
        const nextRevision = Math.max(0, Math.floor(revision));
        const previousRevision = this.sourcesRevision;
        this.sourcesRevision = previousRevision === null
            ? nextRevision
            : Math.max(previousRevision, nextRevision);
        if (notify && (reconnected || previousRevision === null || nextRevision > previousRevision)) {
            this.onSourcesRevisionChanged?.(nextRevision, reconnected);
        }
    }

    /** Starts a new connection-scoped revision sequence and records whether this is a reconnect. */
    private prepareForOpenedSocket(): void {
        this.openedSocketCount++;
        this.awaitingSocketSourcesRevision = true;
        // Revisions are process-local; retaining the previous socket's maximum
        // would hide equal or lower revisions after a backend restart.
        this.sourcesRevision = null;
    }

    /** Returns aggregated compression metrics for `/interactive/payload` responses. */
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
            activeWebSocketPath: this.debugPath(this.activeStreamPath),
            activePullPath: this.debugPath(this.resolvePullPath()),
            usingLegacyWebSocketFallback: this.usingLegacyWebSocketFallback,
            usingLegacyPullFallback: this.usingLegacyPullFallback,
            latestRequestedRequestId: this.latestRequestedRequestId,
            incomingRequestId: this.incomingRequestId,
            supportsRequestContextFrames: this.supportsRequestContextFrames,
            pullClientId: this.pullClientId,
            sourcesRevision: this.sourcesRevision,
            pendingFrameQueueSize: this.getPendingFrameQueueSize(),
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
     * Sends the current logical interactive tile request if it differs from the last one.
     * Large requests are chunked across multiple websocket messages but still share one request id.
     */
    async updateRequest(
        tileLayerRequests: any[],
        force = false
    ): Promise<"sent" | "unchanged" | "failed"> {
        const stringPoolOffsets = this.parser!.getFieldDictOffsets();
        const requestBodyBase = {
            requests: tileLayerRequests,
            stringPoolOffsets,
        };

        const newRequestBody = JSON.stringify(requestBodyBase);

        // Ensure that the new request is different from the previous one.
        if (!force && this.lastTilesRequestBody === newRequestBody) {
            return "unchanged";
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
            return "sent";
        } catch (err) {
            this.lastTilesRequestBody = null;
            this.latestRequestedRequestId = previousRequestId;
            console.error("Failed to send interactive tile request.", err);
            return "failed";
        }
    }

    /**
     * Splits oversized interactive requests while preserving one atomic logical
     * snapshot identified by the shared request id and ordered chunk metadata.
     */
    private buildRequestPayloads(
        tileLayerRequests: any[],
        stringPoolOffsets: unknown,
        requestId: number): string[]
    {
        // Chunk only between complete request groups where possible. Mapget
        // stages every piece and reconciles only after the final chunk.
        const singlePayload = JSON.stringify({
            requests: tileLayerRequests,
            stringPoolOffsets,
            requestId,
        } satisfies TileRequestPayload);
        if (this.byteLength(singlePayload) <= TARGET_TILE_REQUEST_CHUNK_BYTES) {
            return [singlePayload];
        }

        // A user-configured view can put hundreds of thousands of IDs into one
        // map/layer/filter group. Split tile-indexed fields together so that a
        // single logical group never becomes an unsendable all-or-nothing JSON
        // object when one presentation covers a very large tile set.
        const boundedRequests = tileLayerRequests.flatMap(request =>
            this.splitRequestGroupForTransport(
                request,
                stringPoolOffsets,
                requestId
            )
        );

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

        for (const request of boundedRequests) {
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
                    `Single interactive request group exceeds ${MAX_TILE_REQUEST_MESSAGE_BYTES} bytes; refusing to send it.`);
            }
        }
        finalizeCurrentChunk();

        if (chunks.length === 0) {
            return [singlePayload];
        }

        chunks[chunks.length - 1].chunk!.isLast = true;
        return chunks.map(chunk => JSON.stringify(chunk));
    }

    /** Bisects one request group while keeping every tile-indexed side array aligned. */
    private splitRequestGroupForTransport(
        request: any,
        stringPoolOffsets: unknown,
        requestId: number
    ): any[] {
        const encoded = JSON.stringify({
            requests: [request],
            requestId,
            chunk: {index: 0, isLast: false},
            stringPoolOffsets
        } satisfies TileRequestPayload);
        if (this.byteLength(encoded) <= TARGET_TILE_REQUEST_CHUNK_BYTES) {
            return [request];
        }
        const tileIds = Array.isArray(request?.tileIds)
            ? request.tileIds
            : [];
        if (tileIds.length <= 1) {
            if (this.byteLength(encoded) > MAX_TILE_REQUEST_MESSAGE_BYTES) {
                throw new Error(
                    `Single interactive request group exceeds ` +
                    `${MAX_TILE_REQUEST_MESSAGE_BYTES} bytes; refusing to send it.`
                );
            }
            return [request];
        }

        const midpoint = Math.ceil(tileIds.length / 2);
        const left = this.sliceRequestGroup(request, tileIds.slice(0, midpoint));
        const right = this.sliceRequestGroup(request, tileIds.slice(midpoint));
        return [
            ...this.splitRequestGroupForTransport(
                left,
                stringPoolOffsets,
                requestId
            ),
            ...this.splitRequestGroupForTransport(
                right,
                stringPoolOffsets,
                requestId
            )
        ];
    }

    /** Copies one request for a tile subset and filters all known per-tile fields. */
    private sliceRequestGroup(request: any, tileIds: any[]): any {
        const membership = new Set(tileIds.map(tileId => String(tileId)));
        const containsTile = (value: unknown): boolean =>
            membership.has(String(value));
        const result: Record<string, any> = {
            ...request,
            tileIds
        };
        for (const field of [
            "priorityTileIds",
            "roots",
            "featureIds"
        ]) {
            const values = request?.[field];
            if (!Array.isArray(values)) {
                continue;
            }
            result[field] = values.filter((value: any) =>
                field === "priorityTileIds"
                    ? containsTile(value)
                    : containsTile(value?.tileId)
            );
        }
        return result;
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

    /** Waits for the backend to report completion of the latest logical interactive request. */
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
        if (this.protocolMismatchActive) {
            throw new Error(
                "The map backend uses an incompatible tile-stream protocol."
            );
        }
        if (this.socket?.readyState === WebSocket.OPEN) {
            return;
        }
        if (this.connecting) {
            return this.connecting;
        }

        const attempt = this.connectWithEndpointFallback();
        this.connecting = attempt;
        try {
            await attempt;
        } finally {
            if (this.connecting === attempt) {
                this.connecting = null;
            }
        }
    }

    /** Attempts the configured websocket endpoint first, then legacy `/tiles` for stale proxy setups. */
    private async connectWithEndpointFallback(): Promise<void> {
        const candidates = this.streamEndpointCandidates();
        let lastError: Event | CloseEvent | unknown = undefined;
        for (let index = 0; index < candidates.length; ++index) {
            const candidate = candidates[index];
            try {
                await this.openSocket(candidate);
                this.activeStreamPath = candidate;
                this.usingLegacyWebSocketFallback = index > 0;
                this.usingLegacyPullFallback = index > 0;
                if (index > 0) {
                    console.warn(`Fell back to legacy mapget tile stream endpoint ${this.debugPath(candidate)}.`);
                }
                return;
            } catch (error) {
                lastError = error;
                if (index === 0 && candidates.length > 1) {
                    console.warn(
                        `Mapget tile stream endpoint ${this.debugPath(candidate)} failed before opening; trying ${this.debugPath(candidates[1])}.`);
                }
            }
        }
        this.reportConnectionFailure(lastError);
        throw lastError;
    }

    /** Opens one websocket endpoint and resolves only after the connection is usable. */
    private openSocket(path: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(this.resolveUrl(path));
            let opened = false;
            let rejected = false;
            socket.binaryType = "arraybuffer";
            this.socket = socket;

            const rejectBeforeOpen = (event: Event | CloseEvent) => {
                if (opened || rejected) {
                    return;
                }
                rejected = true;
                if (this.socket === socket) {
                    this.socket = null;
                }
                reject(event);
            };

            socket.onopen = () => {
                if (this.socket !== socket || rejected) {
                    return;
                }
                opened = true;
                this.prepareForOpenedSocket();
                this.transportFailureActive = false;
                this.onOpen?.();
                resolve();
            };
            socket.onerror = (event) => {
                if (this.socket !== socket) {
                    return;
                }
                if (!opened) {
                    rejectBeforeOpen(event);
                    return;
                }
                this.onError?.(event);
                if (this.awaitingCompletion) {
                    this.rejectCompletion(event);
                }
            };
            socket.onclose = (event) => {
                if (!opened) {
                    rejectBeforeOpen(event);
                    return;
                }
                const isCurrent = this.socket === socket;
                if (isCurrent) {
                    this.socket = null;
                    // A new server-side session has no subscription registry;
                    // force the next update to send the complete snapshot.
                    this.lastTilesRequestBody = null;
                    this.pullClientId = null;
                    this.stopPullLoops();
                    this.onClose?.(event);
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
    }

    /** Reports final connection failure after all endpoint candidates have been exhausted. */
    private reportConnectionFailure(error: unknown): void {
        if (typeof CloseEvent !== "undefined" && error instanceof CloseEvent) {
            this.onClose?.(error);
        } else if (typeof Event !== "undefined" && error instanceof Event) {
            this.onError?.(error);
        }
        if (this.awaitingCompletion) {
            this.rejectCompletion(error);
        }
    }

    /** Lazily allocates the promise resolved by the final interactive status frame. */
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

    /** Returns the websocket endpoint candidates, preserving custom non-interactive paths. */
    private streamEndpointCandidates(): string[] {
        const legacyPath = this.legacyEndpointPath(this.path, "interactive", "tiles");
        return legacyPath ? [this.path, legacyPath] : [this.path];
    }

    /** Resolves the websocket URL relative to the current document and upgrades HTTP to WS. */
    private resolveUrl(path: string = this.activeStreamPath): string {
        const url = new URL(path, document.baseURI);
        if (url.protocol === "http:") {
            url.protocol = "ws:";
        } else if (url.protocol === "https:") {
            url.protocol = "wss:";
        }
        return url.toString();
    }

    /**
     * Splits raw websocket/pull messages in arrival order, then queues every
     * contained VTLV frame as one independently budgeted work item.
     */
    private enqueueFrame(data: ArrayBuffer | Blob) {
        const epoch = this.frameQueueEpoch;
        this.pendingFrameMessages += 1;
        this.frameMessageChain = this.frameMessageChain
            .then(async () => {
                if (epoch !== this.frameQueueEpoch) {
                    return;
                }
                const frames = await this.decodeMessage(data);
                if (epoch === this.frameQueueEpoch) {
                    this.frameLoop.enqueueMany(frames);
                }
            })
            .catch(err => {
                this.failInteractiveConnection(
                    "Tile stream message could not be decoded.",
                    err
                );
            })
            .finally(() => {
                if (epoch === this.frameQueueEpoch) {
                    this.pendingFrameMessages =
                        Math.max(0, this.pendingFrameMessages - 1);
                }
            });
    }

    /** Test/auxiliary path which immediately dispatches one complete packed message. */
    private async handleMessage(data: ArrayBuffer | Blob): Promise<void> {
        for (const frame of await this.decodeMessage(data)) {
            this.dispatchFrame(frame);
        }
    }

    /** Normalizes one message and returns its strictly ordered VTLV frames. */
    private async decodeMessage(
        data: ArrayBuffer | Blob
    ): Promise<QueuedTransportFrame[]> {
        let bytes: Uint8Array;

        if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
        } else if (data instanceof Blob) {
            bytes = new Uint8Array(await data.arrayBuffer());
        } else {
            throw new Error("Unexpected WebSocket message payload.");
        }

        if (bytes.length < MAP_TILE_STREAM_HEADER_SIZE) {
            throw new Error("Tile stream frame is smaller than its header.");
        }

        const frames: QueuedTransportFrame[] = [];
        let offset = 0;
        while (offset + MAP_TILE_STREAM_HEADER_SIZE <= bytes.length) {
            const header = this.readFrameHeader(bytes, offset);
            const type = header.type;
            const payloadLength = header.payloadLength;
            const frameEnd = offset + MAP_TILE_STREAM_HEADER_SIZE + payloadLength;
            if (frameEnd > bytes.length) {
                throw new Error("Tile stream frame size does not match its header.");
            }

            frames.push({
                bytes: bytes.subarray(offset, frameEnd),
                type,
                version: header.version
            });
            offset = frameEnd;
        }

        if (offset !== bytes.length) {
            throw new Error("Tile stream frame alignment is invalid.");
        }
        return frames;
    }

    /** Applies compatibility checks and dispatches one frame at its FIFO turn. */
    private dispatchFrame(frame: QueuedTransportFrame): void {
        if (!this.isCompatibleProtocol(frame.version)) {
            this.reportProtocolMismatch(frame.version);
            this.clearPendingFrames();
            return;
        }
        this.handleFrame(frame.bytes, frame.type);
    }

    /** Reads the fixed-size VTLV header emitted by mapget's TileLayerStream writer. */
    private readFrameHeader(bytes: Uint8Array, offset: number) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, MAP_TILE_STREAM_HEADER_SIZE);
        return {
            version: {
                major: view.getUint16(0, true),
                minor: view.getUint16(2, true),
                patch: view.getUint16(4, true)
            },
            type: view.getUint8(6),
            payloadLength: view.getUint32(7, true)
        };
    }

    /** Returns whether a VTLV frame can be parsed by this frontend build. */
    private isCompatibleProtocol(version: {major: number; minor: number}): boolean {
        return version.major === this.protocolVersion.major
            && version.minor === this.protocolVersion.minor;
    }

    /** Reports one protocol mismatch and stops the active transport because following frame parsing is unsafe. */
    private reportProtocolMismatch(version: {major: number; minor: number; patch: number}): void {
        this.protocolMismatchActive = true;
        this.transportFailureActive = true;
        if (!this.protocolMismatchReported) {
            this.protocolMismatchReported = true;
            this.onProtocolMismatch?.({
                actual: version,
                expected: this.protocolVersion
            });
        }
        this.stopPullLoops();
        this.rejectCompletion(new Error(
            `Unsupported mapget tile-stream protocol ${version.major}.${version.minor}.${version.patch}; `
            + `expected ${this.protocolVersion.major}.${this.protocolVersion.minor}.x.`));
        this.close(1002, "unsupported mapget tile-stream protocol");
    }

    /** Dispatches one parsed transport frame to the parser, callbacks, or completion tracking. */
    private handleFrame(bytes: Uint8Array, type: number): void {
        if (type === MAP_TILE_STREAM_TYPE_END_OF_STREAM) {
            return;
        }
        try {
            if (type === MAP_TILE_STREAM_TYPE_STATUS) {
                const payloadBytes = bytes.slice(MAP_TILE_STREAM_HEADER_SIZE);
                const payloadText = this.decoder.decode(payloadBytes);
                const payload = JSON.parse(payloadText) as MapTileStreamStatusPayload;
                if (!this.matchesCurrentRequest(payload.requestId)) {
                    return;
                }
                if (payload.type === MAP_TILE_STREAM_FILTER_STATUS_TYPE) {
                    if (this.onFilterStatus) {
                        this.onFilterStatus(payload as unknown as MapTileStreamFilterStatusPayload);
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
                return;
            }

            if (type === MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT) {
                const payloadBytes = bytes.slice(MAP_TILE_STREAM_HEADER_SIZE);
                const payloadText = this.decoder.decode(payloadBytes);
                const payload = JSON.parse(payloadText) as MapTileStreamRequestContextPayload;
                if (payload.type === MAP_TILE_STREAM_REQUEST_CONTEXT_TYPE && Number.isFinite(payload.requestId)) {
                    this.supportsRequestContextFrames = true;
                    this.incomingRequestId = Math.max(0, Math.floor(payload.requestId));
                    if (Number.isFinite(payload.sourcesRevision)) {
                        const reconnected = this.awaitingSocketSourcesRevision
                            && this.openedSocketCount > 1;
                        this.awaitingSocketSourcesRevision = false;
                        this.updateSourcesRevision(Number(payload.sourcesRevision), true, reconnected);
                    }
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
                return;
            }

            if (type === MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE) {
                const payloadBytes = bytes.slice(MAP_TILE_STREAM_HEADER_SIZE);
                const payloadText = this.decoder.decode(payloadBytes);
                const payload = JSON.parse(payloadText) as MapTileStreamSourceCatalogChangePayload;
                if (payload.type === "mapget.sources.changed" && Number.isFinite(payload.revision)) {
                    const revision = Math.max(0, Math.floor(Number(payload.revision)));
                    this.updateSourcesRevision(revision, false);
                    const source = this.parseSourceCatalogChangeSource(payload.source);
                    this.onSourceCatalogChanged?.({
                        type: "mapget.sources.changed",
                        revision,
                        reason: typeof payload.reason === "string" ? payload.reason : undefined,
                        ...(source ? {source} : {})
                    });
                }
                return;
            }

            if (type === MAP_TILE_STREAM_TYPE_FIELDS) {
                // Field dictionaries are string-pool-keyed prerequisites for feature/subset payloads.
                // They can legitimately arrive after a newer request context has superseded
                // their original request, while the already-accepted feature payload still
                // remains cached. Keep them additive across request churn; datasource reloads
                // close/reset the stream so dictionaries cannot leak across metadata epochs.
                uint8ArrayToWasm((wasmBuffer: any) => {
                    this.parser.readFieldDictUpdate(wasmBuffer);
                }, bytes);
                if (this.onFields) {
                    this.onFields(bytes);
                }
                return;
            }

            if (type === MAP_TILE_STREAM_TYPE_FEATURES) {
                if (!this.acceptsCurrentPayloadFrame()) {
                    return;
                }
                if (this.onFeatures) {
                    this.onFeatures(bytes.slice(MAP_TILE_STREAM_HEADER_SIZE));
                }
                return;
            }

            if (type === MAP_TILE_STREAM_TYPE_SOURCEDATA) {
                if (!this.acceptsCurrentPayloadFrame()) {
                    return;
                }
                if (this.onSourceData) {
                    this.onSourceData(bytes.slice(MAP_TILE_STREAM_HEADER_SIZE));
                }
                return;
            }

            if (type === MAP_TILE_STREAM_TYPE_SUBSETS) {
                // A pull response can cross a same-generation coverage update:
                // the server has already marked its subset tile forwarded,
                // while the newer request-context frame may be processed first.
                // Unlike complete feature/source-data frames, every subset
                // carries filterId + generation + tile identity and the owning
                // FilterSubscriptionRef applies the exact current-coverage
                // gate. Rejecting it by untagged request context here loses a
                // valid result permanently.
                if (this.onSubsets) {
                    this.onSubsets(bytes.slice(MAP_TILE_STREAM_HEADER_SIZE));
                }
                return;
            }

            if (this.onFrame) {
                this.onFrame(bytes, type);
            }
        } catch (err) {
            this.failInteractiveConnection(
                "Tile stream frame could not be processed.",
                err
            );
        }
    }

    /** Returns whether the active request context allows decoding untagged payload frames. */
    private acceptsCurrentPayloadFrame(): boolean {
        if (!this.supportsRequestContextFrames || this.latestRequestedRequestId === null) {
            return true;
        }
        return this.incomingRequestId === this.latestRequestedRequestId;
    }

    /** Filters stale status/context frames that belong to an older logical request id. */
    private matchesCurrentRequest(requestId: number | undefined): boolean {
        if (this.latestRequestedRequestId === null) {
            return true;
        }
        if (requestId === undefined) {
            // Versioned interactive servers tag every logical request status. Reject
            // untagged frames once that capability has been observed so an
            // unrelated control/error frame cannot complete the active
            // request or overwrite its terminal diagnostics.
            return !this.supportsRequestContextFrames;
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
                    this.failInteractiveConnection("Tile pull loop failed.", err);
                }
            });
        }
    }

    /** Aborts every active `/interactive/payload` pull loop. */
    private stopPullLoops() {
        for (const controller of this.pullControllers) {
            controller.abort();
        }
        this.pullControllers = [];
    }

    /** Long-polls the active payload endpoint until the server reports the request is gone or the controller aborts. */
    private async runPullLoop(controller: AbortController) {
        while (!controller.signal.aborted) {
            const clientId = this.pullClientId;
            if (clientId === null) {
                return;
            }

            try {
                const startedAt = performance.now();
                const pullUrl = this.resolvePullUrl(clientId);
                const response = await fetch(pullUrl, {
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
                    this.failInteractiveConnection(
                        "The interactive payload session disappeared."
                    );
                    return;
                }

                if (this.activateLegacyPullFallbackForStatus(
                    response.status,
                    pullUrl
                )) {
                    continue;
                }
                this.failInteractiveConnection(
                    `Interactive payload fetch failed with HTTP ${response.status}.`
                );
                return;
            } catch (err) {
                if (controller.signal.aborted) {
                    return;
                }
                this.failInteractiveConnection(
                    "Interactive payload fetch failed.",
                    err
                );
                return;
            }
        }
    }

    /** Builds the active payload URL with the current adaptive batch size and compression flags. */
    private resolvePullUrl(clientId: number): string {
        const pullUrl = new URL(this.resolvePullPath(), document.baseURI);
        pullUrl.searchParams.set("clientId", String(clientId));
        pullUrl.searchParams.set("waitMs", String(this.pullWaitMs));
        pullUrl.searchParams.set("maxBytes", String(this.currentPullMaxBytes()));
        pullUrl.searchParams.set("compress", this.pullCompressionEnabled ? "1" : "0");
        return pullUrl.toString();
    }

    /** Returns the payload endpoint paired with the active websocket endpoint. */
    private resolvePullPath(): string {
        const legacyPullPath = this.legacyEndpointPath(this.activeStreamPath, "interactive", "tiles/next");
        if (this.usingLegacyPullFallback && legacyPullPath) {
            return legacyPullPath;
        }

        const url = new URL(this.activeStreamPath, document.baseURI);
        const normalizedPath = url.pathname.replace(/\/+$/, "");
        if (normalizedPath.endsWith("/tiles")) {
            url.pathname = `${normalizedPath}/next`;
        } else {
            url.pathname = `${normalizedPath}/payload`;
        }
        url.search = "";
        url.hash = "";
        return url.toString();
    }

    /** Switches payload pulls to `/tiles/next` when a stale proxy rejects `/interactive/payload`. */
    private activateLegacyPullFallbackForStatus(
        status: number,
        requestedUrl?: string
    ): boolean {
        if (![404, 405, 501].includes(status)) {
            return false;
        }
        const legacyPath = this.legacyEndpointPath(
            this.activeStreamPath,
            "interactive",
            "tiles/next"
        );
        if (!legacyPath) {
            return false;
        }
        if (this.usingLegacyPullFallback) {
            // Parallel pulls may both have targeted the primary route before
            // the first 404 enables fallback. Treat those already-issued
            // primary responses as handled, but fail if the legacy route
            // itself returns an unsupported-route status.
            return requestedUrl !== undefined &&
                new URL(requestedUrl, document.baseURI).pathname !==
                    new URL(legacyPath, document.baseURI).pathname;
        }
        this.usingLegacyPullFallback = true;
        console.warn(`Fell back to legacy mapget tile payload endpoint ${this.debugPath(this.resolvePullPath())}.`);
        return true;
    }

    /** Rewrites the trailing endpoint segment while preserving origin and proxy prefix. */
    private legacyEndpointPath(path: string, currentSegment: string, replacementSegment: string): string | null {
        const url = new URL(path, document.baseURI);
        const normalizedPath = url.pathname.replace(/\/+$/, "");
        const suffix = `/${currentSegment}`;
        if (!normalizedPath.endsWith(suffix)) {
            return null;
        }
        url.pathname = `${normalizedPath.slice(0, -suffix.length)}/${replacementSegment}`;
        url.search = "";
        url.hash = "";
        return url.toString();
    }

    /** Returns a compact endpoint path for diagnostics without leaking origin noise. */
    private debugPath(path: string): string {
        const url = new URL(path, document.baseURI);
        return `${url.pathname}${url.search}`;
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

}
