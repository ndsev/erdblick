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
