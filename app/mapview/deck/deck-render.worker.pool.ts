import {
    DeckGeometryOutputMode,
    DeckLowFiBundleBuffers,
    DeckTileRenderBuffers,
    DeckTileRenderResult,
    DeckTileRenderTask,
    DeckWorkerOutboundMessage
} from "./deck-render.worker.protocol";

const AUTO_WORKER_MIN = 2;
const AUTO_WORKER_FALLBACK_CPU_COUNT = 4;
const WORKER_OVERRIDE_CAP = 32;

/** Main-thread request payload accepted by the render-worker pool. */
export interface DeckTileRenderRequest {
    viewIndex: number;
    tileKey: string;
    tileStageBlobs: Uint8Array[];
    fieldDictBlob: Uint8Array;
    dataSourceInfoBlob: Uint8Array;
    nodeId: string;
    mapName: string;
    styleSource: string;
    styleOptions: Record<string, boolean | number | string>;
    highlightModeValue: number;
    fidelityValue: number;
    highFidelityStage: number;
    maxLowFiLod: number;
    outputMode: DeckGeometryOutputMode;
    featureIdSubset: string[];
    mergeCountSnapshot: Record<string, number>;
}

/** Runtime settings that decide whether worker rendering is used and how many workers are spawned. */
export interface DeckRenderWorkerSettings {
    threadedRenderingEnabled: boolean;
    workerCountOverride: number | null;
}

type PendingTask = {
    task: DeckTileRenderTask;
    resolve: (value: DeckTileRenderBuffers) => void;
    reject: (reason?: unknown) => void;
};

/**
 * Pool of module workers that turn staged tile/style inputs into deck-ready buffers.
 * The pool lazily initializes, keeps one task in flight per worker, and can be rebuilt on settings changes.
 */
export class DeckRenderWorkerPool {
    private readonly workers: Worker[] = [];
    private readonly workerBusy: boolean[] = [];
    private readonly runningTaskIdByWorker: Array<string | null> = [];
    private readonly inFlightByTaskId = new Map<string, PendingTask>();
    private readonly availableWorkerWaiters: Array<{
        resolve: (workerIndex: number) => void;
        reject: (reason?: unknown) => void;
    }> = [];
    private workerBlobUrl: string | null = null;
    private initPromise: Promise<void> | null = null;
    private nextTaskId = 0;

    /** Creates the pool wrapper with the maximum number of workers to spawn on initialization. */
    constructor(private readonly maxWorkers: number) {}

    /** Queues one tile render request onto the next free worker and resolves with the packed buffers. */
    async renderTile(request: DeckTileRenderRequest): Promise<DeckTileRenderBuffers> {
        await this.ensureInitialized();
        const workerIndex = await this.acquireWorkerSlot();
        return await new Promise<DeckTileRenderBuffers>((resolve, reject) => {
            const task: DeckTileRenderTask = {
                type: "DeckTileRenderTask",
                taskId: this.makeTaskId(),
                ...request
            };
            const pendingTask: PendingTask = {task, resolve, reject};
            this.inFlightByTaskId.set(task.taskId, pendingTask);
            this.runningTaskIdByWorker[workerIndex] = task.taskId;
            this.workers[workerIndex]!.postMessage(task);
        });
    }

    /** Initializes workers once and shares the same promise across concurrent callers. */
    private async ensureInitialized(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = this.initializeWorkers().catch((error) => {
                this.initPromise = null;
                throw error;
            });
        }
        return await this.initPromise;
    }

    /** Starts the first worker from the module URL and clones additional workers from its script blob. */
    private async initializeWorkers(): Promise<void> {
        const firstWorker = new Worker(new URL("./deck-render.worker", import.meta.url), {type: "module"});
        const moduleUrl = await this.waitForWorkerReady(firstWorker);
        this.registerWorker(firstWorker, 0);

        if (this.maxWorkers <= 1) {
            return;
        }

        const workerBlobUrl = await this.fetchWorkerBlobUrl(moduleUrl);
        this.workerBlobUrl = workerBlobUrl;
        console.log(`Creating ${this.maxWorkers} workers.`);
        for (let i = 1; i < this.maxWorkers; i++) {
            const worker = new Worker(workerBlobUrl, {type: "module"});
            this.registerWorker(worker, i);
        }
    }

    /** Waits for the initial worker handshake that confirms the worker script finished booting. */
    private waitForWorkerReady(worker: Worker): Promise<string> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                worker.removeEventListener("message", onMessage);
                reject(new Error("Timed out waiting for deck worker readiness."));
            }, 8000);

            const onMessage = (event: MessageEvent<DeckWorkerOutboundMessage>) => {
                const msg = event.data;
                if (!msg || msg.type !== "DeckWorkerReady") {
                    return;
                }
                clearTimeout(timeout);
                worker.removeEventListener("message", onMessage);
                resolve(msg.scriptUrl);
            };
            worker.addEventListener("message", onMessage);
            worker.postMessage({type: "DeckWorkerInit"});
        });
    }

    /** Fetches the booted worker module and turns it into a blob URL for cheaper worker fan-out. */
    private async fetchWorkerBlobUrl(workerModuleUrl: string): Promise<string> {
        const response = await fetch(workerModuleUrl, {cache: "force-cache"});
        if (!response.ok) {
            throw new Error(
                `Failed to fetch deck worker module (${response.status} ${response.statusText}).`
            );
        }
        const blob = await response.blob();
        return URL.createObjectURL(blob);
    }

    /** Registers message/error handlers for one worker slot. */
    private registerWorker(worker: Worker, index: number): void {
        this.workers[index] = worker;
        this.workerBusy[index] = false;
        this.runningTaskIdByWorker[index] = null;
        worker.onmessage = (event: MessageEvent<DeckWorkerOutboundMessage>) => {
            const msg = event.data;
            this.runningTaskIdByWorker[index] = null;
            this.handleTaskResult(msg as DeckTileRenderResult);
            this.releaseWorkerSlot(index);
        };
        worker.onerror = (event) => {
            const runningTaskId = this.runningTaskIdByWorker[index];
            this.runningTaskIdByWorker[index] = null;
            if (runningTaskId) {
                const inFlight = this.inFlightByTaskId.get(runningTaskId);
                this.inFlightByTaskId.delete(runningTaskId);
                inFlight!.reject(new Error(event.message || "Deck worker execution failed."));
            }
            this.releaseWorkerSlot(index);
        };
    }

    /** Resolves or rejects the promise associated with a completed worker task. */
    private handleTaskResult(result: DeckTileRenderResult): void {
        const pending = this.inFlightByTaskId.get(result.taskId);
        if (!pending) {
            return;
        }
        this.inFlightByTaskId.delete(result.taskId);
        if (result.error) {
            pending.reject(new Error(result.error));
            return;
        }

        pending.resolve({
            vertexCount: Math.max(0, Math.floor(result.vertexCount)),
            pointWorld: result.pointWorld,
            pointBillboard: result.pointBillboard,
            labelWorld: result.labelWorld,
            labelBillboard: result.labelBillboard,
            surface: result.surface,
            pathWorld: result.pathWorld,
            pathBillboard: result.pathBillboard,
            arrowWorld: result.arrowWorld,
            arrowBillboard: result.arrowBillboard,
            coordinateOrigin: result.coordinateOrigin,
            lowFiBundles: (result.lowFiBundles ?? []).map((bundle): DeckLowFiBundleBuffers => ({
                lod: Number.isFinite(bundle.lod) ? Math.max(0, Math.min(7, Math.floor(bundle.lod))) : 0,
                pointWorld: bundle.pointWorld,
                pointBillboard: bundle.pointBillboard,
                labelWorld: bundle.labelWorld,
                labelBillboard: bundle.labelBillboard,
                surface: bundle.surface,
                pathWorld: bundle.pathWorld,
                pathBillboard: bundle.pathBillboard,
                arrowWorld: bundle.arrowWorld,
                arrowBillboard: bundle.arrowBillboard
            })),
            mergedPointFeatures: result.mergedPointFeatures ?? {},
            workerTimings: result.timings
        });
    }

    /** Acquires the next idle worker slot or waits until one becomes available. */
    private async acquireWorkerSlot(): Promise<number> {
        for (let i = 0; i < this.workers.length; i++) {
            if (this.workerBusy[i]) {
                continue;
            }
            this.workerBusy[i] = true;
            return i;
        }
        return await new Promise<number>((resolve, reject) => {
            this.availableWorkerWaiters.push({resolve, reject});
        });
    }

    /** Releases a worker slot and immediately hands it to the next waiter if one exists. */
    private releaseWorkerSlot(index: number): void {
        const waiter = this.availableWorkerWaiters.shift();
        if (waiter) {
            this.workerBusy[index] = true;
            waiter.resolve(index);
            return;
        }
        this.workerBusy[index] = false;
    }

    /** Builds a unique task id used to correlate worker results back to their pending promise. */
    private makeTaskId(): string {
        this.nextTaskId += 1;
        return `deck-task-${Date.now()}-${this.nextTaskId}`;
    }

    /** Tears down the entire pool and rejects every pending or waiting task with a reset reason. */
    dispose(reason = "Deck render worker pool reset."): void {
        const resetError = new Error(reason);
        this.availableWorkerWaiters.splice(0).forEach(waiter => waiter.reject(resetError));
        for (const pending of this.inFlightByTaskId.values()) {
            pending.reject(resetError);
        }
        this.inFlightByTaskId.clear();
        this.workerBusy.length = 0;
        this.runningTaskIdByWorker.length = 0;
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers.length = 0;
        if (this.workerBlobUrl) {
            URL.revokeObjectURL(this.workerBlobUrl);
            this.workerBlobUrl = null;
        }
        this.initPromise = null;
    }
}

let settings: DeckRenderWorkerSettings = {
    threadedRenderingEnabled: true,
    workerCountOverride: null
};

let singleton: DeckRenderWorkerPool | null = null;

/** Normalizes a user-provided worker override into the supported range or clears it. */
function sanitizeWorkerOverride(workerCountOverride: number | null): number | null {
    if (workerCountOverride === null || workerCountOverride === undefined) {
        return null;
    }
    if (!Number.isFinite(workerCountOverride)) {
        return null;
    }
    return Math.max(1, Math.min(Math.floor(workerCountOverride), WORKER_OVERRIDE_CAP));
}

/** Chooses an automatic worker count from the reported CPU count with conservative caps. */
function resolveAutoWorkerCount(): number {
    const rawCpuCount = Number(
        globalThis.navigator?.hardwareConcurrency ?? AUTO_WORKER_FALLBACK_CPU_COUNT
    );
    const normalizedCpuCount =
        Number.isFinite(rawCpuCount) && rawCpuCount >= 1
            ? Math.floor(rawCpuCount)
            : AUTO_WORKER_FALLBACK_CPU_COUNT;
    const halfCpuCount = Math.floor(normalizedCpuCount / 2);
    return Math.max(AUTO_WORKER_MIN, Math.min(halfCpuCount, WORKER_OVERRIDE_CAP));
}

/** Resolves the effective worker count after applying enable/disable state and overrides. */
function resolveConfiguredWorkerCount(): number {
    if (!settings.threadedRenderingEnabled) {
        return 0;
    }
    if (settings.workerCountOverride !== null) {
        return settings.workerCountOverride;
    }
    return resolveAutoWorkerCount();
}

/** Applies new worker-pool settings and disposes the singleton when the configuration changed. */
export function configureDeckRenderWorkerSettings(next: DeckRenderWorkerSettings): void {
    const normalized: DeckRenderWorkerSettings = {
        threadedRenderingEnabled: next.threadedRenderingEnabled !== false,
        workerCountOverride: sanitizeWorkerOverride(next.workerCountOverride)
    };
    const changed =
        settings.threadedRenderingEnabled !== normalized.threadedRenderingEnabled
        || settings.workerCountOverride !== normalized.workerCountOverride;
    settings = normalized;
    if (changed && singleton) {
        singleton.dispose("Deck render worker pool reconfigured.");
        singleton = null;
    }
}

/** Returns whether threaded deck rendering is currently enabled at all. */
export function isDeckRenderWorkerPipelineEnabled(): boolean {
    return settings.threadedRenderingEnabled;
}

/** Returns the currently configured worker concurrency. */
export function getDeckRenderWorkerConcurrency(): number {
    return resolveConfiguredWorkerCount();
}

/** Returns the automatic worker count that would be chosen without an explicit override. */
export function getDeckRenderAutoWorkerCount(): number {
    return resolveAutoWorkerCount();
}

/** Returns the lazily created singleton worker pool. */
export function deckRenderWorkerPool(): DeckRenderWorkerPool {
    if (!settings.threadedRenderingEnabled) {
        throw new Error("Deck render worker pipeline is disabled.");
    }
    if (!singleton) {
        singleton = new DeckRenderWorkerPool(resolveConfiguredWorkerCount());
    }
    return singleton;
}
