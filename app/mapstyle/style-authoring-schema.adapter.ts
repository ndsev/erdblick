import {z} from "zod";
import {coreLib, ErdblickCore_} from "../integrations/wasm.adapter";

const fieldSchema = z.object({
    kind: z.enum(["string", "expression", "number", "boolean", "enum", "enum-list", "vector",
        "record", "list", "color", "color-ref", "stops", "option-default"]),
    group: z.string().default("Common"),
    label: z.string().optional(),
    help: z.string().optional(),
    record: z.string().optional(),
    values: z.array(z.string()).default([]),
    sizes: z.array(z.number()).default([]),
    exclusive: z.array(z.string()).default([]),
    topLevel: z.boolean().default(false),
    valueKind: z.enum(["color", "number"]).optional(),
    seed: z.unknown().optional()
});
const catalogSchema = z.object({
    records: z.record(z.string(), z.record(z.string(), fieldSchema)),
    seeds: z.record(z.string(), z.record(z.string(), z.unknown()))
});

export type StyleField = z.infer<typeof fieldSchema>;
export type StyleAuthoringSchema = z.infer<typeof catalogSchema>;
let catalog: StyleAuthoringSchema | undefined;

/** Loads the native catalog after the application's WASM initializer has completed. */
export function styleAuthoringSchema(): StyleAuthoringSchema {
    const lib: ErdblickCore_ = coreLib;
    return catalog ??= catalogSchema.parse(JSON.parse(lib.styleAuthoringSchemaJson()));
}

/** Supplies both GUI and CodeMirror with the same supported properties and enum values. */
export function styleAuthoringCompletions(): Array<{label: string; type: string}> {
    const entries = new Map<string, string>();
    for (const fields of Object.values(styleAuthoringSchema().records)) {
        for (const [key, field] of Object.entries(fields)) {
            entries.set(key, "property");
            for (const value of field.values) if (!entries.has(value)) entries.set(value, "keyword");
        }
    }
    return [...entries].map(([label, type]) => ({label, type}));
}
