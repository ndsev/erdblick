import {Viewport} from "../../build/libs/core/erdblick-core";
import {coreLib} from "../integrations/wasm";
import type {ITileVisualization} from "./render-view.model";

export const DEFAULT_VIEWPORT: Viewport = {
    south: .0,
    west: .0,
    width: .0,
    height: .0,
    camPosLon: .0,
    camPosLat: .0,
    orientation: .0
};

/**
 * Visible-tile-count policy for low-fidelity rendering.
 * For levels with many visible tiles we force low-fidelity stage-0 rendering
 * and progressively tighten the allowed LOD in stage 0.
 */
export const LOW_FI_LOD0_TILE_COUNT_THRESHOLD = 4096;
export const LOW_FI_LOD1_TILE_COUNT_THRESHOLD = 1024;
export const LOW_FI_LOD2_TILE_COUNT_THRESHOLD = 512;
export const LOW_FI_LOD3_TILE_COUNT_THRESHOLD = 256;
export const LOW_FI_LOD4_TILE_COUNT_THRESHOLD = 128;
export const LOW_FI_LOD5_TILE_COUNT_THRESHOLD = 64;
export const LOW_FI_LOD6_TILE_COUNT_THRESHOLD = 32;
export const LOW_FI_LOD7_TILE_COUNT_THRESHOLD = 16;
export const LOW_FI_MAX_LOD = 7;

export interface TileRenderPolicy {
    targetFidelity: "low" | "high";
    maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
}

/** Maps a visible tile count to the low-/high-fidelity policy that should be applied at that density. */
function tileRenderPolicyForCount(tileCount: number, pinLowFiToMaxLod: boolean): TileRenderPolicy {
    const lowFiPolicy = (maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7): TileRenderPolicy => ({
        targetFidelity: "low",
        maxLowFiLod: pinLowFiToMaxLod ? LOW_FI_MAX_LOD : maxLowFiLod
    });
    if (tileCount >= LOW_FI_LOD0_TILE_COUNT_THRESHOLD) {
        return lowFiPolicy(0);
    }
    if (tileCount >= LOW_FI_LOD1_TILE_COUNT_THRESHOLD) {
        return lowFiPolicy(1);
    }
    if (tileCount >= LOW_FI_LOD2_TILE_COUNT_THRESHOLD) {
        return lowFiPolicy(2);
    }
    if (tileCount >= LOW_FI_LOD3_TILE_COUNT_THRESHOLD) {
        return lowFiPolicy(3);
    }
    if (tileCount >= LOW_FI_LOD4_TILE_COUNT_THRESHOLD) {
        return lowFiPolicy(4);
    }
    if (tileCount >= LOW_FI_LOD5_TILE_COUNT_THRESHOLD) {
        return lowFiPolicy(5);
    }
    if (tileCount >= LOW_FI_LOD6_TILE_COUNT_THRESHOLD) {
        return lowFiPolicy(6);
    }
    if (tileCount >= LOW_FI_LOD7_TILE_COUNT_THRESHOLD) {
        return lowFiPolicy(7);
    }
    return {
        targetFidelity: "high",
        maxLowFiLod: null
    };
}

/**
 * Ordered per-view queue for pending visualizations.
 * Membership and sort invalidation live here so render scheduling cannot accidentally desynchronize them.
 */
export class VisualizationQueue {
    private readonly queue: ITileVisualization[] = [];
    private readonly queued = new Set<ITileVisualization>();
    private orderDirty = false;

    /** Returns the number of queued visualizations. */
    get length(): number {
        return this.queue.length;
    }

    /** Exposes the raw queue for diagnostics; callers must treat it as read-only. */
    get items(): readonly ITileVisualization[] {
        return this.queue;
    }

    /** Returns whether the visualization is already queued. */
    has(visualization: ITileVisualization): boolean {
        return this.queued.has(visualization);
    }

    /** Adds a visualization once and marks queue ordering as dirty. */
    enqueue(visualization: ITileVisualization): void {
        this.orderDirty = true;
        if (this.queued.has(visualization)) {
            return;
        }
        this.queue.push(visualization);
        this.queued.add(visualization);
    }

    /** Pops the highest-priority visualization whose tile is not currently blocked. */
    dequeueNext(blockedTileIds?: ReadonlyMap<bigint, number>): ITileVisualization | undefined {
        if (!this.queue.length) {
            return undefined;
        }
        this.ensureSorted();

        if (!blockedTileIds || !blockedTileIds.size) {
            return this.removeAt(0);
        }

        const queueIndex = this.queue.findIndex(candidate => !blockedTileIds.has(candidate.tile.tileId));
        return queueIndex < 0 ? undefined : this.removeAt(queueIndex);
    }

    /** Retains only the entries accepted by the predicate and rebuilds membership bookkeeping if needed. */
    retain(predicate: (visualization: ITileVisualization) => boolean): void {
        if (!this.queue.length) {
            return;
        }

        let removed = false;
        const retained = this.queue.filter(visualization => {
            const keep = predicate(visualization);
            removed = removed || !keep;
            return keep;
        });
        if (!removed) {
            return;
        }

        this.queue.length = 0;
        this.queue.push(...retained);
        this.queued.clear();
        for (const visualization of this.queue) {
            this.queued.add(visualization);
        }
    }

    /** Drops all queued visualizations and resets the ordering state. */
    clear(): void {
        this.queue.length = 0;
        this.queued.clear();
        this.orderDirty = false;
    }

    /** Sorts lazily so repeated enqueue bursts only pay one ordering pass. */
    private ensureSorted(): void {
        if (!this.orderDirty) {
            return;
        }
        this.sort();
    }

    /** Orders visualizations by render rank, then by stable tile/style identifiers. */
    private sort(): void {
        this.orderDirty = false;
        if (this.queue.length < 2) {
            return;
        }
        const rankedQueue = this.queue.map((visualization, index) => ({
            visualization,
            rank: visualization.renderRank(),
            tileKey: visualization.tile.mapTileKey,
            styleId: visualization.styleId,
            index
        }));
        rankedQueue.sort((lhs, rhs) => {
            if (lhs.rank !== rhs.rank) {
                return lhs.rank - rhs.rank;
            }
            const tileKeyCompare = lhs.tileKey.localeCompare(rhs.tileKey);
            if (tileKeyCompare !== 0) {
                return tileKeyCompare;
            }
            const styleIdCompare = lhs.styleId.localeCompare(rhs.styleId);
            if (styleIdCompare !== 0) {
                return styleIdCompare;
            }
            return lhs.index - rhs.index;
        });
        for (let i = 0; i < rankedQueue.length; i++) {
            this.queue[i] = rankedQueue[i].visualization;
        }
    }

    /** Removes one queue entry while keeping the membership set in sync. */
    private removeAt(index: number): ITileVisualization | undefined {
        const [entry] = this.queue.splice(index, 1);
        if (entry) {
            this.queued.delete(entry);
        }
        return entry;
    }
}

/**
 * Per-view cache of visible tiles, tile render policies, and active visualizations.
 * This is the local working set owned by `MapViewStateService` and mutated by `MapRenderService`.
 */
export class ViewVisualizationState {
    viewport: Viewport = DEFAULT_VIEWPORT;
    visibleTileIds: Set<bigint> = new Set();
    visibleTileIdsPerLevel = new Map<number, Array<bigint>>();
    tileRenderPolicy = new Map<bigint, TileRenderPolicy>();
    tileOrder = new Map<bigint, number>();
    readonly visualizationQueue = new VisualizationQueue();
    private visualizedTileLayers: Map<string, Map<string, ITileVisualization>> = new Map();

    /** Returns the visualization for one style/tile pair if it already exists. */
    getVisualization(styleId: string, tileKey: string): ITileVisualization | undefined {
        return this.visualizedTileLayers.get(styleId)?.get(tileKey);
    }

    /** Inserts or replaces the visualization for one style/tile pair. */
    putVisualization(styleId: string, tileKey: string, visu: ITileVisualization) {
        let tileVisus = this.visualizedTileLayers.get(styleId);
        if (!tileVisus) {
            tileVisus = new Map<string, ITileVisualization>();
            this.visualizedTileLayers.set(styleId, tileVisus);
        }
        tileVisus.set(tileKey, visu);
    }

    /** Returns whether this view currently holds any visualizations for the given style. */
    hasVisualizations(styleId: string): boolean {
        return this.visualizedTileLayers.has(styleId);
    }

    /** Removes visualizations filtered by style id, tile key, or both, yielding each removed instance. */
    *removeVisualizations(styleId?: string, tileKey?: string): Generator<ITileVisualization> {
        if (styleId !== undefined) {
            if (tileKey !== undefined) {
                const tileVisus = this.visualizedTileLayers.get(styleId);
                if (!tileVisus) {
                    return;
                }
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                    tileVisus.delete(tileKey);
                }
                if (!tileVisus.size) {
                    this.visualizedTileLayers.delete(styleId);
                }
                return;
            }
            const tileVisus = this.visualizedTileLayers.get(styleId);
            if (tileVisus) {
                for (const visu of tileVisus.values()) {
                    yield visu;
                }
            }
            this.visualizedTileLayers.delete(styleId);
            return;
        }

        if (tileKey !== undefined) {
            const stylesToDelete: string[] = [];
            for (const [style, tileVisus] of this.visualizedTileLayers) {
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                    tileVisus.delete(tileKey);
                }
                if (!tileVisus.size) {
                    stylesToDelete.push(style);
                }
            }
            for (const style of stylesToDelete) {
                this.visualizedTileLayers.delete(style);
            }
            return;
        }

        for (const tileVisus of this.visualizedTileLayers.values()) {
            for (const visu of tileVisus.values()) {
                yield visu;
            }
        }
        this.visualizedTileLayers.clear();
    }

    /** Iterates the style ids that currently have at least one visualization in this view. */
    *getVisualizedStyleIds(): Generator<string> {
        for (const styleId of Array.from(this.visualizedTileLayers.keys())) {
            yield styleId;
        }
    }

    /** Iterates visualizations filtered by style id, tile key, or both. */
    *getVisualizations(styleId?: string, tileKey?: string): Generator<ITileVisualization> {
        if (styleId !== undefined) {
            const tileVisus = this.visualizedTileLayers.get(styleId);
            if (!tileVisus) {
                return;
            }
            if (tileKey !== undefined) {
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                }
                return;
            }
            for (const visu of tileVisus.values()) {
                yield visu;
            }
            return;
        }

        if (tileKey !== undefined) {
            for (const tileVisus of this.visualizedTileLayers.values()) {
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                }
            }
            return;
        }

        for (const tileVisus of this.visualizedTileLayers.values()) {
            for (const visu of tileVisus.values()) {
                yield visu;
            }
        }
    }

    /**
     * Recomputes visible tile ids and the corresponding fidelity policy for each requested level.
     * Tile order is cached alongside visibility so render scheduling can stay stable across updates.
     */
    recalculateTileIds(
        tileLimit: number,
        levels: Iterable<number>,
        canonicalCameraAltitudeMeters: number,
        pinLowFiToMaxLod = false
    ) {
        this.visibleTileIds.clear();
        this.tileRenderPolicy.clear();
        this.visibleTileIdsPerLevel.clear();
        this.tileOrder.clear();
        for (let level of levels) {
            if (this.visibleTileIdsPerLevel.has(level)) {
                continue;
            }
            const visibleTileIdsForLevel = coreLib.getTileIds(this.viewport, level, tileLimit) as bigint[];
            this.visibleTileIdsPerLevel.set(level, visibleTileIdsForLevel);
            this.visibleTileIds = new Set([
                ...this.visibleTileIds,
                ...new Set<bigint>(visibleTileIdsForLevel)
            ]);

            const canonicalTileCount = coreLib.getNumTileIdsForCanonicalCamera(canonicalCameraAltitudeMeters, level);
            const levelPolicy = tileRenderPolicyForCount(canonicalTileCount, pinLowFiToMaxLod);

            for (const tileId of visibleTileIdsForLevel) {
                this.tileRenderPolicy.set(tileId, levelPolicy);
            }
            for (let order = 0; order < visibleTileIdsForLevel.length; order++) {
                const tileId = visibleTileIdsForLevel[order];
                this.tileOrder.set(tileId, order);
            }
        }
    }

    /** Returns the cached fidelity policy for a tile, defaulting to the most conservative low-fi fallback. */
    getTileRenderPolicy(tileId: bigint): TileRenderPolicy {
        return this.tileRenderPolicy.get(tileId) ?? {
            targetFidelity: "low",
            maxLowFiLod: 0
        };
    }

    /** Returns the cached render-order index for a tile, or a large fallback for unknown tiles. */
    getTileOrder(tileId: bigint): number {
        return this.tileOrder.get(tileId) ?? Number.MAX_SAFE_INTEGER;
    }
}
