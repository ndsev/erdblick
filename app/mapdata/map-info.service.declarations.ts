import {z} from "zod";
import {
    APP_STATE_COLLECTION_LIMIT,
    identifierSchema,
    indexSchema,
    styleOptionValueSchema
} from "../actions/action-schema";
import {viewIdSchema} from "../mapview/view-id";

const viewSelectorSchema = z.strictObject({viewId: viewIdSchema});
const layerSelectorSchema = viewSelectorSchema.extend({mapId: identifierSchema, layerId: identifierSchema});
const presetSchema = z.strictObject({styleId: identifierSchema, presetId: identifierSchema}).nullable();
const layersSchema = z
    .array(
        z.strictObject({
            mapId: identifierSchema,
            layerId: identifierSchema,
            visible: z.boolean(),
            level: indexSchema,
            autoLevel: z.boolean()
        })
    )
    .max(APP_STATE_COLLECTION_LIMIT);

export const mapInfoControls = {
    layers: {
        name: "view.layers",
        description:
            "Read-only layer overview; mapId/layerId selectors also include hidden layers. To change visibility or level, use viewer_set_control with the singular view.layer channel.",
        selectorSchema: viewSelectorSchema.extend({
            mapId: identifierSchema.optional(),
            layerId: identifierSchema.optional()
        }),
        valueSchema: layersSchema,
        readable: true,
        writable: false,
        persistence: "runtime-summary",
        synchronization: "none"
    },
    styleOption: {
        name: "view.styleOption",
        description:
            "One applicable style option, validated against its declared type. For a named look such as Cinematic or Lane Topology, discover viewer_list_presets and use view.layerPreset to apply all supporting options together; a same-named boolean alone may not enable the needed geometry.",
        selectorSchema: layerSelectorSchema.extend({styleId: identifierSchema, optionId: identifierSchema}),
        valueSchema: styleOptionValueSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "follow-view-sync"
    },
    layerPreset: {
        name: "view.layerPreset",
        description:
            "Apply all options of a qualified layer preset. Discover viewer_list_presets with mapId/layerId, then assign {styleId,presetId}; null clears its association without resetting options.",
        selectorSchema: layerSelectorSchema,
        valueSchema: presetSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "follow-view-sync"
    },
    mapPreset: {
        name: "view.mapPreset",
        description: "Apply a map preset; null clears its association without resetting options.",
        selectorSchema: viewSelectorSchema.extend({mapId: identifierSchema}),
        valueSchema: identifierSchema.nullable(),
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "follow-view-sync"
    }
} as const;

import {pageInput, pageOutput, text} from "../actions/action-schema";

export const mapInfoActions = {
    listMaps: {
        name: "viewer_list_maps",
        mutation: false,
        description:
            "List configured map identities and availability without loading feature/schema content. Use viewer_list_layers for one map's layers.",
        inputSchema: z.strictObject({...pageInput}),
        outputSchema: z.strictObject({
            ...pageOutput,
            items: z.array(z.strictObject({id: identifierSchema, name: text, available: z.boolean()})).max(100)
        })
    },
    listLayers: {
        name: "viewer_list_layers",
        mutation: false,
        description:
            "List a map's layers, supported zoom levels and declared feature types. SourceData includes raw tables. Metadata does not prove a feature exists. Use viewer_list_style_options or viewer_list_presets for styling.",
        inputSchema: z.strictObject({
            mapId: identifierSchema,
            layerType: z.enum(["Features", "SourceData", "all"]).default("Features"),
            viewId: viewIdSchema.optional(),
            ...pageInput
        }),
        outputSchema: z.strictObject({
            ...pageOutput,
            items: z
                .array(
                    z.strictObject({
                        id: identifierSchema,
                        mapId: identifierSchema,
                        kind: text,
                        visible: z.boolean(),
                        available: z.boolean(),
                        zoomLevels: z.array(z.number().int().min(0).max(15)).max(16),
                        featureTypes: z.array(identifierSchema).max(1000),
                        schemaFeatureTypes: z.array(identifierSchema).max(1000).optional(),
                        partitionKind: z.enum(["tile", "object"])
                    })
                )
                .max(100)
        })
    },
    listStyleOptions: {
        name: "viewer_list_style_options",
        mutation: false,
        description:
            "List one layer's applicable public style options and exact control targets. Options belong to visible styles; enable an appropriate hidden style before retrying an empty list. Named looks may require viewer_list_presets.",
        inputSchema: z.strictObject({
            mapId: identifierSchema,
            layerId: identifierSchema,
            styleId: identifierSchema.optional(),
            viewId: viewIdSchema,
            ...pageInput
        }),
        outputSchema: z.strictObject({
            ...pageOutput,
            items: z
                .array(
                    z.strictObject({
                        id: identifierSchema,
                        name: text,
                        kind: text,
                        styleId: identifierSchema,
                        value: styleOptionValueSchema,
                        defaultValue: styleOptionValueSchema,
                        description: text,
                        writeTarget: mapInfoControls.styleOption.selectorSchema.extend({
                            control: z.literal("view.styleOption")
                        })
                    })
                )
                .max(100)
        })
    },
    listPresets: {
        name: "viewer_list_presets",
        mutation: false,
        description:
            "List map presets, or qualified layer presets when layerId is supplied. Apply a complete named look through view.mapPreset or view.layerPreset.",
        inputSchema: z.strictObject({
            mapId: identifierSchema,
            layerId: identifierSchema.optional(),
            styleId: identifierSchema.optional(),
            viewId: viewIdSchema,
            ...pageInput
        }),
        outputSchema: z.strictObject({
            ...pageOutput,
            items: z
                .array(
                    z.strictObject({
                        id: identifierSchema,
                        name: text,
                        kind: z.enum(["map", "layer"]),
                        styleId: identifierSchema.optional(),
                        available: z.boolean()
                    })
                )
                .max(100)
        })
    }
} as const;
