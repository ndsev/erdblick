/**
 * Small native type projections used by inspection and search-style controls.
 * These describe one field's meaning, not a second schema graph in TypeScript.
 * The exact schema/type identity prevents two identically named fields with
 * different units or sentinel values from being merged into one color scale.
 */
import {z} from "zod";

/** Integers outside JavaScript's exact range arrive as decimal strings. */
const exactNumber = z.union([z.number().finite(), z.string().regex(/^-?\d+$/)]);

/** Native metadata validates at the worker boundary before any editor consumes it. */
export const schemaTypeIdentitySchema = z.object({
    schemaId: z.string().min(1),
    typeId: z.number().int().min(1).max(0xffff),
});

export type SchemaTypeIdentity = z.infer<typeof schemaTypeIdentitySchema>;

/**
 * Saved searches and YAML styles predate the typeId spelling. Accept their
 * legacy numeric key only while reading persisted input; the normalized value
 * and all native worker messages use the current schema/type identity.
 */
export const legacySchemaTypeIdentitySchema = z.object({
    schemaId: schemaTypeIdentitySchema.shape.schemaId,
    domainId: schemaTypeIdentitySchema.shape.typeId
}).transform(value => ({schemaId: value.schemaId, typeId: value.domainId}));

/**
 * A saved color scale can cover several verified equivalent source types.
 * Read historical singular guards at the persistence/YAML boundary; an invalid
 * current spelling must not fall through to a different legacy guard.
 */
export const colorScaleTypesSchema = z.preprocess((value) => {
    if (!value || typeof value !== "object") return value;
    const input = value as Record<string, unknown>;
    if (input["schemaTypes"] !== undefined) return input["schemaTypes"];
    if (input["schemaType"] !== undefined) return [input["schemaType"]];
    if (input["domain"] !== undefined) {
        const old = legacySchemaTypeIdentitySchema.safeParse(input["domain"]);
        return old.success ? [old.data] : [input["domain"]];
    }
    return undefined;
}, z.array(schemaTypeIdentitySchema).min(1).optional());

/** Presentation metadata borrowed from one installed native type. */
export const schemaScalarTypeSchema = schemaTypeIdentitySchema.extend({
    typeName: z.string(),
    numeric: z.object({
        encoding: z.string(),
        unit: z.string(),
        minimum: exactNumber.optional(),
        maximum: exactNumber.optional(),
        ordinaryRanges: z.array(z.object({min: exactNumber, max: exactNumber})),
        scale: z.number().finite(),
        offset: z.number().finite(),
        complete: z.boolean()
    }).optional(),
    namedValues: z.array(z.object({
        name: z.string(),
        value: z.union([z.string(), z.number().finite(), z.boolean()]),
        valueType: z.enum(["string", "integer", "number", "boolean"]),
        /** Physical enum ordinal; the displayed value can instead be a string label. */
        rawValue: z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).optional(),
        role: z.enum(["constant", "special", "flag"]),
        meaning: z.enum(["ordinary", "unknown", "variable", "unbounded", "saturated"]),
        deprecated: z.boolean(),
        removed: z.boolean()
    })),
    bitWidth: z.number().int().min(1).max(64).optional()
});

export type SchemaScalarType = z.infer<typeof schemaScalarTypeSchema>;
export type SchemaNamedValue = SchemaScalarType["namedValues"][number];

/**
 * Compare values by their meaning rather than by their position in a schema.
 * Two map versions can encode the same speed scale with different type IDs.
 * Numeric units, raw ranges and exceptional values must still agree. Symbolic
 * categories instead use their logical string labels: adding enum entries or
 * changing their wire ordinals does not change the color of "ANIMALS".
 */
export function schemaScalarMeaning(type: SchemaScalarType): string {
    if (!type.numeric && type.namedValues.length && type.namedValues.every(value =>
        value.valueType === "string" && value.role === "constant")) {
        return "symbolic-categories";
    }
    return JSON.stringify({
        numeric: type.numeric,
        bitWidth: type.bitWidth,
        namedValues: [...type.namedValues].sort((a, b) => a.name.localeCompare(b.name))
    });
}

/** Lossless mask transport, matching simfil's JSON export representation. */
export interface SchemaBitmask {
    _bitmask: true;
    bits: string;
    schema: string;
    typeId: number;
}
