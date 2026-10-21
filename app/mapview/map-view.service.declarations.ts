import {z} from "zod";
import {boundedUnicodeString} from "../shared/unicode-string.js";
import {identifierSchema, indexSchema, colorSchema} from "../actions/app-action.js";
import {viewIdSchema} from "../mapview/map-view-state.service.declarations.js";


export const mapViewActions = {
    manageView: {name: "viewer_manage_view", 
        description: "Create a comparison view copied from the given source viewId, or remove that view. Cannot remove the last view. Read app.views afterward for current logical IDs.",
        mutation: true,
        inputSchema: z.strictObject({operation: z.enum(["create", "remove"]), ...{viewId: viewIdSchema}}), outputSchema: z.strictObject({status: z.literal("applied"), changed: z.boolean()})
    }
} as const;

/** Public controls registered by this service; internal slots remain private to persistence. */
export const mapViewControls = {
    views: {
        name: "app.views",
        
        description: "Views, focus, synchronization, projection and live navigation availability.",
        selectorSchema: z.strictObject({}),
        valueSchema: z.strictObject({
    focusedViewId: viewIdSchema,
    sync: z.array(boundedUnicodeString(32)).max(32),
    views: z.array(z.strictObject({
        viewId: viewIdSchema,
        projection: z.enum(["2d", "3d"]),
        navigationMode: z.enum(["map", "first_person", "unavailable"])
    })).max(100)
}),
        readable: true, writable: false,
        persistence: "runtime-summary", synchronization: "none"
    
    },
    camera: {
        name: "view.camera",
        
        description: "Live map camera; assignment focuses the target and honors position/movement synchronization. Unavailable in first-person mode.",
        selectorSchema: z.strictObject({viewId: viewIdSchema}),
        valueSchema: z.strictObject({
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
}),
        readable: true, writable: true,
        persistence: "url-and-local-storage", synchronization: "focus-target-and-follow-view-sync"
    
    },
    projection: {
        name: "view.projection",
        description: "2D/3D projection, honoring projection sync.",
        selectorSchema: z.strictObject({viewId: viewIdSchema}),
        valueSchema: z.enum(["2d", "3d"]),
        readable: true, writable: true,
        synchronization: "focus-target-and-follow-view-sync", persistence: "url-and-local-storage"
    },
    background: {
        name: "view.background",
        description: "Configured background identity and opacity percentage; no URLs or credentials.",
        selectorSchema: z.strictObject({viewId: viewIdSchema}),
        valueSchema: z.strictObject({layerId: boundedUnicodeString(4096).nullable(), opacity: z.number().int().min(0).max(100)}),
        readable: true, writable: true,
        synchronization: "follow-view-sync", persistence: "url-and-local-storage"
    },
    grid: {
        name: "view.grid",
        description: "Tile grid appearance; color is six hex digits without #.",
        selectorSchema: z.strictObject({viewId: viewIdSchema}),
        valueSchema: z.strictObject({
    visible: z.boolean(), mode: z.enum(["nds", "xyz"]), level: z.number().int().min(0).max(30),
    autoLevel: z.boolean(), color: z.string().regex(/^[0-9a-fA-F]{6}$/), opacity: z.number().int().min(0).max(100)
}),
        readable: true, writable: true,
        synchronization: "follow-view-sync", persistence: "url-and-local-storage"
    }
} as const;
