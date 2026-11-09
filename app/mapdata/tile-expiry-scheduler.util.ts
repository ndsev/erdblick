/** Identity retained with one finite-lifetime tile while it is in the shared heap. */
export interface TileExpiryToken<Key extends string | number = number> {
    tileId: Key;
    valueVersion: number;
}

interface HeapEntry<
    Owner extends object,
    Key extends string | number
> extends TileExpiryToken<Key> {
    owner: Owner;
    expiresAtMs: number;
    heapIndex: number;
}

/**
 * One-timer, indexed min-heap for all finite-lifetime tiles.
 *
 * Memory is O(active finite-TTL tiles), replacement/cancellation is O(log n),
 * and a bounded wake-up quantum prevents a large simultaneous expiry from
 * monopolizing the browser task queue. Owners supply absolute Date.now()
 * deadlines and decide how to renew expired values. Dispose the scheduler when
 * its transport lifetime ends; cancellation and disposal do not invoke onExpired.
 */
export class TileExpiryScheduler<
    Owner extends object,
    Key extends string | number = number
> {
    private readonly heap: Array<HeapEntry<Owner, Key>> = [];
    private readonly entriesByOwner =
        new Map<Owner, Map<Key, HeapEntry<Owner, Key>>>();
    private timer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Call onExpired once per owner in each expiry batch. maxExpiriesPerTask
     * limits tiles processed per browser task (512 by default), yielding between
     * batches so a burst of expirations does not block interaction.
     */
    constructor(
        private readonly onExpired: (
            owner: Owner,
            tokens: TileExpiryToken<Key>[]
        ) => void,
        private readonly maxExpiriesPerTask = 512
    ) {}

    get size(): number {
        return this.heap.length;
    }

    /**
     * Replace the deadline for one owner/tile pair, in Unix milliseconds.
     * A non-finite deadline cancels any previous expiration. valueVersion is
     * returned with the expiry so owners can ignore tokens for replaced values.
     */
    schedule(
        owner: Owner,
        tileId: Key,
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
        const entry: HeapEntry<Owner, Key> = {
            owner,
            tileId,
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

    /**
     * Remove one deadline without expiring its value. Internal replacement can
     * suppress timer rearming until the new heap head is known.
     */
    cancel(owner: Owner, tileId: Key, rearm = true): void {
        const ownerEntries = this.entriesByOwner.get(owner);
        const entry = ownerEntries?.get(tileId);
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

    /** Drop all deadlines for an owner when its subscription is released. */
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

    /** Cancel the pending wake-up and release every retained owner and token. */
    dispose(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.heap.length = 0;
        this.entriesByOwner.clear();
    }

    /** Wake just after the earliest deadline, clamping to the browser timer range. */
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

    /**
     * Remove a bounded batch before notifying owners, allowing callbacks to
     * schedule replacement values without those values joining the current batch.
     */
    private drainExpired(): void {
        const dueByOwner = new Map<Owner, TileExpiryToken<Key>[]>();
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

    /** Fill a removed heap slot from the tail and restore ordering in either direction. */
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

    /** Move a new or earlier deadline toward the heap root. */
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

    /** Move a later deadline below its earliest child. */
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
            (a.expiresAtMs === b.expiresAtMs &&
                String(a.tileId) < String(b.tileId));
    }

    /** Keep entry indices synchronized so cancellation can remove a tile directly. */
    private swap(left: number, right: number): void {
        const value = this.heap[left];
        this.heap[left] = this.heap[right];
        this.heap[right] = value;
        this.heap[left].heapIndex = left;
        this.heap[right].heapIndex = right;
    }
}
