import {describe, expect, it} from "vitest";
import {
    ndsCoordinatesFromWgs84,
    normalizeCoordinatePanelOptionName,
    packedTileIdFromWgs84,
    parseMortonCoordinateString,
    parseNdsCoordinateString,
    parsePackedTileId
} from "./nds-coordinate.util";

describe("NDS coordinate utilities", () => {
    it("normalizes legacy tile-id display options to PackedTileId", () => {
        expect(normalizeCoordinatePanelOptionName("Mapget TileId (level 13)")).toBe("PackedTileId (level 13)");
        expect(normalizeCoordinatePanelOptionName("NDS TileId (level 4)")).toBe("PackedTileId (level 4)");
        expect(normalizeCoordinatePanelOptionName("WGS84")).toBe("WGS84");
    });

    it("computes NDS coordinates and packed tile ids through ndslive-math", () => {
        expect(ndsCoordinatesFromWgs84(0, 0)).toEqual([0, 0]);
        expect(packedTileIdFromWgs84(0, 0, 0)).toBe(65536);
        expect(packedTileIdFromWgs84(0, 0, 15)).toBe(-2147483648);
    });

    it("rejects malformed packed tile ids", () => {
        expect(parsePackedTileId("65536")?.value).toBe(65536);
        expect(parsePackedTileId("-2147483648")?.value).toBe(-2147483648);
        expect(parsePackedTileId("123")).toBeUndefined();
        expect(parsePackedTileId("1 2")).toBeUndefined();
    });

    it("parses NDS coordinate and Morton jump inputs", () => {
        expect(parseNdsCoordinateString("1 2 3", true)).toMatchObject({x: 1, y: 2, level: 3});
        expect(parseNdsCoordinateString("1 2 3", false)).toMatchObject({x: 2, y: 1, level: 3});
        expect(parseMortonCoordinateString("0 0")).toMatchObject({x: 0, y: 0, level: 0});
    });
});
