import {PackedTileId} from "@ndsev/ndslive-math";

/**
 * Return the WGS84 center of one packed tile as its local GPU coordinate origin.
 * Per-tile origins keep worker tasks independently replaceable while retaining
 * enough precision for high-detail geometry far from the global origin.
 */
export function tileCoordinateOrigin(
    tileId: number
): [number, number, number] {
    const tile = new PackedTileId(tileId);
    const [southWestX, southWestY] = tile.southWestCorner();
    const halfSize = tile.size() / 2;
    return [
        (southWestX + halfSize) * 360 / 2 ** 32,
        (southWestY + halfSize) * 180 / 2 ** 31,
        0
    ];
}
