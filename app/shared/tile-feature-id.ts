export interface TileFeatureIdLike {
    featureId: string;
    mapTileKey: string;
    featureIndex?: number;
}

const COMPACT_TILE_FEATURE_ID_PREFIX = "tfid:";
const COMPACT_TILE_FEATURE_INDEX_PREFIX = "tfii:";

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
    if (decodedFeatureId) {
        return {
            mapTileKey: decodedFeatureId.mapTileKey,
            featureId: decodedFeatureId.payload,
        };
    }

    const decodedFeatureIndex = decodeCompactPayload(value, COMPACT_TILE_FEATURE_INDEX_PREFIX);
    if (!decodedFeatureIndex) {
        return undefined;
    }

    const featureIndex = Number(decodedFeatureIndex.payload);
    if (!Number.isInteger(featureIndex) || featureIndex < 0) {
        return undefined;
    }

    return {
        mapTileKey: decodedFeatureIndex.mapTileKey,
        featureId: decodedFeatureIndex.payload,
        featureIndex,
    };
}

export function normalizeTileFeatureId(value: TileFeatureIdLike | string | null | undefined): TileFeatureIdLike | string | null | undefined {
    if (typeof value !== "string") {
        return value;
    }
    return decodeCompactTileFeatureId(value) ?? value;
}
