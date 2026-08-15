import {Buffer, type Device} from "@luma.gl/core";
import {
    GpuRangeAllocator,
    type GpuRecordRange
} from "./gpu-range-allocator";

const MINIMUM_CAPACITY_RECORDS = 64;
const INITIAL_CAPACITY_HEADROOM_FACTOR = 8;
const MAX_INITIAL_CAPACITY_HEADROOM_BYTES = 4 * 1024 * 1024;
export const MAX_GPU_PRIMITIVE_STORE_BYTES = 512 * 1024 * 1024;

/** Diagnostic counters for one physical material buffer in a persistent GPU scene. */
export interface GpuPrimitiveStoreSnapshot {
    materialKey: bigint;
    recordStride: number;
    capacityRecords: number;
    highWaterRecords: number;
    fragmentedRecords: number;
    allocatedBytes: number;
    uploadedBytes: number;
    uploadCount: number;
    growthCount: number;
}

/**
 * Owns one growable interleaved GPU buffer for a primitive/material pair.
 *
 * Geometry bytes go directly from transferred packets into luma buffers. The
 * store retains only logical ranges; growth is a GPU-to-GPU copy. Released
 * bytes may remain physically resident, but scene-global activation tokens
 * keep stale records inert even after their contribution slot is recycled.
 */
export class GpuPrimitiveStore {
    private readonly allocator = new GpuRangeAllocator();
    private gpuBuffer: Buffer | null = null;
    private renderBuffer: Buffer | null = null;
    private capacity = 0;
    private _bufferRevision = 0;
    private renderBufferRevision = 0;
    private renderHighWaterRecord = 0;
    private readonly retiredBuffers: Buffer[] = [];
    private uploadedBytes = 0;
    private uploadCount = 0;
    private growthCount = 0;

    /** Create an initially empty material store with a hard allocation ceiling. */
    constructor(
        private readonly device: Device,
        readonly materialKey: bigint,
        readonly recordStride: number,
        private readonly maxBytes = MAX_GPU_PRIMITIVE_STORE_BYTES
    ) {
        if (!Number.isSafeInteger(recordStride) || recordStride <= 0) {
            throw new Error("GPU primitive stride must be a positive integer.");
        }
        if (!Number.isSafeInteger(maxBytes) || maxBytes < recordStride) {
            throw new Error("GPU primitive store byte cap is invalid.");
        }
    }

    /** Reserve a contiguous record range, growing the physical buffer as needed. */
    allocate(recordCount: number): GpuRecordRange {
        const range = this.allocator.allocate(recordCount);
        try {
            this.ensureCapacity(this.allocator.highWaterRecord);
            return range;
        } catch (error) {
            // Allocation ownership is transactional even when the graphics
            // backend rejects a large buffer or a growth copy fails.
            this.allocator.release(range);
            throw error;
        }
    }

    /** Upload one packet stream into its pre-reserved range without repacking. */
    write(range: GpuRecordRange, records: Uint8Array): void {
        const expectedBytes = range.recordCount * this.recordStride;
        if (records.byteLength !== expectedBytes) {
            throw new Error(
                `GPU upload has ${records.byteLength} bytes; expected ${expectedBytes}.`
            );
        }
        if (range.firstRecord < 0 ||
            range.firstRecord + range.recordCount > this.capacity ||
            !this.gpuBuffer) {
            throw new Error("GPU upload range is not allocated by this store.");
        }
        this.gpuBuffer.write(records, range.firstRecord * this.recordStride);
        this.uploadedBytes += records.byteLength;
        this.uploadCount += 1;
    }

    /** Return a logical range without uploading over its now-inactive bytes. */
    release(range: GpuRecordRange): void {
        if (!this.gpuBuffer) {
            throw new Error("Cannot release records from an empty GPU store.");
        }
        this.allocator.release(range);
    }

    /** Destroy the physical buffer and reset all range ownership. */
    destroy(): void {
        const buffers = new Set<Buffer>();
        if (this.gpuBuffer) {
            buffers.add(this.gpuBuffer);
        }
        if (this.renderBuffer) {
            buffers.add(this.renderBuffer);
        }
        this.retiredBuffers.forEach(buffer => buffers.add(buffer));
        buffers.forEach(buffer => buffer.destroy());
        this.gpuBuffer = null;
        this.renderBuffer = null;
        this.retiredBuffers.length = 0;
        this.capacity = 0;
        this.allocator.clear();
        this._bufferRevision += 1;
        this.renderBufferRevision = this._bufferRevision;
        this.renderHighWaterRecord = 0;
    }

    /** Publish the latest allocation while retaining one old generation for in-flight draws. */
    publish(): void {
        this.renderBuffer = this.allocator.highWaterRecord > 0
            ? this.gpuBuffer
            : null;
        this.renderBufferRevision = this._bufferRevision;
        this.renderHighWaterRecord = this.allocator.highWaterRecord;
    }

    /** Destroy superseded allocations after every model has rebound to the published buffer. */
    releaseRetiredBuffers(): void {
        this.retiredBuffers.forEach(buffer => buffer.destroy());
        this.retiredBuffers.length = 0;
    }

    /** Current luma buffer, absent until the first non-empty allocation. */
    get buffer(): Buffer | null {
        return this.gpuBuffer;
    }

    /** Buffer visible to models at the last explicit scene publication. */
    get presentedBuffer(): Buffer | null {
        return this.renderBuffer;
    }

    /** Changes whenever a model must bind a newly allocated physical buffer. */
    get bufferRevision(): number {
        return this._bufferRevision;
    }

    /** Published buffer generation used to decide when model attributes must rebind. */
    get presentedBufferRevision(): number {
        return this.renderBufferRevision;
    }

    /** Exclusive record bound that must be supplied as the instance count. */
    get highWaterRecord(): number {
        return this.allocator.highWaterRecord;
    }

    /** Published instance bound which remains stable across unrelated Deck redraws. */
    get presentedHighWaterRecord(): number {
        return this.renderHighWaterRecord;
    }

    /** Number of live instances, excluding cleared holes below the draw bound. */
    get activeRecordCount(): number {
        return this.allocator.highWaterRecord - this.allocator.fragmentedRecords;
    }

    /** Return stable diagnostics without reading GPU memory back to JavaScript. */
    snapshot(): GpuPrimitiveStoreSnapshot {
        return {
            materialKey: this.materialKey,
            recordStride: this.recordStride,
            capacityRecords: this.capacity,
            highWaterRecords: this.allocator.highWaterRecord,
            fragmentedRecords: this.allocator.fragmentedRecords,
            allocatedBytes: this.capacity * this.recordStride,
            uploadedBytes: this.uploadedBytes,
            uploadCount: this.uploadCount,
            growthCount: this.growthCount
        };
    }

    /** Grow geometrically and preserve existing records entirely on the GPU. */
    private ensureCapacity(requiredRecords: number): void {
        if (requiredRecords <= this.capacity) {
            return;
        }
        const maximumRecords = Math.floor(this.maxBytes / this.recordStride);
        if (requiredRecords > maximumRecords) {
            throw new Error(
                `GPU material ${this.materialKey.toString(16)} exceeds its ` +
                `${this.maxBytes} byte store cap.`
            );
        }
        let nextCapacity = Math.max(MINIMUM_CAPACITY_RECORDS, this.capacity);
        if (this.capacity === 0) {
            const headroomLimit = Math.max(
                requiredRecords,
                Math.floor(
                    MAX_INITIAL_CAPACITY_HEADROOM_BYTES /
                    this.recordStride
                )
            );
            const desiredCapacity = Math.min(
                maximumRecords,
                headroomLimit,
                requiredRecords * INITIAL_CAPACITY_HEADROOM_FACTOR
            );
            nextCapacity = Math.max(
                nextCapacity,
                Math.min(
                    maximumRecords,
                    2 ** Math.ceil(Math.log2(desiredCapacity))
                )
            );
        }
        while (nextCapacity < requiredRecords) {
            nextCapacity = Math.max(nextCapacity + 1, nextCapacity * 2);
        }
        nextCapacity = Math.min(nextCapacity, maximumRecords);
        let next: Buffer | null = null;
        try {
            next = this.device.createBuffer({
                id: `erdblick-gpu-material-${this.materialKey.toString(16)}`,
                usage: Buffer.VERTEX | Buffer.COPY_SRC | Buffer.COPY_DST,
                byteLength: nextCapacity * this.recordStride
            });
            if (this.gpuBuffer && this.allocator.highWaterRecord > 0) {
                const encoder = this.device.createCommandEncoder({
                    id: `grow-erdblick-gpu-material-${this.materialKey.toString(16)}`
                });
                encoder.copyBufferToBuffer({
                    sourceBuffer: this.gpuBuffer,
                    destinationBuffer: next,
                    size: Math.min(
                        this.gpuBuffer.byteLength,
                        this.allocator.highWaterRecord * this.recordStride
                    )
                });
                this.device.submit(encoder.finish());
            }
        } catch (error) {
            next?.destroy();
            throw error;
        }
        if (this.gpuBuffer) {
            if (this.gpuBuffer === this.renderBuffer) {
                this.retiredBuffers.push(this.gpuBuffer);
            } else {
                // A staging-only generation was never visible to a model and
                // can be released as soon as its GPU copy has been submitted.
                this.gpuBuffer.destroy();
            }
        }
        this.gpuBuffer = next;
        this.capacity = nextCapacity;
        this._bufferRevision += 1;
        this.growthCount += 1;
    }
}
