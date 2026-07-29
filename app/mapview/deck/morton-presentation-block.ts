import {PackedTileId} from "@ndsev/ndslive-math";

/** Largest spatial presentation block: 4x4 source tiles. */
export const MAX_MORTON_PRESENTATION_BLOCK_BITS = 4;

/** Largest aggregate accepted before a block falls back to a smaller prefix. */
export const MORTON_PRESENTATION_VERTEX_BUDGET = 16 * 1024;

/** Non-singleton block sizes, ordered from the largest prefix to the smallest. */
export const MORTON_AGGREGATE_BLOCK_BIT_COUNTS = [4, 3, 2, 1] as const;

export interface MortonPresentationBlock {
    key: string;
    level: number;
    suffixBitCount: number;
    width: number;
    height: number;
    origin: [number, number, number];
}

export interface MortonBlockBatch extends MortonPresentationBlock {
    tileIds: number[];
}

interface TileGridAddress {
    level: number;
    x: number;
    y: number;
}

function deinterleaveMorton(
    morton: number,
    level: number
): [number, number] {
    let x = 0;
    let y = 0;
    for (let bit = 0; bit < level; ++bit) {
        if (morton & (1 << (2 * bit))) {
            x |= 1 << bit;
        }
        if (morton & (1 << (2 * bit + 1))) {
            y |= 1 << bit;
        }
    }
    if (morton & (1 << (2 * level))) {
        x |= 1 << level;
    }
    return [x, y];
}

function interleaveGrid(
    x: number,
    y: number,
    level: number
): number {
    let morton = 0;
    for (let bit = 0; bit < level; ++bit) {
        if (x & (1 << bit)) {
            morton |= 1 << (2 * bit);
        }
        if (y & (1 << bit)) {
            morton |= 1 << (2 * bit + 1);
        }
    }
    if (x & (1 << level)) {
        morton |= 1 << (2 * level);
    }
    return morton;
}

export function packedTileIdFromGrid(
    x: number,
    y: number,
    level: number
): number {
    return PackedTileId.fromTileIndex(
        interleaveGrid(x, y, level),
        level
    ).value;
}

function blockCenterWgs84(
    southWestTile: PackedTileId,
    width: number,
    height: number
): [number, number] {
    const [southWestX, southWestY] = southWestTile.southWestCorner();
    const tileSize = southWestTile.size();
    const x = southWestX + width * tileSize / 2;
    const y = southWestY + height * tileSize / 2;
    return [
        x * 360 / 2 ** 32,
        y * 180 / 2 ** 31
    ];
}

/** Returns the same-level tile-grid address encoded by one packed tile id. */
export function tileGridAddress(tileId: number): TileGridAddress {
    const tile = new PackedTileId(tileId);
    const [x, y] = deinterleaveMorton(
        tile.mortonNumber(),
        tile.level()
    );
    return {
        level: tile.level(),
        x,
        y
    };
}

/**
 * Returns the deterministic aligned ownership block used to combine Deck
 * contributions. Each suffix bit doubles one alternating grid axis, so odd
 * bit counts produce the canonical intermediate Morton rectangles.
 */
export function mortonPresentationBlock(
    tileId: number,
    requestedSuffixBitCount = MAX_MORTON_PRESENTATION_BLOCK_BITS
): MortonPresentationBlock {
    const tile = new PackedTileId(tileId);
    const level = tile.level();
    const [x, y] = deinterleaveMorton(tile.mortonNumber(), level);
    const suffixBitCount = Math.max(
        0,
        Math.min(
            Math.floor(requestedSuffixBitCount),
            2 * level + 1
        )
    );
    const width = 2 ** Math.ceil(suffixBitCount / 2);
    const height = 2 ** Math.floor(suffixBitCount / 2);
    const baseX = Math.floor(x / width) * width;
    const baseY = Math.floor(y / height) * height;
    const southWestTile = new PackedTileId(
        packedTileIdFromGrid(baseX, baseY, level)
    );
    const [longitude, latitude] = blockCenterWgs84(
        southWestTile,
        width,
        height
    );
    return {
        key: `z${level}/b${suffixBitCount}/t${southWestTile.value}`,
        level,
        suffixBitCount,
        width,
        height,
        origin: [longitude, latitude, 0]
    };
}

/** Returns one selected aligned block batch and all of its same-level tiles. */
export function mortonBlockBatch(
    tileId: number,
    requestedSuffixBitCount: number
): MortonBlockBatch {
    const block = mortonPresentationBlock(
        tileId,
        requestedSuffixBitCount
    );
    return {
        ...block,
        tileIds: mortonBlockTileIds(
            tileId,
            block.suffixBitCount
        )
    };
}

/**
 * Enumerates one aligned Morton-prefix rectangle containing `tileId`.
 * The 4x4 spatial limit makes readiness probes independent of queue length.
 */
export function mortonBlockTileIds(
    tileId: number,
    requestedSuffixBitCount: number
): number[] {
    const tile = new PackedTileId(tileId);
    const level = tile.level();
    const [tileX, tileY] = deinterleaveMorton(
        tile.mortonNumber(),
        level
    );
    const suffixBitCount = Math.max(
        0,
        Math.min(
            Math.floor(requestedSuffixBitCount),
            2 * level + 1
        )
    );
    const width = 2 ** Math.ceil(suffixBitCount / 2);
    const height = 2 ** Math.floor(suffixBitCount / 2);
    const baseX = Math.floor(tileX / width) * width;
    const baseY = Math.floor(tileY / height) * height;
    const result: number[] = [];
    for (let y = baseY; y < baseY + height; ++y) {
        for (let x = baseX; x < baseX + width; ++x) {
            result.push(packedTileIdFromGrid(x, y, level));
        }
    }
    return result;
}

/**
 * Applies the soft aggregate limit while always permitting a singleton.
 */
export function fitsMortonPresentationVertexBudget(
    vertexCounts: readonly number[],
    budget = MORTON_PRESENTATION_VERTEX_BUDGET
): boolean {
    if (vertexCounts.length <= 1) {
        return true;
    }
    let total = 0;
    for (const count of vertexCounts) {
        if (!Number.isFinite(count) || count < 0) {
            return false;
        }
        total += count;
        if (total > budget) {
            return false;
        }
    }
    return true;
}
