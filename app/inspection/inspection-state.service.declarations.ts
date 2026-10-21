import { z } from "zod";
import { colorSchema, indexSchema } from "../actions/app-action.js";
import { boundedUnicodeString } from "../shared/unicode-string.js";

export const inspectionStateActions = {
    closeInspection: {
        name: "viewer_close_inspection",
        description: "Remove one inspection, including locked panels. Read panelId and lifetime from app.selections; supplying lifetime rejects stale selections. This also removes its feature selection, highlight and displayed ID. It is not a way to hide settings dialogs. For a screenshot requiring the selected feature or its ID, retain that inspection and close only the obstructing settings UI. Other inspections are preserved.",
        mutation: true,
        inputSchema: z.strictObject({ panelId: indexSchema, lifetime: indexSchema.optional() }),
        outputSchema: z.strictObject({ status: z.literal("applied"), changed: z.boolean() })
    }
} as const;

/** Public controls registered by this service; internal slots remain private to persistence. */
export const inspectionStateControls = {
    preferences: {
        name: "app.preferences.inspection",
        description: "Inspection limits and value presentation preferences.",
        selectorSchema: z.strictObject({}),
        valueSchema: z.strictObject({
            limit: z.number().int().min(1).max(50),
            drillPickRadius: z.number().int().min(1).max(10),
            expandByDefault: z.boolean(),
            varyColors: z.boolean(),
            varyOutlines: z.boolean(),
            varyStriping: z.boolean()
        }),
        readable: true,
        writable: true,
        synchronization: "none",
        persistence: "local-storage"
    },
    hover: {
        name: "app.preferences.hover",
        description: "Configured hover values and optional display labels.",
        selectorSchema: z.strictObject({}),
        valueSchema: z.strictObject({
            enabled: z.boolean(),
            fields: z.array(z.strictObject({
                expression: boundedUnicodeString(4096, true),
                customExpression: z.boolean(),
                displayKey: boundedUnicodeString(128).optional()
            })).max(32)
        }),
        readable: true,
        writable: true,
        synchronization: "none",
        persistence: "local-storage"
    },
    panel: {
        name: "inspection.panel",
        description: "One existing inspection panel's presentation; closing is a lifecycle command.",
        selectorSchema: z.strictObject({ panelId: indexSchema }),
        valueSchema: z.strictObject({ locked: z.boolean(), undocked: z.boolean(), focused: z.boolean(), color: colorSchema }),
        readable: true,
        writable: true,
        synchronization: "none",
        persistence: "url-and-local-storage"
    }
} as const;
