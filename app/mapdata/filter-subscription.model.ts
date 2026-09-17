import type {MapTileStreamFilterStatusPayload} from "./tilestream";
import {
    partitionJson,
    partitionKey,
    partitionsEqual,
    type PartitionId
} from "./partition.model";

/** JSON scalar values accepted by mapget filter bindings. */
export type FilterBindingValue = null | boolean | number | string;

/** One generic mapget evaluation channel produced by Erdblick's style planner. */
export interface FilterChannelDefinition {
    channelId: string;
    scope: "feature" | "attribute" | "relation" | "auto";
    rewrite: boolean;
    featureTypes: string[];
    featureFields: string[];
    entryFields: string[];
    geometryTypes: number;
    geometryName?: string;
    featureFilter?: string;
    entryFilter?: string;
    group?: {
        kind: "point-grid";
        origin: [number, number, number];
        cellSize: [number, number, number];
    };
    relation?: {
        namePattern?: string;
        recursive: boolean;
        mergeTwoway: boolean;
    };
}

/** Stable source and evaluation definition owned by one presentation subscription. */
export interface FilterSubscriptionDefinition {
    mapId: string;
    layerId: string;
    sourceId?: string;
    channels: FilterChannelDefinition[];
    bindings?: Record<string, FilterBindingValue>;
}

/** Mutable output demand for one filter definition. Order is significant. */
export interface FilterSubscriptionCoverage {
    partitions: PartitionId[];
    priorityPartitions?: PartitionId[];
    roots?: Array<{
        partition: PartitionId;
        typeId?: string;
        featureId: string | Array<string | number>;
    }>;
}

/** One immutable subset byte value plus its cheaply decoded routing metadata. */
export interface TileSubsetDelivery {
    readonly blob: Uint8Array;
    readonly filterId: string;
    readonly generation: number;
    readonly mapId: string;
    readonly layerId: string;
    readonly partition: PartitionId;
    readonly partitionKey: string;
    readonly mapTileKey: string;
    readonly stringPoolId: string;
    readonly conversionTimestampMs: number | null;
    readonly ttlMs: number | null;
    readonly dependencies: Array<{
        sourceTileKey: string;
        mapId: string;
        layerId: string;
        partition: PartitionId;
        sourceFeatureCount: number;
    }>;
    readonly issues: Array<{
        channelId: string;
        expression: string;
        scope: string;
        message: string;
        occurrenceCount: number;
    }>;
    readonly info: Record<string, unknown>;
    readonly numEntries: number;
    readonly geometryVertexCount: number;
    readonly glbAttachmentName: string;
    readonly receivedAt: number;
}

/** Result of attempting to install one semantically current subset value. */
export type FilterTileInstallResult =
    | {readonly status: "accepted"; readonly valueVersion: number}
    | {readonly status: "superseded"};

/** Outcome of routing one subset through the subscription admission boundary. */
export type FilterSubsetAdmission = "accepted" | "benign-rejection";

/** Consumer callbacks invoked only for the currently active generation. */
export interface FilterSubscriptionCallbacks {
    onTile(
        delivery: TileSubsetDelivery,
        remainsPending: boolean
    ): FilterTileInstallResult;
    onPartitionsPending?(
        partitions: readonly PartitionId[],
        generation: number
    ): void;
    onStatus?(status: MapTileStreamFilterStatusPayload): void;
    onError?(message: string): void;
    onRequestSynchronized?(): void;
}

/** Narrow owner interface keeps the ref independent of Angular transport implementation details. */
export interface FilterSubscriptionOwner {
    updateFilterSubscription(ref: FilterSubscriptionRef, force: boolean): void;
    releaseFilterSubscription(ref: FilterSubscriptionRef): void;
    updateFilterPartitionExpiry?(
        ref: FilterSubscriptionRef,
        partition: PartitionId,
        valueVersion: number,
        expiresAtMs: number | null
    ): void;
    cancelFilterPartitionExpiries?(
        ref: FilterSubscriptionRef,
        partitions?: readonly PartitionId[]
    ): void;
}

function cloneDefinition(definition: FilterSubscriptionDefinition): FilterSubscriptionDefinition {
    return {
        mapId: definition.mapId,
        layerId: definition.layerId,
        ...(definition.sourceId ? {sourceId: definition.sourceId} : {}),
        channels: structuredClone(definition.channels),
        bindings: {...(definition.bindings ?? {})}
    };
}

function cloneCoverage(coverage: FilterSubscriptionCoverage): FilterSubscriptionCoverage {
    return {
        partitions: coverage.partitions.map(partitionJson),
        ...(coverage.priorityPartitions ? {
            priorityPartitions: coverage.priorityPartitions.map(partitionJson)
        } : {}),
        ...(coverage.roots ? {
            roots: coverage.roots.map(root => ({
                ...structuredClone(root),
                partition: partitionJson(root.partition)
            }))
        } : {})
    };
}

function orderedValuesEqual<T>(
    left: readonly T[] | undefined,
    right: readonly T[] | undefined
): boolean {
    const leftValues = left ?? [];
    const rightValues = right ?? [];
    return leftValues.length === rightValues.length &&
        leftValues.every((value, index) => value === rightValues[index]);
}

function featureIdsEqual(
    left: string | Array<string | number>,
    right: string | Array<string | number>
): boolean {
    if (typeof left === "string" || typeof right === "string") {
        return left === right;
    }
    return orderedValuesEqual(left, right);
}

function rootsEqual(
    left: FilterSubscriptionCoverage["roots"],
    right: FilterSubscriptionCoverage["roots"]
): boolean {
    const leftRoots = left ?? [];
    const rightRoots = right ?? [];
    return leftRoots.length === rightRoots.length &&
        leftRoots.every((root, index) => {
            const other = rightRoots[index];
            return partitionsEqual(root.partition, other.partition) &&
                root.typeId === other.typeId &&
                featureIdsEqual(root.featureId, other.featureId);
        });
}

function orderedPartitionsEqual(
    left: readonly PartitionId[] | undefined,
    right: readonly PartitionId[] | undefined
): boolean {
    const leftValues = left ?? [];
    const rightValues = right ?? [];
    return leftValues.length === rightValues.length &&
        leftValues.every((value, index) =>
            partitionsEqual(value, rightValues[index])
        );
}

/** Compares ordered coverage structurally; partition and root order are semantic. */
export function filterSubscriptionCoverageEqual(
    left: FilterSubscriptionCoverage,
    right: FilterSubscriptionCoverage
): boolean {
    return orderedPartitionsEqual(left.partitions, right.partitions) &&
        orderedPartitionsEqual(
            left.priorityPartitions,
            right.priorityPartitions
        ) &&
        rootsEqual(left.roots, right.roots);
}

/**
 * One independently owned filter demand.
 *
 * Definition and exact-root replacement advance the semantic generation.
 * Partition coverage and priority changes retain it, allowing mapget to preserve
 * overlapping pending work. The transport never stores delivered
 * subsets: the callback receives the immutable byte value and its metadata.
 */
export class FilterSubscriptionRef {
    private definitionValue: FilterSubscriptionDefinition;
    private coverageValue: FilterSubscriptionCoverage;
    private generationValue = 1;
    private releasedValue = false;
    private suspendedValue = false;
    private readonly coveredPartitions = new Map<string, PartitionId>();
    private readonly pendingPartitionKeys = new Set<string>();
    private readonly acceptedValueVersionsByPartition = new Map<string, number>();
    private readonly expiredWhileSuspended = new Map<string, number>();

    constructor(
        private readonly owner: FilterSubscriptionOwner,
        readonly filterId: string,
        definition: FilterSubscriptionDefinition,
        coverage: FilterSubscriptionCoverage,
        private readonly callbacks: FilterSubscriptionCallbacks
    ) {
        this.definitionValue = cloneDefinition(definition);
        this.coverageValue = cloneCoverage(coverage);
        this.resetCoveredPartitions();
        this.resetPendingPartitions();
    }

    get generation(): number {
        return this.generationValue;
    }

    get released(): boolean {
        return this.releasedValue;
    }

    get suspended(): boolean {
        return this.suspendedValue;
    }

    /** Number of output keys currently projected into the backend snapshot. */
    get pendingPartitionCount(): number {
        return this.releasedValue || this.suspendedValue
            ? 0
            : this.pendingPartitionKeys.size;
    }

    /** Returns whether one covered output is currently awaiting acceptance. */
    isPending(partition: PartitionId): boolean {
        return this.pendingPartitionKeys.has(partitionKey(partition));
    }

    /** Returns whether one output identity still belongs to current coverage. */
    covers(partition: PartitionId): boolean {
        return this.coveredPartitions.has(partitionKey(partition));
    }

    /** Replaces both immutable definition and output coverage as one generation. */
    replace(definition: FilterSubscriptionDefinition, coverage: FilterSubscriptionCoverage): void {
        this.assertLive();
        const nextDefinition = cloneDefinition(definition);
        const nextCoverage = cloneCoverage(coverage);
        if (JSON.stringify(nextDefinition) === JSON.stringify(this.definitionValue)
            && filterSubscriptionCoverageEqual(
                nextCoverage,
                this.coverageValue
            )) {
            return;
        }
        this.definitionValue = nextDefinition;
        this.coverageValue = nextCoverage;
        this.resetCoveredPartitions();
        this.advanceGeneration();
    }

    /** Replaces only output coverage while preserving the planned channel bundle. */
    setCoverage(coverage: FilterSubscriptionCoverage): void {
        this.assertLive();
        const nextCoverage = cloneCoverage(coverage);
        if (filterSubscriptionCoverageEqual(
            nextCoverage,
            this.coverageValue
        )) {
            return;
        }
        const rootsChanged = !rootsEqual(
            nextCoverage.roots,
            this.coverageValue.roots
        );
        const previousPartitions = new Map(
            this.coverageValue.partitions.map(partition => [
                partitionKey(partition),
                partition
            ])
        );
        const nextPartitions = new Map(
            nextCoverage.partitions.map(partition => [
                partitionKey(partition),
                partition
            ])
        );
        const removedPartitions = [...previousPartitions]
            .filter(([key]) => !nextPartitions.has(key))
            .map(([, partition]) => partition);
        this.coverageValue = nextCoverage;
        this.resetCoveredPartitions();
        for (const partition of removedPartitions) {
            const key = partitionKey(partition);
            this.pendingPartitionKeys.delete(key);
            this.acceptedValueVersionsByPartition.delete(key);
            this.expiredWhileSuspended.delete(key);
        }
        for (const partition of nextCoverage.partitions) {
            const key = partitionKey(partition);
            if (!previousPartitions.has(key)) {
                this.pendingPartitionKeys.add(key);
            }
        }
        if (removedPartitions.length) {
            this.owner.cancelFilterPartitionExpiries?.(
                this,
                removedPartitions
            );
        }
        if (rootsChanged) {
            this.advanceGeneration();
        } else {
            this.owner.updateFilterSubscription(this, true);
        }
    }

    /** Forces backend re-evaluation without changing definition or coverage. */
    refresh(): void {
        this.assertLive();
        this.advanceGeneration();
    }

    /** Temporarily removes demand while retaining already delivered consumer state. */
    suspend(): void {
        this.assertLive();
        if (this.suspendedValue) {
            return;
        }
        this.suspendedValue = true;
        this.owner.updateFilterSubscription(this, true);
    }

    /** Restores suspended demand without changing its semantic generation. */
    resume(): void {
        this.assertLive();
        if (!this.suspendedValue) {
            return;
        }
        this.suspendedValue = false;
        const expiredPartitions = [...this.expiredWhileSuspended]
            .filter(([key, valueVersion]) =>
                this.acceptedValueVersionsByPartition.get(key) === valueVersion
            )
            .flatMap(([key]) => {
                const partition = this.coveredPartitions.get(key);
                return partition ? [partition] : [];
            });
        this.expiredWhileSuspended.clear();
        for (const partition of expiredPartitions) {
            this.pendingPartitionKeys.add(partitionKey(partition));
        }
        if (expiredPartitions.length) {
            this.callbacks.onPartitionsPending?.(
                expiredPartitions,
                this.generationValue
            );
        }
        this.owner.updateFilterSubscription(this, true);
    }

    /** Cancels this consumer's demand. It cannot be reactivated. */
    release(): void {
        if (this.releasedValue) {
            return;
        }
        this.releasedValue = true;
        this.owner.cancelFilterPartitionExpiries?.(this);
        this.owner.releaseFilterSubscription(this);
    }

    /** Internal canonical request object serialized into `/interactive`. */
    requestJson(): Record<string, unknown> {
        const partitions = this.coverageValue.partitions
            .filter(partition =>
                this.pendingPartitionKeys.has(partitionKey(partition))
            );
        const pending = new Set(partitions.map(partitionKey));
        const priorityPartitions =
            (this.coverageValue.priorityPartitions ?? [])
                .filter(partition => pending.has(partitionKey(partition)));
        const roots = (this.coverageValue.roots ?? [])
            .filter(root => pending.has(partitionKey(root.partition)));
        return {
            ...cloneDefinition(this.definitionValue),
            partitions: partitions.map(partitionJson),
            ...(priorityPartitions.length ? {
                priorityPartitions: priorityPartitions.map(partitionJson)
            } : {}),
            ...(roots.length ? {
                roots: roots.map(root => ({
                    ...structuredClone(root),
                    partition: partitionJson(root.partition)
                }))
            } : {}),
            filterId: this.filterId,
            generation: this.generationValue
        };
    }

    /**
     * Internal transactional delivery boundary.
     *
     * Superseded or no-longer-demanded frames are benign. Exceptions from the
     * current-value install callback deliberately propagate to the transport,
     * which must close the connection so mapget releases its handoff record.
     */
    accept(delivery: TileSubsetDelivery): FilterSubsetAdmission {
        if (this.releasedValue || this.suspendedValue ||
            delivery.generation !== this.generationValue ||
            !this.covers(delivery.partition)) {
            return "benign-rejection";
        }
        const expiresAtMs = delivery.conversionTimestampMs !== null &&
            delivery.ttlMs !== null
            ? delivery.conversionTimestampMs + delivery.ttlMs
            : null;
        const finiteExpiry = expiresAtMs !== null &&
            Number.isFinite(expiresAtMs)
            ? expiresAtMs
            : null;
        const remainsPending = finiteExpiry !== null &&
            Date.now() > finiteExpiry;
        const installResult = this.callbacks.onTile(
            delivery,
            remainsPending
        );
        if (installResult.status === "superseded") {
            return "benign-rejection";
        }
        this.acceptedValueVersionsByPartition.set(
            delivery.partitionKey,
            installResult.valueVersion
        );
        if (remainsPending) {
            this.pendingPartitionKeys.add(delivery.partitionKey);
            this.owner.cancelFilterPartitionExpiries?.(
                this,
                [delivery.partition]
            );
            // An already-expired handoff can leave the logical body unchanged,
            // so bypass suppression and give mapget a fresh reconciliation.
            this.owner.updateFilterSubscription(this, true);
        } else {
            this.pendingPartitionKeys.delete(delivery.partitionKey);
            this.owner.updateFilterPartitionExpiry?.(
                this,
                delivery.partition,
                installResult.valueVersion,
                finiteExpiry
            );
            this.owner.updateFilterSubscription(this, false);
        }
        return "accepted";
    }

    /** Internal scheduler boundary; expires only the installed value incarnation. */
    expirePartitions(tokens: ReadonlyArray<{
        partitionKey: string;
        valueVersion: number;
    }>): void {
        if (this.releasedValue) {
            return;
        }
        const partitions = tokens
            .filter(token =>
                this.acceptedValueVersionsByPartition.get(token.partitionKey) ===
                    token.valueVersion
            )
            .flatMap(token => {
                const partition = this.coveredPartitions.get(
                    token.partitionKey
                );
                return partition ? [partition] : [];
            });
        if (!partitions.length) {
            return;
        }
        if (this.suspendedValue) {
            for (const token of tokens) {
                if (this.acceptedValueVersionsByPartition.get(
                    token.partitionKey
                ) ===
                    token.valueVersion) {
                    this.expiredWhileSuspended.set(
                        token.partitionKey,
                        token.valueVersion
                    );
                }
            }
            return;
        }
        for (const partition of partitions) {
            this.pendingPartitionKeys.add(partitionKey(partition));
        }
        this.callbacks.onPartitionsPending?.(
            partitions,
            this.generationValue
        );
        this.owner.updateFilterSubscription(this, true);
    }

    /** Internal generation-aware status boundary. */
    acceptStatus(status: MapTileStreamFilterStatusPayload): void {
        if (this.releasedValue || this.suspendedValue ||
            status.generation !== this.generationValue) {
            return;
        }
        this.callbacks.onStatus?.(status);
    }

    /** Internal transport error boundary for malformed or failed deliveries. */
    reportError(message: string): void {
        if (!this.releasedValue) {
            this.callbacks.onError?.(message);
        }
    }

    /**
     * Internal transport acknowledgement for a sent or already-current
     * request envelope.
     */
    notifyRequestSynchronized(): void {
        if (!this.releasedValue && !this.suspendedValue) {
            this.callbacks.onRequestSynchronized?.();
        }
    }

    private advanceGeneration(): void {
        this.owner.cancelFilterPartitionExpiries?.(this);
        this.generationValue += 1;
        this.resetPendingPartitions();
        this.owner.updateFilterSubscription(this, true);
    }

    private resetPendingPartitions(): void {
        this.pendingPartitionKeys.clear();
        this.acceptedValueVersionsByPartition.clear();
        this.expiredWhileSuspended.clear();
        for (const partition of this.coverageValue.partitions) {
            this.pendingPartitionKeys.add(partitionKey(partition));
        }
    }

    private resetCoveredPartitions(): void {
        this.coveredPartitions.clear();
        for (const partition of this.coverageValue.partitions) {
            this.coveredPartitions.set(partitionKey(partition), partition);
        }
    }

    private assertLive(): void {
        if (this.releasedValue) {
            throw new Error(`Filter subscription '${this.filterId}' has already been released.`);
        }
    }
}

export type TileAttachmentState = "pending" | "ready" | "failed" | "released";

export interface TileAttachmentValue {
    readonly bytes: Uint8Array;
    readonly etag: string | null;
    readonly mimeType: string;
}

/** Narrow owner interface for request coalescing and last-ref cleanup. */
export interface TileAttachmentOwner {
    releaseTileAttachment(ref: TileAttachmentRef): void;
}

/** Retained reference to one separately transferred tile attachment. */
export class TileAttachmentRef {
    state: TileAttachmentState = "pending";
    value: TileAttachmentValue | null = null;
    error: string | null = null;

    constructor(
        private readonly owner: TileAttachmentOwner,
        readonly key: string,
        readonly ready: Promise<TileAttachmentValue | null>
    ) {}

    release(): void {
        if (this.state === "released") {
            return;
        }
        this.state = "released";
        this.value = null;
        this.owner.releaseTileAttachment(this);
    }
}
