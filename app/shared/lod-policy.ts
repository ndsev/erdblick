export const MIN_STYLE_LOD = 0;
export const MAX_STYLE_LOD = 7;
export const DEFAULT_LOD3_TILE_THRESHOLD = 128;
export const MIN_LOD3_TILE_THRESHOLD = 16;
export const MAX_LOD3_TILE_THRESHOLD = 4096;

/** Clamp the visible-tile boundary between style LOD 2 and LOD 3. */
export function clampLod3TileThreshold(
    value: unknown,
    fallback = DEFAULT_LOD3_TILE_THRESHOLD
): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(
        MAX_LOD3_TILE_THRESHOLD,
        Math.max(MIN_LOD3_TILE_THRESHOLD, Math.trunc(numeric))
    );
}

/** Clamp an external style LOD before it reaches WASM or packed GPU metadata. */
export function clampStyleLod(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return MIN_STYLE_LOD;
    }
    return Math.min(
        MAX_STYLE_LOD,
        Math.max(MIN_STYLE_LOD, Math.trunc(numeric))
    );
}
