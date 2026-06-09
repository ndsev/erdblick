import type {Viewport} from "../../build/libs/core/erdblick-core";
import type {TileGridMode} from "../shared/appstate.service";

const TILE_GRID_MAX_LEVEL = 22;
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

/** Extent of the visible tile-grid region for one level, including wrap-aware column bookkeeping. */
export interface TileGridLevelExtent {
    level: number;
    rowCount: number;
    colCount: number;
    coversFullWorldX: boolean;
    minCol: number;
    maxCol: number;
    minRow: number;
    maxRow: number;
    width: number;
    height: number;
    west: number;
    east: number;
    south: number;
    north: number;
}

/** Coarsens every requested grid level until its visible cell count falls under the safety threshold. */
export function coarsenedTileGridLevels(
    levels: number[],
    viewport: Viewport,
    maxVisibleCells: number,
    mode: TileGridMode
): number[] {
    const effectiveLevels = new Set<number>();
    for (const level of levels) {
        effectiveLevels.add(coarsenedTileLevel(level, viewport, maxVisibleCells, mode));
    }
    return Array.from(effectiveLevels.values()).sort((lhs, rhs) => lhs - rhs);
}

/** Coarsens one tile level until the number of visible cells fits the supplied overlay budget. */
export function coarsenedTileLevel(
    level: number,
    viewport: Viewport,
    maxVisibleCells: number,
    mode: TileGridMode
): number {
    let effectiveLevel = Math.max(0, Math.min(TILE_GRID_MAX_LEVEL, Math.floor(level)));
    while (effectiveLevel > 0 && tileGridVisibleCellCount(effectiveLevel, viewport, mode) > maxVisibleCells) {
        effectiveLevel -= 1;
    }
    return effectiveLevel;
}

/** Returns the number of grid cells that would be visible for a level in the supplied viewport. */
export function tileGridVisibleCellCount(level: number, viewport: Viewport, mode: TileGridMode): number {
    const extent = tileGridExtentForLevel(level, viewport, mode);
    return extent ? extent.width * extent.height : 0;
}

/**
 * Computes the wrap-aware tile-grid extent that covers the current viewport for one level.
 * The extent intentionally includes a small margin so fast pans do not reveal seams immediately.
 */
export function tileGridExtentForLevel(
    level: number,
    viewport: Viewport,
    mode: TileGridMode
): TileGridLevelExtent | null {
    if (!Number.isFinite(level) || level < 0) {
        return null;
    }
    const safeLevel = Math.max(0, Math.min(TILE_GRID_MAX_LEVEL, Math.floor(level)));
    const viewportWest = viewport.west;
    const viewportEast = viewport.west + viewport.width;
    const viewportSouth = viewport.south;
    const viewportNorth = viewport.south + viewport.height;
    const westNorm = tileGridLonToNormX(viewportWest);
    const eastNorm = tileGridLonToNormX(viewportEast);
    const southNorm = tileGridLatToNormY(viewportSouth, mode);
    const northNorm = tileGridLatToNormY(viewportNorth, mode);
    const rowCount = Math.pow(2, safeLevel);
    const colCount = mode === "nds" ? rowCount * 2 : rowCount;
    const coversFullWorldX = eastNorm - westNorm >= 1 - 1e-9;
    const normMinX = coversFullWorldX ? 0 : Math.min(westNorm, eastNorm);
    const normMaxX = coversFullWorldX ? 1 : Math.max(westNorm, eastNorm);
    const normMinY = Math.min(northNorm, southNorm);
    const normMaxY = Math.max(northNorm, southNorm);
    const marginTiles = 2;
    const minCol = coversFullWorldX ? 0 : Math.floor(normMinX * colCount) - marginTiles;
    const maxCol = coversFullWorldX ? colCount : Math.ceil(normMaxX * colCount) + marginTiles;
    const minRow = Math.max(0, Math.floor(normMinY * rowCount) - marginTiles);
    const maxRow = Math.min(rowCount, Math.ceil(normMaxY * rowCount) + marginTiles);
    const width = Math.max(1, maxCol - minCol);
    const height = Math.max(1, maxRow - minRow);
    const north = tileGridNormYToLat(minRow / rowCount, mode);
    const south = tileGridNormYToLat(maxRow / rowCount, mode);
    return {
        level: safeLevel,
        rowCount,
        colCount,
        coversFullWorldX,
        minCol,
        maxCol,
        minRow,
        maxRow,
        width,
        height,
        west: tileGridNormXToLon(minCol / colCount),
        east: tileGridNormXToLon(maxCol / colCount),
        north: Math.min(north, WEB_MERCATOR_MAX_LATITUDE),
        south: Math.max(south, -WEB_MERCATOR_MAX_LATITUDE)
    };
}

/** Converts a tile id's raw column into the current extent so world-wrap repeats stay contiguous. */
export function wrapColumnIntoExtent(rawCol: number, extent: TileGridLevelExtent): number {
    const normalizedCol = ((rawCol % extent.colCount) + extent.colCount) % extent.colCount;
    const repeatsToNearExtent = Math.round((extent.minCol - normalizedCol) / extent.colCount);
    let repeatedCol = normalizedCol + repeatsToNearExtent * extent.colCount;
    while (repeatedCol < extent.minCol) {
        repeatedCol += extent.colCount;
    }
    while (repeatedCol >= extent.maxCol) {
        repeatedCol -= extent.colCount;
    }
    return repeatedCol - extent.minCol;
}

/** Converts longitude to the normalized X space shared by tile-grid calculations. */
export function tileGridLonToNormX(lon: number): number {
    return (lon + 180.0) / 360.0;
}

/** Converts normalized X space back to longitude. */
export function tileGridNormXToLon(normX: number): number {
    return normX * 360.0 - 180.0;
}

/** Converts latitude to normalized Y in either XYZ/Mercator or NDS grid space. */
export function tileGridLatToNormY(lat: number, mode: TileGridMode): number {
    if (mode === "nds") {
        const clampedLat = Math.max(-90.0, Math.min(90.0, lat));
        return (90.0 - clampedLat) / 180.0;
    }
    const clampedLat = Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, lat));
    const sinLat = Math.sin((clampedLat * Math.PI) / 180.0);
    const mercatorY = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    return Math.max(0, Math.min(1, mercatorY));
}

/** Converts normalized Y back to latitude in either XYZ/Mercator or NDS grid space. */
export function tileGridNormYToLat(normY: number, mode: TileGridMode): number {
    const clampedY = Math.max(0, Math.min(1, normY));
    if (mode === "nds") {
        return 90.0 - clampedY * 180.0;
    }
    const exponent = Math.exp(Math.PI * (1 - 2 * clampedY));
    const latRad = 2 * Math.atan(exponent) - Math.PI / 2;
    return (latRad * 180.0) / Math.PI;
}
