import {MortonCode, PackedTileId, Wgs84} from "@ndsev/ndslive-math";
/** Returns whether a parsed integer is within the public signed packed-tile-id range. */
function isSignedPackedTileId(value: number): boolean {
    return Number.isInteger(value) && value >= -2147483648 && value <= 4294967295;
}

/** Converts unsigned packed tile ids to the signed int32 representation used by mapget JSON. */
function toSignedPackedTileId(value: number): number {
    return value >= 2147483648 ? value - 4294967296 : value;
}

/** Converts one removed `0xXXXXYYYYZZZZ` mapget tile id to an NDS.Live packed tile id. */
function legacyMapgetTileIdToPackedValue(raw: bigint): number | null {
    if (raw < 0n || (raw >> 48n) !== 0n) {
        return null;
    }

    const level = Number(raw & 0xffffn);
    if (!Number.isInteger(level) || level < 0 || level > 15) {
        return null;
    }

    const x = Number((raw >> 32n) & 0xffffn);
    const y = Number((raw >> 16n) & 0xffffn);
    if (x >= 2 ** (level + 1) || y >= 2 ** level) {
        return null;
    }

    const columnCount = 2 ** (level + 1);
    const rowCount = 2 ** level;
    const lon = -180 + ((x + 0.5) * 360) / columnCount;
    const lat = 90 - ((y + 0.5) * 180) / rowCount;
    const [ndsX, ndsY] = new Wgs84(lon, lat).toNdsCoordinates();
    return PackedTileId.fromMortonAndLevel(MortonCode.fromNdsCoordinates(ndsX, ndsY), level).value;
}

/** Parses legacy decimal or hex mapget tile ids while preserving already-packed ids. */
export function tileIdNumberFromString(value: string): number | null {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
        const decimal = Number(trimmed);
        if (!Number.isSafeInteger(decimal)) {
            return null;
        }
        if (isSignedPackedTileId(decimal)) {
            return Math.trunc(decimal);
        }
        return legacyMapgetTileIdToPackedValue(BigInt(trimmed));
    }

    if (/^[0-9a-fA-F]{1,12}$/.test(trimmed)) {
        return legacyMapgetTileIdToPackedValue(BigInt(`0x${trimmed}`));
    }

    return null;
}

/** Returns a map-tile-key-safe decimal tile id string, or the original token if it cannot be normalized. */
export function normalizeMapTileIdString(value: string): string {
    const parsed = tileIdNumberFromString(value);
    return parsed === null ? value : String(parsed);
}
