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
    readonly ttlMs: number | null;
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
    onTilesPending?(tileIds: readonly number[], generation: number): void;
    onStatus?(status: MapTileStreamFilterStatusPayload): void;
    onError?(message: string): void;
    onRequestSynchronized?(): void;
}

/** Narrow owner interface keeps the ref independent of Angular transport implementation details. */
export interface FilterSubscriptionOwner {
    updateFilterSubscription(ref: FilterSubscriptionRef, force: boolean): void;
    releaseFilterSubscription(ref: FilterSubscriptionRef): void;
    updateFilterTileExpiry?(
        ref: FilterSubscriptionRef,
        tileId: number,
        valueVersion: number,
        expiresAtMs: number | null
    ): void;
    cancelFilterTileExpiries?(ref: FilterSubscriptionRef, tileIds?: readonly number[]): void;
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
 * One independently owned filter demand.
 *
 * Definition and exact-root replacement advance the semantic generation.
 * Tile coverage and priority changes retain it, allowing mapget to preserve
 * overlapping pending work. The transport never stores delivered
 * subsets: the callback receives the immutable byte value and its metadata.
 */
export class FilterSubscriptionRef {
    private definitionValue: FilterSubscriptionDefinition;
    private coverageValue: FilterSubscriptionCoverage;
    private generationValue = 1;
    private releasedValue = false;
    private suspendedValue = false;
    private readonly coveredTileIds = new Set<number>();
    private readonly pendingTileIds = new Set<number>();
    private readonly acceptedValueVersionsByTile = new Map<number, number>();
    private readonly expiredWhileSuspended = new Map<number, number>();

    constructor(
        private readonly owner: FilterSubscriptionOwner,
        readonly filterId: string,
        definition: FilterSubscriptionDefinition,
        coverage: FilterSubscriptionCoverage,
        private readonly callbacks: FilterSubscriptionCallbacks
    ) {
        this.definitionValue = cloneDefinition(definition);
        this.coverageValue = cloneCoverage(coverage);
        this.resetCoveredTiles();
        this.resetPendingTiles();
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
    get pendingTileCount(): number {
        return this.releasedValue || this.suspendedValue
            ? 0
            : this.pendingTileIds.size;
    }

    /** Returns whether one covered output is currently awaiting acceptance. */
    isPending(tileId: number): boolean {
        return this.pendingTileIds.has(Number(tileId));
    }

    /** Returns whether one output identity still belongs to current coverage. */
    covers(tileId: number): boolean {
        return this.coveredTileIds.has(Number(tileId));
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
        this.resetCoveredTiles();
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
        const previousTileIds = new Set(this.coverageValue.tileIds);
        const nextTileIds = new Set(nextCoverage.tileIds);
        const removedTileIds = [...previousTileIds]
            .filter(tileId => !nextTileIds.has(tileId));
        this.coverageValue = nextCoverage;
        this.resetCoveredTiles();
        for (const tileId of removedTileIds) {
            this.pendingTileIds.delete(tileId);
            this.acceptedValueVersionsByTile.delete(tileId);
            this.expiredWhileSuspended.delete(tileId);
        }
        for (const tileId of nextCoverage.tileIds) {
            if (!previousTileIds.has(tileId)) {
                this.pendingTileIds.add(tileId);
            }
        }
        if (removedTileIds.length) {
            this.owner.cancelFilterTileExpiries?.(this, removedTileIds);
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
        const expiredTileIds = [...this.expiredWhileSuspended]
            .filter(([tileId, valueVersion]) =>
                this.acceptedValueVersionsByTile.get(tileId) === valueVersion
            )
            .map(([tileId]) => tileId);
        this.expiredWhileSuspended.clear();
        for (const tileId of expiredTileIds) {
            this.pendingTileIds.add(tileId);
        }
        if (expiredTileIds.length) {
            this.callbacks.onTilesPending?.(
                expiredTileIds,
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
        this.owner.cancelFilterTileExpiries?.(this);
        this.owner.releaseFilterSubscription(this);
    }

    /** Internal canonical request object serialized into `/interactive`. */
    requestJson(): Record<string, unknown> {
        const tileIds = this.coverageValue.tileIds
            .filter(tileId => this.pendingTileIds.has(tileId));
        const pending = new Set(tileIds);
        const priorityTileIds = (this.coverageValue.priorityTileIds ?? [])
            .filter(tileId => pending.has(tileId));
        const roots = (this.coverageValue.roots ?? [])
            .filter(root => pending.has(root.tileId));
        return {
            ...cloneDefinition(this.definitionValue),
            tileIds,
            ...(priorityTileIds.length ? {priorityTileIds} : {}),
            ...(roots.length ? {roots: structuredClone(roots)} : {}),
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
            !this.covers(delivery.tileId)) {
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
        this.acceptedValueVersionsByTile.set(
            delivery.tileId,
            installResult.valueVersion
        );
        if (remainsPending) {
            this.pendingTileIds.add(delivery.tileId);
            this.owner.cancelFilterTileExpiries?.(this, [delivery.tileId]);
            // An already-expired handoff can leave the logical body unchanged,
            // so bypass suppression and give mapget a fresh reconciliation.
            this.owner.updateFilterSubscription(this, true);
        } else {
            this.pendingTileIds.delete(delivery.tileId);
            this.owner.updateFilterTileExpiry?.(
                this,
                delivery.tileId,
                installResult.valueVersion,
                finiteExpiry
            );
            this.owner.updateFilterSubscription(this, false);
        }
        return "accepted";
    }

    /** Internal scheduler boundary; expires only the installed value incarnation. */
    expireTiles(tokens: ReadonlyArray<{tileId: number; valueVersion: number}>): void {
        if (this.releasedValue) {
            return;
        }
        const tileIds = tokens
            .filter(token =>
                this.acceptedValueVersionsByTile.get(token.tileId) ===
                    token.valueVersion
            )
            .map(token => token.tileId);
        if (!tileIds.length) {
            return;
        }
        if (this.suspendedValue) {
            for (const token of tokens) {
                if (this.acceptedValueVersionsByTile.get(token.tileId) ===
                    token.valueVersion) {
                    this.expiredWhileSuspended.set(
                        token.tileId,
                        token.valueVersion
                    );
                }
            }
            return;
        }
        for (const tileId of tileIds) {
            this.pendingTileIds.add(tileId);
        }
        this.callbacks.onTilesPending?.(tileIds, this.generationValue);
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
        this.owner.cancelFilterTileExpiries?.(this);
        this.generationValue += 1;
        this.resetPendingTiles();
        this.owner.updateFilterSubscription(this, true);
    }

    private resetPendingTiles(): void {
        this.pendingTileIds.clear();
        this.acceptedValueVersionsByTile.clear();
        this.expiredWhileSuspended.clear();
        for (const tileId of this.coverageValue.tileIds) {
            this.pendingTileIds.add(tileId);
        }
    }

    private resetCoveredTiles(): void {
        this.coveredTileIds.clear();
        for (const tileId of this.coverageValue.tileIds) {
            this.coveredTileIds.add(tileId);
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
