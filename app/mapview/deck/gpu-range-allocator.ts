export interface GpuRecordRange {
    firstRecord: number;
    recordCount: number;
}

/**
 * First-fit allocator for logical record ranges inside one growable GPU store.
 *
 * It deliberately knows nothing about bytes or graphics resources. Adjacent
 * releases coalesce immediately, while capacity beyond the high-water mark is
 * represented implicitly and therefore does not create bookkeeping objects.
 */
export class GpuRangeAllocator {
    private readonly freeRanges: GpuRecordRange[] = [];
    private nextRecord = 0;

    /** Reserve one contiguous range, reusing the lowest suitable hole first. */
    allocate(recordCount: number): GpuRecordRange {
        const count = this.validCount(recordCount);
        for (let index = 0; index < this.freeRanges.length; ++index) {
            const free = this.freeRanges[index];
            if (free.recordCount < count) {
                continue;
            }
            const result = {
                firstRecord: free.firstRecord,
                recordCount: count
            };
            free.firstRecord += count;
            free.recordCount -= count;
            if (free.recordCount === 0) {
                this.freeRanges.splice(index, 1);
            }
            return result;
        }
        const result = {
            firstRecord: this.nextRecord,
            recordCount: count
        };
        this.nextRecord += count;
        return result;
    }

    /** Return one allocation and coalesce it with neighboring holes. */
    release(range: GpuRecordRange): void {
        const recordCount = this.validCount(range.recordCount);
        const firstRecord = Math.trunc(range.firstRecord);
        if (firstRecord < 0 || firstRecord + recordCount > this.nextRecord) {
            throw new Error("GPU record release is outside the allocator range.");
        }
        let insertion = 0;
        while (insertion < this.freeRanges.length &&
            this.freeRanges[insertion].firstRecord < firstRecord) {
            insertion += 1;
        }
        const previous = this.freeRanges[insertion - 1];
        const next = this.freeRanges[insertion];
        if ((previous && previous.firstRecord + previous.recordCount > firstRecord) ||
            (next && firstRecord + recordCount > next.firstRecord)) {
            throw new Error("GPU record range was released more than once.");
        }
        this.freeRanges.splice(insertion, 0, {firstRecord, recordCount});
        this.coalesceAt(Math.max(0, insertion - 1));
        this.trimHighWater();
    }

    /** Reset all ownership while retaining no stale allocator holes. */
    clear(): void {
        this.freeRanges.length = 0;
        this.nextRecord = 0;
    }

    /** Current exclusive upper record bound required by a draw call. */
    get highWaterRecord(): number {
        return this.nextRecord;
    }

    /** Number of unused records retained below the current high-water mark. */
    get fragmentedRecords(): number {
        return this.freeRanges.reduce(
            (sum, range) => sum + range.recordCount,
            0
        );
    }

    /** Normalize external counts before they enter allocator arithmetic. */
    private validCount(value: number): number {
        const result = Math.trunc(value);
        if (!Number.isSafeInteger(result) || result <= 0) {
            throw new Error("GPU record range must contain at least one record.");
        }
        return result;
    }

    /** Merge every adjacent free range reachable from one insertion point. */
    private coalesceAt(startIndex: number): void {
        let index = startIndex;
        while (index + 1 < this.freeRanges.length) {
            const current = this.freeRanges[index];
            const next = this.freeRanges[index + 1];
            if (current.firstRecord + current.recordCount !== next.firstRecord) {
                index += 1;
                continue;
            }
            current.recordCount += next.recordCount;
            this.freeRanges.splice(index + 1, 1);
        }
    }

    /** Remove a trailing hole so draw calls never scan unused tail records. */
    private trimHighWater(): void {
        const last = this.freeRanges.at(-1);
        if (!last || last.firstRecord + last.recordCount !== this.nextRecord) {
            return;
        }
        this.nextRecord = last.firstRecord;
        this.freeRanges.pop();
    }
}
