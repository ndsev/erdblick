import {z} from "zod";
import type {LayerPresetRef} from "../styledata/layer-preset.model";

export const DEFAULT_TILE_GRID_LEVEL = 13;

export const DEFAULT_TILE_GRID_COLOR = "f5f5f5";

export const DEFAULT_TILE_GRID_OPACITY = 39;

/** Persisted selected background-layer id plus per-view opacity. */
export interface BackgroundLayerViewState {
    layerId: string | null;
    opacity: number;
}

/** Per-view configuration entry for one map/layer selection. */
export interface LayerViewConfig {
    autoLevel: boolean;
    level: number;
    visible: boolean;
}

/** One complete per-option value array written through the atomic style-state batch API. */
export interface StyleOptionStateUpdate {
    mapId: string;
    layerId: string;
    shortStyleId: string;
    optionId: string;
    values: Array<string | number | boolean>;
}

/** Qualified layer-preset selections for concrete map/layer pairs within one map view. */
export type LayerPresetSelections = Record<string, Record<string, LayerPresetRef>>;

/** Map-preset selections for concrete maps within one map view. */
export type MapPresetSelections = Record<string, string>;

export const LAYER_PRESET_REF_SCHEMA = z
    .object({
        styleId: z.string(),
        presetId: z.string().min(1)
    })
    .strict();

// A stored unqualified id from the former global preset implementation is retained
// with an empty style id so the map tree can migrate it only when resolution is unique.
export const STORED_LAYER_PRESET_REF_SCHEMA = z.union([
    LAYER_PRESET_REF_SCHEMA,
    z
        .string()
        .min(1)
        .transform((presetId) => ({styleId: "", presetId}))
]);

/** Tile-grid overlay labeling mode used by the map panel and Deck overlay. */
export type TileGridMode = "xyz" | "nds";

/** Returns the highest meaningful grid level for the selected coordinate mode. */
export function tileGridMaxLevel(mode: TileGridMode): number {
    return mode === "nds" ? 15 : 22;
}

/** Clamps a configured grid level to the selected coordinate mode. */
export function clampTileGridLevel(value: unknown, mode: TileGridMode): number {
    const numeric = Number(value);
    return Number.isFinite(numeric)
        ? Math.max(0, Math.min(tileGridMaxLevel(mode), Math.round(numeric)))
        : DEFAULT_TILE_GRID_LEVEL;
}

/** Normalizes a PrimeNG colour-picker value to six lowercase RGB digits. */
export function normalizeTileGridColor(value: unknown): string {
    const normalized = String(value).replace(/^#/, "").toLowerCase();
    return /^[0-9a-f]{6}$/.test(normalized) ? normalized : DEFAULT_TILE_GRID_COLOR;
}

/** Clamps tile-grid opacity to an integer percentage. */
export function clampTileGridOpacity(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : DEFAULT_TILE_GRID_OPACITY;
}

/** Converts persisted grid appearance values to the deck.gl RGBA tuple. */
export function tileGridRgba(color: string, opacity: number): [number, number, number, number] {
    const normalized = normalizeTileGridColor(color);
    return [
        Number.parseInt(normalized.slice(0, 2), 16),
        Number.parseInt(normalized.slice(2, 4), 16),
        Number.parseInt(normalized.slice(4, 6), 16),
        Math.round((clampTileGridOpacity(opacity) * 255) / 100)
    ];
}

/** Returns whether the layer id refers to source or meta-data rather than a feature layer. */
export function isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
    return mapLayerNameOrLayerId.includes("/SourceData-") || mapLayerNameOrLayerId.includes("/Metadata-");
}
