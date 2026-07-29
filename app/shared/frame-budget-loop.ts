/**
 * Small consumer-owned requestAnimationFrame work loop.
 *
 * It deliberately has no global queue or Angular lifetime. A consumer owns one
 * instance, enqueues replaceable work items, and disposes it with the consumer.
 */
export class FrameBudgetLoop<T> {
    private readonly queue: T[] = [];
    private frame: number | null = null;
    private disposed = false;

    constructor(
        private readonly work: (item: T, deadline: number) => boolean,
        private readonly frameBudgetMs = 8
    ) {}

    enqueue(item: T): void {
        if (this.disposed) {
            return;
        }
        this.queue.push(item);
        this.schedule();
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
        if (this.frame !== null) {
            cancelAnimationFrame(this.frame);
            this.frame = null;
        }
    }

    private schedule(): void {
        if (this.frame !== null || !this.queue.length || this.disposed) {
            return;
        }
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            this.runFrame();
        });
    }

    private runFrame(): void {
        const deadline = performance.now() + Math.max(1, this.frameBudgetMs);
        while (this.queue.length && performance.now() < deadline) {
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
