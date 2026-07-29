export const DEFAULT_LOW_FI_TILE_THRESHOLD = 128;
export const MIN_LOW_FI_TILE_THRESHOLD = 1;
export const MAX_LOW_FI_TILE_THRESHOLD = 4096;
export const AUTO_TILE_SUBSET_RENDER_WORKER_COUNT = 0;
export const MIN_TILE_SUBSET_RENDER_WORKER_COUNT = 0;
export const MAX_TILE_SUBSET_RENDER_WORKER_COUNT = 32;
export const DEFAULT_RENDER_BLOCK_VERTEX_LIMIT = 16 * 1024;
export const MIN_RENDER_BLOCK_VERTEX_LIMIT = 256;
export const MAX_RENDER_BLOCK_VERTEX_LIMIT = 1024 * 1024;

/** Clamp one low-fi tile threshold to the supported integer preference range. */
export function clampLowFiTileThreshold(
    value: unknown,
    fallback = DEFAULT_LOW_FI_TILE_THRESHOLD
): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(
        MAX_LOW_FI_TILE_THRESHOLD,
        Math.max(MIN_LOW_FI_TILE_THRESHOLD, Math.trunc(numeric))
    );
}

/** Clamp a persisted worker count; zero keeps automatic CPU-based sizing. */
export function clampTileSubsetRenderWorkerCount(
    value: unknown,
    fallback = AUTO_TILE_SUBSET_RENDER_WORKER_COUNT
): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(
        MAX_TILE_SUBSET_RENDER_WORKER_COUNT,
        Math.max(
            MIN_TILE_SUBSET_RENDER_WORKER_COUNT,
            Math.trunc(numeric)
        )
    );
}

/** Clamp the aggregate geometry-vertex budget used by Morton render blocks. */
export function clampRenderBlockVertexLimit(
    value: unknown,
    fallback = DEFAULT_RENDER_BLOCK_VERTEX_LIMIT
): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(
        MAX_RENDER_BLOCK_VERTEX_LIMIT,
        Math.max(
            MIN_RENDER_BLOCK_VERTEX_LIMIT,
            Math.trunc(numeric)
        )
    );
}
