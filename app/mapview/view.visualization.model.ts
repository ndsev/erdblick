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

/** Per-view visible coverage and stylesheet fidelity decisions. */
export class ViewVisualizationState {
    viewport: Viewport = DEFAULT_VIEWPORT;
    visibleTileIds = new Set<number>();
    visibleTileIdsPerLevel = new Map<number, number[]>();
    visibleTileIdSetsPerLevel = new Map<number, Set<number>>();
    searchVisibleTileIdsPerLevel = new Map<number, number[]>();
    searchVisibleTileIdSetsPerLevel = new Map<number, Set<number>>();
    tileRenderPolicy = new Map<number, TileRenderPolicy>();
    tileOrder = new Map<number, number>();

    recalculateTileIds(
        tileLimit: number,
        levels: Iterable<number>,
        canonicalCameraAltitudeMeters: number,
        lowFiTileThreshold = DEFAULT_LOW_FI_TILE_THRESHOLD
    ): void {
        this.visibleTileIds.clear();
        this.tileRenderPolicy.clear();
        this.visibleTileIdsPerLevel.clear();
        this.visibleTileIdSetsPerLevel.clear();
        this.searchVisibleTileIdsPerLevel.clear();
        this.searchVisibleTileIdSetsPerLevel.clear();
        this.tileOrder.clear();
        for (const level of levels) {
            if (this.visibleTileIdsPerLevel.has(level)) {
                continue;
            }
            const tileIds = coreLib.getTileIds(
                this.viewport,
                level,
                tileLimit
            ) as number[];
            const tileIdSet = new Set(tileIds);
            this.visibleTileIdsPerLevel.set(level, tileIds);
            this.visibleTileIdSetsPerLevel.set(level, tileIdSet);
            tileIdSet.forEach(tileId => this.visibleTileIds.add(tileId));

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
                this.tileRenderPolicy.set(tileId, policy);
                this.tileOrder.set(tileId, order);
            });
        }
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
