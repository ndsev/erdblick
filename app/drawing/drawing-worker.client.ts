import type {DrawingOperation, DrawingReply, DrawingWorkerResponse} from "./drawing.model";

/** Distinguishes a lost heap from an ordinary validation error. */
export class DrawingWorkerStoppedError extends Error {}

/** Lazy single-worker transport with bounded lifetime and request-specific failures. */
export class DrawingWorkerClient {
    private worker?: Worker;
    private serial = 0;
    private readonly pending = new Map<number, {resolve(value: DrawingReply): void; reject(error: Error): void}>();

    /** Queue one native operation; removing a document cannot redirect it to a backend. */
    request(operation: DrawingOperation): Promise<DrawingReply> {
        if (!this.worker) {
            this.worker = new Worker(new URL("./drawing.worker", import.meta.url), {type: "module"});
            this.worker.onmessage = ({data}: MessageEvent<DrawingWorkerResponse>) => {
                const pending = this.pending.get(data.id);
                if (!pending) return;
                this.pending.delete(data.id);
                if (data.error) pending.reject(new Error(data.error));
                else pending.resolve(data.result ?? {});
            };
            this.worker.onerror = () => this.destroy(new DrawingWorkerStoppedError("The local drawing worker stopped."));
        }
        const id = ++this.serial;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            this.worker!.postMessage({id, operation});
        });
    }

    /** Invalidate all outstanding replies before releasing the worker heap. */
    destroy(error = new Error("Local drawing worker closed.")): void {
        this.worker?.terminate();
        this.worker = undefined;
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
}
