import {z} from "zod";
import {boundedUnicodeString} from "../shared/unicode-string.js";
import {identifierSchema, indexSchema, colorSchema} from "../actions/app-action.js";
import {viewIdSchema} from "../mapview/map-view-state.service.declarations.js";

const text = boundedUnicodeString(4096);

export const diagnosticActions = {
    getDiagnostics: {name: "viewer_get_diagnostics", 
        description: "Read BROWSER transport, render-worker queues, frame-time metrics, cached loading, GPU allocation and style/search errors without resetting the view. Native BACKEND workers/cache/memory require the separately privileged mapget_get_diagnostics tool. Call it only when it appears in your tool catalog; otherwise explain the permission limit. Browser workers and observed transport latency are not backend queue statistics. No scene/tile scan or GPU readback. Cached and unavailable metrics are explicit.",
        mutation: false,
        inputSchema: z.strictObject({viewId: viewIdSchema.optional(), mapId: identifierSchema.optional(), layerId: identifierSchema.optional(),
            sections: z.array(z.enum(["transport", "workers", "loading", "gpu", "errors"])).max(5).optional(), limit: z.number().int().min(1).max(100).optional()}),
        outputSchema: z.strictObject({...{observedAt: z.string()}, ...{complete: z.boolean(), reason: z.enum(["item_limit", "byte_limit", "text_limit", "loading"]).optional()},
            executionContext: z.literal("browser"),
            interpretation: text,
            metrics: z.array(z.strictObject({section: text, name: text, value: z.union([z.number(), z.boolean(), z.null()]),
                scope: z.enum(["tab", "view"]), viewId: viewIdSchema.optional(), cached: z.boolean().optional()})).max(100),
            errors: z.array(z.strictObject({source: text, message: text,
                severity: z.enum(["warning", "error"]).optional(), phase: text.optional(),
                property: text.optional(), expression: text.optional(), rulePath: text.optional(),
                mapId: identifierSchema.optional(), layerId: identifierSchema.optional(),
                featureId: identifierSchema.optional()})).max(100), unavailable: z.array(text).max(20)
        })
    }
} as const;
