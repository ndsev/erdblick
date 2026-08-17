export const GPU_RENDER_PACKET_ABI_VERSION = 10;
export const GPU_RENDER_PACKET_HEADER_BYTES = 160;
// One oversized packet is still admitted by itself, so this ceiling is also
// the maximum unavoidable geometry upload burst from one worker task.
export const GPU_RENDER_PACKET_MAX_BYTES = 4 * 1024 * 1024;
export const GPU_RENDER_PACKET_MAX_FRAGMENTS = 8;

const GPU_RENDER_PACKET_MAGIC = 0x50475245;
const STREAM_DESCRIPTOR_BYTES = 48;
const CONTRIBUTION_DESCRIPTOR_BYTES = 56;
const CONTRIBUTION_SPAN_BYTES = 16;
const PICK_RECORD_BYTES = 24;
const PICK_MEMBER_BYTES = 8;
const LABEL_RECORD_BYTES = 120;
const RESOURCE_RECORD_BYTES = 24;
const ISSUE_RECORD_BYTES = 40;
const GPU_ACTIVATION_TOKEN_MAX = 0x00ff_ffff;
const UTF8_DECODER = new TextDecoder();

export enum GpuPrimitiveKind {
    Point = 1,
    PathSegment = 2,
    Arrow = 3,
    SurfaceTriangle = 4,
    Icon = 5
}

export enum GpuRenderPacketFlag {
    RevisionComplete = 1 << 0
}

export enum GpuMaterialFlag {
    Billboard = 1 << 0,
    DepthTest = 1 << 1,
    CompactPath = 1 << 2,
    SimplePath = 1 << 3,
    DualStrokePath = 1 << 4
}

export enum GpuLabelFlag {
    Billboard = 1 << 0,
    DepthTest = 1 << 1,
    Background = 1 << 2,
    Collision = 1 << 3
}

/** Browser resource categories emitted by native packet generation. */
export enum GpuResourceKind {
    Icon = 1
}

export interface GpuPacketOrigin {
    slot: number;
    key: bigint;
    longitude: number;
    latitude: number;
    altitude: number;
}

export interface GpuRecordStreamView {
    kind: GpuPrimitiveKind;
    flags: number;
    materialKey: bigint;
    recordStride: number;
    recordCount: number;
    records: Uint8Array;
    glowColor: [number, number, number, number];
    glowRadius: number;
    atlasPage: number;
    renderOrder: number;
}

export interface GpuContributionSpanView {
    streamIndex: number;
    firstRecord: number;
    recordCount: number;
}

/** One authored z-index and its contribution-independent rule-order tie key. */
export interface GpuZIndexEntryView {
    value: number;
    tieBreaker: number;
}

export interface GpuContributionView {
    key: bigint;
    revision: number;
    slot: number;
    activationToken: number;
    totalPickCount: number;
    spans: GpuContributionSpanView[];
    firstPick: number;
    pickCount: number;
    firstLabel: number;
    labelCount: number;
    zIndices: GpuZIndexEntryView[];
}

export interface GpuPickRecordView {
    contributionIndex: number;
    localPickIndex: number;
    channelOrdinal: number;
    entryOrdinal: number;
    endpointRole: number;
    navigationAltitude: number;
}

interface PickStorage {
    picks: DataView;
    pickCount: number;
}

/** Validate one string-table reference without materializing a JavaScript string. */
function validateStringReference(
    strings: Uint8Array,
    offset: number,
    length: number
): void {
    if (offset > strings.byteLength || length > strings.byteLength - offset) {
        throw new Error("GPU render packet string reference is invalid.");
    }
}

/** Decode one UTF-8 string only when semantic picking actually consumes it. */
function decodeString(
    strings: Uint8Array,
    offset: number,
    length: number
): string {
    validateStringReference(strings, offset, length);
    return length === 0
        ? ""
        : UTF8_DECODER.decode(strings.subarray(offset, offset + length));
}

/** Bounds-check and return one pick record's byte offset. */
function pickOffset(storage: PickStorage, index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= storage.pickCount) {
        throw new Error("GPU pick index is out of range.");
    }
    return index * PICK_RECORD_BYTES;
}

/** Materialize one compact source-row identity from retained packet bytes. */
function decodePickRecord(
    storage: PickStorage,
    index: number
): GpuPickRecordView {
    const offset = pickOffset(storage, index);
    return {
        contributionIndex: storage.picks.getUint32(offset, true),
        localPickIndex: storage.picks.getUint32(offset + 4, true),
        channelOrdinal: storage.picks.getUint32(offset + 8, true),
        entryOrdinal: storage.picks.getUint32(offset + 12, true),
        endpointRole: storage.picks.getUint32(offset + 16, true),
        navigationAltitude: storage.picks.getFloat32(offset + 20, true)
    };
}

/**
 * Compact subset-row references retained after packet geometry bytes are released.
 */
export class GpuRetainedPickTable {
    private readonly storage: PickStorage;

    /** Own copied tuple bytes independent of the source packet. */
    constructor(picks: Uint8Array) {
        if (picks.byteLength % PICK_RECORD_BYTES !== 0) {
            throw new Error("Retained GPU pick table has an invalid layout.");
        }
        this.storage = {
            picks: new DataView(
                picks.buffer,
                picks.byteOffset,
                picks.byteLength
            ),
            pickCount: picks.byteLength / PICK_RECORD_BYTES
        };
    }

    /** Number of dense contribution-local records retained in this fragment. */
    get count(): number { return this.storage.pickCount; }

    /** First contribution-local index, or zero for an empty table. */
    get firstLocalPickIndex(): number {
        return this.count === 0 ? 0 : this.localPickIndex(0);
    }

    /** Read one numeric local index without decoding semantic strings. */
    localPickIndex(index: number): number {
        return this.storage.picks.getUint32(
            pickOffset(this.storage, index) + 4,
            true
        );
    }

    /** Read one source-row tuple after Deck or an interaction lookup selects it. */
    record(index: number): GpuPickRecordView {
        return decodePickRecord(this.storage, index);
    }
}

/**
 * Validated zero-copy view over a packet's compact source-row pick tuples.
 */
export class GpuPickTableView {
    private readonly storage: PickStorage;

    /** Validate fixed tuple fields while retaining a zero-copy packet view. */
    constructor(packet: Uint8Array, picks: PacketTable) {
        this.storage = {
            picks: new DataView(
                packet.buffer,
                packet.byteOffset + picks.offset,
                picks.byteLength
            ),
            pickCount: picks.count
        };
        this.validate();
    }

    /** Number of packed records in this packet fragment. */
    get count(): number { return this.storage.pickCount; }

    /** Read one contribution owner without creating a semantic object. */
    contributionIndex(index: number): number {
        return this.storage.picks.getUint32(
            pickOffset(this.storage, index),
            true
        );
    }

    /** Read one contribution-local index without decoding strings. */
    localPickIndex(index: number): number {
        return this.storage.picks.getUint32(
            pickOffset(this.storage, index) + 4,
            true
        );
    }

    /** Read one exact source-row tuple for an immediate consumer. */
    record(index: number): GpuPickRecordView {
        return decodePickRecord(this.storage, index);
    }

    /** Copy only one owned tuple range so the large geometry packet can die. */
    retainRange(first: number, count: number): GpuRetainedPickTable {
        if (!Number.isInteger(first) || !Number.isInteger(count) ||
            first < 0 || count < 0 || first > this.count ||
            count > this.count - first) {
            throw new Error("GPU pick retention range is invalid.");
        }
        const pickBytes = new Uint8Array(
            this.storage.picks.buffer,
            this.storage.picks.byteOffset + first * PICK_RECORD_BYTES,
            count * PICK_RECORD_BYTES
        ).slice();
        return new GpuRetainedPickTable(pickBytes);
    }

    /** Reject infinite navigation heights without allocating semantic objects. */
    private validate(): void {
        for (let index = 0; index < this.count; ++index) {
            const offset = index * PICK_RECORD_BYTES;
            const navigationAltitude = this.storage.picks.getFloat32(
                offset + 20,
                true
            );
            if (!Number.isFinite(navigationAltitude) &&
                !Number.isNaN(navigationAltitude)) {
                throw new Error(
                    `GPU pick ${index} has an infinite navigation altitude.`
                );
            }
        }
    }
}

export interface GpuLabelRecordView {
    contributionIndex: number;
    localPickIndex: number;
    position: [number, number, number];
    text: string;
    fontFamily: string;
    size: number;
    pixelOffset: [number, number];
    angle: number;
    zIndex: number;
    color: [number, number, number, number];
    outlineColor: [number, number, number, number];
    backgroundColor: [number, number, number, number];
    outlineWidth: number;
    backgroundPadding: [number, number];
    flags: number;
    horizontalOrigin: number;
    verticalOrigin: number;
    renderOrder: number;
    fontWeight: number;
    collisionPriority: number;
}

export interface GpuResourceRequestView {
    resourceKind: number;
    uri: string;
}

export interface GpuRuntimeIssueView {
    contributionIndex: number;
    ruleIndex: number;
    occurrenceCount: bigint;
    property: string;
    expression: string;
    message: string;
}

interface PacketTable {
    offset: number;
    count: number;
    byteLength: number;
}

/**
 * Validated zero-copy view over one worker-produced GPU packet.
 *
 * Primitive streams remain views into the transferred buffer. Only semantic
 * strings and the small descriptor tables become JavaScript objects.
 */
export class GpuRenderPacketView {
    readonly sceneGeneration: number;
    readonly packetSequence: number;
    readonly fragmentIndex: number;
    readonly fragmentCount: number;
    readonly revisionComplete: boolean;
    readonly iconCatalogVersion: number;
    readonly origin: GpuPacketOrigin;
    readonly streams: GpuRecordStreamView[];
    readonly contributions: GpuContributionView[];
    readonly picks: GpuPickTableView;
    readonly labels: GpuLabelRecordView[];
    readonly resourceRequests: GpuResourceRequestView[];
    readonly issues: GpuRuntimeIssueView[];

    private readonly data: DataView;
    private readonly bytes: Uint8Array;
    private readonly packetRanges: Array<{offset: number; byteLength: number}> = [];
    private readonly stringTable: PacketTable;

    /** Validate the complete packet before exposing any record range. */
    constructor(packet: Uint8Array) {
        if (packet.byteLength < GPU_RENDER_PACKET_HEADER_BYTES ||
            packet.byteLength > GPU_RENDER_PACKET_MAX_BYTES) {
            throw new Error("GPU render packet size is invalid.");
        }
        this.bytes = packet;
        this.data = new DataView(
            packet.buffer,
            packet.byteOffset,
            packet.byteLength
        );
        if (this.u32(0) !== GPU_RENDER_PACKET_MAGIC) {
            throw new Error("GPU render packet magic does not match.");
        }
        if (this.u16(4) !== GPU_RENDER_PACKET_ABI_VERSION ||
            this.u16(6) !== GPU_RENDER_PACKET_HEADER_BYTES) {
            throw new Error("GPU render packet ABI is unsupported.");
        }
        if (this.u32(8) !== packet.byteLength) {
            throw new Error("GPU render packet byte length does not match.");
        }
        const flags = this.u32(12);
        this.sceneGeneration = this.u32(16);
        this.packetSequence = this.u32(20);
        this.fragmentIndex = this.u32(24);
        this.fragmentCount = this.u32(36);
        this.revisionComplete =
            (flags & GpuRenderPacketFlag.RevisionComplete) !== 0;
        if ((flags & ~GpuRenderPacketFlag.RevisionComplete) !== 0 ||
            this.fragmentCount === 0 ||
            this.fragmentCount > GPU_RENDER_PACKET_MAX_FRAGMENTS ||
            this.fragmentIndex >= this.fragmentCount ||
            this.revisionComplete !==
                (this.fragmentIndex + 1 === this.fragmentCount)) {
            throw new Error("GPU render packet fragment lifecycle is invalid.");
        }
        this.iconCatalogVersion = this.u32(28);
        this.origin = {
            slot: this.u32(32),
            key: this.u64(40),
            longitude: this.f64(48),
            latitude: this.f64(56),
            altitude: this.f64(64)
        };

        const streamTable = this.table(72, STREAM_DESCRIPTOR_BYTES);
        const contributionTable = this.table(80, CONTRIBUTION_DESCRIPTOR_BYTES);
        const spanTable = this.table(88, CONTRIBUTION_SPAN_BYTES);
        const pickTable = this.table(96, PICK_RECORD_BYTES);
        const memberTable = this.table(104, PICK_MEMBER_BYTES);
        const labelTable = this.table(112, LABEL_RECORD_BYTES);
        this.stringTable = this.table(120, 1);
        const resourceTable = this.table(128, RESOURCE_RECORD_BYTES);
        if (this.u32(136) !== 0 || this.u32(140) !== 0) {
            throw new Error("GPU render packet reserved table is nonzero.");
        }
        const issueTable = this.table(144, ISSUE_RECORD_BYTES);
        const zIndexTable = this.table(152, 16);

        this.streams = this.readStreams(streamTable);
        const spans = this.readSpans(spanTable);
        this.contributions = this.readContributions(
            contributionTable,
            spans,
            pickTable.count,
            labelTable.count,
            zIndexTable
        );
        if (memberTable.count !== 0) {
            throw new Error("GPU compact pick member table must be empty.");
        }
        this.picks = new GpuPickTableView(this.bytes, pickTable);
        this.labels = this.readLabels(labelTable);
        this.resourceRequests = this.readResources(resourceTable);
        this.issues = this.readIssues(issueTable);
        this.validatePacketRanges();
        this.validateContributionOwnership();
    }

    /** Read and validate all physical stream descriptors without copying bytes. */
    private readStreams(table: PacketTable): GpuRecordStreamView[] {
        const expectedStrides: Record<number, number> = {
            [GpuPrimitiveKind.Point]: 40,
            [GpuPrimitiveKind.PathSegment]: 144,
            [GpuPrimitiveKind.Arrow]: 68,
            [GpuPrimitiveKind.SurfaceTriangle]: 60,
            [GpuPrimitiveKind.Icon]: 68
        };
        return Array.from({length: table.count}, (_, index) => {
            const offset = table.offset + index * STREAM_DESCRIPTOR_BYTES;
            const kind = this.u16(offset) as GpuPrimitiveKind;
            const flags = this.u16(offset + 2);
            const recordStride = this.u32(offset + 12);
            const recordCount = this.u32(offset + 16);
            const recordsOffset = this.u32(offset + 20);
            const recordsBytes = this.u32(offset + 24);
            const glowRadius = this.f32(offset + 32);
            const compactPath =
                (flags & GpuMaterialFlag.CompactPath) !== 0;
            const simplePath =
                (flags & GpuMaterialFlag.SimplePath) !== 0;
            const dualStrokePath =
                (flags & GpuMaterialFlag.DualStrokePath) !== 0;
            const expectedStride = compactPath && simplePath
                ? -1
                : dualStrokePath && !compactPath && !simplePath
                    ? -1
                : simplePath
                    ? kind === GpuPrimitiveKind.PathSegment
                        ? dualStrokePath ? 60 : 52
                        : -1
                    : compactPath
                        ? kind === GpuPrimitiveKind.PathSegment
                            ? dualStrokePath ? 84 : 76
                            : -1
                        : expectedStrides[kind];
            if (expectedStride !== recordStride ||
                recordCount * recordStride !== recordsBytes ||
                !Number.isFinite(glowRadius) || glowRadius < 0 ||
                this.u32(offset + 44) !== 0 ||
                (flags & ~(
                    GpuMaterialFlag.Billboard | GpuMaterialFlag.DepthTest
                    | GpuMaterialFlag.CompactPath | GpuMaterialFlag.SimplePath
                    | GpuMaterialFlag.DualStrokePath
                )) !== 0) {
                throw new Error(`GPU stream ${index} has an invalid record layout.`);
            }
            this.range(recordsOffset, recordsBytes, 8);
            this.packetRanges.push({offset: recordsOffset, byteLength: recordsBytes});
            return {
                kind,
                flags,
                materialKey: this.u64(offset + 4),
                recordStride,
                recordCount,
                records: this.bytes.subarray(
                    recordsOffset,
                    recordsOffset + recordsBytes
                ),
                glowColor: [
                    this.u8(offset + 28),
                    this.u8(offset + 29),
                    this.u8(offset + 30),
                    this.u8(offset + 31)
                ],
                glowRadius,
                atlasPage: this.u32(offset + 36),
                renderOrder: this.u32(offset + 40)
            };
        });
    }

    /** Decode the compact global span table and reject out-of-stream ranges. */
    private readSpans(table: PacketTable): GpuContributionSpanView[] {
        return Array.from({length: table.count}, (_, index) => {
            const offset = table.offset + index * CONTRIBUTION_SPAN_BYTES;
            if (this.u32(offset + 12) !== 0) {
                throw new Error(
                    `GPU contribution span ${index} has a nonzero reserved field.`
                );
            }
            const result = {
                streamIndex: this.u32(offset),
                firstRecord: this.u32(offset + 4),
                recordCount: this.u32(offset + 8)
            };
            const stream = this.streams[result.streamIndex];
            if (!stream || result.firstRecord > stream.recordCount ||
                result.recordCount > stream.recordCount - result.firstRecord) {
                throw new Error(`GPU contribution span ${index} is out of bounds.`);
            }
            return result;
        });
    }

    /** Decode independently replaceable owners and their stream/pick/label ranges. */
    private readContributions(
        table: PacketTable,
        spans: GpuContributionSpanView[],
        pickCount: number,
        labelCount: number,
        zIndexTable: PacketTable
    ): GpuContributionView[] {
        const result: GpuContributionView[] = [];
        const keys = new Set<bigint>();
        const slots = new Set<number>();
        const activationTokens = new Set<number>();
        let expectedSpan = 0;
        let expectedPick = 0;
        let expectedLabel = 0;
        let expectedZIndex = 0;
        for (let index = 0; index < table.count; ++index) {
            const offset = table.offset + index * CONTRIBUTION_DESCRIPTOR_BYTES;
            const activationToken = this.u32(offset + 16);
            const firstSpan = this.u32(offset + 20);
            const spanCount = this.u32(offset + 24);
            const firstPick = this.u32(offset + 28);
            const ownedPickCount = this.u32(offset + 32);
            const firstLabel = this.u32(offset + 36);
            const ownedLabelCount = this.u32(offset + 40);
            const firstZIndex = this.u32(offset + 44);
            const zIndexCount = this.u32(offset + 48);
            const totalPickCount = this.u32(offset + 52);
            const key = this.u64(offset);
            const slot = this.u32(offset + 12);
            if (activationToken === 0 ||
                activationToken > GPU_ACTIVATION_TOKEN_MAX ||
                keys.has(key) || slots.has(slot) ||
                activationTokens.has(activationToken)) {
                throw new Error(
                    `GPU contribution ${index} has an invalid identity, slot, or activation token.`
                );
            }
            keys.add(key);
            slots.add(slot);
            activationTokens.add(activationToken);
            if (firstSpan !== expectedSpan ||
                firstSpan > spans.length || spanCount > spans.length - firstSpan ||
                firstPick !== expectedPick ||
                firstPick > pickCount || ownedPickCount > pickCount - firstPick ||
                firstLabel !== expectedLabel ||
                firstLabel > labelCount || ownedLabelCount > labelCount - firstLabel ||
                firstZIndex !== expectedZIndex ||
                firstZIndex > zIndexTable.count ||
                zIndexCount > zIndexTable.count - firstZIndex) {
                throw new Error(`GPU contribution ${index} has an invalid owned range.`);
            }
            const ownedSpans = spans.slice(firstSpan, firstSpan + spanCount);
            if (ownedSpans.some(span => span.recordCount === 0) ||
                new Set(ownedSpans.map(span => span.streamIndex)).size !==
                    ownedSpans.length) {
                throw new Error(`GPU contribution ${index} has an invalid stream span.`);
            }
            result.push({
                key,
                revision: this.u32(offset + 8),
                slot,
                activationToken,
                totalPickCount,
                spans: ownedSpans,
                firstPick,
                pickCount: ownedPickCount,
                firstLabel,
                labelCount: ownedLabelCount,
                zIndices: Array.from({length: zIndexCount}, (_, ordinal) => {
                    const offset = zIndexTable.offset +
                        (firstZIndex + ordinal) * 16;
                    const value = this.f64(
                        offset
                    );
                    if ((!Number.isFinite(value) && !Number.isNaN(value)) ||
                        this.u32(offset + 12) !== 0) {
                        throw new Error(
                            `GPU contribution ${index} has invalid z-index metadata.`
                        );
                    }
                    return {
                        value,
                        tieBreaker: this.u32(offset + 8)
                    };
                })
            });
            expectedSpan += spanCount;
            expectedPick += ownedPickCount;
            expectedLabel += ownedLabelCount;
            expectedZIndex += zIndexCount;
        }
        if (expectedSpan !== spans.length || expectedPick !== pickCount ||
            expectedLabel !== labelCount || expectedZIndex !== zIndexTable.count) {
            throw new Error("GPU contribution tables are not fully owned.");
        }
        return result;
    }

    /** Decode logical labels retained by the one-per-view TextLayer host. */
    private readLabels(table: PacketTable): GpuLabelRecordView[] {
        const color = (offset: number): [number, number, number, number] => [
            this.u8(offset),
            this.u8(offset + 1),
            this.u8(offset + 2),
            this.u8(offset + 3)
        ];
        return Array.from({length: table.count}, (_, index) => {
            const offset = table.offset + index * LABEL_RECORD_BYTES;
            const flags = this.u32(offset + 96);
            const fontWeight = this.u32(offset + 112);
            const collisionPriority = this.i32(offset + 116);
            if (fontWeight === 0 || fontWeight > 1000 ||
                collisionPriority < -1000 || collisionPriority > 1000 ||
                (flags & ~(GpuLabelFlag.Billboard |
                    GpuLabelFlag.DepthTest |
                    GpuLabelFlag.Background |
                    GpuLabelFlag.Collision)) !== 0) {
                throw new Error(`GPU label ${index} has invalid metadata.`);
            }
            return {
                contributionIndex: this.u32(offset),
                localPickIndex: this.u32(offset + 4),
                position: [this.f64(offset + 8), this.f64(offset + 16), this.f64(offset + 24)],
                text: this.string(this.u32(offset + 32), this.u32(offset + 36)),
                fontFamily: this.string(this.u32(offset + 40), this.u32(offset + 44)),
                size: this.f32(offset + 48),
                pixelOffset: [this.f32(offset + 52), this.f32(offset + 56)],
                angle: this.f32(offset + 60),
                zIndex: this.f64(offset + 64),
                color: color(offset + 72),
                outlineColor: color(offset + 76),
                backgroundColor: color(offset + 80),
                outlineWidth: this.f32(offset + 84),
                backgroundPadding: [this.f32(offset + 88), this.f32(offset + 92)],
                flags,
                horizontalOrigin: this.i32(offset + 100),
                verticalOrigin: this.i32(offset + 104),
                renderOrder: this.u32(offset + 108),
                fontWeight,
                collisionPriority
            };
        });
    }

    /** Decode resource misses which the browser atlas must resolve asynchronously. */
    private readResources(table: PacketTable): GpuResourceRequestView[] {
        return Array.from({length: table.count}, (_, index) => {
            const offset = table.offset + index * RESOURCE_RECORD_BYTES;
            if (this.u32(offset + 4) !== 0 ||
                this.u32(offset + 16) !== 0 ||
                this.u32(offset + 20) !== 0) {
                throw new Error(
                    `GPU resource request ${index} has a nonzero reserved field.`
                );
            }
            return {
                resourceKind: this.u32(offset),
                uri: this.string(this.u32(offset + 8), this.u32(offset + 12))
            };
        });
    }

    /** Decode worker-side style diagnostics outside primitive streams. */
    private readIssues(table: PacketTable): GpuRuntimeIssueView[] {
        return Array.from({length: table.count}, (_, index) => {
            const offset = table.offset + index * ISSUE_RECORD_BYTES;
            return {
                contributionIndex: this.u32(offset),
                ruleIndex: this.u32(offset + 4),
                occurrenceCount: this.u64(offset + 8),
                property: this.string(this.u32(offset + 16), this.u32(offset + 20)),
                expression: this.string(this.u32(offset + 24), this.u32(offset + 28)),
                message: this.string(this.u32(offset + 32), this.u32(offset + 36))
            };
        });
    }

    /** Verify that descriptor ranges and semantic owner fields agree exactly. */
    private validateContributionOwnership(): void {
        const rangesByStream = this.streams.map(() =>
            [] as GpuContributionSpanView[]);
        for (let index = 0; index < this.contributions.length; ++index) {
            const owner = this.contributions[index];
            for (const span of owner.spans) {
                rangesByStream[span.streamIndex].push(span);
            }
            for (let pick = owner.firstPick; pick < owner.firstPick + owner.pickCount; ++pick) {
                const contributionIndex =
                    this.picks.contributionIndex(pick);
                const localPickIndex = this.picks.localPickIndex(pick);
                if (contributionIndex !== index ||
                    localPickIndex >= owner.totalPickCount ||
                    (pick > owner.firstPick &&
                        localPickIndex <=
                            this.picks.localPickIndex(pick - 1))) {
                    throw new Error(`GPU pick ${pick} disagrees with its contribution range.`);
                }
            }
            if (this.fragmentCount === 1 &&
                (owner.pickCount !== owner.totalPickCount ||
                    (owner.pickCount > 0 &&
                        this.picks.localPickIndex(
                            owner.firstPick + owner.pickCount - 1
                        ) + 1 !== owner.totalPickCount))) {
                throw new Error(
                    `GPU contribution ${index} has incomplete picking metadata.`
                );
            }
            for (let label = owner.firstLabel; label < owner.firstLabel + owner.labelCount; ++label) {
                const record = this.labels[label];
                if (record?.contributionIndex !== index ||
                    (record.localPickIndex !== 0xffffffff &&
                        record.localPickIndex >= owner.totalPickCount)) {
                    throw new Error(`GPU label ${label} disagrees with its contribution range.`);
                }
            }
        }
        for (let streamIndex = 0; streamIndex < this.streams.length; ++streamIndex) {
            const ranges = rangesByStream[streamIndex]
                .sort((left, right) => left.firstRecord - right.firstRecord);
            let cursor = 0;
            for (const range of ranges) {
                if (range.firstRecord !== cursor) {
                    throw new Error(
                        `GPU stream ${streamIndex} ownership has a gap or overlap.`
                    );
                }
                cursor += range.recordCount;
            }
            if (cursor !== this.streams[streamIndex].recordCount) {
                throw new Error(`GPU stream ${streamIndex} is not fully owned.`);
            }
        }
    }

    /** Read one aligned table pair from the fixed packet header. */
    private table(headerOffset: number, stride: number): PacketTable {
        const table = {
            offset: this.u32(headerOffset),
            count: this.u32(headerOffset + 4),
            byteLength: 0
        };
        const byteLength = table.count * stride;
        if (!Number.isSafeInteger(byteLength)) {
            throw new Error("GPU render packet table size overflows.");
        }
        table.byteLength = byteLength;
        this.range(table.offset, byteLength, 8);
        if (table.offset < GPU_RENDER_PACKET_HEADER_BYTES) {
            throw new Error("GPU render packet table overlaps its header.");
        }
        this.packetRanges.push({offset: table.offset, byteLength});
        return table;
    }

    /** Reject aliases between tables and primitive streams before GPU upload. */
    private validatePacketRanges(): void {
        const ranges = this.packetRanges
            .filter(range => range.byteLength > 0)
            .sort((left, right) => left.offset - right.offset);
        let previousEnd = GPU_RENDER_PACKET_HEADER_BYTES;
        for (const range of ranges) {
            if (range.offset < previousEnd) {
                throw new Error("GPU render packet byte ranges overlap.");
            }
            previousEnd = range.offset + range.byteLength;
        }
    }

    /** Decode one UTF-8 string relative to the packet string table. */
    private string(offset: number, length: number): string {
        if (offset > this.stringTable.count ||
            length > this.stringTable.count - offset) {
            throw new Error("GPU render packet string reference is invalid.");
        }
        if (length === 0) {
            return "";
        }
        return UTF8_DECODER.decode(this.bytes.subarray(
            this.stringTable.offset + offset,
            this.stringTable.offset + offset + length
        ));
    }

    /** Reject a byte range that is misaligned or outside the transferred view. */
    private range(offset: number, byteLength: number, alignment: number): void {
        if (offset % alignment !== 0 || offset < 0 || byteLength < 0 ||
            offset > this.bytes.byteLength ||
            byteLength > this.bytes.byteLength - offset) {
            throw new Error("GPU render packet table range is invalid.");
        }
    }

    private u8(offset: number): number { return this.data.getUint8(offset); }
    private u16(offset: number): number { return this.data.getUint16(offset, true); }
    private u32(offset: number): number { return this.data.getUint32(offset, true); }
    private i32(offset: number): number { return this.data.getInt32(offset, true); }
    private u64(offset: number): bigint { return this.data.getBigUint64(offset, true); }
    private f32(offset: number): number { return this.data.getFloat32(offset, true); }
    private f64(offset: number): number { return this.data.getFloat64(offset, true); }
}
