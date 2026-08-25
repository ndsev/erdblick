export type BudgetLoopScheduler = "frame" | "task";

/**
 * Small consumer-owned budgeted work loop.
 *
 * Frame scheduling is the default for presentation work. Task scheduling is
 * available to transport consumers whose progress must not stop when rendering
 * misses animation frames. It deliberately has no global queue or Angular
 * lifetime.
 */
export class FrameBudgetLoop<T> {
    private readonly queue: T[] = [];
    private scheduledWork: ReturnType<typeof setTimeout> | number | null = null;
    private disposed = false;
    private paused = false;

    constructor(
        private readonly work: (item: T, deadline: number) => boolean,
        private readonly frameBudgetMs = 8,
        private readonly scheduler: BudgetLoopScheduler = "frame"
    ) {}

    enqueue(item: T): void {
        if (this.disposed) {
            return;
        }
        this.queue.push(item);
        this.schedule();
    }

    /** Adds an already ordered batch without scheduling one callback per item. */
    enqueueMany(items: readonly T[]): void {
        if (this.disposed || !items.length) {
            return;
        }
        for (const item of items) {
            this.queue.push(item);
        }
        this.schedule();
    }

    /** Number of work items which have not completed yet. */
    get length(): number {
        return this.queue.length;
    }

    /** Suspends or resumes processing without discarding queued work. */
    setPaused(paused: boolean): void {
        if (this.disposed || this.paused === paused) {
            return;
        }
        this.paused = paused;
        if (paused && this.scheduledWork !== null) {
            this.cancelScheduledWork();
        } else if (!paused) {
            this.schedule();
        }
    }

    cancel(predicate: (item: T) => boolean): void {
        for (let index = this.queue.length - 1; index >= 0; --index) {
            if (predicate(this.queue[index])) {
                this.queue.splice(index, 1);
            }
        }
    }

    clear(): void {
        this.queue.length = 0;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.queue.length = 0;
        if (this.scheduledWork !== null) {
            this.cancelScheduledWork();
        }
    }

    private schedule(): void {
        if (this.scheduledWork !== null || !this.queue.length ||
            this.disposed || this.paused) {
            return;
        }
        const callback = () => {
            this.scheduledWork = null;
            this.runSlice();
        };
        this.scheduledWork = this.scheduler === "task"
            ? setTimeout(callback, 0)
            : requestAnimationFrame(callback);
    }

    private cancelScheduledWork(): void {
        if (this.scheduledWork === null) {
            return;
        }
        if (this.scheduler === "task") {
            clearTimeout(this.scheduledWork);
        } else {
            cancelAnimationFrame(this.scheduledWork as number);
        }
        this.scheduledWork = null;
    }

    private runSlice(): void {
        if (this.paused || this.disposed) {
            return;
        }
        const deadline = performance.now() + Math.max(1, this.frameBudgetMs);
        while (!this.paused &&
            this.queue.length &&
            performance.now() < deadline) {
            const item = this.queue[0];
            if (this.work(item, deadline)) {
                this.queue.shift();
            } else {
                // Round-robin prevents one very large tile from starving later
                // tiles while preserving FIFO order within each individual task.
                this.queue.push(this.queue.shift()!);
            }
        }
        this.schedule();
    }
}
