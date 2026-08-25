import {describe, expect, it} from "vitest";
import {GpuRangeAllocator} from "./gpu-range-allocator";

describe("GpuRangeAllocator", () => {
    it("reuses and coalesces released ranges", () => {
        const allocator = new GpuRangeAllocator();
        const first = allocator.allocate(4);
        const second = allocator.allocate(3);
        const third = allocator.allocate(2);

        allocator.release(second);
        const reused = allocator.allocate(2);
        expect(reused).toEqual({firstRecord: 4, recordCount: 2});
        allocator.release(first);
        allocator.release(reused);
        allocator.release(third);

        expect(allocator.highWaterRecord).toBe(0);
        expect(allocator.fragmentedRecords).toBe(0);
    });

    it("rejects invalid and duplicate releases", () => {
        const allocator = new GpuRangeAllocator();
        const range = allocator.allocate(4);
        allocator.release({firstRecord: 1, recordCount: 2});

        expect(() => allocator.release({firstRecord: 1, recordCount: 1}))
            .toThrow(/more than once/);
        expect(() => allocator.release({firstRecord: 10, recordCount: 1}))
            .toThrow(/outside/);
        expect(range).toEqual({firstRecord: 0, recordCount: 4});
    });
});
