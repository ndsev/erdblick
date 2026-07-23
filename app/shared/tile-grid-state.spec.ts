import {describe, expect, it} from "vitest";
import {
    clampTileGridLevel,
    clampTileGridOpacity,
    normalizeTileGridColor,
    tileGridMaxLevel,
    tileGridRgba
} from "./appstate.service";

describe("tile-grid state helpers", () => {
    it("uses mode-specific level limits", () => {
        expect(tileGridMaxLevel("nds")).toBe(15);
        expect(tileGridMaxLevel("xyz")).toBe(22);
        expect(clampTileGridLevel(19, "nds")).toBe(15);
        expect(clampTileGridLevel(19, "xyz")).toBe(19);
        expect(clampTileGridLevel(-3, "xyz")).toBe(0);
    });

    it("normalizes colour and clamps opacity at the AppState boundary", () => {
        expect(normalizeTileGridColor("#A0b1C2")).toBe("a0b1c2");
        expect(normalizeTileGridColor("not-a-colour")).toBe("f5f5f5");
        expect(clampTileGridOpacity(-1)).toBe(0);
        expect(clampTileGridOpacity(101)).toBe(100);
        expect(clampTileGridOpacity(41.7)).toBe(42);
    });

    it("converts RGB and percentage opacity to exact deck RGBA", () => {
        expect(tileGridRgba("123456", 0)).toEqual([0x12, 0x34, 0x56, 0]);
        expect(tileGridRgba("abcdef", 39)).toEqual([0xab, 0xcd, 0xef, 99]);
        expect(tileGridRgba("ffffff", 100)).toEqual([255, 255, 255, 255]);
    });
});
