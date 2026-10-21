/** Background layer id used when neither URL nor stored state selects a layer. */
export const DEFAULT_BACKGROUND_LAYER_ID = "osm";

/** Default background opacity chosen for the shipped OSM layer so map data stays dominant. */
export const DEFAULT_BACKGROUND_OPACITY = 6;

/** Clamps persisted and config-driven background opacity to the supported percentage range. */
export function clampBackgroundOpacity(value: number): number {
    if (!Number.isFinite(value)) {
        return 100;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
}
