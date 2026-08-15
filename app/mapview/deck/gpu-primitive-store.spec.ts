import {describe, expect, it} from "vitest";
import type {Buffer, Device} from "@luma.gl/core";
import {GpuPrimitiveStore} from "./gpu-primitive-store";

class FakeBuffer {
    readonly bytes: Uint8Array;
    destroyed = false;

    constructor(readonly byteLength: number) {
        this.bytes = new Uint8Array(byteLength);
    }

    write(data: ArrayBufferLike | ArrayBufferView, byteOffset = 0): void {
        const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        this.bytes.set(bytes, byteOffset);
    }

    destroy(): void {
        this.destroyed = true;
    }
}

class FakeDevice {
    buffers: FakeBuffer[] = [];
    copies: Array<{
        source: FakeBuffer;
        destination: FakeBuffer;
        size: number;
    }> = [];

    createBuffer(props: {byteLength: number}): Buffer {
        const buffer = new FakeBuffer(props.byteLength);
        this.buffers.push(buffer);
        return buffer as unknown as Buffer;
    }

    createCommandEncoder() {
        return {
            copyBufferToBuffer: (copy: {
                sourceBuffer: FakeBuffer;
                destinationBuffer: FakeBuffer;
                size: number;
            }) => this.copies.push({
                source: copy.sourceBuffer,
                destination: copy.destinationBuffer,
                size: copy.size
            }),
            finish: () => ({})
        };
    }

    submit(): void {
        for (const copy of this.copies.splice(0)) {
            copy.destination.bytes.set(
                copy.source.bytes.subarray(0, copy.size)
            );
        }
    }
}

describe("GpuPrimitiveStore", () => {
    it("reserves bounded headroom for early packet streams", () => {
        const device = new FakeDevice();
        const store = new GpuPrimitiveStore(
            device as unknown as Device,
            7n,
            4
        );
        const first = store.allocate(40);
        store.write(first, new Uint8Array(160).fill(17));
        const firstBuffer = device.buffers.at(-1)!;

        const second = store.allocate(40);
        store.write(second, new Uint8Array(160).fill(23));

        expect(firstBuffer.destroyed).toBe(false);
        expect(device.buffers.at(-1)!.bytes.slice(0, 160))
            .toEqual(new Uint8Array(160).fill(17));
        expect(device.buffers.at(-1)!.bytes.slice(160, 320))
            .toEqual(new Uint8Array(160).fill(23));
        expect(store.snapshot()).toMatchObject({
            highWaterRecords: 80,
            uploadCount: 2,
            growthCount: 1
        });
    });

    it("preserves uploaded bytes when retained headroom is exhausted", () => {
        const device = new FakeDevice();
        const store = new GpuPrimitiveStore(
            device as unknown as Device,
            8n,
            4
        );
        const first = store.allocate(40);
        store.write(first, new Uint8Array(160).fill(17));
        const firstBuffer = device.buffers.at(-1)!;

        const second = store.allocate(500);
        store.write(second, new Uint8Array(2000).fill(23));

        expect(firstBuffer.destroyed).toBe(true);
        expect(device.buffers.at(-1)!.bytes.slice(0, 160))
            .toEqual(new Uint8Array(160).fill(17));
        expect(device.buffers.at(-1)!.bytes.slice(160, 2160))
            .toEqual(new Uint8Array(2000).fill(23));
        expect(store.snapshot()).toMatchObject({
            highWaterRecords: 540,
            uploadCount: 2,
            growthCount: 2
        });
    });

    it("retains a presented buffer until models can bind the grown generation", () => {
        const device = new FakeDevice();
        const store = new GpuPrimitiveStore(
            device as unknown as Device,
            10n,
            4
        );
        const first = store.allocate(40);
        store.write(first, new Uint8Array(160).fill(17));
        store.publish();
        const presented = store.presentedBuffer as unknown as FakeBuffer;

        const second = store.allocate(500);
        store.write(second, new Uint8Array(2000).fill(23));

        expect(store.presentedBuffer).toBe(presented);
        expect(presented.destroyed).toBe(false);
        store.publish();
        expect(store.presentedBuffer).not.toBe(presented);
        expect(presented.destroyed).toBe(false);
        store.releaseRetiredBuffers();
        expect(presented.destroyed).toBe(true);
    });

    it("reuses released ranges without uploading over inactive bytes", () => {
        const device = new FakeDevice();
        const store = new GpuPrimitiveStore(
            device as unknown as Device,
            9n,
            4
        );
        const first = store.allocate(4);
        const second = store.allocate(2);
        store.write(first, new Uint8Array(16).fill(31));
        store.write(second, new Uint8Array(8).fill(47));

        store.release(first);

        expect(device.buffers.at(-1)!.bytes.slice(0, 16))
            .toEqual(new Uint8Array(16).fill(31));
        const reused = store.allocate(3);
        expect(reused).toEqual({firstRecord: 0, recordCount: 3});
        store.write(reused, new Uint8Array(12).fill(59));
        expect(device.buffers.at(-1)!.bytes.slice(0, 16))
            .toEqual(new Uint8Array([
                59, 59, 59, 59, 59, 59, 59, 59,
                59, 59, 59, 59, 31, 31, 31, 31
            ]));
        expect(store.highWaterRecord).toBe(6);
    });

    it("rolls back logical ownership when the byte cap rejects growth", () => {
        const device = new FakeDevice();
        const store = new GpuPrimitiveStore(
            device as unknown as Device,
            11n,
            4,
            256
        );
        const retained = store.allocate(32);

        expect(() => store.allocate(40)).toThrow(/store cap/);
        expect(store.snapshot()).toMatchObject({
            highWaterRecords: 32,
            fragmentedRecords: 0,
            allocatedBytes: 256
        });
        store.release(retained);
        expect(store.highWaterRecord).toBe(0);
    });
});
