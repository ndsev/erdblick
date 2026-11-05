/**
 * The stylesheet LOD ladder accepted by WASM and packed GPU metadata.
 * Presentation may interpolate between these levels; styles use integer steps.
 */
export const MIN_STYLE_LOD = 0;
export const MAX_STYLE_LOD = 7;

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
