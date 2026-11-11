/**
 * Named stylesheet option values and their stable preset references.
 * These contracts are shared by persistence and preset resolution without
 * loading styles or constructing the preset service.
 */
/** One Boolean option value declared by a preset in its owning style sheet. */
export interface LayerPresetValue {
    optionId: string;
    value: boolean;
}

/** A preset whose style id and layer affinity are supplied by its owning style sheet. */
export interface LayerPresetDefinition {
    id: string;
    name: string;
    values: LayerPresetValue[];
}

/** Stable qualified identity of a layer preset outside its owning style sheet. */
export interface LayerPresetRef {
    styleId: string;
    presetId: string;
}
