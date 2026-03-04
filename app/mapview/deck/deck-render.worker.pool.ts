import {
    DeckGeometryOutputMode,
    DeckPathRenderResult,
    DeckPathRenderTask,
    DeckWorkerTimings,
    DeckWorkerOutboundMessage
} from "./deck-render.worker.protocol";

const AUTO_WORKER_CAP = 8;
const AUTO_WORKER_FALLBACK = 4;
const WORKER_OVERRIDE_CAP = 32;

export interface DeckPathRenderRequest {
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
    fidelityValue: number;
    maxLowFiLod: number;
    outputMode: DeckGeometryOutputMode;
    featureIdSubset: string[];
    mergeCountSnapshot: Record<string, number>;
}

export interface DeckPathRenderBuffers {
    vertexCount: number;
    pointPositions: Float32Array;
    pointColors: Uint8Array;
    pointRadii: Float32Array;
    pointFeatureIds: Uint32Array;
    coordinateOrigin: Float64Array;
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    widths: Float32Array;
    featureIds: Uint32Array;
    dashArrays: Float32Array;
    dashOffsets: Float32Array;
    arrowPositions: Float32Array;
    arrowStartIndices: Uint32Array;
    arrowColors: Uint8Array;
    arrowWidths: Float32Array;
    arrowFeatureIds: Uint32Array;
    mergedPointFeatures: Record<string, any[]>;
    workerTimings?: DeckWorkerTimings;
}

export interface DeckRenderWorkerSettings {
    enabled: boolean;
    workerCountOverride: number | null;
}

type PendingTask = {
    task: DeckPathRenderTask;
    resolve: (value: DeckPathRenderBuffers) => void;
    reject: (reason?: unknown) => void;
};

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

    constructor(private readonly maxWorkers: number) {}

    async renderPaths(request: DeckPathRenderRequest): Promise<DeckPathRenderBuffers> {
        await this.ensureInitialized();
        const workerIndex = await this.acquireWorkerSlot();
        return await new Promise<DeckPathRenderBuffers>((resolve, reject) => {
            const task: DeckPathRenderTask = {
                type: "DeckPathRenderTask",
                taskId: this.makeTaskId(),
                ...request
            };
            const pendingTask: PendingTask = {task, resolve, reject};
            this.inFlightByTaskId.set(task.taskId, pendingTask);
            this.runningTaskIdByWorker[workerIndex] = task.taskId;
            this.workers[workerIndex]!.postMessage(task);
        });
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = this.initializeWorkers().catch((error) => {
                this.initPromise = null;
                throw error;
            });
        }
        return await this.initPromise;
    }

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

    private registerWorker(worker: Worker, index: number): void {
        this.workers[index] = worker;
        this.workerBusy[index] = false;
        this.runningTaskIdByWorker[index] = null;
        worker.onmessage = (event: MessageEvent<DeckWorkerOutboundMessage>) => {
            const msg = event.data;
            this.runningTaskIdByWorker[index] = null;
            this.handleTaskResult(msg as DeckPathRenderResult);
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

    private handleTaskResult(result: DeckPathRenderResult): void {
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
            pointPositions: this.toFloat32Array(result.pointPositions),
            pointColors: this.toUint8Array(result.pointColors),
            pointRadii: this.toFloat32Array(result.pointRadii),
            pointFeatureIds: this.toUint32Array(result.pointFeatureIds),
            coordinateOrigin: this.toFloat64Array(result.coordinateOrigin),
            positions: this.toFloat32Array(result.positions),
            startIndices: this.toUint32Array(result.startIndices),
            colors: this.toUint8Array(result.colors),
            widths: this.toFloat32Array(result.widths),
            featureIds: this.toUint32Array(result.featureIds),
            dashArrays: this.toFloat32Array(result.dashArrays),
            dashOffsets: this.toFloat32Array(result.dashOffsets),
            arrowPositions: this.toFloat32Array(result.arrowPositions),
            arrowStartIndices: this.toUint32Array(result.arrowStartIndices),
            arrowColors: this.toUint8Array(result.arrowColors),
            arrowWidths: this.toFloat32Array(result.arrowWidths),
            arrowFeatureIds: this.toUint32Array(result.arrowFeatureIds),
            mergedPointFeatures: result.mergedPointFeatures ?? {},
            workerTimings: result.timings
        });
    }

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

    private releaseWorkerSlot(index: number): void {
        const waiter = this.availableWorkerWaiters.shift();
        if (waiter) {
            this.workerBusy[index] = true;
            waiter.resolve(index);
            return;
        }
        this.workerBusy[index] = false;
    }

    private makeTaskId(): string {
        this.nextTaskId += 1;
        return `deck-task-${Date.now()}-${this.nextTaskId}`;
    }

    private toFloat32Array(buffer: ArrayBuffer): Float32Array {
        if (buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
            return new Float32Array();
        }
        return new Float32Array(buffer);
    }

    private toFloat64Array(buffer: ArrayBuffer): Float64Array {
        if (buffer.byteLength % Float64Array.BYTES_PER_ELEMENT !== 0) {
            return new Float64Array();
        }
        return new Float64Array(buffer);
    }

    private toUint32Array(buffer: ArrayBuffer): Uint32Array {
        if (buffer.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
            return new Uint32Array();
        }
        return new Uint32Array(buffer);
    }

    private toUint8Array(buffer: ArrayBuffer): Uint8Array {
        return new Uint8Array(buffer);
    }

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
    enabled: false,
    workerCountOverride: null
};

let singleton: DeckRenderWorkerPool | null = null;

function sanitizeWorkerOverride(workerCountOverride: number | null): number | null {
    if (workerCountOverride === null || workerCountOverride === undefined) {
        return null;
    }
    if (!Number.isFinite(workerCountOverride)) {
        return null;
    }
    return Math.max(1, Math.min(Math.floor(workerCountOverride), WORKER_OVERRIDE_CAP));
}

function resolveAutoWorkerCount(): number {
    const rawConcurrency = Number((globalThis as any).navigator?.hardwareConcurrency ?? AUTO_WORKER_FALLBACK);
    if (!Number.isFinite(rawConcurrency) || rawConcurrency < 1) {
        return AUTO_WORKER_FALLBACK;
    }
    return Math.max(1, Math.min(Math.floor(rawConcurrency), AUTO_WORKER_CAP));
}

function resolveConfiguredWorkerCount(): number {
    if (settings.workerCountOverride !== null) {
        return settings.workerCountOverride;
    }
    return resolveAutoWorkerCount();
}

export function configureDeckRenderWorkerSettings(next: DeckRenderWorkerSettings): void {
    const normalized: DeckRenderWorkerSettings = {
        enabled: !!next.enabled,
        workerCountOverride: sanitizeWorkerOverride(next.workerCountOverride)
    };
    const changed = settings.enabled !== normalized.enabled ||
        settings.workerCountOverride !== normalized.workerCountOverride;
    settings = normalized;
    if (changed && singleton) {
        singleton.dispose("Deck render worker pool reconfigured.");
        singleton = null;
    }
}

export function isDeckRenderWorkerPoolEnabled(): boolean {
    return settings.enabled;
}

export function deckRenderWorkerPool(): DeckRenderWorkerPool {
    if (!singleton) {
        singleton = new DeckRenderWorkerPool(resolveConfiguredWorkerCount());
    }
    return singleton;
}
