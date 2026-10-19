/** Admission for retained immutable point-cloud subsets, shared by all views and layers. */
export class PointCloudInputBudget {
    private readonly entries = new Map<object, {bytes: number; evict: () => void}>();
    private retained = 0;
    private limit = (512 - 16) * 1048576 / 4;

    /** Leave space for worker copies/model storage and at least one worker's fixed overhead. */
    setWorkingLimit(bytes: number): void {
        this.limit = Math.max(0, (bytes - 16 * 1048576) / 4);
        for (const [key, entry] of this.entries) {
            if (this.retained <= this.limit) break;
            this.release(key);
            entry.evict();
        }
    }

    /** Replace one claim atomically; rejection leaves the previous claim intact. */
    admit(key: object, bytes: number, evict: () => void): boolean {
        const previous = this.entries.get(key)?.bytes ?? 0;
        if (!Number.isSafeInteger(bytes) || bytes < 0 || this.retained - previous + bytes > this.limit) return false;
        this.retained += bytes - previous;
        this.entries.set(key, {bytes, evict});
        return true;
    }

    /** Return a claim when its owner releases the immutable payload. */
    release(key: object): void {
        this.retained -= this.entries.get(key)?.bytes ?? 0;
        this.entries.delete(key);
    }

    /** Retained bytes, excluding transient transport frames and worker heaps. */
    get retainedBytes(): number { return this.retained; }
}

export const pointCloudInputBudget = new PointCloudInputBudget();
