import {z} from "zod";
import {boundedUnicodeString} from "./unicode-string.js";

export const APP_STATE_COLLECTION_LIMIT = 100;
export const APP_STATE_TEXT_LIMIT = 4096;

export const indexSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const identifierSchema = boundedUnicodeString(APP_STATE_TEXT_LIMIT, true);
const tabSelectorSchema = z.strictObject({});
const viewSelectorSchema = z.strictObject({viewIndex: indexSchema});
const layerSelectorSchema = viewSelectorSchema.extend({mapId: identifierSchema, layerId: identifierSchema});
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const styleOptionValueSchema = z.union([z.boolean(), z.number(), boundedUnicodeString(4096)]);
const syncSchema = z.array(z.enum(["pos", "mov", "proj", "lay"])).max(4);
const presetSchema = z.strictObject({styleId: identifierSchema, presetId: identifierSchema}).nullable();
const layerConfigSchema = z.strictObject({visible: z.boolean(), level: z.number().int().min(0).max(15), autoLevel: z.boolean()});
const backgroundSchema = z.strictObject({layerId: boundedUnicodeString(APP_STATE_TEXT_LIMIT).nullable(), opacity: z.number().int().min(0).max(100)});
const gridSchema = z.strictObject({
    visible: z.boolean(), mode: z.enum(["nds", "xyz"]), level: z.number().int().min(0).max(30),
    autoLevel: z.boolean(), color: z.string().regex(/^[0-9a-fA-F]{6}$/), opacity: z.number().int().min(0).max(100)
});
const markerSchema = z.strictObject({enabled: z.boolean(), position: z.strictObject({
    lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90), alt: z.number()
}).nullable()});
const renderingPreferencesSchema = z.strictObject({
    antialiasing: z.boolean(), semanticCompositing: z.boolean(), contactShading: z.boolean(),
    tilePullCompression: z.boolean(), tileLimit: z.number().int().min(1).max(1000000),
    renderWorkers: z.number().int().min(0).max(32)
});
const navigationPreferencesSchema = z.strictObject({
    zoomStep: z.number().min(0.001).max(1), featureZoomClearance: z.number().min(0).max(100)
});
const inspectionPreferencesSchema = z.strictObject({
    limit: z.number().int().min(1).max(50), drillPickRadius: z.number().int().min(1).max(10),
    expandByDefault: z.boolean(), varyColors: z.boolean(), varyOutlines: z.boolean(), varyStriping: z.boolean()
});
const hoverPreferencesSchema = z.strictObject({enabled: z.boolean(), fields: z.array(z.strictObject({
    expression: boundedUnicodeString(4096, true), customExpression: z.boolean(), displayKey: boundedUnicodeString(128).optional()
})).max(32)});
const panelSchema = z.strictObject({locked: z.boolean(), undocked: z.boolean(), focused: z.boolean(), color: colorSchema});

/** Consistent metadata for explicit owner-backed settings; never discovers the internal state pool. */
function setting<Selector extends z.ZodRawShape, Value extends z.ZodType>(
    description: string, selectorSchema: z.ZodObject<Selector>, valueSchema: Value,
    synchronization: "none" | "follow-view-sync" | "focus-target-and-follow-view-sync" = "none",
    persistence: "url-and-local-storage" | "local-storage" | "mixed" = "url-and-local-storage"
) {
    return {description, selectorSchema, valueSchema, readable: true, writable: true,
        persistence, synchronization} as const;
}

/** Canonical runtime camera value, independent of AppState's flattened storage codec. */
export const cameraViewStateSchema = z.strictObject({
    destination: z.strictObject({
        lon: z.number().min(-180).max(180).describe("WGS84 longitude in degrees."),
        lat: z.number().min(-85.05113).max(85.05113).describe("Web Mercator latitude in degrees."),
        alt: z.number().positive().describe("Viewer scale-height in metres, not physical eye/terrain altitude.")
    }),
    orientation: z.strictObject({
        heading: z.number().min(-2 * Math.PI).max(2 * Math.PI).describe("Clockwise heading from north, in radians."),
        pitch: z.number().min(-Math.PI / 2).max(-Math.PI / 36).describe("Pitch in radians; -pi/2 is top-down, -pi/36 is the maximum tilt."),
        roll: z.literal(0).describe("Roll is not implemented; only zero is supported.")
    }),
    // Some MCP clients reject tuple schemas; refine to a tuple only after validating the array length.
    position: z.array(z.number()).length(3).transform(position => position as [number, number, number]).optional()
        .describe("Local map-centre offset in metres; omitted means [0,0,0].")
});

const viewsSchema = z.strictObject({
    focusedView: indexSchema,
    sync: z.array(boundedUnicodeString(32)).max(32),
    views: z.array(z.strictObject({
        viewIndex: indexSchema,
        projection: z.enum(["2d", "3d"]),
        navigationMode: z.enum(["map", "first_person", "unavailable"])
    })).max(APP_STATE_COLLECTION_LIMIT)
});

const layersSchema = z.array(z.strictObject({
    mapId: identifierSchema,
    layerId: identifierSchema,
    visible: z.boolean(),
    level: indexSchema,
    autoLevel: z.boolean()
})).max(APP_STATE_COLLECTION_LIMIT);

const selectionsSchema = z.array(z.strictObject({
    panelId: indexSchema,
    locked: z.boolean(),
    undocked: z.boolean(),
    loading: z.boolean().nullable().describe("Feature resolution state; null when owned by a source-data panel."),
    features: z.array(z.strictObject({mapTileKey: identifierSchema, featureId: identifierSchema}))
        .max(APP_STATE_COLLECTION_LIMIT),
    sourceData: z.strictObject({
        mapTileKey: identifierSchema,
        address: z.string().regex(/^[0-9]+$/).max(20).optional()
            .describe("Unsigned 64-bit address as a lossless decimal string.")
    }).optional()
})).max(APP_STATE_COLLECTION_LIMIT);

const searchesSchema = z.array(z.strictObject({
    searchId: identifierSchema,
    query: boundedUnicodeString(APP_STATE_TEXT_LIMIT),
    enabled: z.boolean(),
    paused: z.boolean(),
    autoUpdate: z.boolean(),
    showResultsOnMap: z.boolean(),
    runtime: z.strictObject({
        complete: z.boolean(),
        progressDone: indexSchema,
        progressTotal: indexSchema,
        resultCount: indexSchema,
        errorCount: indexSchema
    }).optional()
})).max(APP_STATE_COLLECTION_LIMIT);

/** Explicit public allowlist; registration in AppState alone never exposes a state slot. */
export const appStateChannels = {
    "app.views": {
        description: "Views, focus, synchronization, projection and live navigation availability.",
        selectorSchema: tabSelectorSchema,
        valueSchema: viewsSchema,
        readable: true, writable: false,
        persistence: "runtime-summary", synchronization: "none"
    },
    "view.camera": {
        description: "Live map camera; assignment focuses the target and honors position/movement synchronization. Unavailable in first-person mode.",
        selectorSchema: viewSelectorSchema,
        valueSchema: cameraViewStateSchema,
        readable: true, writable: true,
        persistence: "url-and-local-storage", synchronization: "focus-target-and-follow-view-sync"
    },
    "view.layers": {
        description: "Read-only layer overview; mapId/layerId selectors also include hidden layers. To change visibility or level, use viewer_set_app_state with the singular view.layer channel.",
        selectorSchema: viewSelectorSchema.extend({mapId: identifierSchema.optional(), layerId: identifierSchema.optional()}),
        valueSchema: layersSchema,
        readable: true, writable: false,
        persistence: "runtime-summary", synchronization: "none"
    },
    "app.selections": {
        description: "Inspection identities and panel/loading state, including undocked panels; never inspection trees.",
        selectorSchema: z.strictObject({panelId: indexSchema.optional()}),
        valueSchema: selectionsSchema,
        readable: true, writable: false,
        persistence: "runtime-summary", synchronization: "none"
    },
    "app.searches": {
        description: "Persisted search definitions and live progress, including hidden and paused searches; never results or style rules.",
        selectorSchema: z.strictObject({searchId: identifierSchema.optional()}),
        valueSchema: searchesSchema,
        readable: true, writable: false,
        persistence: "runtime-summary", synchronization: "none"
    },
    "view.projection": setting("2D/3D projection, honoring projection sync.", viewSelectorSchema, z.enum(["2d", "3d"]), "focus-target-and-follow-view-sync"),
    "view.background": setting("Configured background identity and opacity percentage; no URLs or credentials.", viewSelectorSchema, backgroundSchema, "follow-view-sync"),
    "view.grid": setting("Tile grid appearance; color is six hex digits without #.", viewSelectorSchema, gridSchema, "follow-view-sync"),
    "view.layer": setting("Read/write one layer's visibility, requested level and automatic level policy. Select viewIndex/mapId/layerId. Read this channel first, then assign {visible, level, autoLevel}, preserving fields you do not want to change.", layerSelectorSchema, layerConfigSchema, "follow-view-sync"),
    "view.styleOption": setting("One applicable style option, validated against its declared type.", layerSelectorSchema.extend({styleId: identifierSchema, optionId: identifierSchema}), styleOptionValueSchema, "follow-view-sync"),
    "view.layerPreset": setting("Apply a qualified layer preset; null clears its association without resetting options.", layerSelectorSchema, presetSchema, "follow-view-sync"),
    "view.mapPreset": setting("Apply a map preset; null clears its association without resetting options.", viewSelectorSchema.extend({mapId: identifierSchema}), identifierSchema.nullable(), "follow-view-sync"),
    "app.focusedView": setting("Focused source view; requires the observed layout revision.", tabSelectorSchema, indexSchema),
    "app.viewSync": setting("Cross-view position, movement, projection and layer synchronization.", tabSelectorSchema, syncSchema),
    "app.marker": setting("Coordinate marker visibility and WGS84 position.", tabSelectorSchema, markerSchema),
    "app.preferences.rendering": setting("Rendering quality, tile budget, worker count (0=automatic) and transport compression. Only tile budget is included in URLs.", tabSelectorSchema, renderingPreferencesSchema, "none", "mixed"),
    "app.preferences.navigation": setting("Zoom step and feature-fit clearance in metres.", tabSelectorSchema, navigationPreferencesSchema, "none", "local-storage"),
    "app.preferences.inspection": setting("Inspection limits and value presentation preferences.", tabSelectorSchema, inspectionPreferencesSchema, "none", "local-storage"),
    "app.preferences.hover": setting("Configured hover values and optional display labels.", tabSelectorSchema, hoverPreferencesSchema, "none", "local-storage"),
    "inspection.panel": setting("One existing inspection panel's presentation; closing is a lifecycle command.", z.strictObject({panelId: indexSchema}), panelSchema)
} as const;

export const appStateTargetSchemas = {
    "app.views": appStateChannels["app.views"].selectorSchema.extend({channel: z.literal("app.views")}),
    "view.camera": appStateChannels["view.camera"].selectorSchema.extend({channel: z.literal("view.camera")}),
    "view.layers": appStateChannels["view.layers"].selectorSchema.extend({channel: z.literal("view.layers")}),
    "app.selections": appStateChannels["app.selections"].selectorSchema.extend({channel: z.literal("app.selections")}),
    "app.searches": appStateChannels["app.searches"].selectorSchema.extend({channel: z.literal("app.searches")}),
    "view.projection": appStateChannels["view.projection"].selectorSchema.extend({channel: z.literal("view.projection")}),
    "view.background": appStateChannels["view.background"].selectorSchema.extend({channel: z.literal("view.background")}),
    "view.grid": appStateChannels["view.grid"].selectorSchema.extend({channel: z.literal("view.grid")}),
    "view.layer": appStateChannels["view.layer"].selectorSchema.extend({channel: z.literal("view.layer")}),
    "view.styleOption": appStateChannels["view.styleOption"].selectorSchema.extend({channel: z.literal("view.styleOption")}),
    "view.layerPreset": appStateChannels["view.layerPreset"].selectorSchema.extend({channel: z.literal("view.layerPreset")}),
    "view.mapPreset": appStateChannels["view.mapPreset"].selectorSchema.extend({channel: z.literal("view.mapPreset")}),
    "app.focusedView": appStateChannels["app.focusedView"].selectorSchema.extend({channel: z.literal("app.focusedView")}),
    "app.viewSync": appStateChannels["app.viewSync"].selectorSchema.extend({channel: z.literal("app.viewSync")}),
    "app.marker": appStateChannels["app.marker"].selectorSchema.extend({channel: z.literal("app.marker")}),
    "app.preferences.rendering": appStateChannels["app.preferences.rendering"].selectorSchema.extend({channel: z.literal("app.preferences.rendering")}),
    "app.preferences.navigation": appStateChannels["app.preferences.navigation"].selectorSchema.extend({channel: z.literal("app.preferences.navigation")}),
    "app.preferences.inspection": appStateChannels["app.preferences.inspection"].selectorSchema.extend({channel: z.literal("app.preferences.inspection")}),
    "app.preferences.hover": appStateChannels["app.preferences.hover"].selectorSchema.extend({channel: z.literal("app.preferences.hover")}),
    "inspection.panel": appStateChannels["inspection.panel"].selectorSchema.extend({channel: z.literal("inspection.panel")})
};

export const appStateTargetSchema = z.union(Object.values(appStateTargetSchemas));

/** Derives channel/value pairs once for exported schemas and boundary validation. */
export const appStateAssignments = Object.entries(appStateChannels).map(([name, channel]) =>
    z.strictObject({target: appStateTargetSchemas[name as keyof typeof appStateChannels], value: channel.valueSchema}));
export const appStateWritableChannels = Object.entries(appStateChannels).filter(([, channel]) => channel.writable);
export const appStateWritableTargetSchema = z.union(appStateWritableChannels.map(([name]) => appStateTargetSchemas[name as keyof typeof appStateChannels]));
export const appStateWritableValueSchema = z.union(appStateWritableChannels.map(([, channel]) => channel.valueSchema));

export type AppStateChannelName = keyof typeof appStateChannels;
export type AppStateTarget = z.infer<typeof appStateTargetSchema>;

/** Correlates channel identity with its exact value schema at both wire boundaries. */
export const appStateValueSchema = z.union([
    ...appStateAssignments,
    z.strictObject({
        target: appStateTargetSchema,
        unavailable: z.enum(["view_unavailable", "first_person", "target_unavailable", "value_out_of_contract"])
    })
]);

export const appStateOmissionSchema = z.strictObject({
    target: appStateTargetSchema,
    reason: z.enum(["item_limit", "byte_limit", "text_limit"])
});

export const appStateReadinessSchema = z.strictObject({
    status: z.enum(["ready", "loading", "error", "unknown"]),
    pending: indexSchema.optional(),
    errors: indexSchema.optional()
});
