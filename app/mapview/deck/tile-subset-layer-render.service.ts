import {Injectable, Optional} from "@angular/core";
import {skip, Subject} from "rxjs";
import {AppStateService} from "../../shared/appstate.service";
import {
    AUTO_TILE_SUBSET_RENDER_WORKER_COUNT,
    DEFAULT_RENDER_BLOCK_VERTEX_LIMIT
} from "../../shared/tile-render-policy";
import type {
    TileSubsetLayerRenderBuffers,
    TileSubsetLayerRenderResult,
    TileSubsetLayerRenderTask,
    TileSubsetLayerRenderWorkerOutbound
} from "./tile-subset-layer-render.worker.protocol";

const AUTO_WORKER_MIN = 2;
const AUTO_WORKER_FALLBACK_CPU_COUNT = 4;
const WORKER_CAP = 32;
const RESULT_WAVE_MAX_WAIT_MS = 200;
const RESULT_WAVE_WORKER_MULTIPLIER = 2;

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

export type TileSubsetLayerRenderPolicyChange =
    "workers" | "debug-blocks" | "block-vertex-limit";

export interface TileSubsetLayerRenderRequest {
    visualizationId: string;
    renderSignature: string;
    viewIndex: number;
    blockKey: string;
    mapTileKeys: string[];
    tileIds: number[];
    coordinateOrigin: [number, number, number];
    mapId: string;
    catalogRevision: number;
    dataSourceInfoBlob: Uint8Array;
    stringPoolId: string;
    fieldDictBlob: Uint8Array;
    subsetBlobs: Uint8Array[];
    inputGeometryVertexCount: number;
    styleKey: string;
    styleSource: string;
    highlightModeValue: number;
    fidelityValue: number;
}

interface PendingRender {
    task: TileSubsetLayerRenderTask;
    resolve: (value: TileSubsetLayerRenderBuffers) => void;
    reject: (reason?: unknown) => void;
    queuedAt: number;
    dispatchedAt?: number;
}

interface ReadyRender {
    pending: PendingRender;
    buffers: TileSubsetLayerRenderBuffers;
    completedAt: number;
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
    completed: number;
    completedTiles: number;
    released: number;
    releaseBatches: number;
    failed: number;
    stale: number;
    latestBlockTiles: number;
    maxBlockTiles: number;
    queuedGeometryVertices: number;
    inFlightGeometryVertices: number;
    readyGeometryVertices: number;
    latestBlockGeometryVertices: number;
    maxBlockGeometryVertices: number;
    maxAggregateGeometryVertices: number;
    blockSizeHistogram: Record<string, number>;
    latestRoundTripMs: number;
    latestNativeMs: number;
    averageRoundTripMs: number;
    averageNativeMs: number;
    averageNativeMsPerTile: number;
    maxRoundTripMs: number;
    maxNativeMs: number;
    oldestQueuedMs: number;
    oldestInFlightMs: number;
    oldestReadyMs: number;
}

export class StaleSubsetRenderError extends Error {
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
    /** Fires when a live render/block presentation preference changes. */
    readonly policyChanged = new Subject<TileSubsetLayerRenderPolicyChange>();
    private readonly workers: Worker[] = [];
    private readonly idleWorkers: number[] = [];
    private readonly runningTaskIdByWorker: Array<string | null> = [];
    private readonly catalogKeysByWorker: Array<Set<string>> = [];
    private readonly fieldDictSizesByWorker:
        Array<Map<string, number>> = [];
    private readonly styleKeysByWorker: Array<Set<string>> = [];
    private readonly queue: PendingRender[] = [];
    private readonly inFlight = new Map<string, PendingRender>();
    private readonly ready: ReadyRender[] = [];
    private readyReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly latestSignatureByVisualization = new Map<string, string>();
    private initialization: Promise<void> = Promise.resolve();
    private nextTaskId = 0;
    private latestNativeRenderMs = 0;
    private readonly deckFrameIntervalsMsByView = new Map<number, number[]>();
    private completedTaskCount = 0;
    private completedTileCount = 0;
    private releasedTaskCount = 0;
    private releaseBatchCount = 0;
    private failedTaskCount = 0;
    private staleTaskCount = 0;
    private totalRoundTripMs = 0;
    private totalNativeMs = 0;
    private latestRoundTripMs = 0;
    private maxRoundTripMs = 0;
    private maxNativeMs = 0;
    private latestBlockTiles = 0;
    private maxBlockTiles = 0;
    private latestBlockGeometryVertices = 0;
    private maxBlockGeometryVertices = 0;
    private maxAggregateGeometryVertices = 0;
    private readonly completedBlocksByTileCount = new Map<number, number>();

    constructor(
        @Optional()
        private readonly appState: AppStateService | null = null
    ) {
        if (!appState) {
            return;
        }
        appState.tileSubsetRenderWorkerCountState.pipe(skip(1)).subscribe(() => {
            this.policyChanged.next("workers");
            this.ensureWorkers()
                .then(() => {
                    this.capacityChanged.next();
                    return this.pump();
                })
                .catch(error =>
                    console.error("Could not resize subset render workers.", error)
                );
        });
        appState.debugRenderBlocksState.pipe(skip(1)).subscribe(() =>
            this.policyChanged.next("debug-blocks")
        );
        appState.renderBlockVertexLimitState.pipe(skip(1)).subscribe(() =>
            this.policyChanged.next("block-vertex-limit")
        );
    }

    activeWorkerCount(): number {
        return resolveTileSubsetLayerRenderWorkerCount(
            this.appState?.tileSubsetRenderWorkerCount ??
                AUTO_TILE_SUBSET_RENDER_WORKER_COUNT
        );
    }

    blockVertexLimit(): number {
        return this.appState?.renderBlockVertexLimit ??
            DEFAULT_RENDER_BLOCK_VERTEX_LIMIT;
    }

    debugRenderBlocksEnabled(): boolean {
        return this.appState?.debugRenderBlocks ?? false;
    }

    visualizationQueueLength(): number {
        return this.queue.length + this.inFlight.size + this.ready.length;
    }

    /** Number of block renders which can be accepted without building a hidden queue. */
    availableWorkerSlots(): number {
        return Math.max(
            0,
            this.activeWorkerCount() -
                this.queue.length -
                this.inFlight.size
        );
    }

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
            queuedTiles: this.queue.reduce(
                (sum, pending) => sum + pending.task.tileIds.length,
                0
            ),
            inFlight: this.inFlight.size,
            inFlightTiles: [...this.inFlight.values()].reduce(
                (sum, pending) => sum + pending.task.tileIds.length,
                0
            ),
            ready: this.ready.length,
            readyTiles: this.ready.reduce(
                (sum, item) => sum + item.pending.task.tileIds.length,
                0
            ),
            completed: this.completedTaskCount,
            completedTiles: this.completedTileCount,
            released: this.releasedTaskCount,
            releaseBatches: this.releaseBatchCount,
            failed: this.failedTaskCount,
            stale: this.staleTaskCount,
            latestBlockTiles: this.latestBlockTiles,
            maxBlockTiles: this.maxBlockTiles,
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
            readyGeometryVertices: this.ready.reduce(
                (sum, item) =>
                    sum + item.pending.task.inputGeometryVertexCount,
                0
            ),
            latestBlockGeometryVertices:
                this.latestBlockGeometryVertices,
            maxBlockGeometryVertices:
                this.maxBlockGeometryVertices,
            maxAggregateGeometryVertices:
                this.maxAggregateGeometryVertices,
            blockSizeHistogram: Object.fromEntries(
                [...this.completedBlocksByTileCount.entries()]
                    .sort(([left], [right]) => left - right)
                    .map(([size, count]) => [String(size), count])
            ),
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
                : 0,
            oldestReadyMs: this.ready.length
                ? now - Math.min(...this.ready.map(item => item.completedAt))
                : 0
        };
    }

    render(request: TileSubsetLayerRenderRequest): Promise<TileSubsetLayerRenderBuffers> {
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
                resolve,
                reject,
                queuedAt: performance.now()
            });
            this.pump().catch(reject);
        });
    }

    cancel(visualizationId: string): void {
        this.latestSignatureByVisualization.delete(visualizationId);
        this.dropReplacedQueuedJobs(visualizationId, true);
    }

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
        for (let index = this.ready.length - 1; index >= 0; --index) {
            const item = this.ready[index];
            if (item.pending.task.visualizationId !== visualizationId) {
                continue;
            }
            if (!cancelAll && item.pending.task.renderSignature ===
                this.latestSignatureByVisualization.get(visualizationId)) {
                continue;
            }
            this.ready.splice(index, 1);
            this.staleTaskCount += 1;
            item.pending.reject(new StaleSubsetRenderError());
        }
        if (!this.ready.length && this.readyReleaseTimer !== null) {
            clearTimeout(this.readyReleaseTimer);
            this.readyReleaseTimer = null;
        }
    }

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
            const subsetBlobs = pending.task.subsetBlobs.map(
                subsetBlob => subsetBlob.slice()
            );
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
                subsetBlobs,
                dataSourceInfoBlob,
                fieldDictBlob,
                styleSource
            };
            const transferables: ArrayBuffer[] = subsetBlobs.map(
                subsetBlob => subsetBlob.buffer
            );
            if (dataSourceInfoBlob) {
                transferables.push(dataSourceInfoBlob.buffer);
            }
            if (fieldDictBlob) {
                transferables.push(fieldDictBlob.buffer);
            }
            this.workers[workerIndex].postMessage(
                outbound,
                transferables
            );
            if (needsCatalog) {
                knownCatalogs.add(catalogKey);
            }
            if (needsFieldDict) {
                knownFieldDicts.set(
                    fieldDictKey,
                    fieldDictSize
                );
            }
            if (needsStyle) {
                knownStyles.add(pending.task.styleKey);
            }
        }
    }

    private isCurrent(task: TileSubsetLayerRenderTask): boolean {
        return this.latestSignatureByVisualization.get(task.visualizationId) ===
            task.renderSignature;
    }

    private ensureWorkers(): Promise<void> {
        const targetCount = this.activeWorkerCount();
        if (this.workers.length < targetCount) {
            this.initialization = this.initialization.then(
                () => this.initializeWorkers(targetCount)
            );
        }
        return this.initialization;
    }

    private async initializeWorkers(targetCount: number): Promise<void> {
        const startIndex = this.workers.length;
        if (startIndex >= targetCount) {
            return;
        }
        await Promise.all(Array.from(
            {length: targetCount - startIndex},
            async (_, offset) => {
                const index = startIndex + offset;
                const worker = new Worker(
                    new URL("./tile-subset-layer-render.worker", import.meta.url),
                    {type: "module"}
                );
                await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(
                        () => reject(new Error("Timed out initializing a subset render worker.")),
                        10_000
                    );
                    const onMessage = (event: MessageEvent<TileSubsetLayerRenderWorkerOutbound>) => {
                        if (event.data.type !== "TileSubsetLayerRenderWorkerReady") {
                            return;
                        }
                        clearTimeout(timeout);
                        worker.removeEventListener("message", onMessage);
                        resolve();
                    };
                    worker.addEventListener("message", onMessage);
                    worker.addEventListener("error", error => reject(error), {once: true});
                    worker.postMessage({type: "TileSubsetLayerRenderWorkerInit"});
                });
                worker.onmessage = event => this.handleResult(
                    index,
                    event.data as TileSubsetLayerRenderResult
                );
                worker.onerror = event => this.handleWorkerError(index, event);
                this.workers[index] = worker;
                this.runningTaskIdByWorker[index] = null;
                this.catalogKeysByWorker[index] = new Set<string>();
                this.fieldDictSizesByWorker[index] =
                    new Map<string, number>();
                this.styleKeysByWorker[index] = new Set<string>();
                this.idleWorkers.push(index);
            }
        ));
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

    private handleResult(workerIndex: number, result: TileSubsetLayerRenderResult): void {
        const pending = this.inFlight.get(result.taskId);
        this.inFlight.delete(result.taskId);
        this.runningTaskIdByWorker[workerIndex] = null;
        this.idleWorkers.push(workerIndex);
        if (pending) {
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
            } else if (result.error) {
                this.failedTaskCount += 1;
                pending.reject(new Error(result.error));
            } else {
                const {
                    type: _type,
                    taskId: _taskId,
                    visualizationId: _visualizationId,
                    renderSignature: _renderSignature,
                    error: _error,
                    ...buffers
                } = result;
                this.latestNativeRenderMs = Number.isFinite(buffers.timings.totalMs)
                    ? buffers.timings.totalMs
                    : 0;
                const blockTiles = Math.max(1, pending.task.tileIds.length);
                this.completedTaskCount += 1;
                this.completedTileCount += blockTiles;
                this.totalRoundTripMs += roundTripMs;
                this.totalNativeMs += nativeMs;
                this.latestBlockTiles = blockTiles;
                this.maxBlockTiles = Math.max(this.maxBlockTiles, blockTiles);
                const geometryVertices =
                    pending.task.inputGeometryVertexCount;
                this.latestBlockGeometryVertices = geometryVertices;
                this.maxBlockGeometryVertices = Math.max(
                    this.maxBlockGeometryVertices,
                    geometryVertices
                );
                if (blockTiles > 1) {
                    this.maxAggregateGeometryVertices = Math.max(
                        this.maxAggregateGeometryVertices,
                        geometryVertices
                    );
                }
                this.completedBlocksByTileCount.set(
                    blockTiles,
                    (this.completedBlocksByTileCount.get(blockTiles) ?? 0) + 1
                );
                this.enqueueReadyResult(pending, buffers);
            }
        }
        this.pump()
            .then(() => this.capacityChanged.next())
            .catch(error => console.error("Subset render queue failed.", error));
    }

    /**
     * Releases the first worker wave immediately, then coalesces at most two
     * worker waves for a short bounded interval. Resolving a wave in one task
     * lets all visualization microtasks update the Deck registry before its
     * next RAF commit without delaying worker admission.
     */
    private enqueueReadyResult(
        pending: PendingRender,
        buffers: TileSubsetLayerRenderBuffers
    ): void {
        this.ready.push({
            pending,
            buffers,
            completedAt: performance.now()
        });
        const firstProgressiveWave =
            this.releasedTaskCount === 0 &&
            this.inFlight.size === 0;
        const boundedWaveIsFull =
            this.ready.length >=
            this.activeWorkerCount() *
                RESULT_WAVE_WORKER_MULTIPLIER;
        if (firstProgressiveWave || boundedWaveIsFull) {
            this.releaseReadyWave();
            return;
        }
        if (this.readyReleaseTimer === null) {
            this.readyReleaseTimer = setTimeout(
                () => this.releaseReadyWave(),
                RESULT_WAVE_MAX_WAIT_MS
            );
        }
    }

    /** Releases one bounded progressive wave and reopens worker admission. */
    private releaseReadyWave(): void {
        if (this.readyReleaseTimer !== null) {
            clearTimeout(this.readyReleaseTimer);
            this.readyReleaseTimer = null;
        }
        if (!this.ready.length) {
            return;
        }
        const wave = this.ready.splice(0);
        let released = 0;
        for (const item of wave) {
            if (!this.isCurrent(item.pending.task)) {
                this.staleTaskCount += 1;
                item.pending.reject(new StaleSubsetRenderError());
                continue;
            }
            item.pending.resolve(item.buffers);
            released += 1;
        }
        if (released > 0) {
            this.releasedTaskCount += released;
            this.releaseBatchCount += 1;
        }
        this.pump()
            .then(() => this.capacityChanged.next())
            .catch(error => console.error("Subset render queue failed.", error));
    }

    private handleWorkerError(workerIndex: number, event: ErrorEvent): void {
        const taskId = this.runningTaskIdByWorker[workerIndex];
        this.runningTaskIdByWorker[workerIndex] = null;
        const pending = taskId ? this.inFlight.get(taskId) : undefined;
        if (pending) {
            this.inFlight.delete(pending.task.taskId);
            this.failedTaskCount += 1;
            pending.reject(new Error(event.message || "Subset render worker failed."));
        }
        this.idleWorkers.push(workerIndex);
        this.pump()
            .then(() => this.capacityChanged.next())
            .catch(error => console.error("Subset render queue failed.", error));
    }
}
