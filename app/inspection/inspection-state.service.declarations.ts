import {z} from "zod";
import {colorSchema, indexSchema} from "../actions/action-schema";
import {boundedUnicodeString} from "../shared/unicode-string";

const tabSelectorSchema = z.strictObject({});
const inspectionPreferencesSchema = z.strictObject({
    limit: z.number().int().min(1).max(50),
    drillPickRadius: z.number().int().min(1).max(10),
    expandByDefault: z.boolean(),
    varyColors: z.boolean(),
    varyOutlines: z.boolean(),
    varyStriping: z.boolean()
});
const hoverPreferencesSchema = z.strictObject({
    enabled: z.boolean(),
    fields: z
        .array(
            z.strictObject({
                expression: boundedUnicodeString(4096, true),
                customExpression: z.boolean(),
                displayKey: boundedUnicodeString(128).optional()
            })
        )
        .max(32)
});
const panelSchema = z.strictObject({
    locked: z.boolean(),
    undocked: z.boolean(),
    focused: z.boolean(),
    color: colorSchema
});

export const inspectionStateControls = {
    preferences: {
        name: "app.preferences.inspection",
        description: "Inspection limits and value presentation preferences.",
        selectorSchema: tabSelectorSchema,
        valueSchema: inspectionPreferencesSchema,
        readable: true,
        writable: true,
        persistence: "local-storage",
        synchronization: "none"
    },
    hover: {
        name: "app.preferences.hover",
        description: "Configured hover values and optional display labels.",
        selectorSchema: tabSelectorSchema,
        valueSchema: hoverPreferencesSchema,
        readable: true,
        writable: true,
        persistence: "local-storage",
        synchronization: "none"
    },
    panel: {
        name: "inspection.panel",
        description: "One existing inspection panel's presentation; closing is a lifecycle command.",
        selectorSchema: z.strictObject({panelId: indexSchema}),
        valueSchema: panelSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "none"
    }
} as const;
