import {z} from "zod";
import {bounded, count, identifierSchema, indexSchema, pageInput, pageOutput, text} from "../actions/action-schema";
import {boundedUnicodeString} from "../shared/unicode-string.js";

const sourceText = boundedUnicodeString(48000, true);
const issueSchema = z.strictObject({
    severity: z.enum(["info", "warning", "error"]),
    message: text,
    phase: text,
    rulePath: text.optional(),
    property: text.optional(),
    line: count.optional(),
    column: count.optional()
});
const styleReportSchema = z.strictObject({
    valid: z.boolean(),
    loadable: z.boolean(),
    runtimeVerified: z.literal(false),
    guidance: text,
    issues: z.array(issueSchema).max(100),
    ...bounded
});

/** Public operations owned and bound by the adjacent service. */
export const styleActions = {
    viewer_get_style: {
        name: "viewer_get_style",
        description:
            "Read one style's YAML and browser-local lifecycle flags. A style shows how some fields are drawn; it is not a data inventory. Discover available attributes with mapget_query_schema and actual values with mapget_extract_features. Search-overlay colors, categories and labels belong to viewer_get_search/viewer_set_search, not this base stylesheet. Never returns credentials or source filesystem paths.",
        mutation: false,
        inputSchema: z.strictObject({
            styleId: identifierSchema.describe(
                "Copy the exact id from viewer_get_catalog kind:styles; do not use the layer ID or display name."
            )
        }),
        outputSchema: z.strictObject({
            styleId: identifierSchema,
            source: boundedUnicodeString(180000),
            imported: z.boolean(),
            modified: z.boolean(),
            visible: z.boolean()
        })
    },
    viewer_validate_style: {
        name: "viewer_validate_style",
        description:
            "Validate bounded style YAML structure using the native parser without installing it. valid/loadable do not prove fields, geometry or rendered output exist in a dataset. After applying, use viewer_get_diagnostics sections=[errors] for runtime expression failures. Options are local to each stylesheet: copied option filters require matching options declarations in that stylesheet.",
        mutation: false,
        inputSchema: z.strictObject({source: sourceText}),
        outputSchema: styleReportSchema
    },
    viewer_edit_style: {
        name: "viewer_edit_style",
        description:
            "Create/update/patch/reset a browser-local YAML style, delete an imported style, or change visibility. Prefer patch for focused changes after viewer_get_style: edits are sequential exact find/replace pairs, each find must occur exactly once in the current source. All edits and final YAML validation succeed before any change is installed. Preserve unrelated rules/options. Missing stock options do not prevent custom rules. Options belong to each stylesheet; declare copied option filters locally. Never writes server files. Create/update require source; patch requires styleId and edits. Reset restores builtin YAML, not visibility or option values.",
        mutation: true,
        inputSchema: z.strictObject({
            operation: z.enum(["create", "update", "patch", "reset", "delete", "visibility"]),
            styleId: identifierSchema.optional(),
            source: sourceText.optional(),
            visible: z.boolean().optional(),
            edits: z
                .array(z.strictObject({find: boundedUnicodeString(16000, true), replace: boundedUnicodeString(32000)}))
                .min(1)
                .max(16)
                .optional()
        }),
        outputSchema: z.strictObject({
            status: z.literal("applied"),
            styleId: identifierSchema,
            changed: z.boolean().optional(),
            editCount: indexSchema.optional()
        })
    }
} as const;


export const styleDiscoveryActions = {
    listStyles: {
        name: "viewer_list_styles",
        mutation: false,
        description:
            "List editable styles, including hidden and optionless styles. Optional layerId filters by layer affinity. Use exact returned IDs with style operations; styles are global, not layer IDs.",
        inputSchema: z.strictObject({
            layerId: identifierSchema.optional(),
            styleId: identifierSchema.optional(),
            ...pageInput
        }),
        outputSchema: z.strictObject({
            ...pageOutput,
            items: z
                .array(
                    z.strictObject({
                        id: identifierSchema,
                        name: text,
                        kind: text,
                        visible: z.boolean(),
                        imported: z.boolean(),
                        modified: z.boolean()
                    })
                )
                .max(100)
        })
    }
} as const;
