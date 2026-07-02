import {MortonCode, PackedTileId, Wgs84} from "@ndsev/ndslive-math";

export const NDS_COORDINATES_OPTION = "NDS";
export const PACKED_TILE_ID_OPTION_PREFIX = "PackedTileId";

/** Returns the stable coordinate-panel option name for one packed tile-id level. */
export function packedTileIdOptionName(level: number): string {
    return `${PACKED_TILE_ID_OPTION_PREFIX} (level ${level})`;
}

/** Normalizes legacy coordinate-panel option names to the current built-in names. */
export function normalizeCoordinatePanelOptionName(name: string): string {
    const level = levelFromTileIdOptionName(name);
    return level === undefined ? name : packedTileIdOptionName(level);
}

/** Extracts the level encoded in current or legacy tile-id coordinate-panel option names. */
export function levelFromTileIdOptionName(name: string): number | undefined {
    if (!/^(Mapget TileId|NDS TileId|PackedTileId) \(level \d+\)$/.test(name)) {
        return undefined;
    }
    const level = Number(name.match(/\d+/)?.[0]);
    return Number.isInteger(level) && level >= 0 && level <= 15 ? level : undefined;
}

/** Converts WGS84 lon/lat degrees into signed NDS integer coordinates. */
export function ndsCoordinatesFromWgs84(lon: number, lat: number): [number, number] {
    return new Wgs84(lon, lat).toNdsCoordinates();
}

/** Returns the signed NDS.Live packed tile id containing a WGS84 position. */
export function packedTileIdFromWgs84(lon: number, lat: number, level: number): number {
    const [x, y] = ndsCoordinatesFromWgs84(lon, lat);
    return packedTileIdFromNdsCoordinates(x, y, level);
}

/** Parses a signed NDS.Live packed tile id and rejects malformed or out-of-range input. */
export function parsePackedTileId(value: string): PackedTileId | undefined {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
        return undefined;
    }
    const numericValue = Number(trimmed);
    if (!Number.isSafeInteger(numericValue)) {
        return undefined;
    }
    if (numericValue < -2147483648 || numericValue > 4294967295) {
        return undefined;
    }
    try {
        return new PackedTileId(numericValue);
    } catch (_error) {
        return undefined;
    }
}

export interface ParsedNdsCoordinates {
    x: number;
    y: number;
    lon: number;
    lat: number;
    level?: number;
}

/** Parses integer NDS coordinate pairs, optionally followed by a tile level. */
export function parseNdsCoordinateString(value: string, isXyOrder: boolean): ParsedNdsCoordinates | undefined {
    const match = value.trim().match(/^(-?\d+)[^\d-]+(-?\d+)(?:[^\d-]+(\d+))?[^\d]*$/);
    if (!match) {
        return undefined;
    }
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) {
        return undefined;
    }
    const x = isXyOrder ? first : second;
    const y = isXyOrder ? second : first;
    const wgs84 = Wgs84.fromNdsCoordinates(x, y);
    const result: ParsedNdsCoordinates = {x, y, lon: wgs84.longitude(), lat: wgs84.latitude()};
    if (match[3] !== undefined) {
        result.level = clampTileLevel(Number(match[3]));
    }
    return result;
}

/** Parses a Morton code, optionally followed by a tile level. */
export function parseMortonCoordinateString(value: string): ParsedNdsCoordinates | undefined {
    const match = value.trim().match(/^(\d+)(?:[^\d-]+(\d+))?[^\d]*$/);
    if (!match) {
        return undefined;
    }
    try {
        const mortonCode = new MortonCode(BigInt(match[1]));
        const [x, y] = mortonCode.toNdsCoordinates();
        const wgs84 = Wgs84.fromNdsCoordinates(x, y);
        const result: ParsedNdsCoordinates = {x, y, lon: wgs84.longitude(), lat: wgs84.latitude()};
        if (match[2] !== undefined) {
            result.level = clampTileLevel(Number(match[2]));
        }
        return result;
    } catch (_error) {
        return undefined;
    }
}

/** Returns the packed tile id addressed by a parsed coordinate's optional level. */
export function packedTileIdFromParsedNdsCoordinates(coordinates: ParsedNdsCoordinates): number | undefined {
    if (coordinates.level === undefined) {
        return undefined;
    }
    return packedTileIdFromNdsCoordinates(coordinates.x, coordinates.y, coordinates.level);
}

/** Returns the packed tile id addressed by a Morton code and optional level. */
export function packedTileIdFromMortonString(value: string): number | undefined {
    const match = value.trim().match(/^(\d+)(?:[^\d-]+(\d+))?[^\d]*$/);
    if (!match?.[2]) {
        return undefined;
    }
    return PackedTileId.fromMortonAndLevel(new MortonCode(BigInt(match[1])), clampTileLevel(Number(match[2]))).value;
}

/** Clamps user-entered tile levels to the range supported by NDS.Live packed tile ids. */
function clampTileLevel(level: number): number {
    return Math.max(0, Math.min(Math.trunc(level), 15));
}

/** Builds a signed packed tile id for the tile containing one NDS coordinate. */
function packedTileIdFromNdsCoordinates(x: number, y: number, level: number): number {
    return PackedTileId.fromMortonAndLevel(MortonCode.fromNdsCoordinates(x, y), level).value;
}
