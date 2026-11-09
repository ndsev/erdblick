/**
 * Feature identity schemas and compact inspection-target encoding.
 * These value operations keep feature, attribute and validity targets consistent
 * across inspection, selection, hover and search without loading a feature.
 */
import { z } from "zod";
import { identifierSchema, indexSchema } from "../action/action.model";

const count = indexSchema;

/**
 * An unresolved foreign reference names its parts independently of the source
 * schema. BigInt is an in-browser transport value for exact native int64 parts;
 * strings remain strings, including decimal-looking strings.
 */
export const namedFeatureReferenceSchema = z.strictObject({
    mapId: identifierSchema,
    typeId: identifierSchema,
    // Keep the original own-key dictionary: an ordinary z.record projection
    // drops '__proto__', which is a valid native part name rather than JS code.
    id: z.custom<Record<string, string | number | bigint>>(parts => {
        if (!parts || typeof parts !== "object" || Array.isArray(parts)) return false;
        const entries = Object.entries(parts);
        return entries.length > 0 && entries.length <= 255 && entries.every(([key, value]) =>
            identifierSchema.safeParse(key).success && (typeof value === "string"
                || (typeof value === "number" && Number.isSafeInteger(value))
                || (typeof value === "bigint" && value >= -9223372036854775808n && value <= 9223372036854775807n)));
    }, "A named feature reference requires 1–255 named string or exact int64 parts")
});

export type NamedFeatureReference = z.infer<typeof namedFeatureReferenceSchema>;

/** A rendered foreign identity awaiting target-map locate, with optional local row selectors. */
export interface NamedFeaturePick {
    featureReference: NamedFeatureReference;
    attributeIndex?: number;
    relationIndex?: number;
    validityIndex?: number;
}

/** Native rendering uses canonical strings for local IDs and named parts for foreign IDs. */
export type FeaturePickIdentity = string | NamedFeaturePick;

/** The subset key identifies the rendering owner; a foreign target's partition is not known yet. */
export type FeaturePickTarget =
    | (TileFeatureIdLike & {featureReference?: never})
    | (NamedFeaturePick & {mapTileKey: string; featureId?: never});

/**
 * Write the established JSON reference shape without narrowing large integers.
 * JSON.stringify cannot encode BigInt; quoting it instead would change an
 * integer ID part into a string. Every string/key is escaped by JSON.stringify.
 */
export function namedFeatureReferenceJson(value: NamedFeatureReference): string {
    const reference = namedFeatureReferenceSchema.parse(value);
    const parts = Object.keys(reference.id).sort().map(key => {
        const part = reference.id[key];
        return `${JSON.stringify(key)}:${typeof part === "bigint" ? part.toString() : JSON.stringify(part)}`;
    });
    return `{"mapId":${JSON.stringify(reference.mapId)},"typeId":${JSON.stringify(reference.typeId)},"id":{${parts.join(",")}}}`;
}

/** Stable cache/comparison key; never exposed as a canonical feature ID or persisted in URL state. */
export function featurePickIdentityKey(identity: FeaturePickIdentity): string {
    if (typeof identity === "string") return `local:${identity}`;
    return "foreign:" + namedFeatureReferenceJson(identity.featureReference)
        + JSON.stringify([identity.attributeIndex, identity.relationIndex, identity.validityIndex]);
}

const inspectionTargetFields = {
    attributeIndex: count.optional().describe("Observed attribute index on the base feature; mutually exclusive with relationIndex and an ID suffix."),
    relationIndex: count.optional().describe("Observed relation index on the base feature; mutually exclusive with attributeIndex and an ID suffix."),
    validityIndex: count.optional().describe("Observed validity index; requires attributeIndex or relationIndex. For a relation, addresses targetValidity, not sourceValidity. Omit to select the whole attribute/relation.")
};

export const featureIdentitySchema = z.union([
    z.strictObject({
        ...inspectionTargetFields,
        mapTileKey: identifierSchema,
        featureId: identifierSchema.describe("Full feature ID, including its feature-type prefix; copy an observed ID, not only its numeric parts.")
    }),
    z.strictObject({
        ...inspectionTargetFields,
        mapId: identifierSchema,
        layerId: identifierSchema.optional(),
        featureId: identifierSchema.describe("Full feature ID beginning with its exact feature type, with source-specific ID parts separated by dots.")
    })
]);

/** Minimal feature identity used by URL state and inspection panels. */
export interface TileFeatureIdLike {
    featureId: string;
    mapTileKey: string;
}

/** Parsed identity of a feature or one of its inspectable child rows. */
export type FeatureInspectionTarget =
    | {
        scope: "feature";
        baseFeatureId: string;
    }
    | {
        scope: "attribute";
        baseFeatureId: string;
        attributeIndex: number;
        validityIndex?: number;
    }
    | {
        scope: "relation";
        baseFeatureId: string;
        relationIndex: number;
        validityIndex?: number;
    };

const COMPACT_TILE_FEATURE_ID_PREFIX = "tfid:";

interface DecodedCompactTileFeaturePayload {
    mapTileKey: string;
    payload: string;
}

/** Decodes the internal compact `tfid:` transport format back into its two components. */
function decodeCompactPayload(
    value: string,
    prefix: string
): DecodedCompactTileFeaturePayload | undefined {
    if (!value.startsWith(prefix)) {
        return undefined;
    }
    const lengthSep = value.indexOf(":", prefix.length);
    if (lengthSep < 0) {
        return undefined;
    }
    const mapTileKeyLength = Number(value.substring(prefix.length, lengthSep));
    if (!Number.isFinite(mapTileKeyLength) || mapTileKeyLength < 0) {
        return undefined;
    }
    const mapTileKeyStart = lengthSep + 1;
    const mapTileKeyEnd = mapTileKeyStart + mapTileKeyLength;
    if (mapTileKeyEnd > value.length) {
        return undefined;
    }
    return {
        mapTileKey: value.substring(mapTileKeyStart, mapTileKeyEnd),
        payload: value.substring(mapTileKeyEnd),
    };
}

/** Expands a compact tile-feature-id string when the URL uses the shortened form. */
export function decodeCompactTileFeatureId(value: string): TileFeatureIdLike | undefined {
    const decodedFeatureId = decodeCompactPayload(value, COMPACT_TILE_FEATURE_ID_PREFIX);
    if (!decodedFeatureId) {
        return undefined;
    }
    return {
        mapTileKey: decodedFeatureId.mapTileKey,
        featureId: decodedFeatureId.payload,
    };
}

/** Normalizes a possibly compact feature identifier while leaving non-strings untouched. */
export function normalizeTileFeatureId(value: TileFeatureIdLike | string | null | undefined): TileFeatureIdLike | string | null | undefined {
    if (typeof value !== "string") {
        return value;
    }
    return decodeCompactTileFeatureId(value) ?? value;
}

/**
 * Parses the inspection suffix shared by native picking, search results, and
 * inspection panels. The comma before `validity` is accepted for old URLs;
 * newly formatted targets always use a colon.
 * This parses syntax only; callers validate index range and target existence.
 */
export function parseFeatureInspectionTarget(targetId: string): FeatureInspectionTarget {
    const match = targetId.match(
        /^(.*):(attribute|relation)#(\d+)(?:(?::|,)validity#(\d+))?$/
    );
    if (!match) {
        return {scope: "feature", baseFeatureId: targetId};
    }
    const baseFeatureId = match[1];
    const entryIndex = Number(match[3]);
    const validityIndex = match[4] === undefined
        ? undefined
        : Number(match[4]);
    if (match[2] === "attribute") {
        return {
            scope: "attribute",
            baseFeatureId,
            attributeIndex: entryIndex,
            ...(validityIndex === undefined ? {} : {validityIndex})
        };
    }
    return {
        scope: "relation",
        baseFeatureId,
        relationIndex: entryIndex,
        ...(validityIndex === undefined ? {} : {validityIndex})
    };
}

/** Formats one parsed inspection target using the canonical suffix grammar. */
export function formatFeatureInspectionTarget(
    target: FeatureInspectionTarget
): string {
    if (target.scope === "feature") {
        return target.baseFeatureId;
    }
    const entryIndex = target.scope === "attribute"
        ? target.attributeIndex
        : target.relationIndex;
    const validitySuffix = target.validityIndex === undefined
        ? ""
        : `:validity#${target.validityIndex}`;
    return `${target.baseFeatureId}:${target.scope}#${entryIndex}${validitySuffix}`;
}

/** Returns true when an id addresses an attribute or relation inspection row. */
export function isFeatureInspectionSubTarget(targetId: string): boolean {
    return parseFeatureInspectionTarget(targetId).scope !== "feature";
}

/** Returns true when an id addresses one exact validity row. */
export function hasFeatureInspectionValidity(targetId: string): boolean {
    const target = parseFeatureInspectionTarget(targetId);
    return target.scope !== "feature" && target.validityIndex !== undefined;
}

/** Removes only the validity suffix and retains its attribute or relation row. */
export function stripFeatureInspectionValidity(targetId: string): string {
    const target = parseFeatureInspectionTarget(targetId);
    if (target.scope === "feature" || target.validityIndex === undefined) {
        return targetId;
    }
    return target.scope === "attribute"
        ? formatFeatureInspectionTarget({
            scope: "attribute",
            baseFeatureId: target.baseFeatureId,
            attributeIndex: target.attributeIndex
        })
        : formatFeatureInspectionTarget({
            scope: "relation",
            baseFeatureId: target.baseFeatureId,
            relationIndex: target.relationIndex
        });
}

/** Removes inspection sub-target suffixes while preserving the base feature id. */
export function stripFeatureInspectionTarget(featureId: string): string {
    return parseFeatureInspectionTarget(featureId).baseFeatureId;
}

/** Returns whether two picking targets describe the exact same interaction row. */
export function tileFeatureInteractionTargetsEqual(
    first: TileFeatureIdLike,
    second: TileFeatureIdLike
): boolean {
    return first.mapTileKey === second.mapTileKey &&
        first.featureId === second.featureId;
}

/** Removes inspection sub-target suffixes while preserving the base feature id for display. */
export function displayFeatureId(featureId: string): string {
    return stripFeatureInspectionTarget(featureId);
}
