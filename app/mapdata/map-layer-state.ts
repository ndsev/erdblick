import { z } from "zod";
import type { LayerPresetRef } from "../map-styles/layer-preset";

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

export const LAYER_PRESET_REF_SCHEMA = z.object({
    styleId: z.string(),
    presetId: z.string().min(1)
}).strict();

// A stored unqualified id from the former global preset implementation is retained
// with an empty style id so the map tree can migrate it only when resolution is unique.
export const STORED_LAYER_PRESET_REF_SCHEMA = z.union([
    LAYER_PRESET_REF_SCHEMA,
    z.string().min(1).transform(presetId => ({ styleId: "", presetId }))
]);

/** Returns whether the layer id refers to source or meta-data rather than a feature layer. */
export function isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
    return mapLayerNameOrLayerId.includes('/SourceData-') ||
        mapLayerNameOrLayerId.includes('/Metadata-');
}
