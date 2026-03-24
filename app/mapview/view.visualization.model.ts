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

export class ViewVisualizationState {
    viewport: Viewport = DEFAULT_VIEWPORT;
    visibleTileIds: Set<bigint> = new Set();
    visibleTileIdsPerLevel = new Map<number, Array<bigint>>();
    tileRenderPolicy = new Map<bigint, TileRenderPolicy>();
    tileOrder = new Map<bigint, number>();
    visualizationQueue: ITileVisualization[] = [];
    private visualizedTileLayers: Map<string, Map<string, ITileVisualization>> = new Map();

    getVisualization(styleId: string, tileKey: string): ITileVisualization | undefined {
        return this.visualizedTileLayers.get(styleId)?.get(tileKey);
    }

    putVisualization(styleId: string, tileKey: string, visu: ITileVisualization) {
        let tileVisus = this.visualizedTileLayers.get(styleId);
        if (!tileVisus) {
            tileVisus = new Map<string, ITileVisualization>();
            this.visualizedTileLayers.set(styleId, tileVisus);
        }
        tileVisus.set(tileKey, visu);
    }

    hasVisualizations(styleId: string): boolean {
        return this.visualizedTileLayers.has(styleId);
    }

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

    *getVisualizedStyleIds(): Generator<string> {
        for (const styleId of Array.from(this.visualizedTileLayers.keys())) {
            yield styleId;
        }
    }

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

    getTileRenderPolicy(tileId: bigint): TileRenderPolicy {
        return this.tileRenderPolicy.get(tileId) ?? {
            targetFidelity: "low",
            maxLowFiLod: 0
        };
    }

    getTileOrder(tileId: bigint): number {
        return this.tileOrder.get(tileId) ?? Number.MAX_SAFE_INTEGER;
    }
}
