export type BudgetLoopScheduler = "frame" | "task";

/**
 * Cooperative work queue owned and disposed by its consumer.
 *
 * Frame scheduling is the default for presentation work. Task scheduling is
 * available to transport consumers whose progress must not stop when rendering
 * misses animation frames. Each callback receives a performance.now() deadline
 * and must yield itself: this loop cannot interrupt a long-running callback.
 */
export class FrameBudgetLoop<T> {
    private readonly queue: T[] = [];
    private scheduledWork: ReturnType<typeof setTimeout> | number | null = null;
    private disposed = false;
    private paused = false;

    /**
     * work returns true when an item is complete, or false to retry it behind
     * other queued items. frameBudgetMs is a per-slice budget in milliseconds;
     * the default eight milliseconds leaves time for other browser work.
     */
    constructor(
        private readonly work: (item: T, deadline: number) => boolean,
        private readonly frameBudgetMs = 8,
        private readonly scheduler: BudgetLoopScheduler = "frame"
    ) {}

    /** Append work and arrange one wake-up; enqueueing after disposal is ignored. */
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

    /** Remove matching queued items without invoking their work callback. */
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

    /** Permanently stop the loop, cancel its wake-up and discard pending work. */
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

    /** Keep at most one pending frame or task callback while runnable work exists. */
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

    /** Cancel using the scheduler that created the handle, then clear that handle. */
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

    /**
     * Process items until the elapsed-time budget is exhausted, rotating partial
     * items to the tail so later items can make progress in the same slice.
     */
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
