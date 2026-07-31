import type {MapTileStreamFilterStatusPayload} from "./tilestream";

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
    geometryName: string;
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
    tileIds: number[];
    priorityTileIds?: number[];
    roots?: Array<{
        tileId: number;
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
    readonly tileId: number;
    readonly mapTileKey: string;
    readonly stringPoolId: string;
    readonly conversionTimestampMs: number | null;
    readonly dependencies: Array<{
        sourceTileKey: string;
        mapId: string;
        layerId: string;
        tileId: number;
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

/** Consumer callbacks invoked only for the currently active generation. */
export interface FilterSubscriptionCallbacks {
    onTile(delivery: TileSubsetDelivery): void;
    onStatus?(status: MapTileStreamFilterStatusPayload): void;
    onError?(message: string): void;
    onRequestSynchronized?(): void;
}

/** Narrow owner interface keeps the ref independent of Angular transport implementation details. */
export interface FilterSubscriptionOwner {
    updateFilterSubscription(ref: FilterSubscriptionRef, force: boolean): void;
    releaseFilterSubscription(ref: FilterSubscriptionRef): void;
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
        tileIds: [...coverage.tileIds],
        ...(coverage.priorityTileIds ? {priorityTileIds: [...coverage.priorityTileIds]} : {}),
        ...(coverage.roots ? {roots: structuredClone(coverage.roots)} : {})
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

function unorderedValuesEqual<T>(
    left: readonly T[] | undefined,
    right: readonly T[] | undefined
): boolean {
    const leftValues = left ?? [];
    const rightValues = right ?? [];
    if (leftValues.length !== rightValues.length) {
        return false;
    }
    const leftSet = new Set(leftValues);
    const rightSet = new Set(rightValues);
    return leftSet.size === leftValues.length &&
        rightSet.size === rightValues.length &&
        leftValues.every(value => rightSet.has(value));
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
            return root.tileId === other.tileId &&
                root.typeId === other.typeId &&
                featureIdsEqual(root.featureId, other.featureId);
        });
}

/** Compares ordered coverage structurally; tile and root order are semantic. */
export function filterSubscriptionCoverageEqual(
    left: FilterSubscriptionCoverage,
    right: FilterSubscriptionCoverage
): boolean {
    return orderedValuesEqual(left.tileIds, right.tileIds) &&
        orderedValuesEqual(left.priorityTileIds, right.priorityTileIds) &&
        rootsEqual(left.roots, right.roots);
}

/**
 * Compares output/priority membership while retaining exact root order.
 *
 * Presentation owners use this to avoid replacing an already-running request
 * merely because continuous camera motion slightly reordered the same tiles.
 * A later membership change still carries the newest priority order.
 */
export function filterSubscriptionCoverageMembershipEqual(
    left: FilterSubscriptionCoverage,
    right: FilterSubscriptionCoverage
): boolean {
    return unorderedValuesEqual(left.tileIds, right.tileIds) &&
        unorderedValuesEqual(left.priorityTileIds, right.priorityTileIds) &&
        rootsEqual(left.roots, right.roots);
}

/**
 * One independently owned filter demand.
 *
 * Definition and exact-root replacement advance the semantic generation.
 * Tile coverage and priority changes retain it, allowing the transport to
 * preserve already delivered overlap. The transport never stores delivered
 * subsets: the callback receives the immutable byte value and its metadata.
 */
export class FilterSubscriptionRef {
    private definitionValue: FilterSubscriptionDefinition;
    private coverageValue: FilterSubscriptionCoverage;
    private generationValue = 1;
    private releasedValue = false;
    private suspendedValue = false;
    private coverageTileIds: Set<number>;

    constructor(
        private readonly owner: FilterSubscriptionOwner,
        readonly filterId: string,
        definition: FilterSubscriptionDefinition,
        coverage: FilterSubscriptionCoverage,
        private readonly callbacks: FilterSubscriptionCallbacks
    ) {
        this.definitionValue = cloneDefinition(definition);
        this.coverageValue = cloneCoverage(coverage);
        this.coverageTileIds = new Set(this.coverageValue.tileIds);
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
        this.coverageTileIds = new Set(nextCoverage.tileIds);
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
        this.coverageValue = nextCoverage;
        this.coverageTileIds = new Set(nextCoverage.tileIds);
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
        this.owner.updateFilterSubscription(this, true);
    }

    /** Cancels this consumer's demand. It cannot be reactivated. */
    release(): void {
        if (this.releasedValue) {
            return;
        }
        this.releasedValue = true;
        this.owner.releaseFilterSubscription(this);
    }

    /** Internal canonical request object serialized into `/interactive`. */
    requestJson(): Record<string, unknown> {
        return {
            ...cloneDefinition(this.definitionValue),
            ...cloneCoverage(this.coverageValue),
            filterId: this.filterId,
            generation: this.generationValue
        };
    }

    /** Internal stale-safe delivery boundary. */
    accept(delivery: TileSubsetDelivery): boolean {
        if (this.releasedValue || this.suspendedValue ||
            delivery.generation !== this.generationValue ||
            !this.coverageTileIds.has(delivery.tileId)) {
            return false;
        }
        this.callbacks.onTile(delivery);
        return true;
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
        this.generationValue += 1;
        this.owner.updateFilterSubscription(this, true);
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
