import type {Buffer, Device, Texture} from "@luma.gl/core";
import {describe, expect, it, vi} from "vitest";

import {
    GpuScene,
    type GpuSceneRenderReservation
} from "./gpu-scene";
import {gpuSceneShaderModule} from "./erdblick-vector.shaders";
import {
    GPU_RENDER_PACKET_ABI_VERSION,
    GPU_RENDER_PACKET_HEADER_BYTES,
    GpuLabelFlag,
    GpuMaterialFlag,
    GpuPrimitiveKind
} from "./gpu-render-packet";

const STREAM_BYTES = 48;
const CONTRIBUTION_BYTES = 56;
const SPAN_BYTES = 16;
const PICK_BYTES = 24;
const LABEL_BYTES = 120;
const POINT_BYTES = 40;

/** Minimal byte-addressable luma buffer used to verify scene ownership. */
class FakeBuffer {
    readonly bytes: Uint8Array;
    destroyed = false;
    failNextWrite = false;

    constructor(readonly byteLength: number) {
        this.bytes = new Uint8Array(byteLength);
    }

    /** Mirrors the luma bulk-write contract used by primitive stores. */
    write(data: ArrayBufferLike | ArrayBufferView, byteOffset = 0): void {
        if (this.failNextWrite) {
            this.failNextWrite = false;
            throw new Error("Synthetic buffer upload failure.");
        }
        const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        this.bytes.set(bytes, byteOffset);
    }

    /** Marks resource retirement without invalidating prior assertions. */
    destroy(): void {
        this.destroyed = true;
    }
}

/** Small texture stand-in retaining lookup-table uploads for assertions. */
class FakeTexture {
    destroyed = false;
    failNextWrite = false;
    readonly writes: Array<{data: ArrayBufferView; options: unknown}> = [];

    constructor(
        readonly id: string,
        readonly width: number,
        readonly height: number
    ) {}

    /** Records one compact origin, contribution, or mask-table upload. */
    writeData(data: ArrayBufferView, options: unknown): void {
        if (this.failNextWrite) {
            this.failNextWrite = false;
            throw new Error("Synthetic texture upload failure.");
        }
        this.writes.push({
            data: new Float32Array(
                data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            ),
            options
        });
    }

    /** Marks the old allocation destroyed after geometric growth. */
    destroy(): void {
        this.destroyed = true;
    }
}

/** Fake luma device implementing only the scene's direct resource contract. */
class FakeDevice {
    readonly buffers: FakeBuffer[] = [];
    readonly textures: FakeTexture[] = [];
    failNextTextureWriteId: string | null = null;
    private readonly copies: Array<{
        source: FakeBuffer;
        destination: FakeBuffer;
        size: number;
    }> = [];

    /** Allocates one persistent primitive store. */
    createBuffer(props: {byteLength: number}): Buffer {
        const buffer = new FakeBuffer(props.byteLength);
        this.buffers.push(buffer);
        return buffer as unknown as Buffer;
    }

    /** Allocates one scene lookup texture with observable dimensions. */
    createTexture(props: {id: string; width: number; height: number}): Texture {
        const texture = new FakeTexture(props.id, props.width, props.height);
        if (props.id === this.failNextTextureWriteId) {
            texture.failNextWrite = true;
            this.failNextTextureWriteId = null;
        }
        this.textures.push(texture);
        return texture as unknown as Texture;
    }

    /** Captures GPU-to-GPU growth copies without introducing a CPU mirror. */
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

    /** Applies recorded growth copies as the fake command submission. */
    submit(): void {
        for (const copy of this.copies.splice(0)) {
            copy.destination.bytes.set(copy.source.bytes.subarray(0, copy.size));
        }
    }
}

interface PacketOptions {
    featureId?: string;
    label?: string;
    materialKey?: bigint;
    pointByte?: number;
    zIndex?: number;
    depthTieKey?: number;
    renderOrder?: number;
}

/** Aligns the next packet table or stream to the ABI's eight-byte boundary. */
function align(offset: number): number {
    return Math.ceil(offset / 8) * 8;
}

/** Writes one table pair into the fixed packet header. */
function table(
    view: DataView,
    headerOffset: number,
    offset: number,
    count: number
): void {
    view.setUint32(headerOffset, offset, true);
    view.setUint32(headerOffset + 4, count, true);
}

/** Builds one valid point contribution packet matching a scene reservation. */
function pointPacket(
    reservation: GpuSceneRenderReservation,
    options: PacketOptions = {}
): Uint8Array {
    const labelBytes = new TextEncoder().encode(options.label ?? "");
    const streamOffset = GPU_RENDER_PACKET_HEADER_BYTES;
    const contributionOffset = streamOffset + STREAM_BYTES;
    const spanOffset = contributionOffset + CONTRIBUTION_BYTES;
    let cursor = spanOffset + SPAN_BYTES;
    const pickOffset = cursor;
    const pickCount = options.featureId ? 1 : 0;
    cursor += pickCount * PICK_BYTES;
    const memberOffset = cursor;
    const labelOffset = cursor;
    const labelCount = labelBytes.length ? 1 : 0;
    cursor += labelCount * LABEL_BYTES;
    const stringOffset = cursor;
    const strings = labelBytes;
    cursor += strings.byteLength;
    const resourceOffset = align(cursor);
    const zIndexOffset = resourceOffset;
    const recordOffset = zIndexOffset + 16;
    const totalBytes = recordOffset + POINT_BYTES;
    const bytes = new Uint8Array(totalBytes);
    const view = new DataView(bytes.buffer);
    const contribution = reservation.contributions[0];
    if (options.featureId) {
        contribution.resolvePick = () => options.featureId;
        contribution.findPickReferences = target =>
            target === options.featureId
                ? [{channelOrdinal: 0, entryOrdinal: 0, endpointRole: 0}]
                : [];
    }

    view.setUint32(0, 0x50475245, true);
    view.setUint16(4, GPU_RENDER_PACKET_ABI_VERSION, true);
    view.setUint16(6, GPU_RENDER_PACKET_HEADER_BYTES, true);
    view.setUint32(8, bytes.byteLength, true);
    view.setUint32(12, 1, true);
    view.setUint32(16, reservation.sceneGeneration, true);
    view.setUint32(20, reservation.packetSequence, true);
    view.setUint32(36, 1, true);
    view.setUint32(32, reservation.origin.slot, true);
    view.setBigUint64(40, reservation.origin.key, true);
    view.setFloat64(48, reservation.origin.position[0], true);
    view.setFloat64(56, reservation.origin.position[1], true);
    view.setFloat64(64, reservation.origin.position[2], true);

    table(view, 72, streamOffset, 1);
    table(view, 80, contributionOffset, 1);
    table(view, 88, spanOffset, 1);
    table(view, 96, pickOffset, pickCount);
    table(view, 104, memberOffset, 0);
    table(view, 112, labelOffset, labelCount);
    table(view, 120, stringOffset, strings.byteLength);
    table(view, 128, resourceOffset, 0);
    table(view, 144, resourceOffset, 0);
    table(view, 152, zIndexOffset, 1);

    view.setUint16(streamOffset, GpuPrimitiveKind.Point, true);
    view.setUint16(streamOffset + 2, GpuMaterialFlag.DepthTest, true);
    view.setBigUint64(streamOffset + 4, options.materialKey ?? 7n, true);
    view.setUint32(streamOffset + 12, POINT_BYTES, true);
    view.setUint32(streamOffset + 16, 1, true);
    view.setUint32(streamOffset + 20, recordOffset, true);
    view.setUint32(streamOffset + 24, POINT_BYTES, true);
    view.setUint32(streamOffset + 40, options.renderOrder ?? 0, true);

    view.setBigUint64(contributionOffset, contribution.key, true);
    view.setUint32(contributionOffset + 8, contribution.revision, true);
    view.setUint32(contributionOffset + 12, contribution.slot, true);
    view.setUint32(
        contributionOffset + 16,
        contribution.activationToken,
        true
    );
    view.setUint32(contributionOffset + 20, 0, true);
    view.setUint32(contributionOffset + 24, 1, true);
    view.setUint32(contributionOffset + 28, 0, true);
    view.setUint32(contributionOffset + 32, pickCount, true);
    view.setUint32(contributionOffset + 36, 0, true);
    view.setUint32(contributionOffset + 40, labelCount, true);
    view.setUint32(contributionOffset + 44, 0, true);
    view.setUint32(contributionOffset + 48, 1, true);
    view.setUint32(contributionOffset + 52, pickCount, true);

    view.setUint32(spanOffset, 0, true);
    view.setUint32(spanOffset + 4, 0, true);
    view.setUint32(spanOffset + 8, 1, true);

    if (pickCount) {
        view.setUint32(pickOffset, 0, true);
        view.setUint32(pickOffset + 4, 0, true);
        view.setUint32(pickOffset + 8, 0, true);
        view.setUint32(pickOffset + 12, 0, true);
        view.setUint32(pickOffset + 16, 0, true);
    }
    if (labelCount) {
        view.setUint32(labelOffset, 0, true);
        view.setUint32(labelOffset + 4, 0xffffffff, true);
        view.setFloat64(labelOffset + 8, 11, true);
        view.setFloat64(labelOffset + 16, 48, true);
        view.setUint32(labelOffset + 32, 0, true);
        view.setUint32(labelOffset + 36, labelBytes.length, true);
        view.setFloat32(labelOffset + 48, 12, true);
        view.setUint32(labelOffset + 96, GpuLabelFlag.Billboard, true);
        view.setUint32(labelOffset + 112, 400, true);
    }
    bytes.set(strings, stringOffset);
    view.setFloat64(zIndexOffset, options.zIndex ?? Number.NaN, true);
    view.setUint32(zIndexOffset + 8, options.depthTieKey ?? 0, true);
    bytes.fill(options.pointByte ?? 23, recordOffset, recordOffset + POINT_BYTES);
    view.setUint32(recordOffset + 16, 0, true);
    view.setUint32(recordOffset + 24, reservation.origin.slot, true);
    view.setUint32(recordOffset + 28, contribution.slot, true);
    view.setUint32(recordOffset + 32, pickCount ? 0 : 0xffffffff, true);
    view.setUint32(
        recordOffset + 36,
        1 | (contribution.activationToken << 8),
        true
    );
    return bytes;
}

/** Creates one scene with deterministic fake graphics resources. */
function createScene() {
    const device = new FakeDevice();
    const redraw = vi.fn();
    return {
        device,
        redraw,
        scene: new GpuScene(device as unknown as Device, redraw)
    };
}

/** Return the currently published texture after transactional replacements. */
function activeTexture(device: FakeDevice, id: string): FakeTexture {
    const texture = [...device.textures]
        .reverse()
        .find(candidate => candidate.id === id && !candidate.destroyed);
    if (!texture) {
        throw new Error(`No active fake texture named '${id}'.`);
    }
    return texture;
}

describe("GpuScene contribution lifecycle", () => {
    it("does not invent feature-local depth ordering for equal semantic z-index values", () => {
        expect(gpuSceneShaderModule.vs).not.toContain("tieSource");
    });

    it("rejects multi-contribution tasks at the scene boundary", () => {
        const {scene} = createScene();

        expect(() => scene.prepareRender("origin", [11, 48, 0], [
            {
                identity: "first",
                mapTileKey: "Features:Map:Layer:1:0",
                styleOrder: 0
            },
            {
                identity: "second",
                mapTileKey: "Features:Map:Layer:2:0",
                styleOrder: 0
            }
        ])).toThrow("exactly one contribution");
    });

    it("releases a new contribution when reservation allocation fails", () => {
        const {scene} = createScene();
        (scene as unknown as {nextActivationToken: number})
            .nextActivationToken = 0x00ff_ffff;

        expect(() => scene.prepareRender("origin", [11, 48, 0], [{
            identity: "failed",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }])).toThrow("exhausted its 24-bit contribution activation tokens");

        expect((scene as unknown as {
            contributionByIdentity: Map<string, unknown>;
            contributionSlots: {highWaterRecord: number};
        }).contributionByIdentity.size).toBe(0);
        expect((scene as unknown as {
            contributionSlots: {highWaterRecord: number};
        }).contributionSlots.highWaterRecord).toBe(0);
    });

    it("publishes a fragmented revision only after its final fragment", () => {
        const {scene} = createScene();
        const reservation = scene.prepareRender("origin", [11, 48, 0], [{
            identity: "fragmented",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }]);
        const first = pointPacket(reservation, {featureId: "Road.1"});
        const firstView = new DataView(first.buffer);
        firstView.setUint32(12, 0, true);
        firstView.setUint32(24, 0, true);
        firstView.setUint32(36, 2, true);
        firstView.setUint32(100, 0, true);
        firstView.setUint32(156, 0, true);
        firstView.setUint32(
            GPU_RENDER_PACKET_HEADER_BYTES + STREAM_BYTES + 32,
            0,
            true
        );
        firstView.setUint32(
            GPU_RENDER_PACKET_HEADER_BYTES + STREAM_BYTES + 48,
            0,
            true
        );
        const final = pointPacket(reservation, {featureId: "Road.1"});
        const finalView = new DataView(final.buffer);
        finalView.setUint32(24, 1, true);
        finalView.setUint32(36, 2, true);
        finalView.setUint32(76, 0, true);
        finalView.setUint32(92, 0, true);
        finalView.setUint32(
            GPU_RENDER_PACKET_HEADER_BYTES + STREAM_BYTES + 24,
            0,
            true
        );

        expect(scene.applyPacket(first, reservation)).toBeNull();
        expect(scene.snapshot()).toMatchObject({
            activeContributionCount: 0,
            pickingHighWater: 0
        });
        expect(scene.resolvePick(0)).toEqual([]);

        expect(scene.applyPacket(final, reservation)).toMatchObject({
            appliedContributions: 1
        });
        scene.finishRender(reservation);
        expect(scene.snapshot()).toMatchObject({
            activeContributionCount: 1,
            stores: [{highWaterRecords: 1}],
            pickingHighWater: 1
        });
        expect(scene.resolvePick(0)).toEqual([{
            mapTileKey: "Features:Map:Layer:1:0",
            featureId: "Road.1"
        }]);
    });

    it("rolls back an incomplete fragmented revision on task release", () => {
        const {scene} = createScene();
        const reservation = scene.prepareRender("origin", [11, 48, 0], [{
            identity: "fragmented",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }]);
        const first = pointPacket(reservation);
        const view = new DataView(first.buffer);
        view.setUint32(12, 0, true);
        view.setUint32(36, 2, true);

        expect(scene.applyPacket(first, reservation)).toBeNull();
        scene.finishRender(reservation);
        expect(scene.snapshot()).toMatchObject({
            activeContributionCount: 0,
            materialCount: 0,
            stores: []
        });
    });

    it("consolidates tiles and origins into one material store", () => {
        const {scene} = createScene();
        for (const [index, origin] of [[11, 48, 0], [12, 49, 0]].entries()) {
            const reservation = scene.prepareRender(
                `origin-${index}`,
                origin as [number, number, number],
                [{
                    identity: `tile-${index}`,
                    mapTileKey: `Features:Map:Layer:${index}:0`,
                    styleOrder: 3
                }]
            );
            scene.applyPacket(pointPacket(reservation), reservation);
            scene.finishRender(reservation);
        }

        expect(scene.snapshot()).toMatchObject({
            materialCount: 1,
            activeContributionCount: 2,
            activeOriginCount: 2,
            stores: [{highWaterRecords: 2, fragmentedRecords: 0}]
        });
        expect(scene.materialStores()).toHaveLength(1);
    });

    it("partitions draw buffers by bounded style order rather than by tile", () => {
        const {scene} = createScene();
        for (const styleOrder of [7, 2]) {
            const reservation = scene.prepareRender(
                "origin",
                [11, 48, 0],
                [{
                    identity: `style-${styleOrder}`,
                    mapTileKey: `Features:Map:Layer:${styleOrder}:0`,
                    styleOrder
                }]
            );
            scene.applyPacket(pointPacket(reservation), reservation);
            scene.finishRender(reservation);
        }

        expect(scene.snapshot()).toMatchObject({
            materialCount: 2,
            activeContributionCount: 2,
            activeOriginCount: 1
        });
        expect(scene.materialStores().map(store => store.styleOrder).sort())
            .toEqual([2, 7]);
    });

    it("partitions authored concrete rules without making tiles draw buckets", () => {
        const {scene} = createScene();
        for (const renderOrder of [7, 2]) {
            const reservation = scene.prepareRender(
                "origin",
                [11, 48, 0],
                [{
                    identity: `rule-${renderOrder}`,
                    mapTileKey: `Features:Map:Layer:${renderOrder}:0`,
                    styleOrder: 3
                }]
            );
            scene.applyPacket(pointPacket(reservation, {
                materialKey: BigInt(renderOrder),
                renderOrder
            }), reservation);
            scene.finishRender(reservation);
        }

        expect(scene.materialStores().map(store => store.renderOrder).sort())
            .toEqual([2, 7]);
    });

    it("globally ranks exact z values at the presentation boundary", () => {
        const {device, scene} = createScene();
        for (const [index, zIndex] of [65535, 65535.0001].entries()) {
            const reservation = scene.prepareRender(
                "origin",
                [11, 48, 0],
                [{
                    identity: `z-${index}`,
                    mapTileKey: `Features:Map:Layer:${index}:0`,
                    styleOrder: 0
                }]
            );
            scene.applyPacket(pointPacket(reservation, {zIndex}), reservation);
            scene.finishRender(reservation);
        }

        expect(new Set(new Float32Array([65535, 65535.0001])).size).toBe(1);
        expect(scene.snapshot().zIndexHighWater).toBe(2);
        scene.publishPresentation();
        const texture = activeTexture(device, "erdblick-gpu-z-index-table");
        const ranked = texture.writes.at(-1)!.data as Float32Array;
        expect(ranked[4]).toBeGreaterThan(ranked[0]);
    });

    it("assigns matching semantic ties the same depth across tile contributions", () => {
        const {device, scene} = createScene();
        for (const tileId of [1, 2]) {
            const reservation = scene.prepareRender(
                "origin",
                [11, 48, 0],
                [{
                    identity: `tile-${tileId}`,
                    mapTileKey: `Features:Map:Layer:${tileId}:0`,
                    styleOrder: 0
                }]
            );
            scene.applyPacket(pointPacket(reservation, {
                featureId: `Road.${tileId}`,
                zIndex: 10,
                depthTieKey: 17
            }), reservation);
            scene.finishRender(reservation);
        }

        scene.publishPresentation();
        const zTexture = activeTexture(device, "erdblick-gpu-z-index-table");
        const ranked = zTexture.writes.at(-1)!.data as Float32Array;
        expect(ranked[0]).toBe(ranked[4]);
        expect(ranked[1]).toBe(0);
        expect(ranked[5]).toBe(0);
        const contributionTexture = activeTexture(
            device,
            "erdblick-gpu-contribution-table"
        );
        const contributions = contributionTexture.writes.at(-1)!
            .data as Float32Array;
        expect(contributions[1]).toBe(0);
        expect(contributions[5]).toBe(0);
    });

    it("separates distinct semantic ties at the same authored depth", () => {
        const {device, scene} = createScene();
        for (const [tileId, depthTieKey] of [[1, 17], [2, 18]]) {
            const reservation = scene.prepareRender(
                "origin",
                [11, 48, 0],
                [{
                    identity: `tile-${tileId}`,
                    mapTileKey: `Features:Map:Layer:${tileId}:0`,
                    styleOrder: 0
                }]
            );
            scene.applyPacket(pointPacket(reservation, {
                zIndex: 10,
                depthTieKey
            }), reservation);
            scene.finishRender(reservation);
        }

        scene.publishPresentation();
        const ranked = activeTexture(device, "erdblick-gpu-z-index-table")
            .writes.at(-1)!.data as Float32Array;
        expect(ranked[0]).not.toBe(ranked[4]);
    });

    it("retains tie separation when many unrelated authored depths consume the scene", () => {
        const {device, scene} = createScene();
        const install = (
            identity: string,
            tileId: number,
            zIndex: number,
            depthTieKey: number
        ) => {
            const reservation = scene.prepareRender(
                "origin",
                [11, 48, 0],
                [{
                    identity,
                    mapTileKey: `Features:Map:Layer:${tileId}:0`,
                    styleOrder: 0
                }]
            );
            scene.applyPacket(pointPacket(reservation, {
                zIndex,
                depthTieKey
            }), reservation);
            scene.finishRender(reservation);
        };
        install("tied-a", 1, 0, 16);
        install("tied-b", 2, 0, 17);
        for (let zIndex = 1; zIndex <= 512; zIndex++) {
            install(`unique-${zIndex}`, zIndex + 2, zIndex, 0);
        }

        scene.publishPresentation();
        const ranked = activeTexture(device, "erdblick-gpu-z-index-table")
            .writes.at(-1)!.data as Float32Array;
        expect(ranked[0]).not.toBe(ranked[4]);
        expect(ranked[8]).toBeGreaterThan(Math.max(ranked[0], ranked[4]));
    });

    it("defers whole-scene z-index ranking while packets are arriving", () => {
        const {device, scene} = createScene();
        const install = (identity: string, tileId: number) => {
            const reservation = scene.prepareRender(
                "origin",
                [11, 48, 0],
                [{
                    identity,
                    mapTileKey: `Features:Map:Layer:${tileId}:0`,
                    styleOrder: 0
                }]
            );
            scene.applyPacket(pointPacket(reservation, {zIndex: 10}), reservation);
            scene.finishRender(reservation);
        };

        install("first", 1);
        const texture = activeTexture(device, "erdblick-gpu-z-index-table");
        const writesBefore = texture.writes.length;
        install("second", 2);

        expect(texture.writes.length - writesBefore).toBe(1);
        scene.publishPresentation();
        expect(activeTexture(device, "erdblick-gpu-z-index-table"))
            .not.toBe(texture);
    });

    it("rejects a superseded packet without replacing the visible revision", () => {
        const {scene} = createScene();
        const input = [{
            identity: "tile",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }];
        const initial = scene.prepareRender("origin", [11, 48, 0], input);
        scene.applyPacket(pointPacket(initial, {pointByte: 1}), initial);
        scene.finishRender(initial);
        const stale = scene.prepareRender("origin", [11, 48, 0], input);
        const current = scene.prepareRender("origin", [11, 48, 0], input);

        expect(scene.applyPacket(pointPacket(stale, {pointByte: 2}), stale))
            .toMatchObject({appliedContributions: 0});
        expect(scene.snapshot().activeContributionCount).toBe(1);
        expect(scene.applyPacket(pointPacket(current, {pointByte: 3}), current))
            .toMatchObject({appliedContributions: 1});
        scene.finishRender(stale);
        scene.finishRender(current);
        expect(scene.snapshot()).toMatchObject({
            activeContributionCount: 1,
            activeOriginCount: 1
        });
    });

    it("preserves the prior revision when packet validation fails", () => {
        const {scene} = createScene();
        const input = [{
            identity: "tile",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }];
        const initial = scene.prepareRender("origin", [11, 48, 0], input);
        scene.applyPacket(pointPacket(initial), initial);
        scene.finishRender(initial);
        const replacement = scene.prepareRender("origin", [11, 48, 0], input);
        const corrupt = pointPacket(replacement);
        corrupt[0] = 0;

        expect(() => scene.applyPacket(corrupt, replacement)).toThrow(/magic/);
        scene.finishRender(replacement);
        expect(scene.snapshot()).toMatchObject({
            activeContributionCount: 1,
            activeOriginCount: 1,
            stores: [{highWaterRecords: 1}]
        });
    });

    it("keeps the active revision isolated from a failed replacement upload", () => {
        const {device, scene} = createScene();
        const input = [{
            identity: "tile",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }];
        const initial = scene.prepareRender("origin", [11, 48, 0], input);
        scene.applyPacket(pointPacket(initial, {
            featureId: "Road.1",
            label: "Main Street"
        }), initial);
        scene.finishRender(initial);

        const replacement = scene.prepareRender("origin", [11, 48, 0], input);
        expect(replacement.contributions[0].slot)
            .not.toBe(initial.contributions[0].slot);
        device.buffers.at(-1)!.failNextWrite = true;
        expect(() => scene.applyPacket(pointPacket(replacement), replacement))
            .toThrow(/Synthetic buffer/);
        scene.finishRender(replacement);

        expect(scene.snapshot()).toMatchObject({
            activeContributionCount: 1,
            activeOriginCount: 1,
            pickingHighWater: 1,
            labels: 1,
            stores: [{highWaterRecords: 1}]
        });
        expect(scene.resolvePick(0)).toEqual([{
            mapTileKey: "Features:Map:Layer:1:0",
            featureId: "Road.1"
        }]);
        expect(scene.labels()).toMatchObject([{text: "Main Street"}]);

        const retry = scene.prepareRender("origin", [11, 48, 0], input);
        expect(retry.contributions[0].slot).toBe(replacement.contributions[0].slot);
        scene.finishRender(retry);
    });

    it("does not publish a revision whose exact-order lookup upload fails", () => {
        const {device, scene} = createScene();
        const input = [{
            identity: "tile",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }];
        const initial = scene.prepareRender("origin", [11, 48, 0], input);
        scene.applyPacket(pointPacket(initial, {
            featureId: "Road.1",
            zIndex: 10
        }), initial);
        scene.finishRender(initial);
        const replacement = scene.prepareRender("origin", [11, 48, 0], input);
        const zLookup = device.textures.find(
            texture => texture.id === "erdblick-gpu-z-index-table"
        )!;
        zLookup.failNextWrite = true;

        expect(() => scene.applyPacket(
            pointPacket(replacement, {featureId: "Road.2", zIndex: 10}),
            replacement
        )).toThrow(/Synthetic texture/);
        scene.finishRender(replacement);

        expect(scene.snapshot()).toMatchObject({
            activeContributionCount: 1,
            pickingHighWater: 1,
            zIndexHighWater: 1
        });
        expect(scene.resolvePick(0)).toEqual([{
            mapTileKey: "Features:Map:Layer:1:0",
            featureId: "Road.1"
        }]);
    });

    it("keeps the prior presentation when predecessor deactivation fails", () => {
        const {device, scene} = createScene();
        const input = [{
            identity: "tile",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }];
        const initial = scene.prepareRender("origin", [11, 48, 0], input);
        scene.applyPacket(pointPacket(initial, {
            featureId: "Road.1",
            zIndex: 10
        }), initial);
        scene.finishRender(initial);
        scene.publishPresentation();
        const presentedRevision = scene.presentationRevision;
        const contributionLookup = activeTexture(
            device,
            "erdblick-gpu-contribution-table"
        );
        const replacement = scene.prepareRender("origin", [11, 48, 0], input);

        scene.applyPacket(pointPacket(replacement, {
            featureId: "Road.2",
            zIndex: 10
        }), replacement);
        scene.finishRender(replacement);
        device.failNextTextureWriteId = "erdblick-gpu-contribution-table";

        expect(() => scene.publishPresentation()).toThrow(/Synthetic texture/);
        expect(scene.presentationRevision).toBe(presentedRevision);
        expect(contributionLookup.destroyed).toBe(false);
        expect(scene.resolvePick(0)).toEqual([{
            mapTileKey: "Features:Map:Layer:1:0",
            featureId: "Road.1"
        }]);
    });

    it("publishes a storage generation when inactive staging grows a shared buffer", () => {
        const {device, redraw, scene} = createScene();
        for (let index = 0; index < 64; ++index) {
            const reservation = scene.prepareRender(
                "origin",
                [11, 48, 0],
                [{
                    identity: `retained-${index}`,
                    mapTileKey: `Features:Map:Layer:${index}:0`,
                    styleOrder: 0
                }]
            );
            scene.applyPacket(pointPacket(reservation, {
                pointByte: index + 1
            }), reservation);
            scene.finishRender(reservation);
        }
        const store = scene.materialStores()[0].store;
        const oldBuffer = store.buffer as unknown as FakeBuffer;
        const oldRevision = scene.revision;
        const staging = scene.prepareRender("origin", [11, 48, 0], [{
            identity: "staging",
            mapTileKey: "Features:Map:Layer:64:0",
            styleOrder: 0
        }]);
        const firstFragment = pointPacket(staging, {pointByte: 99});
        const view = new DataView(firstFragment.buffer);
        view.setUint32(12, 0, true);
        view.setUint32(36, 2, true);

        expect(scene.applyPacket(firstFragment, staging)).toBeNull();

        const newBuffer = store.buffer as unknown as FakeBuffer;
        expect(newBuffer).not.toBe(oldBuffer);
        expect(oldBuffer.destroyed).toBe(true);
        expect(newBuffer.bytes[0]).toBe(oldBuffer.bytes[0]);
        expect(store.bufferRevision).toBe(2);
        expect(scene.revision).toBe(oldRevision + 1);
        expect(redraw).toHaveBeenLastCalledWith("GPU material buffer replaced");
        expect(scene.snapshot().activeContributionCount).toBe(64);

        scene.finishRender(staging);
        expect(store.highWaterRecord).toBe(64);
        expect(device.buffers).toHaveLength(2);
    });

    it("retains a presented lookup texture while staging grows its allocation", () => {
        const {scene} = createScene();
        const install = (index: number) => {
            const reservation = scene.prepareRender(
                `origin-${index}`,
                [11 + index / 1000, 48, 0],
                [{
                    identity: `tile-${index}`,
                    mapTileKey: `Features:Map:Layer:${index}:0`,
                    styleOrder: 0
                }]
            );
            scene.applyPacket(pointPacket(reservation), reservation);
            scene.finishRender(reservation);
        };
        for (let index = 0; index < 512; ++index) {
            install(index);
        }
        scene.publishPresentation();
        const presented = scene.originTexture as unknown as FakeTexture;

        install(512);

        expect(scene.originTexture).toBe(presented);
        expect(presented.destroyed).toBe(false);
        scene.publishPresentation();
        expect(scene.originTexture).not.toBe(presented);
        expect(presented.destroyed).toBe(false);
        scene.releaseRetiredPresentationResources();
        expect(presented.destroyed).toBe(true);
    });

    it("rejects late worker reservations after context-owned resources die", () => {
        const {scene} = createScene();
        const reservation = scene.prepareRender("origin", [11, 48, 0], [{
            identity: "tile",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }]);

        expect(scene.accepts(reservation)).toBe(true);
        scene.destroy();
        expect(scene.accepts(reservation)).toBe(false);
        scene.finishRender(reservation);
    });

    it("recycles contribution and origin slots only after all owners release", () => {
        const {scene} = createScene();
        const first = scene.prepareRender("first-origin", [11, 48, 0], [{
            identity: "first-tile",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }]);
        scene.applyPacket(pointPacket(first), first);
        scene.finishRender(first);
        scene.publishPresentation();
        expect(scene.removeContribution("first-tile")).toBe(false);
        scene.publishPresentation();

        const second = scene.prepareRender("second-origin", [12, 49, 0], [{
            identity: "second-tile",
            mapTileKey: "Features:Map:Layer:2:0",
            styleOrder: 0
        }]);
        expect(second.origin.slot).toBe(first.origin.slot);
        expect(second.contributions[0].slot).toBe(first.contributions[0].slot);
        scene.finishRender(second);
    });

    it("keeps stale holes inert when their contribution slot is recycled", () => {
        const {device, scene} = createScene();
        const install = (
            identity: string,
            tileId: number,
            materialKey: bigint,
            pointByte: number
        ) => {
            const reservation = scene.prepareRender("origin", [11, 48, 0], [{
                identity,
                mapTileKey: `Features:Map:Layer:${tileId}:0`,
                styleOrder: 0
            }]);
            scene.applyPacket(pointPacket(reservation, {
                materialKey,
                pointByte
            }), reservation);
            scene.finishRender(reservation);
            return reservation;
        };
        const stale = install("stale", 1, 7n, 31);
        install("retained", 2, 7n, 47);
        scene.publishPresentation();
        const oldStore = device.buffers.at(-1)!;
        const oldStoreView = new DataView(
            oldStore.bytes.buffer,
            oldStore.bytes.byteOffset,
            oldStore.bytes.byteLength
        );
        const oldRecordWord = oldStoreView.getUint32(36, true);

        scene.removeContribution("stale");
        expect(oldStoreView.getUint32(36, true)).toBe(oldRecordWord);
        scene.publishPresentation();

        const replacement = install("replacement", 3, 8n, 59);
        expect(replacement.contributions[0].slot)
            .toBe(stale.contributions[0].slot);
        expect(replacement.contributions[0].activationToken)
            .not.toBe(stale.contributions[0].activationToken);
        expect(oldRecordWord >>> 8)
            .toBe(stale.contributions[0].activationToken);

        const contributionTexture = activeTexture(
            device,
            "erdblick-gpu-contribution-table"
        );
        const publishedToken = [...contributionTexture.writes]
            .reverse()
            .map(write => write.data as Float32Array)
            .find(data => data.length === 4)?.[2];
        expect(publishedToken)
            .toBe(replacement.contributions[0].activationToken);
    });

    it("retains exact picking and reports label ownership changes", () => {
        const {scene} = createScene();
        const reservation = scene.prepareRender("origin", [11, 48, 0], [{
            identity: "tile",
            mapTileKey: "Features:Map:Layer:1:0",
            styleOrder: 0
        }]);
        const packet = pointPacket(reservation, {
            featureId: "Road.1",
            label: "Main Street"
        });
        const result = scene.applyPacket(packet, reservation);
        scene.finishRender(reservation);
        scene.publishPresentation();

        expect(result.labelsChanged).toBe(true);
        expect(scene.labels()).toMatchObject([{
            text: "Main Street",
            styleOrder: 0
        }]);
        expect((scene as unknown as {
            picks: Map<number, unknown>;
        }).picks.size).toBe(0);
        packet.fill(0);
        expect(scene.resolvePick(0)).toEqual([{
            mapTileKey: "Features:Map:Layer:1:0",
            featureId: "Road.1"
        }]);
        expect((scene as unknown as {
            picks: Map<number, unknown>;
        }).picks.size).toBe(1);
        expect(scene.removeContribution("tile")).toBe(true);
        expect(scene.labels()).toEqual([]);
        expect(scene.resolvePick(0)).toEqual([{
            mapTileKey: "Features:Map:Layer:1:0",
            featureId: "Road.1"
        }]);
        scene.publishPresentation();
        expect(scene.resolvePick(0)).toEqual([]);
    });

    it("removes a coverage delta with one scene revision and redraw", () => {
        const {scene, redraw} = createScene();
        for (const [identity, tileId] of [["first", 1], ["second", 2]] as const) {
            const reservation = scene.prepareRender(
                "origin",
                [11, 48, 0],
                [{
                    identity,
                    mapTileKey: `Features:Map:Layer:${tileId}:0`,
                    styleOrder: 0
                }]
            );
            scene.applyPacket(pointPacket(reservation), reservation);
            scene.finishRender(reservation);
        }
        const revisionBeforeRemoval = scene.revision;
        redraw.mockClear();

        expect(scene.removeContributions(["first", "second"])).toBe(false);

        expect(scene.revision).toBe(revisionBeforeRemoval + 1);
        expect(scene.snapshot().activeContributionCount).toBe(0);
        expect(redraw).toHaveBeenCalledOnce();
        expect(redraw).toHaveBeenCalledWith("GPU scene contributions removed");
    });
});
