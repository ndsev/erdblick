import {z} from "zod";

/** One layer-preset selection composed into a map-level preset. */
export interface MapPresetLayer {
    layerId: string;
    styleId: string;
    presetId: string;
}

/** A map-agnostic preset that is evaluated independently against each map. */
export interface MapPresetDefinition {
    id: string;
    name: string;
    enabled: boolean;
    layerPresets: MapPresetLayer[];
}

/** Structural problem in one configured or locally edited map preset. */
export interface MapPresetIssue {
    message: string;
    presetId?: string;
    presetIndex?: number;
    componentIndex?: number;
}

export interface MapPresetParseResult {
    presets: MapPresetDefinition[];
    issues: MapPresetIssue[];
}

const MAP_PRESET_LAYER_SCHEMA = z.object({
    layerId: z.string().trim().min(1).max(200),
    styleId: z.string().trim().min(1).max(200),
    presetId: z.string().trim().min(1).max(200)
}).strict();

const MAP_PRESET_SCHEMA = z.object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    enabled: z.boolean().optional(),
    layerPresets: z.array(MAP_PRESET_LAYER_SCHEMA).min(1).max(100)
}).strict();

/** Structurally validates an inline mapPresets array without consulting current maps or styles. */
export function parseMapPresetDefinitions(source: unknown): MapPresetParseResult {
    if (!Array.isArray(source)) {
        return {presets: [], issues: [{message: "mapPresets must be a list."}]};
    }
    if (source.length > 200) {
        return {presets: [], issues: [{message: "mapPresets exceeds the limit of 200 entries."}]};
    }

    const presets: MapPresetDefinition[] = [];
    const issues: MapPresetIssue[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const [presetIndex, rawPreset] of source.entries()) {
        const parsed = MAP_PRESET_SCHEMA.safeParse(rawPreset);
        if (!parsed.success) {
            issues.push(...parsed.error.issues.map(issue => ({
                presetIndex,
                message: `${issue.path.map(String).join(".") || "preset"}: ${issue.message}`
            })));
            continue;
        }

        const preset = parsed.data;
        let valid = true;
        if (ids.has(preset.id)) {
            issues.push({presetIndex, presetId: preset.id, message: `Duplicate map preset id '${preset.id}'.`});
            valid = false;
        }
        if (names.has(preset.name)) {
            issues.push({presetIndex, presetId: preset.id, message: `Duplicate map preset name '${preset.name}'.`});
            valid = false;
        }
        const layerIds = new Set<string>();
        for (const [componentIndex, component] of preset.layerPresets.entries()) {
            if (layerIds.has(component.layerId)) {
                issues.push({
                    presetIndex,
                    presetId: preset.id,
                    componentIndex,
                    message: `Layer '${component.layerId}' is assigned more than once.`
                });
                valid = false;
            }
            layerIds.add(component.layerId);
        }

        if (valid) {
            ids.add(preset.id);
            names.add(preset.name);
            presets.push({
                id: preset.id,
                name: preset.name,
                enabled: preset.enabled ?? true,
                layerPresets: preset.layerPresets.map(component => ({...component}))
            });
        }
    }
    return {presets, issues};
}

/**
 * Storage/config boundary for the complete map-preset catalog.
 * Invalid siblings are omitted while every accepted entry is normalized.
 */
export const MAP_PRESET_APP_STATE_SCHEMA = z.array(z.unknown())
    .transform(source => parseMapPresetDefinitions(source).presets);
