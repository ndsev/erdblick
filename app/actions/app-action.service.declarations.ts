import {z} from "zod";
import {AppControl, VIEWER_ACTION_TARGET_LIMIT} from "./app-action.js";
import {boundedUnicodeString} from "../shared/unicode-string.js";
import {applicationControls} from "./application-controls.js";

/** JSON-schema generation stays independent of Angular bootstrap and live owner instances. */
export function viewerJsonSchema(schema: z.ZodType): Record<string, unknown> {
    return z.toJSONSchema(schema, {target: "draft-07", io: "input", reused: "inline", cycles: "throw"});
}

const controls: AppControl[] = Object.values(applicationControls);
const controlNames = z.enum(controls.map(control => control.name) as [string, ...string[]]);
const targetSchemas = controls.map(control => control.selectorSchema.extend({control: z.literal(control.name)}));
const targetSchema = z.union(targetSchemas);
const writableTargetSchema = z.union(controls.filter(control => control.writable)
    .map(control => control.selectorSchema.extend({control: z.literal(control.name)})));
const omissionSchema = z.strictObject({target: targetSchema, reason: z.enum(["item_limit", "byte_limit", "text_limit"]), omittedCount: z.number().int().positive().optional()});
const descriptorSchema = z.strictObject({
    name: controlNames, description: z.string(), selectorSchema: z.record(z.string(), z.unknown()),
    valueSchema: z.record(z.string(), z.unknown()), readable: z.boolean(), writable: z.boolean(),
    persistence: z.enum(["runtime-summary", "url-and-local-storage", "local-storage", "mixed"]),
    synchronization: z.enum(["none", "follow-view-sync", "focus-target-and-follow-view-sync"])
});

/** Both Zod and exported Draft-07 validate values against the selected control. */
const assignmentConstraints = controls.filter(control => control.writable).map(control => ({
    if: {properties: {target: {properties: {control: {const: control.name}}}}},
    then: {properties: {value: viewerJsonSchema(control.valueSchema)}}
}));
const assignmentSchema = z.strictObject({target: writableTargetSchema, value: z.unknown()})
    .superRefine((input, context) => {
        const control = controls.find(control => control.name === input.target['control'])!;
        if (!control.valueSchema.safeParse(input.value).success) {
            context.addIssue({code: "custom", path: ["value"], message: "Value does not match the selected control."});
        }
    }).meta({allOf: assignmentConstraints});

export const controlActions = {
    describeControls: {
        name: "viewer_describe_controls", mutation: false,
        description: "Describe public controls, selectors and canonical value schemas. viewId selectors address logical views; discover IDs with app.views. Internal stored values are not automatically exposed.",
        inputSchema: z.strictObject({controls: z.array(controlNames).max(VIEWER_ACTION_TARGET_LIMIT).optional(), prefix: boundedUnicodeString(128).optional()}),
        outputSchema: z.strictObject({observedAt: z.string(), controls: z.array(descriptorSchema).max(VIEWER_ACTION_TARGET_LIMIT),
            complete: z.boolean(), omissions: z.array(omissionSchema).max(VIEWER_ACTION_TARGET_LIMIT)})
    },
    getControls: {
        name: "viewer_get_controls", mutation: false,
        description: "Read explicitly selected controls or a bounded overview of views, inspections, searches and layers. This does not load features. Discover supported layers and style options with the corresponding viewer_list tools.",
        inputSchema: z.strictObject({targets: z.array(targetSchema).max(VIEWER_ACTION_TARGET_LIMIT).optional()}),
        outputSchema: z.strictObject({observedAt: z.string(), values: z.array(z.union([
            ...controls.map(control => z.strictObject({
                target: control.selectorSchema.extend({control: z.literal(control.name)}), value: control.valueSchema
            })),
            z.strictObject({target: targetSchema, unavailable: z.enum(["view_unavailable", "first_person", "target_unavailable", "value_out_of_contract"])})
        ])).max(VIEWER_ACTION_TARGET_LIMIT), complete: z.boolean(), omissions: z.array(omissionSchema).max(VIEWER_ACTION_TARGET_LIMIT)})
    },
    setControl: {
        name: "viewer_set_control", mutation: true,
        description: "Set one control with {target:{control, ...selector},value}. View selectors use viewId. Read and preserve unrelated fields when assigning a compound value. Uses ordinary owner operations and synchronization. Applied does not mean data or rendering is complete.",
        inputSchema: assignmentSchema,
        outputSchema: z.strictObject({status: z.literal("applied"), target: writableTargetSchema, value: z.unknown(),
            changed: z.boolean(), readiness: z.strictObject({status: z.literal("unknown")})})
            .superRefine((output, context) => {
                const control = controls.find(control => control.name === output.target['control'])!;
                if (!control.valueSchema.safeParse(output.value).success) context.addIssue({code: "custom", path: ["value"], message: "Value does not match the selected control."});
            }).meta({allOf: assignmentConstraints})
    }
} as const;

export function describeControls() {
    return controls.map(control => ({...control,
        selectorSchema: viewerJsonSchema(control.selectorSchema), valueSchema: viewerJsonSchema(control.valueSchema)}));
}
