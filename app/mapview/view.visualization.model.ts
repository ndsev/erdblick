import type {Viewport} from "../../build/libs/core/erdblick-core";
import {coreLib} from "../integrations/wasm";
import {
    clampLowFiTileThreshold,
    DEFAULT_LOW_FI_TILE_THRESHOLD
} from "../shared/tile-render-policy";

export const DEFAULT_VIEWPORT: Viewport = {
    south: 0,
    west: 0,
    width: 0,
    height: 0,
    camPosLon: 0,
    camPosLat: 0,
    orientation: 0
};

export interface TileRenderPolicy {
    targetFidelity: "low" | "high";
}

function tileRenderPolicyForCount(
    tileCount: number,
    lowFiTileThreshold: number
): TileRenderPolicy {
    return {
        targetFidelity: tileCount <
            clampLowFiTileThreshold(lowFiTileThreshold)
            ? "high"
            : "low"
    };
}

function tileIdSetsEqual(
    left: ReadonlySet<number> | undefined,
    right: ReadonlySet<number> | undefined
): boolean {
    return !!left && !!right &&
        left.size === right.size &&
        [...left].every(tileId => right.has(tileId));
}

/** Per-view visible coverage and stylesheet fidelity decisions. */
export class ViewVisualizationState {
    viewport: Viewport = DEFAULT_VIEWPORT;
    canonicalCameraAltitudeMeters: number | null = null;
    visibleTileIds = new Set<number>();
    visibleTileIdsPerLevel = new Map<number, number[]>();
    visibleTileIdSetsPerLevel = new Map<number, Set<number>>();
    searchVisibleTileIdsPerLevel = new Map<number, number[]>();
    searchVisibleTileIdSetsPerLevel = new Map<number, Set<number>>();
    tileRenderPolicy = new Map<number, TileRenderPolicy>();
    tileOrder = new Map<number, number>();
    coverageVersion = 0;

    recalculateTileIds(
        tileLimit: number,
        levels: Iterable<number>,
        canonicalCameraAltitudeMeters: number,
        lowFiTileThreshold = DEFAULT_LOW_FI_TILE_THRESHOLD
    ): void {
        const visibleTileIds = new Set<number>();
        const visibleTileIdsPerLevel = new Map<number, number[]>();
        const visibleTileIdSetsPerLevel = new Map<number, Set<number>>();
        const tileRenderPolicy = new Map<number, TileRenderPolicy>();
        const tileOrder = new Map<number, number>();
        for (const level of levels) {
            if (visibleTileIdsPerLevel.has(level)) {
                continue;
            }
            const tileIds = coreLib.getTileIds(
                this.viewport,
                level,
                tileLimit
            ) as number[];
            const tileIdSet = new Set(tileIds);
            visibleTileIdsPerLevel.set(level, tileIds);
            visibleTileIdSetsPerLevel.set(level, tileIdSet);
            tileIdSet.forEach(tileId => visibleTileIds.add(tileId));

            const canonicalTileCount =
                coreLib.getNumTileIdsForCanonicalCamera(
                    canonicalCameraAltitudeMeters,
                    level
                );
            const policy = tileRenderPolicyForCount(
                canonicalTileCount,
                lowFiTileThreshold
            );
            tileIds.forEach((tileId, order) => {
                tileRenderPolicy.set(tileId, policy);
                tileOrder.set(tileId, order);
            });
        }
        const coverageChanged =
            visibleTileIdsPerLevel.size !== this.visibleTileIdsPerLevel.size ||
            [...visibleTileIdSetsPerLevel].some(([level, tileIds]) =>
                !tileIdSetsEqual(
                    tileIds,
                    this.visibleTileIdSetsPerLevel.get(level)
                ) ||
                [...tileIds].some(tileId =>
                    tileRenderPolicy.get(tileId)?.targetFidelity !==
                    this.tileRenderPolicy.get(tileId)?.targetFidelity
                )
            );
        this.searchVisibleTileIdsPerLevel = new Map();
        this.searchVisibleTileIdSetsPerLevel = new Map();
        if (!coverageChanged) {
            return;
        }
        this.visibleTileIds = visibleTileIds;
        this.visibleTileIdsPerLevel = visibleTileIdsPerLevel;
        this.visibleTileIdSetsPerLevel = visibleTileIdSetsPerLevel;
        this.tileRenderPolicy = tileRenderPolicy;
        this.tileOrder = tileOrder;
        this.coverageVersion += 1;
    }

    getTileRenderPolicy(tileId: number): TileRenderPolicy {
        return this.tileRenderPolicy.get(tileId) ?? {
            targetFidelity: "low"
        };
    }

    getTileOrder(tileId: number): number {
        return this.tileOrder.get(tileId) ?? Number.MAX_SAFE_INTEGER;
    }
}
