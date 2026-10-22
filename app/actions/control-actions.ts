import {z} from "zod";
import {boundedUnicodeString} from "../shared/unicode-string";
import type {ControlDeclaration} from "./control";

export type ControlTarget = {control: string; [selector: string]: unknown};
export type ControlValue =
    | {target: ControlTarget; value: unknown}
    | {
          target: ControlTarget;
          unavailable: "view_unavailable" | "first_person" | "target_unavailable" | "value_out_of_contract";
      };
export type ControlOmission = {
    target: ControlTarget;
    reason: "item_limit" | "byte_limit" | "text_limit";
    omittedCount?: number;
};
export interface ControlReadResult {
    observedAt: string;
    values: ControlValue[];
    complete: boolean;
    omissions: ControlOmission[];
}
export interface ControlWriteResult {
    status: "applied";
    target: ControlTarget;
    value: unknown;
    changed: boolean;
    readiness: {status: "unknown"};
}

/** Derives the three generic API contracts from the exact owner control declarations. */
export function createControlActions(controls: readonly ControlDeclaration[]) {
    const targetFor = (control: ControlDeclaration) =>
        control.selectorSchema.extend({control: z.literal(control.name)});
    const target = z.union(controls.map(targetFor)) as unknown as z.ZodType<ControlTarget>;
    const writable = controls.filter((control) => control.writable);
    const writableTarget = z.union(writable.map(targetFor)) as unknown as z.ZodType<ControlTarget>;
    // The same conditional contract validates assignments and browser results in mapget.
    const valueConditions = {
        allOf: writable.map((control) => ({
            if: {properties: {target: {properties: {control: {const: control.name}}}}},
            then: {
                properties: {
                    value: z.toJSONSchema(control.valueSchema, {target: "draft-07", io: "input", reused: "inline"})
                }
            }
        }))
    };
    const checkValue = (input: {target: ControlTarget; value?: unknown}, context: z.RefinementCtx) => {
        if (
            !writable.find((control) => control.name === input.target.control)?.valueSchema.safeParse(input.value)
                .success
        ) {
            context.addIssue({code: "custom", path: ["value"], message: "Value does not match the control"});
        }
    };
    const assignment = z
        .strictObject({target: writableTarget, value: z.unknown()})
        .superRefine(checkValue)
        .meta(valueConditions);
    const writeResult = z
        .strictObject({
            status: z.literal("applied"),
            target: writableTarget,
            value: z.unknown(),
            changed: z.boolean(),
            readiness: z.strictObject({status: z.literal("unknown")})
        })
        .superRefine(checkValue)
        .meta(valueConditions);
    const valueResult = z.union(
        controls.map((control) =>
            z.strictObject({
                target: targetFor(control),
                value: control.valueSchema
            })
        )
    ) as unknown as z.ZodType<{target: ControlTarget; value: unknown}>;
    const omission = z.strictObject({
        target,
        reason: z.enum(["item_limit", "byte_limit", "text_limit"]),
        omittedCount: z.number().int().min(1).optional()
    });
    const completeness = {complete: z.boolean(), omissions: z.array(omission).max(33)};
    return {
        describeControls: {
            name: "viewer_describe_controls",
            mutation: false,
            description:
                "Discover explicit owner controls, their selectors, value schemas and persistence. Use stable view IDs from app.views for view-scoped controls.",
            inputSchema: z.strictObject({
                controls: z.array(z.enum(controls.map(control => control.name))).max(32).optional(),
                prefix: boundedUnicodeString(128).optional()
            }),
            outputSchema: z.strictObject({
                observedAt: z.string(),
                controls: z
                    .array(
                        z.strictObject({
                            name: z.string(),
                            description: z.string(),
                            selectorSchema: z.record(z.string(), z.unknown()),
                            valueSchema: z.record(z.string(), z.unknown()),
                            readable: z.boolean(),
                            writable: z.boolean(),
                            persistence: z.enum(["runtime-summary", "url-and-local-storage", "local-storage", "mixed"]),
                            synchronization: z.enum(["none", "follow-view-sync", "focus-target-and-follow-view-sync"])
                        })
                    )
                    .max(64),
                complete: z.boolean(),
                omissions: z
                    .array(z.strictObject({control: z.string(), reason: z.enum(["item_limit", "byte_limit"])}))
                    .max(64)
            })
        },
        getControls: {
            name: "viewer_get_controls",
            mutation: false,
            description:
                "Read explicit owner controls or a bounded overview. Includes persisted searches and inspections; excludes feature content. Use owner discovery tools for available layers, styles and presets.",
            inputSchema: z.strictObject({targets: z.array(target).max(32).optional()}),
            outputSchema: z.strictObject({
                observedAt: z.string(),
                values: z
                    .array(
                        z.union([
                            valueResult,
                            z.strictObject({
                                target,
                                unavailable: z.enum([
                                    "view_unavailable",
                                    "first_person",
                                    "target_unavailable",
                                    "value_out_of_contract"
                                ])
                            })
                        ])
                    )
                    .max(32),
                ...completeness
            })
        },
        setControl: {
            name: "viewer_set_control",
            mutation: true,
            description:
                "Write one control with {target:{control, ...selector},value}. Read its current value first and preserve unrelated fields. Owners validate choices and honor synchronization. Applied does not mean rendered.",
            inputSchema: assignment,
            outputSchema: writeResult
        }
    } as const;
}
