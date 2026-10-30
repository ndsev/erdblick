import {DEFAULT_POINT_CLOUD_POLICY} from "../point-cloud-policy.model";
import {Subject} from "rxjs";

/** A recoverable admission failure; retry when capacity or render demand changes. */
export class GpuAllocationError extends Error {
    /** Record the rejected allocation size for diagnostics, not as a permanent retry threshold. */
    constructor(readonly requiredBytes: number) {
        super("GPU allocation allowance exhausted. Some data is paused; hide data or raise the GPU allowance.");
        this.name = "GpuAllocationError";
    }
}

/**
 * Capacity accounting and reservation values shared by GPU scene owners.
 * The ledger models admission and retirement overlap; actual device buffers
 * are allocated and destroyed by their rendering owners.
 */
export class GpuMemoryBudget {
    /** Notify paused renderers after a presentation has released its buffers or reusable ranges. */
    readonly reclaimed = new Subject<void>();
    private allocated = 0;
    private reserved = 0;
    private trackedTotal: {readonly count: number} | null = null;
    private active: GpuMemoryReservation | null = null;
    private retiring = 0;
    private retirementFinished: Promise<void> | null = null;
    private finishRetirement: (() => void) | null = null;
    private reclaimedCapacityVersion = 0;
    private enabled = true;
    /** Create an application allowance in bytes, independent of physical VRAM capacity. */
    constructor(private limit = DEFAULT_POINT_CLOUD_POLICY.gpuMemoryMiB * 1024 * 1024) {}

    /** Lowering a limit blocks new allocation; owners reclaim their existing buffers. */
    setLimit(bytes: number): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid GPU memory allowance.");
        this.limit = bytes;
    }
    /** Bypass the application allowance while retaining live allocation accounting. */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }
    /** Retain luma's shared live counter once, including resources owned outside primitive stores. */
    observeTrackedTotal(counter: {readonly count: number}): void {
        this.trackedTotal = counter;
    }
    /** Remaining capacity after live buffers, reservations and other tracked luma resources. */
    get availableBytes(): number {
        const tracked = this.trackedTotal?.count ?? 0;
        const external = Number.isFinite(tracked) ? Math.max(0, tracked - this.allocated) : 0;
        return Math.max(0, (this.enabled ? this.limit : Number.MAX_SAFE_INTEGER) -
            this.allocated - this.reserved - external);
    }
    /** Physical primitive-buffer capacity, including retained replacement buffers. */
    get allocatedBytes(): number { return this.allocated; }
    /** Unconsumed capacity promised to running render jobs. */
    get reservedBytes(): number { return this.reserved; }

    /** Capacity usable by the current upload, including its own reserved headroom. */
    get allocationAvailableBytes(): number { return this.availableBytes + (this.active?.remaining ?? 0); }

    /** Pending scene reclamation, completed after Deck has rebound its models. */
    get retirement(): Promise<void> | null { return this.retirementFinished; }

    /** Changes when installed ranges become reusable, even if their shared buffer stays allocated. */
    get reclamationVersion(): number { return this.reclaimedCapacityVersion; }

    /** Keep admission pending until superseded presentation resources can be freed. */
    beginRetirement(): (reusableCapacity?: boolean) => void {
        if (!this.retiring++) {
            this.retirementFinished = new Promise(resolve => { this.finishRetirement = resolve; });
        }
        let finished = false;
        return (reusableCapacity = false) => {
            if (finished) return;
            finished = true;
            if (reusableCapacity) ++this.reclaimedCapacityVersion;
            if (!--this.retiring) {
                this.retirementFinished = null;
                this.finishRetirement?.();
                this.finishRetirement = null;
                this.reclaimed.next();
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
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid GPU allocation size.");
        if (bytes > this.availableBytes) throw new GpuAllocationError(bytes);
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
