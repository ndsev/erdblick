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
 * pending. A presentation block may retain a removed value until its final
 * constituent tile leaves the requested coverage.
 */
export class FilterTileState {
    status: FilterTileStatus = "pending";
    pendingGeneration: number;
    deliveredGeneration = 0;
    subsetBlob: Uint8Array | null = null;
    stringPoolId = "";
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

    constructor(
        readonly mapId: string,
        readonly layerId: string,
        readonly tileId: number,
        readonly mapTileKey: string,
        generation: number
    ) {
        this.pendingGeneration = generation;
    }

    markPending(generation: number): void {
        this.pendingGeneration = generation;
        this.status = "pending";
        this.error = null;
    }

    install(delivery: TileSubsetDelivery): void {
        if (delivery.mapId !== this.mapId ||
            delivery.layerId !== this.layerId ||
            delivery.tileId !== this.tileId ||
            delivery.mapTileKey !== this.mapTileKey) {
            throw new Error(
                `Subset identity mismatch: expected '${this.mapTileKey}', got '${delivery.mapTileKey}'.`
            );
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
        this.glbAttachmentName = delivery.glbAttachmentName;
        this.receivedAt = delivery.receivedAt;
    }

    fail(generation: number, message: string): void {
        if (generation !== this.pendingGeneration) {
            return;
        }
        this.status = "error";
        this.error = message;
    }

    dispose(): void {
        this.subsetBlob = null;
        this.stringPoolId = "";
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
