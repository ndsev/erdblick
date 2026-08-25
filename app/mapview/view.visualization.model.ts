import type {Viewport} from "../../build/libs/core/erdblick-core";
import {coreLib} from "../integrations/wasm";

export const DEFAULT_VIEWPORT: Viewport = {
    south: 0,
    west: 0,
    width: 0,
    height: 0,
    camPosLon: 0,
    camPosLat: 0,
    orientation: 0
};

const LINE_SIMPLIFICATION_ERROR_PIXELS = 0.25;
const MIN_LINE_SIMPLIFICATION_TOLERANCE_METERS = 0.0625;
const MAX_LINE_SIMPLIFICATION_TOLERANCE_METERS = 64;

/** Quantize line LOD so ordinary camera motion does not rebuild visible tiles. */
export function lineSimplificationToleranceMeters(
    metersPerPixel: number | null
): number {
    if (!Number.isFinite(metersPerPixel) || Number(metersPerPixel) <= 0) {
        return 0;
    }
    const desired = Number(metersPerPixel) *
        LINE_SIMPLIFICATION_ERROR_PIXELS;
    if (desired < MIN_LINE_SIMPLIFICATION_TOLERANCE_METERS) {
        return 0;
    }
    return Math.max(
        MIN_LINE_SIMPLIFICATION_TOLERANCE_METERS,
        Math.min(
            MAX_LINE_SIMPLIFICATION_TOLERANCE_METERS,
            2 ** Math.round(Math.log2(desired))
        )
    );
}

function tileIdSetsEqual(
    left: ReadonlySet<number> | undefined,
    right: ReadonlySet<number> | undefined
): boolean {
    return !!left && !!right &&
        left.size === right.size &&
        [...left].every(tileId => right.has(tileId));
}

/** Per-view visible coverage and canonical density inputs for stylesheet LOD. */
export class ViewVisualizationState {
    viewport: Viewport = DEFAULT_VIEWPORT;
    canonicalCameraAltitudeMeters: number | null = null;
    metersPerPixel: number | null = null;
    lineSimplificationToleranceMeters = 0;
    visibleTileIds = new Set<number>();
    visibleTileIdsPerLevel = new Map<number, number[]>();
    visibleTileIdSetsPerLevel = new Map<number, Set<number>>();
    searchVisibleTileIdsPerLevel = new Map<number, number[]>();
    searchVisibleTileIdSetsPerLevel = new Map<number, Set<number>>();
    canonicalVisibleTileCountPerLevel = new Map<number, number>();
    tileOrder = new Map<number, number>();
    coverageVersion = 0;

    recalculateTileIds(
        tileLimit: number,
        levels: Iterable<number>,
        canonicalCameraAltitudeMeters: number
    ): void {
        const visibleTileIds = new Set<number>();
        const visibleTileIdsPerLevel = new Map<number, number[]>();
        const visibleTileIdSetsPerLevel = new Map<number, Set<number>>();
        const canonicalVisibleTileCountPerLevel = new Map<number, number>();
        const tileOrder = new Map<number, number>();
        const nextLineSimplificationToleranceMeters =
            lineSimplificationToleranceMeters(this.metersPerPixel);
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
            canonicalVisibleTileCountPerLevel.set(level, canonicalTileCount);
            tileIds.forEach((tileId, order) => {
                tileOrder.set(tileId, order);
            });
        }
        const coverageChanged =
            nextLineSimplificationToleranceMeters !==
                this.lineSimplificationToleranceMeters ||
            visibleTileIdsPerLevel.size !== this.visibleTileIdsPerLevel.size ||
            [...visibleTileIdSetsPerLevel].some(([level, tileIds]) =>
                !tileIdSetsEqual(
                    tileIds,
                    this.visibleTileIdSetsPerLevel.get(level)
                )
            );
        this.searchVisibleTileIdsPerLevel = new Map();
        this.searchVisibleTileIdSetsPerLevel = new Map();
        this.canonicalVisibleTileCountPerLevel =
            canonicalVisibleTileCountPerLevel;
        if (!coverageChanged) {
            return;
        }
        this.visibleTileIds = visibleTileIds;
        this.visibleTileIdsPerLevel = visibleTileIdsPerLevel;
        this.visibleTileIdSetsPerLevel = visibleTileIdSetsPerLevel;
        this.tileOrder = tileOrder;
        this.lineSimplificationToleranceMeters =
            nextLineSimplificationToleranceMeters;
        this.coverageVersion += 1;
    }

    getTileOrder(tileId: number): number {
        return this.tileOrder.get(tileId) ?? Number.MAX_SAFE_INTEGER;
    }
}
