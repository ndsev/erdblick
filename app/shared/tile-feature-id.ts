export interface TileFeatureIdLike {
    featureId: string;
    mapTileKey: string;
}

const COMPACT_TILE_FEATURE_ID_PREFIX = "tfid:";

interface DecodedCompactTileFeaturePayload {
    mapTileKey: string;
    payload: string;
}

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

export function normalizeTileFeatureId(value: TileFeatureIdLike | string | null | undefined): TileFeatureIdLike | string | null | undefined {
    if (typeof value !== "string") {
        return value;
    }
    return decodeCompactTileFeatureId(value) ?? value;
}
