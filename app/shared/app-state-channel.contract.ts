import {z} from "zod";
import {boundedUnicodeString} from "./unicode-string.js";

export const APP_STATE_COLLECTION_LIMIT = 100;
export const APP_STATE_TEXT_LIMIT = 4096;

const indexSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifierSchema = boundedUnicodeString(APP_STATE_TEXT_LIMIT, true);
const tabSelectorSchema = z.strictObject({});
const viewSelectorSchema = z.strictObject({viewIndex: indexSchema});

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
        description: "Visible layer settings; use mapId/layerId selectors to read a particular layer, including a hidden one.",
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
    }
} as const;

export const appStateTargetSchemas = {
    "app.views": appStateChannels["app.views"].selectorSchema.extend({channel: z.literal("app.views")}),
    "view.camera": appStateChannels["view.camera"].selectorSchema.extend({channel: z.literal("view.camera")}),
    "view.layers": appStateChannels["view.layers"].selectorSchema.extend({channel: z.literal("view.layers")}),
    "app.selections": appStateChannels["app.selections"].selectorSchema.extend({channel: z.literal("app.selections")}),
    "app.searches": appStateChannels["app.searches"].selectorSchema.extend({channel: z.literal("app.searches")})
};

export const appStateTargetSchema = z.union([
    appStateTargetSchemas["app.views"], appStateTargetSchemas["view.camera"],
    appStateTargetSchemas["view.layers"], appStateTargetSchemas["app.selections"],
    appStateTargetSchemas["app.searches"]
]);

export type AppStateChannelName = keyof typeof appStateChannels;
export type AppStateTarget = z.infer<typeof appStateTargetSchema>;

/** Correlates channel identity with its exact value schema at both wire boundaries. */
export const appStateValueSchema = z.union([
    z.strictObject({target: appStateTargetSchemas["app.views"], value: viewsSchema}),
    z.strictObject({target: appStateTargetSchemas["view.camera"], value: cameraViewStateSchema}),
    z.strictObject({target: appStateTargetSchemas["view.layers"], value: layersSchema}),
    z.strictObject({target: appStateTargetSchemas["app.selections"], value: selectionsSchema}),
    z.strictObject({target: appStateTargetSchemas["app.searches"], value: searchesSchema}),
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
