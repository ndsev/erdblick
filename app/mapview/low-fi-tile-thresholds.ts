export const DEFAULT_HIGH_FIDELITY_TILE_THRESHOLD = 128;
export const DEFAULT_LOW_FIDELITY_TILE_THRESHOLD = 64;
export const MIN_LOW_FI_TILE_THRESHOLD = 1;
export const MAX_LOW_FI_TILE_THRESHOLD = 4096;

export interface LowFiTileThresholds {
    highFidelityTileThreshold: number;
    lowFidelityTileThreshold: number;
}

/** Clamp one low-fi tile threshold to the supported integer preference range. */
export function clampLowFiTileThreshold(
    value: unknown,
    fallback = DEFAULT_LOW_FIDELITY_TILE_THRESHOLD): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(
        MAX_LOW_FI_TILE_THRESHOLD,
        Math.max(MIN_LOW_FI_TILE_THRESHOLD, Math.trunc(numeric)));
}

/** Normalize the two user-facing thresholds while keeping high-fi at least as large as low-fi. */
export function normalizeLowFiTileThresholds(
    highFidelityTileThreshold: unknown,
    lowFidelityTileThreshold: unknown): LowFiTileThresholds {
    const low = clampLowFiTileThreshold(
        lowFidelityTileThreshold,
        DEFAULT_LOW_FIDELITY_TILE_THRESHOLD);
    const high = Math.max(
        low,
        clampLowFiTileThreshold(
            highFidelityTileThreshold,
            DEFAULT_HIGH_FIDELITY_TILE_THRESHOLD));
    return {
        highFidelityTileThreshold: high,
        lowFidelityTileThreshold: low
    };
}
