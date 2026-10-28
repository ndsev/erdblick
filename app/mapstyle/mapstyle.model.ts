/**
 * Stylesheet bundle declarations, loaded-style values and lifecycle snapshots.
 * Configuration parsing and public value shapes stay independent of the style
 * service; this module never loads a stylesheet or initializes native code.
 */
import { z } from "zod";

/** One built-in style bundle entry declared in `config.json`. */
export interface StyleConfigEntry {
    id?: string;
    url: string;
    additional?: boolean;
}

export const STYLE_CONFIG_ENTRY_SCHEMA = z.object({
    id: z.string().optional(),
    url: z.string().min(1),
    additional: z.boolean().optional()
});

/** Normalizes configured style entries. */
export function normalizeStyles(styles: Array<StyleConfigEntry | string> | undefined, additional: boolean): StyleConfigEntry[] {
    if (!Array.isArray(styles)) {
        return [];
    }

    const normalized: StyleConfigEntry[] = [];
    for (const entry of styles) {
        const parsed = STYLE_CONFIG_ENTRY_SCHEMA.safeParse(
            typeof entry === "string" ? { url: entry } : entry
        );
        if (!parsed.success) {
            continue;
        }
        normalized.push({
            ...parsed.data,
            additional
        });
    }
    return normalized;
}

import type { FeatureLayerStyle, FeatureStyleOptionType } from "../../build/libs/core/erdblick-core";
import type { LayerPresetDefinition } from "./layer-preset.model";
import type { StyleSourceRef } from "./style-validation.model";
/** Original server-provided builtin style source kept for resets and comparisons. */
/** Original style source used when comparing or restoring a built-in style. */
export interface BuiltinStyleBaseline {
    id: string,
    source: string
}

/** The built-in source retained behind an imported override. */
export interface OverriddenBaseStyleBaseline extends BuiltinStyleBaseline {
    url: string
}

/** Saved modification markers used to reconcile configured and local styles. */
export interface StyleLifecycleState {
    id: string,
    sha256: string,
    isModified: boolean,
    isUpdated: boolean
}

/** A modified style whose configured source needs refreshing. */
export interface UpdatedModifiedStyleEntry {
    id: string,
    url: string
}

/** An editable native style option with its stable public type name. */
export type FeatureStyleOptionWithStringType = {
    label: string,
    id: string,
    type: FeatureStyleOptionType | string,
    defaultValue: any,
    description: string,
    internal: boolean
};

/** A loaded style value and its metadata; its lifecycle owner releases the native handle. */
export interface ErdblickStyle {
    id: string,
    modified: boolean,
    imported: boolean,
    additional: boolean,
    category: "base" | "search",
    source: string,
    featureLayerStyle: FeatureLayerStyle,
    options: Array<FeatureStyleOptionWithStringType>,
    presets: LayerPresetDefinition[],
    shortId: string,
    key?: string,
    type?: string,
    children?: Array<FeatureStyleOptionWithStringType>,
    expanded?: boolean,
    visible: boolean,
    url: string,
    sourceRef: StyleSourceRef,
    overridesBaseStyle?: OverriddenBaseStyleBaseline
}

/** A display group containing styles or nested style groups. */
export interface ErdblickStyleGroup extends Record<string, any> {
    key: string;
    id: string;
    type: string;
    children: Array<ErdblickStyleGroup | ErdblickStyle>;
    visible: boolean,
    expanded: boolean
}
