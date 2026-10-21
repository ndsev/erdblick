import {z} from "zod";
import {boundedUnicodeString} from "../shared/unicode-string.js";
import {identifierSchema, indexSchema, colorSchema} from "../actions/app-action.js";
import {viewIdSchema} from "../mapview/map-view-state.service.declarations.js";

/** Public controls registered by this service; internal slots remain private to persistence. */
export const renderControls = {
    rendering: {
        name: "app.preferences.rendering",
        description: "Rendering quality, tile budget, worker count (0=automatic) and transport compression. Only tile budget is included in URLs.",
        selectorSchema: z.strictObject({}),
        valueSchema: z.strictObject({
    antialiasing: z.boolean(), semanticCompositing: z.boolean(), contactShading: z.boolean(),
    tileLimit: z.number().int().min(1).max(1000000),
    renderWorkers: z.number().int().min(0).max(32)
}),
        readable: true, writable: true,
        synchronization: "none", persistence: "mixed"
    }
} as const;
