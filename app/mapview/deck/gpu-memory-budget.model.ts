/**
 * Capacity accounting and reservation values shared by GPU scene owners.
 * The ledger models admission and retirement overlap; actual device buffers
 * are allocated and destroyed by their rendering owners.
 */
/** Account requested GPU capacity across scenes, including replacement overlap. */
export class GpuMemoryBudget {
    private allocated = 0;
    private reserved = 0;
    private external = 0;
    private active: GpuMemoryReservation | null = null;
    private retiring = 0;
    private retirementFinished: Promise<void> | null = null;
    private finishRetirement: (() => void) | null = null;
    /** Create an application allowance in bytes, independent of physical VRAM capacity. */
    constructor(private limit = 256 * 1024 * 1024) {}

    /** Lowering a limit blocks new allocation; owners reclaim their existing buffers. */
    setLimit(bytes: number): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid GPU memory allowance.");
        this.limit = bytes;
    }
    /** luma's default statistics are shared; account their total once, not once per view. */
    observeTrackedTotal(bytes: number): void {
        if (Number.isFinite(bytes)) this.external = Math.max(0, bytes - this.allocated);
    }
    /** Remaining capacity after live buffers, reservations and other tracked luma resources. */
    get availableBytes(): number { return Math.max(0, this.limit - this.allocated - this.reserved - this.external); }
    /** Physical primitive-buffer capacity, including retained replacement buffers. */
    get allocatedBytes(): number { return this.allocated; }
    /** Unconsumed capacity promised to running render jobs. */
    get reservedBytes(): number { return this.reserved; }

    /** Pending scene reclamation, completed after Deck has rebound its models. */
    get retirement(): Promise<void> | null { return this.retirementFinished; }

    /** Keep admission pending until superseded presentation resources can be freed. */
    beginRetirement(): () => void {
        if (!this.retiring++) {
            this.retirementFinished = new Promise(resolve => { this.finishRetirement = resolve; });
        }
        let finished = false;
        return () => {
            if (finished) return;
            finished = true;
            if (!--this.retiring) {
                this.retirementFinished = null;
                this.finishRetirement?.();
                this.finishRetirement = null;
            }
        };
    }

    /** Claim replacement headroom before dispatching work. */
    reserve(bytes: number): GpuMemoryReservation {
        this.check(bytes);
        this.reserved += bytes;
        return new GpuMemoryReservation(this, bytes);
    }
    /** Charge before creating a physical buffer; return an idempotent destruction callback. */
    allocate(bytes: number): () => void {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid GPU allocation size.");
        const covered = Math.min(bytes, this.active?.remaining ?? 0);
        this.check(bytes - covered);
        if (this.active) this.active.remaining -= covered;
        this.reserved -= covered;
        this.allocated += bytes;
        let released = false;
        return () => { if (!released) { this.allocated -= bytes; released = true; } };
    }
    /** Convert this job's reservation into physical capacity during synchronous upload. */
    run<T>(reservation: GpuMemoryReservation, callback: () => T): T {
        const previous = this.active;
        this.active = reservation;
        try { return callback(); } finally { this.active = previous; }
    }
    /** Return unused headroom; consumed allocations have their own lifetime. */
    release(reservation: GpuMemoryReservation): void {
        this.reserved -= reservation.remaining;
        reservation.remaining = 0;
    }
    /** Reject invalid arithmetic or an allocation above the remaining allowance. */
    private check(bytes: number): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.availableBytes)
            throw new Error("GPU allocation allowance exhausted. Reduce point-cloud detail or visible data.");
    }
}

/** RAII-like handle explicitly released by render completion and cancellation paths. */
export class GpuMemoryReservation {
    /** Retain the shared owner and the currently unconsumed bytes. */
    constructor(private readonly budget: GpuMemoryBudget, public remaining: number) {}
    /** Execute synchronous GPU admission against this job's claim. */
    run<T>(callback: () => T): T { return this.budget.run(this, callback); }
    /** Idempotently release the unused part of this reservation. */
    release(): void { this.budget.release(this); }
}

export const gpuMemoryBudget = new GpuMemoryBudget();
