import {Injectable, Optional} from "@angular/core";
import {skip, Subject} from "rxjs";
import {AppStateService} from "../../shared/appstate.service";
import {AUTO_TILE_SUBSET_RENDER_WORKER_COUNT} from
    "../../shared/tile-render-policy";
import type {
    TileSubsetLayerRenderBuffers,
    TileSubsetLayerRenderResult,
    TileSubsetLayerRenderTask,
    TileSubsetGpuContribution,
    TileSubsetLayerRenderWorkerOutbound
} from "./tile-subset-layer-render.worker.protocol";
import type {
    GpuSceneSnapshot
} from "./gpu-scene";
import {gpuIconAtlasService} from "./gpu-icon-atlas.service";
import {
    GPU_RENDER_PACKET_MAX_BYTES,
    GPU_RENDER_PACKET_MAX_FRAGMENTS
} from "./gpu-render-packet";

const AUTO_WORKER_MIN = 2;
const AUTO_WORKER_FALLBACK_CPU_COUNT = 4;
const WORKER_CAP = 32;
const MAX_ADMISSION_PACKETS_PER_TASK = 16;
const MAX_ADMISSION_BYTES_PER_TASK = 4 * 1024 * 1024;
const MAX_ADMISSION_TIME_MS = 4;

/** Choose a bounded worker count that leaves half the logical CPUs for the UI. */
export function getTileSubsetLayerRenderAutoWorkerCount(): number {
    const rawCpuCount = Number(
        globalThis.navigator?.hardwareConcurrency ?? AUTO_WORKER_FALLBACK_CPU_COUNT
    );
    const cpuCount = Number.isFinite(rawCpuCount) && rawCpuCount > 0
        ? Math.floor(rawCpuCount)
        : AUTO_WORKER_FALLBACK_CPU_COUNT;
    return Math.max(
        AUTO_WORKER_MIN,
        Math.min(WORKER_CAP, Math.floor(cpuCount / 2))
    );
}

/** Resolves zero-for-auto configuration into the effective active worker count. */
export function resolveTileSubsetLayerRenderWorkerCount(
    configuredWorkerCount: number
): number {
    return configuredWorkerCount === AUTO_TILE_SUBSET_RENDER_WORKER_COUNT
        ? getTileSubsetLayerRenderAutoWorkerCount()
        : Math.max(1, Math.min(WORKER_CAP, Math.trunc(configuredWorkerCount)));
}

export interface TileSubsetLayerRenderRequest {
    visualizationId: string;
    renderSignature: string;
    viewIndex: number;
    renderKey: string;
    mapTileKey: string;
    tileId: number;
    coordinateOrigin: [number, number, number];
    sceneGeneration: number;
    packetSequence: number;
    iconCatalogVersion: number;
    originSlot: number;
    originKeyLow: number;
    originKeyHigh: number;
    contribution: TileSubsetGpuContribution;
    mapId: string;
    catalogRevision: number;
    dataSourceInfoBlob: Uint8Array;
    stringPoolId: string;
    fieldDictBlob: Uint8Array;
    subsetBlob: Uint8Array;
    inputGeometryVertexCount: number;
    styleKey: string;
    styleSource: string;
    highlightModeValue: number;
    fidelityValue: number;
    lineSimplificationToleranceMeters: number;
}

interface PendingRender {
    task: TileSubsetLayerRenderTask;
    admit: (packet: Uint8Array) => void;
    resolve: (value: TileSubsetLayerRenderBuffers) => void;
    reject: (reason?: unknown) => void;
    queuedAt: number;
    dispatchedAt?: number;
}

interface ReadyRender {
    workerIndex: number;
    pending: PendingRender;
    buffers: TileSubsetLayerRenderBuffers;
    nativeMs: number;
    roundTripMs: number;
    nextPacketIndex: number;
}

export interface TileSubsetLayerRenderDebugSnapshot {
    workers: number;
    allocatedWorkers: number;
    idleWorkers: number;
    queued: number;
    queuedTiles: number;
    inFlight: number;
    inFlightTiles: number;
    ready: number;
    readyTiles: number;
    readyPacketBytes: number;
    maxReadyPacketBytes: number;
    completed: number;
    completedTiles: number;
    failed: number;
    stale: number;
    queuedGeometryVertices: number;
    inFlightGeometryVertices: number;
    latestGeometryVertices: number;
    maxGeometryVertices: number;
    latestRoundTripMs: number;
    latestNativeMs: number;
    averageRoundTripMs: number;
    averageNativeMs: number;
    averageNativeMsPerTile: number;
    maxRoundTripMs: number;
    maxNativeMs: number;
    oldestQueuedMs: number;
    oldestInFlightMs: number;
}

/** Aggregate of the live persistent GPU scenes across all views. */
export interface DeckPresentationDebugSnapshot {
    views: number;
    layers: number;
    materials: number;
    activeContributions: number;
    activeOrigins: number;
    pickingHighWater: number;
    pickingFragmentation: number;
    zIndexHighWater: number;
    maxZIndexUpdateMs: number;
    labels: number;
    stores: number;
    capacityRecords: number;
    highWaterRecords: number;
    fragmentedRecords: number;
    allocatedBytes: number;
    uploadedBytes: number;
    uploadCount: number;
    growthCount: number;
}

/** Signals expected supersession without reporting a renderer failure to users. */
export class StaleSubsetRenderError extends Error {
    /** Describe the single benign cancellation condition shared by all callers. */
    constructor() {
        super("A newer render input replaced this TileSubsetLayer render.");
    }
}

/**
 * Global finite worker service for immutable TileSubsetLayer rendering.
 *
 * It owns worker concurrency and latest-job rejection only. Subsets,
 * visualizations, view state, and Deck layers remain consumer-owned.
 */
@Injectable({providedIn: "root"})
export class TileSubsetLayerRenderService {
    /** Fires after worker progress may have made another render slot available. */
    readonly capacityChanged = new Subject<void>();
    private readonly workers: Array<Worker | null> = [];
    private readonly idleWorkers: number[] = [];
    private readonly runningTaskIdByWorker: Array<string | null> = [];
    private readonly catalogKeysByWorker: Array<Set<string>> = [];
    private readonly fieldDictSizesByWorker:
        Array<Map<string, number>> = [];
    private readonly styleKeysByWorker: Array<Set<string>> = [];
    private readonly iconCatalogVersionByWorker: number[] = [];
    private readonly queue: PendingRender[] = [];
    private readonly inFlight = new Map<string, PendingRender>();
    private readonly ready: ReadyRender[] = [];
    private readonly latestSignatureByVisualization = new Map<string, string>();
    private initialization: Promise<void> = Promise.resolve();
    private nextTaskId = 0;
    private latestNativeRenderMs = 0;
    private readonly deckFrameIntervalsMsByView = new Map<number, number[]>();
    private readonly deckPresentationByView = new Map<number, () => {
        layers: number;
        scene: GpuSceneSnapshot;
    }>();
    private completedTaskCount = 0;
    private completedTileCount = 0;
    private failedTaskCount = 0;
    private staleTaskCount = 0;
    private totalRoundTripMs = 0;
    private totalNativeMs = 0;
    private latestRoundTripMs = 0;
    private maxRoundTripMs = 0;
    private maxNativeMs = 0;
    private maxReadyPacketBytes = 0;
    private admissionTimer: ReturnType<typeof setTimeout> | null = null;
    private latestGeometryVertices = 0;
    private maxGeometryVertices = 0;

    /** Track runtime worker-count changes when application state is available. */
    constructor(
        @Optional()
        private readonly appState: AppStateService | null = null
    ) {
        if (!appState) {
            return;
        }
        appState.tileSubsetRenderWorkerCountState.pipe(skip(1)).subscribe(() => {
            this.ensureWorkers()
                .then(() => {
                    this.capacityChanged.next();
                    return this.pump();
                })
                .catch(error =>
                    console.error("Could not resize subset render workers.", error)
                );
        });
    }

    /** Return the currently configured worker-credit ceiling. */
    activeWorkerCount(): number {
        return resolveTileSubsetLayerRenderWorkerCount(
            this.appState?.tileSubsetRenderWorkerCount ??
                AUTO_TILE_SUBSET_RENDER_WORKER_COUNT
        );
    }

    /** Count jobs which have worker credit, including queued and executing work. */
    visualizationQueueLength(): number {
        return this.queue.length + this.inFlight.size;
    }

    /** Return whether one view still owns queued, running, or admission-ready work. */
    hasPendingWork(viewIndex: number): boolean {
        return this.queue.some(pending => pending.task.viewIndex === viewIndex) ||
            [...this.inFlight.values()].some(
                pending => pending.task.viewIndex === viewIndex
            );
    }

    /** Number of tile renders accepted without building a hidden queue. */
    availableWorkerSlots(): number {
        return Math.max(
            0,
            this.activeWorkerCount() -
                this.queue.length -
                this.inFlight.size
        );
    }

    /** Return the worst per-view rolling p90 frame interval used by diagnostics. */
    currentFrameTimeMs(): number {
        return Math.max(
            0,
            ...[...this.deckFrameIntervalsMsByView.values()]
                .map(samples => {
                    if (!samples.length) {
                        return 0;
                    }
                    const ordered = [...samples].sort((left, right) => left - right);
                    return ordered[Math.ceil(ordered.length * 0.9) - 1] ?? 0;
                })
        );
    }

    /** Records one visible Deck frame interval for cadence diagnostics. */
    recordDeckFrameTime(viewIndex: number, milliseconds: number): void {
        if (Number.isFinite(milliseconds) && milliseconds >= 0) {
            const samples = this.deckFrameIntervalsMsByView.get(viewIndex) ?? [];
            samples.push(milliseconds);
            if (samples.length > 30) {
                samples.splice(0, samples.length - 30);
            }
            this.deckFrameIntervalsMsByView.set(viewIndex, samples);
        }
    }

    /** Removes the last Deck timing when its logical view is destroyed. */
    clearDeckFrameTime(viewIndex: number): void {
        this.deckFrameIntervalsMsByView.delete(viewIndex);
    }

    /** Registers an on-demand scene snapshot provider for one live Deck view. */
    setDeckPresentationDiagnosticsProvider(
        viewIndex: number,
        provider: () => {layers: number; scene: GpuSceneSnapshot}
    ): void {
        this.deckPresentationByView.set(viewIndex, provider);
    }

    /** Removes presentation counters when their logical view is destroyed. */
    clearDeckPresentationDiagnostics(viewIndex: number): void {
        this.deckPresentationByView.delete(viewIndex);
    }

    /** Sum per-view scene and store counters without inspecting GPU memory. */
    currentDeckPresentationDiagnostics(): DeckPresentationDebugSnapshot {
        const result: DeckPresentationDebugSnapshot = {
            views: this.deckPresentationByView.size,
            layers: 0,
            materials: 0,
            activeContributions: 0,
            activeOrigins: 0,
            pickingHighWater: 0,
            pickingFragmentation: 0,
            zIndexHighWater: 0,
            maxZIndexUpdateMs: 0,
            labels: 0,
            stores: 0,
            capacityRecords: 0,
            highWaterRecords: 0,
            fragmentedRecords: 0,
            allocatedBytes: 0,
            uploadedBytes: 0,
            uploadCount: 0,
            growthCount: 0
        };
        for (const provider of this.deckPresentationByView.values()) {
            const {layers, scene} = provider();
            result.layers += layers;
            result.materials += scene.materialCount;
            result.activeContributions += scene.activeContributionCount;
            result.activeOrigins += scene.activeOriginCount;
            result.pickingHighWater += scene.pickingHighWater;
            result.pickingFragmentation += scene.pickingFragmentation;
            result.zIndexHighWater += scene.zIndexHighWater;
            result.maxZIndexUpdateMs = Math.max(
                result.maxZIndexUpdateMs,
                scene.zIndexUpdateMs
            );
            result.labels += scene.labels;
            result.stores += scene.stores.length;
            for (const store of scene.stores) {
                result.capacityRecords += store.capacityRecords;
                result.highWaterRecords += store.highWaterRecords;
                result.fragmentedRecords += store.fragmentedRecords;
                result.allocatedBytes += store.allocatedBytes;
                result.uploadedBytes += store.uploadedBytes;
                result.uploadCount += store.uploadCount;
                result.growthCount += store.growthCount;
            }
        }
        return result;
    }

    /** Capture queue, worker, packet, and timing state for diagnostics. */
    debugSnapshot(): TileSubsetLayerRenderDebugSnapshot {
        const now = performance.now();
        const dispatched = [...this.inFlight.values()]
            .map(pending => pending.dispatchedAt)
            .filter((value): value is number => value !== undefined);
        return {
            workers: this.activeWorkerCount(),
            allocatedWorkers: this.workers.length,
            idleWorkers: this.idleWorkers.filter(
                index => index < this.activeWorkerCount()
            ).length,
            queued: this.queue.length,
            queuedTiles: this.queue.length,
            inFlight: this.inFlight.size,
            inFlightTiles: this.inFlight.size,
            ready: this.ready.length,
            readyTiles: this.ready.length,
            readyPacketBytes: this.ready.reduce(
                (sum, item) => sum + item.buffers.packets
                    .slice(item.nextPacketIndex)
                    .reduce((packetSum, packet) =>
                        packetSum + packet.byteLength, 0),
                0
            ),
            maxReadyPacketBytes: this.maxReadyPacketBytes,
            completed: this.completedTaskCount,
            completedTiles: this.completedTileCount,
            failed: this.failedTaskCount,
            stale: this.staleTaskCount,
            queuedGeometryVertices: this.queue.reduce(
                (sum, pending) =>
                    sum + pending.task.inputGeometryVertexCount,
                0
            ),
            inFlightGeometryVertices: [...this.inFlight.values()].reduce(
                (sum, pending) =>
                    sum + pending.task.inputGeometryVertexCount,
                0
            ),
            latestGeometryVertices: this.latestGeometryVertices,
            maxGeometryVertices: this.maxGeometryVertices,
            latestRoundTripMs: this.latestRoundTripMs,
            latestNativeMs: this.latestNativeRenderMs,
            averageRoundTripMs: this.completedTaskCount
                ? this.totalRoundTripMs / this.completedTaskCount
                : 0,
            averageNativeMs: this.completedTaskCount
                ? this.totalNativeMs / this.completedTaskCount
                : 0,
            averageNativeMsPerTile: this.completedTileCount
                ? this.totalNativeMs / this.completedTileCount
                : 0,
            maxRoundTripMs: this.maxRoundTripMs,
            maxNativeMs: this.maxNativeMs,
            oldestQueuedMs: this.queue.length
                ? now - Math.min(...this.queue.map(pending => pending.queuedAt))
                : 0,
            oldestInFlightMs: dispatched.length
                ? now - Math.min(...dispatched)
                : 0
        };
    }

    /**
     * Render one tile and install its vector packet through the task-budgeted
     * admission callback before resolving the result promise.
     */
    render(
        request: TileSubsetLayerRenderRequest,
        admit: (packet: Uint8Array) => void = () => undefined
    ): Promise<TileSubsetLayerRenderBuffers> {
        this.latestSignatureByVisualization.set(
            request.visualizationId,
            request.renderSignature
        );
        this.dropReplacedQueuedJobs(request.visualizationId);
        const task: TileSubsetLayerRenderTask = {
            type: "TileSubsetLayerRenderTask",
            taskId: `subset-render-${++this.nextTaskId}`,
            ...request
        };
        return new Promise<TileSubsetLayerRenderBuffers>((resolve, reject) => {
            this.queue.push({
                task,
                admit,
                resolve,
                reject,
                queuedAt: performance.now()
            });
            this.pump().catch(error => this.rejectQueuedTask(task.taskId, error));
        });
    }

    /** Cancel queued work and stale any in-flight result for one visualization. */
    cancel(visualizationId: string): void {
        this.latestSignatureByVisualization.delete(visualizationId);
        this.dropReplacedQueuedJobs(visualizationId, true);
    }

    /** Reject obsolete queued revisions without disturbing unrelated tile jobs. */
    private dropReplacedQueuedJobs(visualizationId: string, cancelAll = false): void {
        for (let index = this.queue.length - 1; index >= 0; --index) {
            const pending = this.queue[index];
            if (pending.task.visualizationId !== visualizationId) {
                continue;
            }
            if (!cancelAll && pending.task.renderSignature ===
                this.latestSignatureByVisualization.get(visualizationId)) {
                continue;
            }
            this.queue.splice(index, 1);
            this.staleTaskCount += 1;
            pending.reject(new StaleSubsetRenderError());
        }
    }

    /** Dispatch singleton tile jobs while worker and caller credits remain. */
    private async pump(): Promise<void> {
        await this.ensureWorkers();
        const activeLimit = this.activeWorkerCount();
        while (this.queue.length &&
            this.inFlight.size < activeLimit) {
            const workerIndex = this.takeIdleWorker(activeLimit);
            if (workerIndex === undefined) {
                break;
            }
            const pending = this.queue.shift()!;
            if (!this.isCurrent(pending.task)) {
                this.staleTaskCount += 1;
                pending.reject(new StaleSubsetRenderError());
                this.idleWorkers.push(workerIndex);
                continue;
            }
            pending.dispatchedAt = performance.now();
            this.inFlight.set(pending.task.taskId, pending);
            this.runningTaskIdByWorker[workerIndex] = pending.task.taskId;
            const catalogKey =
                `${pending.task.catalogRevision}:${pending.task.mapId}`;
            const knownCatalogs =
                this.catalogKeysByWorker[workerIndex];
            const knownFieldDicts =
                this.fieldDictSizesByWorker[workerIndex];
            const knownStyles =
                this.styleKeysByWorker[workerIndex];
            const needsCatalog = !knownCatalogs.has(catalogKey);
            const fieldDictKey =
                `${catalogKey}:${pending.task.stringPoolId}`;
            const fieldDictSize =
                pending.task.fieldDictBlob?.byteLength ?? 0;
            const needsFieldDict =
                knownFieldDicts.get(fieldDictKey) !==
                fieldDictSize;
            const needsStyle =
                !knownStyles.has(pending.task.styleKey);
            const needsIconCatalog =
                this.iconCatalogVersionByWorker[workerIndex] !==
                pending.task.iconCatalogVersion;
            // Keep the retained tile bytes usable for style changes and
            // context recovery. Structured clone performs the unavoidable
            // worker copy natively; an explicit JS slice here only added a
            // second geometry-sized allocation on the interaction thread.
            const subsetBlob = pending.task.subsetBlob;
            const dataSourceInfoBlob = needsCatalog
                ? pending.task.dataSourceInfoBlob?.slice()
                : undefined;
            const fieldDictBlob = needsFieldDict
                ? pending.task.fieldDictBlob?.slice()
                : undefined;
            const styleSource = needsStyle
                ? pending.task.styleSource
                : undefined;
            const outbound: TileSubsetLayerRenderTask = {
                ...pending.task,
                subsetBlob,
                dataSourceInfoBlob,
                fieldDictBlob,
                styleSource,
                iconCatalogEntries: needsIconCatalog
                    ? gpuIconAtlasService.catalogEntries().map(entry => ({
                        uri: entry.uri,
                        atlasPage: entry.atlasPage,
                        uv: entry.uv,
                        pixelSize: entry.pixelSize
                    }))
                    : undefined
            };
            const transferables: ArrayBuffer[] = [];
            if (dataSourceInfoBlob) {
                transferables.push(dataSourceInfoBlob.buffer);
            }
            if (fieldDictBlob) {
                transferables.push(fieldDictBlob.buffer);
            }
            const worker = this.workers[workerIndex];
            if (!worker) {
                this.failDispatch(
                    workerIndex,
                    pending,
                    new Error("Subset render worker is unavailable.")
                );
                continue;
            }
            try {
                worker.postMessage(outbound, transferables);
            } catch (error) {
                this.failDispatch(workerIndex, pending, error);
            }
        }
    }

    /** Test whether a result still belongs to the latest visualization revision. */
    private isCurrent(task: TileSubsetLayerRenderTask): boolean {
        return this.latestSignatureByVisualization.get(task.visualizationId) ===
            task.renderSignature;
    }

    /** Lazily grow the initialized worker prefix to the configured count. */
    private ensureWorkers(): Promise<void> {
        const targetCount = this.activeWorkerCount();
        if (Array.from(
            {length: targetCount},
            (_, index) => this.workers[index]
        ).some(worker => !worker)) {
            this.initialization = this.initialization
                .catch(() => undefined)
                .then(() => this.initializeWorkers(targetCount));
        }
        return this.initialization;
    }

    /** Initialize missing workers concurrently while preserving stable indices. */
    private async initializeWorkers(targetCount: number): Promise<void> {
        const missing = Array.from(
            {length: targetCount},
            (_, index) => index
        ).filter(index => !this.workers[index]);
        await Promise.all(missing.map(index => this.initializeWorker(index)));
    }

    /** Creates one worker and publishes it only after its WASM handshake succeeds. */
    private async initializeWorker(index: number): Promise<void> {
        const worker = new Worker(
            new URL("./tile-subset-layer-render.worker", import.meta.url),
            {type: "module"}
        );
        try {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error(
                        "Timed out initializing a subset render worker."
                    )),
                    10_000
                );
                const onMessage = (
                    event: MessageEvent<TileSubsetLayerRenderWorkerOutbound>
                ) => {
                    if (event.data.type !== "TileSubsetLayerRenderWorkerReady") {
                        return;
                    }
                    clearTimeout(timeout);
                    worker.removeEventListener("message", onMessage);
                    worker.removeEventListener("error", onError);
                    resolve();
                };
                const onError = (error: ErrorEvent) => {
                    clearTimeout(timeout);
                    worker.removeEventListener("message", onMessage);
                    reject(error);
                };
                worker.addEventListener("message", onMessage);
                worker.addEventListener("error", onError, {once: true});
                worker.postMessage({type: "TileSubsetLayerRenderWorkerInit"});
            });
        } catch (error) {
            worker.terminate();
            throw error;
        }
        worker.onmessage = event => this.handleResult(
            index,
            event.data as TileSubsetLayerRenderResult
        );
        worker.onerror = event => this.handleWorkerError(index, event);
        this.workers[index] = worker;
        this.resetWorkerState(index);
        this.idleWorkers.push(index);
    }

    /** Takes one idle worker which is inside the current active prefix. */
    private takeIdleWorker(activeLimit: number): number | undefined {
        const idleIndex = this.idleWorkers.findIndex(
            workerIndex => workerIndex < activeLimit
        );
        if (idleIndex < 0) {
            return undefined;
        }
        return this.idleWorkers.splice(idleIndex, 1)[0];
    }

    /** Validate a worker response and queue its fragments for scene admission. */
    private handleResult(workerIndex: number, result: TileSubsetLayerRenderResult): void {
        const runningTaskId = this.runningTaskIdByWorker[workerIndex];
        if (!runningTaskId) {
            return;
        }
        const pending = this.inFlight.get(runningTaskId);
        if (!pending) {
            this.releaseWorker(workerIndex, runningTaskId);
            return;
        }
        if (result.type !== "TileSubsetLayerRenderResult" ||
            result.taskId !== runningTaskId ||
            result.visualizationId !== pending.task.visualizationId ||
            result.renderSignature !== pending.task.renderSignature) {
            this.failedTaskCount += 1;
            pending.reject(new Error(
                "Subset render worker returned a result for a different task."
            ));
            this.releaseWorker(workerIndex, runningTaskId);
            return;
        }
        const nativeMs = Number(result.timings?.totalMs ?? 0);
        const roundTripMs = pending.dispatchedAt === undefined
            ? nativeMs
            : performance.now() - pending.dispatchedAt;
        this.latestRoundTripMs = roundTripMs;
        this.maxRoundTripMs = Math.max(this.maxRoundTripMs, roundTripMs);
        this.maxNativeMs = Math.max(this.maxNativeMs, nativeMs);
        if (!this.isCurrent(pending.task)) {
            this.staleTaskCount += 1;
            pending.reject(new StaleSubsetRenderError());
            this.releaseWorker(workerIndex, pending.task.taskId);
            return;
        }
        if (result.error) {
            this.failedTaskCount += 1;
            pending.reject(new Error(result.error));
            this.releaseWorker(workerIndex, pending.task.taskId);
            return;
        }
        if (!result.packets || !result.packets.length ||
            result.packets.length > GPU_RENDER_PACKET_MAX_FRAGMENTS ||
            result.packets.some(packet =>
                !(packet instanceof Uint8Array) ||
                packet.byteLength === 0 ||
                packet.byteLength > GPU_RENDER_PACKET_MAX_BYTES
            ) ||
            !result.bridge || !result.timings ||
            result.vertexCount === undefined) {
            this.failedTaskCount += 1;
            pending.reject(new Error(
                "Subset render worker returned an incomplete GPU packet."
            ));
            this.releaseWorker(workerIndex, pending.task.taskId);
            return;
        }
        this.recordWorkerCaches(workerIndex, pending.task);
        this.ready.push({
            workerIndex,
            pending,
            buffers: {
                packets: result.packets,
                bridge: result.bridge,
                vertexCount: result.vertexCount,
                timings: result.timings
            },
            nativeMs,
            roundTripMs,
            nextPacketIndex: 0
        });
        this.maxReadyPacketBytes = Math.max(
            this.maxReadyPacketBytes,
            this.ready.reduce(
                (sum, item) => sum + item.buffers.packets.reduce(
                    (packetSum, packet) => packetSum + packet.byteLength,
                    0
                ),
                0
            )
        );
        this.scheduleAdmission();
    }

    /**
     * Admit a byte- and time-bounded batch independently of browser rendering.
     *
     * Tying uploads to requestAnimationFrame alternated every small packet batch
     * with a full draw of the growing scene. Chrome then synchronized writes to
     * buffers used by the preceding draw, starving workers and exposing tile-row
     * snapshots for seconds. A short task keeps uploads cooperative without
     * making scene admission wait for (or implicitly request) a render frame.
     */
    private scheduleAdmission(): void {
        if (this.admissionTimer !== null || !this.ready.length) {
            return;
        }
        this.admissionTimer = setTimeout(() => {
            this.admissionTimer = null;
            const startedAt = performance.now();
            let admittedPackets = 0;
            let admittedBytes = 0;
            while (this.ready.length &&
                admittedPackets < MAX_ADMISSION_PACKETS_PER_TASK) {
                const next = this.ready[0];
                const packet = next.buffers.packets[next.nextPacketIndex];
                const packetBytes = packet.byteLength;
                if (admittedPackets > 0 &&
                    admittedBytes + packetBytes >
                        MAX_ADMISSION_BYTES_PER_TASK) {
                    break;
                }
                this.ready.shift();
                const complete = this.admit(next, packet);
                if (!complete) {
                    this.ready.push(next);
                }
                admittedPackets += 1;
                admittedBytes += packetBytes;
                if (performance.now() - startedAt >= MAX_ADMISSION_TIME_MS) {
                    break;
                }
            }
            this.scheduleAdmission();
        }, 0);
    }

    /** Admit one fragment and resolve only after the complete revision is staged. */
    private admit(ready: ReadyRender, packet: Uint8Array): boolean {
        const {pending, buffers, nativeMs, roundTripMs, workerIndex} = ready;
        if (!this.isCurrent(pending.task)) {
            this.staleTaskCount += 1;
            pending.reject(new StaleSubsetRenderError());
            this.releaseWorker(workerIndex, pending.task.taskId);
            return true;
        }
        try {
            pending.admit(packet);
        } catch (error) {
            if (error instanceof StaleSubsetRenderError) {
                this.staleTaskCount += 1;
            } else {
                this.failedTaskCount += 1;
            }
            pending.reject(error);
            this.releaseWorker(workerIndex, pending.task.taskId);
            return true;
        }
        ready.nextPacketIndex += 1;
        if (ready.nextPacketIndex < buffers.packets.length) {
            return false;
        }
        this.latestNativeRenderMs = Number.isFinite(buffers.timings.totalMs)
            ? buffers.timings.totalMs
            : 0;
        this.completedTaskCount += 1;
        this.completedTileCount += 1;
        this.totalRoundTripMs += roundTripMs;
        this.totalNativeMs += nativeMs;
        const geometryVertices = pending.task.inputGeometryVertexCount;
        this.latestGeometryVertices = geometryVertices;
        this.maxGeometryVertices = Math.max(
            this.maxGeometryVertices,
            geometryVertices
        );
        pending.resolve(buffers);
        this.releaseWorker(workerIndex, pending.task.taskId);
        return true;
    }

    /** Release one worker only after its transferred packet is admitted or rejected. */
    private releaseWorker(workerIndex: number, taskId: string): void {
        this.inFlight.delete(taskId);
        this.runningTaskIdByWorker[workerIndex] = null;
        if (this.workers[workerIndex]) {
            this.idleWorkers.push(workerIndex);
        }
        this.pump()
            .then(() => this.capacityChanged.next())
            .catch(error => console.error("Subset render queue failed.", error));
    }

    /** Retire a failed worker, reject its task, and recreate the slot on demand. */
    private handleWorkerError(workerIndex: number, event: ErrorEvent): void {
        const worker = this.workers[workerIndex];
        if (!worker) {
            return;
        }
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        this.workers[workerIndex] = null;
        this.removeIdleWorker(workerIndex);
        const taskId = this.runningTaskIdByWorker[workerIndex];
        this.runningTaskIdByWorker[workerIndex] = null;
        const pending = taskId ? this.inFlight.get(taskId) : undefined;
        const failure = new Error(
            event.message || "Subset render worker failed."
        );
        if (pending) {
            this.inFlight.delete(pending.task.taskId);
            this.failedTaskCount += 1;
            pending.reject(failure);
        }
        for (let index = this.ready.length - 1; index >= 0; --index) {
            const ready = this.ready[index];
            if (ready.workerIndex !== workerIndex) {
                continue;
            }
            this.ready.splice(index, 1);
            this.inFlight.delete(ready.pending.task.taskId);
            if (ready.pending !== pending) {
                this.failedTaskCount += 1;
                ready.pending.reject(failure);
            }
        }
        this.resetWorkerState(workerIndex);
        this.initialization = this.initialization
            .catch(() => undefined)
            .then(() => this.initializeWorker(workerIndex));
        this.initialization.then(() => this.pump())
            .then(() => this.capacityChanged.next())
            .catch(error => console.error(
                "Could not replace subset render worker.",
                error
            ));
    }

    /** Commits cache knowledge only after a worker returned a complete packet. */
    private recordWorkerCaches(
        workerIndex: number,
        task: TileSubsetLayerRenderTask
    ): void {
        const catalogKey = `${task.catalogRevision}:${task.mapId}`;
        this.catalogKeysByWorker[workerIndex].add(catalogKey);
        this.fieldDictSizesByWorker[workerIndex].set(
            `${catalogKey}:${task.stringPoolId}`,
            task.fieldDictBlob?.byteLength ?? 0
        );
        this.styleKeysByWorker[workerIndex].add(task.styleKey);
        this.iconCatalogVersionByWorker[workerIndex] = task.iconCatalogVersion;
    }

    /** Rejects a synchronous dispatch failure and immediately returns its credit. */
    private failDispatch(
        workerIndex: number,
        pending: PendingRender,
        reason: unknown
    ): void {
        this.inFlight.delete(pending.task.taskId);
        this.runningTaskIdByWorker[workerIndex] = null;
        this.failedTaskCount += 1;
        pending.reject(reason instanceof Error ? reason : new Error(String(reason)));
        if (this.workers[workerIndex]) {
            this.idleWorkers.push(workerIndex);
        }
    }

    /** Rejects one task whose worker initialization failed before dispatch. */
    private rejectQueuedTask(taskId: string, reason: unknown): void {
        const index = this.queue.findIndex(
            pending => pending.task.taskId === taskId
        );
        if (index < 0) {
            return;
        }
        const [pending] = this.queue.splice(index, 1);
        this.failedTaskCount += 1;
        pending.reject(reason instanceof Error ? reason : new Error(String(reason)));
        this.capacityChanged.next();
    }

    /** Clears all state which describes the private memory of one worker. */
    private resetWorkerState(workerIndex: number): void {
        this.runningTaskIdByWorker[workerIndex] = null;
        this.catalogKeysByWorker[workerIndex] = new Set<string>();
        this.fieldDictSizesByWorker[workerIndex] = new Map<string, number>();
        this.styleKeysByWorker[workerIndex] = new Set<string>();
        this.iconCatalogVersionByWorker[workerIndex] = -1;
    }

    /** Removes every stale idle credit for a worker being replaced. */
    private removeIdleWorker(workerIndex: number): void {
        for (let index = this.idleWorkers.length - 1; index >= 0; --index) {
            if (this.idleWorkers[index] === workerIndex) {
                this.idleWorkers.splice(index, 1);
            }
        }
    }
}
