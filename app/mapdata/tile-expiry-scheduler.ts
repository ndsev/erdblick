/** Identity retained with one finite-lifetime tile while it is in the shared heap. */
export interface TileExpiryToken {
    tileId: number;
    valueVersion: number;
}

interface HeapEntry<Owner extends object> extends TileExpiryToken {
    owner: Owner;
    expiresAtMs: number;
    heapIndex: number;
}

/**
 * One-timer, indexed min-heap for all finite-lifetime tiles.
 *
 * Memory is O(active finite-TTL tiles), replacement/cancellation is O(log n),
 * and a bounded wake-up quantum prevents a large simultaneous expiry from
 * monopolizing the browser task queue. This class deliberately contains no
 * retry delay or backoff policy.
 */
export class TileExpiryScheduler<Owner extends object> {
    private readonly heap: Array<HeapEntry<Owner>> = [];
    private readonly entriesByOwner =
        new Map<Owner, Map<number, HeapEntry<Owner>>>();
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly onExpired: (
            owner: Owner,
            tokens: TileExpiryToken[]
        ) => void,
        private readonly maxExpiriesPerTask = 512
    ) {}

    get size(): number {
        return this.heap.length;
    }

    schedule(
        owner: Owner,
        tileId: number,
        valueVersion: number,
        expiresAtMs: number
    ): void {
        const previousHeadDeadline = this.heap[0]?.expiresAtMs;
        this.cancel(owner, tileId, false);
        if (!Number.isFinite(expiresAtMs)) {
            if (this.heap[0]?.expiresAtMs !== previousHeadDeadline) {
                this.armTimer();
            }
            return;
        }
        let ownerEntries = this.entriesByOwner.get(owner);
        if (!ownerEntries) {
            ownerEntries = new Map();
            this.entriesByOwner.set(owner, ownerEntries);
        }
        const entry: HeapEntry<Owner> = {
            owner,
            tileId: Math.trunc(tileId),
            valueVersion: Math.max(0, Math.trunc(valueVersion)),
            expiresAtMs,
            heapIndex: this.heap.length
        };
        ownerEntries.set(entry.tileId, entry);
        this.heap.push(entry);
        this.siftUp(entry.heapIndex);
        if (this.timer === null ||
            this.heap[0]?.expiresAtMs !== previousHeadDeadline) {
            this.armTimer();
        }
    }

    cancel(owner: Owner, tileId: number, rearm = true): void {
        const ownerEntries = this.entriesByOwner.get(owner);
        const entry = ownerEntries?.get(Math.trunc(tileId));
        if (!entry) {
            return;
        }
        const wasHead = entry.heapIndex === 0;
        ownerEntries!.delete(entry.tileId);
        if (ownerEntries!.size === 0) {
            this.entriesByOwner.delete(owner);
        }
        this.removeAt(entry.heapIndex);
        if (rearm && (wasHead || this.timer === null)) {
            this.armTimer();
        }
    }

    cancelOwner(owner: Owner): void {
        const entries = this.entriesByOwner.get(owner);
        if (!entries) {
            return;
        }
        for (const entry of [...entries.values()]) {
            this.removeAt(entry.heapIndex);
        }
        this.entriesByOwner.delete(owner);
        this.armTimer();
    }

    dispose(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.heap.length = 0;
        this.entriesByOwner.clear();
    }

    private armTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const next = this.heap[0];
        if (!next) {
            return;
        }
        // TileLayer expiry is strict (`now > timestamp + ttl`).
        const delay = Math.min(
            0x7fffffff,
            Math.max(0, Math.ceil(next.expiresAtMs - Date.now()) + 1)
        );
        this.timer = setTimeout(() => {
            this.timer = null;
            this.drainExpired();
        }, delay);
    }

    private drainExpired(): void {
        const dueByOwner = new Map<Owner, TileExpiryToken[]>();
        const now = Date.now();
        let drained = 0;
        while (this.heap.length > 0 &&
            this.heap[0].expiresAtMs < now &&
            drained < this.maxExpiriesPerTask) {
            const entry = this.heap[0];
            const ownerEntries = this.entriesByOwner.get(entry.owner);
            ownerEntries?.delete(entry.tileId);
            if (ownerEntries?.size === 0) {
                this.entriesByOwner.delete(entry.owner);
            }
            this.removeAt(0);
            let due = dueByOwner.get(entry.owner);
            if (!due) {
                due = [];
                dueByOwner.set(entry.owner, due);
            }
            due.push({
                tileId: entry.tileId,
                valueVersion: entry.valueVersion
            });
            drained++;
        }
        for (const [owner, tokens] of dueByOwner) {
            this.onExpired(owner, tokens);
        }
        this.armTimer();
    }

    private removeAt(index: number): void {
        const last = this.heap.pop();
        if (!last || index >= this.heap.length) {
            return;
        }
        this.heap[index] = last;
        last.heapIndex = index;
        const parent = Math.floor((index - 1) / 2);
        if (index > 0 && this.less(index, parent)) {
            this.siftUp(index);
        } else {
            this.siftDown(index);
        }
    }

    private siftUp(start: number): void {
        let index = start;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (!this.less(index, parent)) {
                break;
            }
            this.swap(index, parent);
            index = parent;
        }
    }

    private siftDown(start: number): void {
        let index = start;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let smallest = index;
            if (left < this.heap.length && this.less(left, smallest)) {
                smallest = left;
            }
            if (right < this.heap.length && this.less(right, smallest)) {
                smallest = right;
            }
            if (smallest === index) {
                return;
            }
            this.swap(index, smallest);
            index = smallest;
        }
    }

    private less(left: number, right: number): boolean {
        const a = this.heap[left];
        const b = this.heap[right];
        return a.expiresAtMs < b.expiresAtMs ||
            (a.expiresAtMs === b.expiresAtMs && a.tileId < b.tileId);
    }

    private swap(left: number, right: number): void {
        const value = this.heap[left];
        this.heap[left] = this.heap[right];
        this.heap[right] = value;
        this.heap[left].heapIndex = left;
        this.heap[right].heapIndex = right;
    }
}
