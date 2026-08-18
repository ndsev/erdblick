import type {TileSubsetDelivery} from "./filter-subscription.model";

export type FilterTileStatus = "pending" | "ready" | "error";

export interface TileSubsetDependency {
    sourceTileKey: string;
    mapId: string;
    layerId: string;
    tileId: number;
    sourceFeatureCount: number;
}

export interface TileSubsetIssue {
    channelId: string;
    expression: string;
    scope: string;
    message: string;
    occurrenceCount: number;
}

/**
 * Compact presentation-owned state for one demanded output tile.
 *
 * It owns the exact immutable subset bytes used for rendering. Replacements
 * are atomic; a previous ready value may remain visible while a generation is
 * pending. An in-flight visualization may retain a removed value until its
 * replacement is admitted or the render task is cancelled.
 */
export class FilterTileState {
    status: FilterTileStatus = "pending";
    backendPending = true;
    pendingGeneration: number;
    deliveredGeneration = 0;
    subsetBlob: Uint8Array | null = null;
    stringPoolId = "";
    conversionTimestampMs: number | null = null;
    ttlMs: number | null = null;
    glbAttachmentName = "";
    valueVersion = 0;
    renderedValueVersion = 0;
    sourceFeatureCount: number | null = null;
    renderedEntryCount = 0;
    geometryVertexCount = 0;
    error: string | null = null;
    dependencies: TileSubsetDependency[] = [];
    issues: TileSubsetIssue[] = [];
    info: Record<string, unknown> = {};
    receivedAt = 0;
    renderStats: Record<string, number> = {};

    /** Create one pending output-tile identity for a filter generation. */
    constructor(
        readonly mapId: string,
        readonly layerId: string,
        readonly tileId: number,
        readonly mapTileKey: string,
        generation: number
    ) {
        this.pendingGeneration = generation;
    }

    /** Retain the previous ready value while marking a newer generation pending. */
    markPending(generation: number): void {
        this.pendingGeneration = generation;
        this.backendPending = true;
        this.status = this.subsetBlob ? "ready" : "pending";
        this.error = null;
    }

    /** Absolute semantic lifetime of the installed value, or null when it does not expire. */
    get expiresAtMs(): number | null {
        if (this.conversionTimestampMs === null || this.ttlMs === null) {
            return null;
        }
        const deadline = this.conversionTimestampMs + this.ttlMs;
        return Number.isFinite(deadline) ? deadline : null;
    }

    /**
     * Atomically replace immutable subset bytes after strict identity validation.
     *
     * Same-generation responses are ordered by semantic lifetime rather than
     * transport arrival. Returning false is a benign supersession; identity
     * mismatches still throw because the current handoff cannot be acknowledged.
     */
    install(
        delivery: TileSubsetDelivery,
        remainsPending = false
    ): boolean {
        if (delivery.mapId !== this.mapId ||
            delivery.layerId !== this.layerId ||
            delivery.tileId !== this.tileId ||
            delivery.mapTileKey !== this.mapTileKey) {
            throw new Error(
                `Subset identity mismatch: expected '${this.mapTileKey}', got '${delivery.mapTileKey}'.`
            );
        }

        if (this.subsetBlob &&
            delivery.generation === this.deliveredGeneration) {
            const retainedDeadline = this.expiresAtMs ??
                Number.POSITIVE_INFINITY;
            const incomingDeadline = delivery.conversionTimestampMs !== null &&
                delivery.ttlMs !== null &&
                Number.isFinite(
                    delivery.conversionTimestampMs + delivery.ttlMs
                )
                ? delivery.conversionTimestampMs + delivery.ttlMs
                : Number.POSITIVE_INFINITY;
            if (incomingDeadline <= retainedDeadline) {
                return false;
            }
        }

        const dependencies = delivery.dependencies as TileSubsetDependency[];
        const localDependencies = dependencies.filter(dependency =>
            dependency.mapId === this.mapId &&
            dependency.layerId === this.layerId &&
            Number(dependency.tileId) === this.tileId
        );
        let sourceFeatureCount: number | null = null;
        if (localDependencies.length === 1) {
            const rawCount = Number(localDependencies[0].sourceFeatureCount);
            sourceFeatureCount = Number.isFinite(rawCount)
                ? Math.max(0, Math.floor(rawCount))
                : null;
        }

        this.subsetBlob = delivery.blob;
        this.deliveredGeneration = delivery.generation;
        this.pendingGeneration = delivery.generation;
        this.valueVersion += 1;
        this.backendPending = remainsPending;
        this.status = "ready";
        this.error = null;
        this.renderStats = {};
        this.dependencies = dependencies;
        this.issues = delivery.issues as TileSubsetIssue[];
        this.info = delivery.info;
        this.sourceFeatureCount = sourceFeatureCount;
        this.renderedEntryCount = delivery.numEntries;
        this.geometryVertexCount = delivery.geometryVertexCount;
        this.stringPoolId = delivery.stringPoolId;
        this.conversionTimestampMs = delivery.conversionTimestampMs;
        this.ttlMs = delivery.ttlMs;
        this.glbAttachmentName = delivery.glbAttachmentName;
        this.receivedAt = delivery.receivedAt;
        return true;
    }

    /** Record only failures belonging to the currently pending generation. */
    fail(generation: number, message: string): void {
        if (generation !== this.pendingGeneration) {
            return;
        }
        this.status = this.subsetBlob ? "ready" : "error";
        this.error = message;
    }

    /** Drop all potentially large immutable payloads while preserving identity fields. */
    dispose(): void {
        this.subsetBlob = null;
        this.backendPending = false;
        this.stringPoolId = "";
        this.conversionTimestampMs = null;
        this.ttlMs = null;
        this.glbAttachmentName = "";
        this.dependencies = [];
        this.issues = [];
        this.info = {};
        this.sourceFeatureCount = null;
        this.renderedEntryCount = 0;
        this.geometryVertexCount = 0;
        this.renderedValueVersion = 0;
        this.renderStats = {};
    }
}
