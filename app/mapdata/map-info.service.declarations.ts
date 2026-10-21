import {z} from "zod";
import {boundedUnicodeString} from "../shared/unicode-string.js";
import {identifierSchema, indexSchema, colorSchema, discoveryPageShape, discoveryResult} from "../actions/app-action.js";
import {viewIdSchema} from "../mapview/map-view-state.service.declarations.js";

/** Public controls registered by this service; internal slots remain private to persistence. */
export const mapControls = {
    layers: {
        name: "view.layers",
        
        description: "Read-only layer overview; mapId/layerId selectors also include hidden layers. To change visibility or level, use viewer_set_control with the singular view.layer control.",
        selectorSchema: z.strictObject({viewId: viewIdSchema}).extend({mapId: identifierSchema.optional(), layerId: identifierSchema.optional()}),
        valueSchema: z.array(z.strictObject({
    mapId: identifierSchema,
    layerId: identifierSchema,
    visible: z.boolean(),
    level: indexSchema,
    autoLevel: z.boolean()
})).max(100),
        readable: true, writable: false,
        persistence: "runtime-summary", synchronization: "none"
    
    },
    layer: {
        name: "view.layer",
        description: "Read/write one layer's visibility, requested level and automatic level policy. Select viewId/mapId/layerId. Read this control first, then assign {visible, level, autoLevel}, preserving fields you do not want to change.",
        selectorSchema: z.strictObject({viewId: viewIdSchema}).extend({mapId: identifierSchema, layerId: identifierSchema}),
        valueSchema: z.strictObject({visible: z.boolean(), level: z.number().int().min(0).max(15), autoLevel: z.boolean()}),
        readable: true, writable: true,
        synchronization: "follow-view-sync", persistence: "url-and-local-storage"
    },
    styleOption: {
        name: "view.styleOption",
        description: "One applicable style option, validated against its declared type. For a named look such as Cinematic or Lane Topology, call viewer_list_presets and use view.layerPreset to apply all supporting options together; a same-named boolean alone may not enable the needed geometry.",
        selectorSchema: z.strictObject({viewId: viewIdSchema}).extend({mapId: identifierSchema, layerId: identifierSchema}).extend({styleId: identifierSchema, optionId: identifierSchema}),
        valueSchema: z.union([z.boolean(), z.number(), boundedUnicodeString(4096)]),
        readable: true, writable: true,
        synchronization: "follow-view-sync", persistence: "url-and-local-storage"
    },
    layerPreset: {
        name: "view.layerPreset",
        description: "Apply all options of a qualified layer preset. Discover viewer_list_presets with mapId/layerId, then assign {styleId,presetId}; null clears its association without resetting options.",
        selectorSchema: z.strictObject({viewId: viewIdSchema}).extend({mapId: identifierSchema, layerId: identifierSchema}),
        valueSchema: z.strictObject({styleId: identifierSchema, presetId: identifierSchema}).nullable(),
        readable: true, writable: true,
        synchronization: "follow-view-sync", persistence: "url-and-local-storage"
    },
    mapPreset: {
        name: "view.mapPreset",
        description: "Apply a map preset; null clears its association without resetting options.",
        selectorSchema: z.strictObject({viewId: viewIdSchema}).extend({mapId: identifierSchema}),
        valueSchema: identifierSchema.nullable(),
        readable: true, writable: true,
        synchronization: "follow-view-sync", persistence: "url-and-local-storage"
    }
} as const;

export const mapActions = {
    listMaps: {
        name: "viewer_list_maps", mutation: false,
        description: "List configured map identities and current availability without loading data or exposing source URLs or credentials.",
        inputSchema: z.strictObject({...discoveryPageShape}),
        outputSchema: discoveryResult(z.strictObject({id: identifierSchema, available: z.boolean()}))
    },
    listLayers: {
        name: "viewer_list_layers", mutation: false,
        description: "List map layers, supported zoom levels and schema-owning feature types. Features are the default; use layerType=SourceData for raw tables. featureTypes may also contain reference-only types. Optional viewId adds the current visibility, without changing defaults or loading data.",
        inputSchema: z.strictObject({mapId: identifierSchema.optional(), layerId: identifierSchema.optional(),
            layerType: z.enum(["Features", "SourceData", "all"]).default("Features"), viewId: viewIdSchema.optional(), ...discoveryPageShape}),
        outputSchema: discoveryResult(z.strictObject({id: identifierSchema, mapId: identifierSchema,
            kind: z.enum(["Features", "SourceData"]), available: z.boolean(), visible: z.boolean().optional(),
            zoomLevels: z.array(z.number().int().min(0).max(15)).max(16),
            featureTypes: z.array(identifierSchema).max(1000), schemaFeatureTypes: z.array(identifierSchema).max(1000),
            partitionKind: z.enum(["tile", "object"])}))
    },
    listStyleOptions: {
        name: "viewer_list_style_options", mutation: false,
        description: "List public style options for one layer and view. Each item supplies its exact writeTarget for viewer_set_control. For a coordinated named appearance, use viewer_list_presets. Reads never turn defaults into user-owned values.",
        inputSchema: z.strictObject({mapId: identifierSchema, layerId: identifierSchema, viewId: viewIdSchema,
            styleId: identifierSchema.optional(), ...discoveryPageShape}),
        outputSchema: discoveryResult(z.strictObject({id: identifierSchema, name: boundedUnicodeString(4096),
            styleId: identifierSchema, mapId: identifierSchema, layerId: identifierSchema, kind: boundedUnicodeString(128),
            value: mapControls.styleOption.valueSchema, defaultValue: mapControls.styleOption.valueSchema,
            description: boundedUnicodeString(4096),
            writeTarget: mapControls.styleOption.selectorSchema.extend({control: z.literal("view.styleOption")})}))
    },
    listPresets: {
        name: "viewer_list_presets", mutation: false,
        description: "List layer presets when layerId is supplied, otherwise map presets. Optional viewId checks synchronized-option conflicts. Apply with view.layerPreset or view.mapPreset controls.",
        inputSchema: z.strictObject({mapId: identifierSchema, layerId: identifierSchema.optional(),
            styleId: identifierSchema.optional(), viewId: viewIdSchema.optional(), ...discoveryPageShape}),
        outputSchema: discoveryResult(z.strictObject({id: identifierSchema, name: boundedUnicodeString(4096),
            kind: z.enum(["map", "layer"]), mapId: identifierSchema, layerId: identifierSchema.optional(),
            styleId: identifierSchema.optional(), available: z.boolean()}))
    }
} as const;
