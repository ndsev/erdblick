export const AUTO_TILE_SUBSET_RENDER_WORKER_COUNT = 0;
export const MIN_TILE_SUBSET_RENDER_WORKER_COUNT = 0;
export const MAX_TILE_SUBSET_RENDER_WORKER_COUNT = 32;

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
