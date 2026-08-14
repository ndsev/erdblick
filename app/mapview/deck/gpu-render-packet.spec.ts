import {describe, expect, it} from "vitest";
import {
    GPU_RENDER_PACKET_ABI_VERSION,
    GPU_RENDER_PACKET_HEADER_BYTES,
    GPU_RENDER_PACKET_MAX_BYTES,
    GpuRenderPacketView
} from "./gpu-render-packet";

/** Build the smallest valid packet for parser boundary tests. */
function emptyPacket(): Uint8Array {
    const bytes = new Uint8Array(GPU_RENDER_PACKET_HEADER_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x50475245, true);
    view.setUint16(4, GPU_RENDER_PACKET_ABI_VERSION, true);
    view.setUint16(6, GPU_RENDER_PACKET_HEADER_BYTES, true);
    view.setUint32(8, bytes.byteLength, true);
    view.setUint32(12, 1, true);
    view.setUint32(36, 1, true);
    for (const offset of [72, 80, 88, 96, 104, 112, 120, 128, 144, 152]) {
        view.setUint32(offset, GPU_RENDER_PACKET_HEADER_BYTES, true);
    }
    return bytes;
}

/** Build one point stream with two records owned by one pickable contribution. */
function ownedPacket(): Uint8Array {
    const bytes = new Uint8Array(384);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x50475245, true);
    view.setUint16(4, GPU_RENDER_PACKET_ABI_VERSION, true);
    view.setUint16(6, GPU_RENDER_PACKET_HEADER_BYTES, true);
    view.setUint32(8, bytes.byteLength, true);
    view.setUint32(12, 1, true);
    view.setUint32(36, 1, true);
    const tables = [
        [72, 160, 1],
        [80, 208, 1],
        [88, 264, 1],
        [96, 280, 1],
        [104, 304, 0],
        [112, 304, 0],
        [120, 304, 0],
        [128, 304, 0],
        [144, 304, 0],
        [152, 304, 0]
    ];
    for (const [header, offset, count] of tables) {
        view.setUint32(header, offset, true);
        view.setUint32(header + 4, count, true);
    }
    view.setUint16(160, 1, true);
    view.setBigUint64(164, 1n, true);
    view.setUint32(172, 40, true);
    view.setUint32(176, 2, true);
    view.setUint32(180, 304, true);
    view.setUint32(184, 80, true);
    view.setBigUint64(208, 1n, true);
    view.setUint32(220, 0, true);
    view.setUint32(224, 1, true);
    view.setUint32(228, 0, true);
    view.setUint32(232, 1, true);
    view.setUint32(236, 0, true);
    view.setUint32(240, 1, true);
    view.setUint32(244, 0, true);
    view.setUint32(248, 0, true);
    view.setUint32(260, 1, true);
    view.setUint32(264, 0, true);
    view.setUint32(268, 0, true);
    view.setUint32(272, 2, true);
    view.setUint32(280, 0, true);
    view.setUint32(284, 0, true);
    return bytes;
}

describe("GpuRenderPacketView", () => {
    it("accepts an empty, explicitly versioned packet", () => {
        const packet = new GpuRenderPacketView(emptyPacket());
        expect(packet.streams).toEqual([]);
        expect(packet.contributions).toEqual([]);
    });

    it("rejects corrupted framing before reading tables", () => {
        const bytes = emptyPacket();
        bytes[0] = 0;
        expect(() => new GpuRenderPacketView(bytes)).toThrow(/magic/);
    });

    it("rejects an out-of-range packet fragment index", () => {
        const bytes = emptyPacket();
        new DataView(bytes.buffer).setUint32(24, 1, true);
        expect(() => new GpuRenderPacketView(bytes)).toThrow(/fragment/);
    });

    it("rejects unknown packet flags", () => {
        const bytes = emptyPacket();
        new DataView(bytes.buffer).setUint32(12, 3, true);
        expect(() => new GpuRenderPacketView(bytes)).toThrow(/fragment/);
    });

    it("requires only the final fragment to complete its revision", () => {
        const bytes = emptyPacket();
        const view = new DataView(bytes.buffer);
        view.setUint32(36, 2, true);
        expect(() => new GpuRenderPacketView(bytes)).toThrow(/fragment/);

        view.setUint32(12, 0, true);
        expect(new GpuRenderPacketView(bytes)).toMatchObject({
            fragmentIndex: 0,
            fragmentCount: 2,
            revisionComplete: false
        });
    });

    it("rejects nonzero reserved descriptor bytes", () => {
        const bytes = ownedPacket();
        new DataView(bytes.buffer).setUint32(276, 1, true);
        expect(() => new GpuRenderPacketView(bytes)).toThrow(/reserved/);
    });

    it("rejects aliased packet tables", () => {
        const bytes = ownedPacket();
        const view = new DataView(bytes.buffer);
        // Reinterpret the otherwise valid pick record as a valid stream span;
        // validation must still reject the two tables sharing the same bytes.
        view.setUint32(88, 280, true);
        view.setUint32(288, 1, true);
        expect(() => new GpuRenderPacketView(bytes)).toThrow(/overlap/);
    });

    it("rejects one worker result above the frame-sized packet ceiling", () => {
        expect(() => new GpuRenderPacketView(
            new Uint8Array(GPU_RENDER_PACKET_MAX_BYTES + 1)
        )).toThrow(/size/);
    });

    it("rejects a table outside the transferred packet", () => {
        const bytes = emptyPacket();
        const view = new DataView(bytes.buffer);
        view.setUint32(72, bytes.byteLength + 8, true);
        view.setUint32(76, 1, true);
        expect(() => new GpuRenderPacketView(bytes)).toThrow(/range/);
    });

    it("requires stream records to be owned exactly once", () => {
        const bytes = ownedPacket();
        new DataView(bytes.buffer).setUint32(272, 1, true);
        expect(() => new GpuRenderPacketView(bytes)).toThrow(/fully owned/);
    });

    it("requires dense contribution-local pick indices", () => {
        const bytes = ownedPacket();
        new DataView(bytes.buffer).setUint32(284, 1, true);
        expect(() => new GpuRenderPacketView(bytes)).toThrow(/disagrees/);
    });
});
