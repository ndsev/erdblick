import {
    DeckPathRenderResult,
    DeckPathRenderTask,
    DeckWorkerOutboundMessage
} from "./deck-render.worker.protocol";

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
}

export interface DeckPathRenderBuffers {
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    widths: Float32Array;
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
    private readonly pendingQueue: PendingTask[] = [];
    private readonly inFlightByTaskId = new Map<string, PendingTask>();
    private initPromise: Promise<void> | null = null;
    private nextTaskId = 0;

    private supportsWorkers(): boolean {
        return typeof Worker !== "undefined";
    }

    isAvailable(): boolean {
        return this.supportsWorkers();
    }

    async renderPaths(request: DeckPathRenderRequest): Promise<DeckPathRenderBuffers> {
        if (!this.supportsWorkers()) {
            throw new Error("Workers are not available in this runtime.");
        }
        await this.ensureInitialized();
        return await new Promise<DeckPathRenderBuffers>((resolve, reject) => {
            const task: DeckPathRenderTask = {
                type: "DeckPathRenderTask",
                taskId: this.makeTaskId(),
                ...request
            };
            const pendingTask: PendingTask = {task, resolve, reject};
            this.pendingQueue.push(pendingTask);
            this.scheduleAllWorkers();
        });
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = this.initializeWorkers();
        }
        return await this.initPromise;
    }

    private async initializeWorkers(): Promise<void> {
        const concurrency = Number((globalThis as any)?.navigator?.hardwareConcurrency ?? 2);
        const maxWorkers = Math.max(1, Math.min(Number.isFinite(concurrency) ? Math.floor(concurrency) : 2, 8));
        const firstWorker = new Worker(new URL("./deck-render.worker", import.meta.url), {type: "module"});
        const moduleUrl = await this.waitForWorkerReady(firstWorker);
        this.registerWorker(firstWorker, 0);

        if (maxWorkers <= 1) {
            return;
        }

        console.log(`Creating ${maxWorkers} workers.`)
        try {
            const workerBlobUrl = await this.fetchWorkerBlobUrl(moduleUrl);
            for (let i = 1; i < maxWorkers; i++) {
                const worker = new Worker(workerBlobUrl, {type: "module"});
                this.registerWorker(worker, i);
            }
        } catch (exc) {
            console.warn("[deck] worker pool clone setup failed, continuing with a single worker:", exc);
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
            if (!msg || msg.type !== "DeckPathRenderResult") {
                return;
            }
            this.workerBusy[index] = false;
            this.runningTaskIdByWorker[index] = null;
            this.handleTaskResult(msg);
            this.scheduleWorker(index);
        };
        worker.onerror = (event) => {
            this.workerBusy[index] = false;
            const runningTaskId = this.runningTaskIdByWorker[index];
            this.runningTaskIdByWorker[index] = null;
            if (runningTaskId) {
                const inFlight = this.inFlightByTaskId.get(runningTaskId);
                if (inFlight) {
                    this.inFlightByTaskId.delete(runningTaskId);
                    inFlight.reject(new Error(event.message || "Deck worker execution failed."));
                }
            }
            console.error("[deck] worker error:", event.message || event);
            this.scheduleWorker(index);
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
            positions: this.toFloat32Array(result.positions),
            startIndices: this.toUint32Array(result.startIndices),
            colors: this.toUint8Array(result.colors),
            widths: this.toFloat32Array(result.widths)
        });
    }

    private scheduleAllWorkers(): void {
        for (let i = 0; i < this.workers.length; i++) {
            this.scheduleWorker(i);
        }
    }

    private scheduleWorker(index: number): void {
        if (this.workerBusy[index]) {
            return;
        }
        const pendingTask = this.pendingQueue.shift();
        if (!pendingTask) {
            return;
        }
        const worker = this.workers[index];
        if (!worker) {
            pendingTask.reject(new Error("Deck worker is not available."));
            return;
        }
        this.workerBusy[index] = true;
        this.inFlightByTaskId.set(pendingTask.task.taskId, pendingTask);
        this.runningTaskIdByWorker[index] = pendingTask.task.taskId;
        worker.postMessage(pendingTask.task);
    }

    private makeTaskId(): string {
        this.nextTaskId += 1;
        return `deck-task-${Date.now()}-${this.nextTaskId}`;
    }

    private toFloat32Array(buffer: ArrayBuffer): Float32Array {
        if (!buffer || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
            return new Float32Array();
        }
        return new Float32Array(buffer);
    }

    private toUint32Array(buffer: ArrayBuffer): Uint32Array {
        if (!buffer || buffer.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
            return new Uint32Array();
        }
        return new Uint32Array(buffer);
    }

    private toUint8Array(buffer: ArrayBuffer): Uint8Array {
        if (!buffer) {
            return new Uint8Array();
        }
        return new Uint8Array(buffer);
    }
}

let singleton: DeckRenderWorkerPool | null = null;

export function deckRenderWorkerPool(): DeckRenderWorkerPool {
    if (!singleton) {
        singleton = new DeckRenderWorkerPool();
    }
    return singleton;
}
