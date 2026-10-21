import {z} from "zod";
import {
    APP_STATE_COLLECTION_LIMIT,
    APP_STATE_TEXT_LIMIT,
    applied,
    identifierSchema,
    view
} from "../actions/action-schema";
import {viewIdSchema} from "../mapview/view-id";
import {boundedUnicodeString} from "../shared/unicode-string.js";

/** Public operations owned and bound by the adjacent service. */
export const mapViewActions = {
    viewer_manage_view: {
        name: "viewer_manage_view",
        description:
            "Create a view from an existing logical view or remove a live view. Use stable viewId from app.views; at least one and at most 32 views remain.",
        mutation: true,
        inputSchema: z.strictObject({operation: z.enum(["create", "remove"]), ...view}),
        outputSchema: applied
    }
} as const;


const tabSelectorSchema = z.strictObject({});
const viewSelectorSchema = z.strictObject({viewId: viewIdSchema});
const layerSelectorSchema = viewSelectorSchema.extend({mapId: identifierSchema, layerId: identifierSchema});
const layerConfigSchema = z.strictObject({
    visible: z.boolean(),
    level: z.number().int().min(0).max(15),
    autoLevel: z.boolean()
});
const backgroundSchema = z.strictObject({
    layerId: boundedUnicodeString(APP_STATE_TEXT_LIMIT).nullable(),
    opacity: z.number().int().min(0).max(100)
});
const gridSchema = z.strictObject({
    visible: z.boolean(),
    mode: z.enum(["nds", "xyz"]),
    level: z.number().int().min(0).max(30),
    autoLevel: z.boolean(),
    color: z.string().regex(/^[0-9a-fA-F]{6}$/),
    opacity: z.number().int().min(0).max(100)
});
const renderingPreferencesSchema = z.strictObject({
    antialiasing: z.boolean(),
    semanticCompositing: z.boolean(),
    contactShading: z.boolean(),
    tilePullCompression: z.boolean(),
    tileLimit: z.number().int().min(1).max(1000000),
    renderWorkers: z.number().int().min(0).max(32)
});
export const cameraViewStateSchema = z.strictObject({
    destination: z.strictObject({
        lon: z.number().min(-180).max(180).describe("WGS84 longitude in degrees."),
        lat: z.number().min(-85.05113).max(85.05113).describe("Web Mercator latitude in degrees."),
        alt: z.number().positive().describe("Viewer scale-height in metres, not physical eye/terrain altitude.")
    }),
    orientation: z.strictObject({
        heading: z
            .number()
            .min(-2 * Math.PI)
            .max(2 * Math.PI)
            .describe("Clockwise heading from north, in radians."),
        pitch: z
            .number()
            .min(-Math.PI / 2)
            .max(-Math.PI / 36)
            .describe("Pitch in radians; -pi/2 is top-down, -pi/36 is the maximum tilt."),
        roll: z.literal(0).describe("Roll is not implemented; only zero is supported.")
    }),
    // Some MCP clients reject tuple schemas; refine to a tuple only after validating the array length.
    position: z
        .array(z.number())
        .length(3)
        .transform((position) => position as [number, number, number])
        .optional()
        .describe("Local map-centre offset in metres; omitted means [0,0,0].")
});
const viewsSchema = z.strictObject({
    focusedViewId: viewIdSchema,
    sync: z.array(boundedUnicodeString(32)).max(32),
    views: z
        .array(
            z.strictObject({
                viewId: viewIdSchema,
                projection: z.enum(["2d", "3d"]),
                navigationMode: z.enum(["map", "first_person", "unavailable"])
            })
        )
        .max(APP_STATE_COLLECTION_LIMIT)
});

export const mapViewControls = {
    views: {
        name: "app.views",
        description: "Views, focus, synchronization, projection and live navigation availability.",
        selectorSchema: tabSelectorSchema,
        valueSchema: viewsSchema,
        readable: true,
        writable: false,
        persistence: "runtime-summary",
        synchronization: "none"
    },
    camera: {
        name: "view.camera",
        description:
            "Live map camera; assignment focuses the target and honors position/movement synchronization. Unavailable in first-person mode.",
        selectorSchema: viewSelectorSchema,
        valueSchema: cameraViewStateSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "focus-target-and-follow-view-sync"
    },
    projection: {
        name: "view.projection",
        description: "2D/3D projection, honoring projection sync.",
        selectorSchema: viewSelectorSchema,
        valueSchema: z.enum(["2d", "3d"]),
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "focus-target-and-follow-view-sync"
    },
    background: {
        name: "view.background",
        description: "Configured background identity and opacity percentage; no URLs or credentials.",
        selectorSchema: viewSelectorSchema,
        valueSchema: backgroundSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "follow-view-sync"
    },
    grid: {
        name: "view.grid",
        description: "Tile grid appearance; color is six hex digits without #.",
        selectorSchema: viewSelectorSchema,
        valueSchema: gridSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "follow-view-sync"
    },
    layer: {
        name: "view.layer",
        description:
            "Read/write one layer's visibility, requested level and automatic level policy. Select viewId/mapId/layerId. Read this channel first, then assign {visible, level, autoLevel}, preserving fields you do not want to change.",
        selectorSchema: layerSelectorSchema,
        valueSchema: layerConfigSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "follow-view-sync"
    },
    rendering: {
        name: "app.preferences.rendering",
        description:
            "Rendering quality, tile budget, worker count (0=automatic) and transport compression. Only tile budget is included in URLs.",
        selectorSchema: tabSelectorSchema,
        valueSchema: renderingPreferencesSchema,
        readable: true,
        writable: true,
        persistence: "mixed",
        synchronization: "none"
    }
} as const;
