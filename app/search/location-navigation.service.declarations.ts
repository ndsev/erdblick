import { z } from "zod";
import { identifierSchema } from "../actions/app-action.js";
import { featureIdentitySchema } from "../inspection/inspection-selection.service.declarations.js";
import { viewIdSchema } from "../mapview/map-view-state.service.declarations.js";
import { boundedUnicodeString } from "../shared/unicode-string.js";

export const navigationActions = {
    navigate: {
        name: "viewer_navigate",
        description: "Locate and fit feature(s), a tile, or WGS84 bounds in an explicit view. Set the intended projection and panel layout first; refit after changing them. Honors synchronization; human movement during loading cancels the later camera commit. Applied is not render completion.",
        mutation: true,
        inputSchema: z.strictObject({
            viewId: viewIdSchema,
            target: z.union([
                z.strictObject({ features: z.array(featureIdentitySchema).min(1).max(50) }),
                z.strictObject({ mapTileKey: identifierSchema }), z.strictObject({
                    bounds: z.strictObject({
                        west: z.number().min(-180).max(180),
                        south: z.number().min(-85.05113).max(85.05113),
                        east: z.number().min(-180).max(180),
                        north: z.number().min(-85.05113).max(85.05113)
                    })
                })
            ])
        }),
        outputSchema: z.strictObject({ status: z.literal("applied"), changed: z.boolean() })
    }
} as const;

/** Network-backed suggestions stay on the location owner; history resolves their identity afresh. */
export const locationActions = {
    navigateLocation: {
        name: "navigate_location_result",
        exposure: "omnibar",
        mutation: true,
        description: "Resolve a live or saved location result and navigate the focused map.",
        inputSchema: z.strictObject({ actionId: boundedUnicodeString(4096, true), payload: z.unknown().optional() }),
        outputSchema: z.strictObject({ status: z.literal("applied"), changed: z.boolean() })
    }
} as const;
