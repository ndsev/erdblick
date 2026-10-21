import { z } from "zod";
import { boundedUnicodeString } from "../shared/unicode-string.js";

const applied = z.strictObject({ status: z.literal("applied"), changed: z.boolean() });

/** Native parsers and configured plugin candidates are resolved at runtime, never during export. */
export const jumpActions = {
    coordinates: {
        name: "jump_coordinates",
        exposure: "omnibar",
        mutation: true,
        description: "Parse coordinates or a packed tile ID and navigate the focused map.",
        inputSchema: z.strictObject({
            targetId: z.enum(["j:packed-tile-id", "j:nds-x-y", "j:nds-y-x", "j:morton-code", "j:wgs84-lon-lat", "j:wgs84-lat-lon"]),
            text: boundedUnicodeString(4096)
        }),
        outputSchema: applied
    },
    sourceData: {
        name: "inspect_source_input",
        exposure: "omnibar",
        mutation: true,
        description: "Inspect a packed tile ID with optional map and source layer names.",
        inputSchema: z.strictObject({ text: boundedUnicodeString(4096) }),
        outputSchema: applied
    },
    feature: {
        name: "jump_feature_input",
        exposure: "omnibar",
        mutation: true,
        description: "Resolve a feature ID expression and navigate the focused map.",
        inputSchema: z.strictObject({ targetId: boundedUnicodeString(4096, true), text: boundedUnicodeString(4096) }),
        outputSchema: applied
    },
    plugin: {
        name: "jump_plugin_input",
        exposure: "omnibar",
        mutation: true,
        description: "Run one configured jump provider with validated text and optional saved payload.",
        inputSchema: z.strictObject({
            targetId: boundedUnicodeString(4096, true),
            text: boundedUnicodeString(4096),
            payload: z.unknown().optional()
        }),
        outputSchema: applied
    }
} as const;
