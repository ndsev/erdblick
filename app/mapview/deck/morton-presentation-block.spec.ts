import {describe, expect, it} from "vitest";
import {
    fitsMortonPresentationVertexBudget,
    mortonBlockBatch,
    mortonBlockTileIds,
    mortonPresentationBlock,
    packedTileIdFromGrid
} from "./morton-presentation-block";

describe("Morton presentation blocks", () => {
    it("assigns every tile in an aligned 4x4 square to one block", () => {
        const blocks = new Set<string>();
        const origins = new Set<string>();
        for (let y = 24; y < 28; ++y) {
            for (let x = 40; x < 44; ++x) {
                const tileId = packedTileIdFromGrid(x, y, 6);
                const block = mortonPresentationBlock(tileId);
                blocks.add(block.key);
                origins.add(block.origin.join(","));
            }
        }
        expect(blocks.size).toBe(1);
        expect(origins.size).toBe(1);
    });

    it("enumerates the largest aligned block containing a tile", () => {
        const tileId = packedTileIdFromGrid(45, 27, 6);
        const members = mortonBlockTileIds(tileId, 4);
        expect(members).toHaveLength(16);
        expect(members).toContain(tileId);
        expect(members).toContain(packedTileIdFromGrid(44, 24, 6));
        expect(members).toContain(packedTileIdFromGrid(47, 27, 6));
    });

    it("forms one nested half-level rectangle for every Morton suffix bit", () => {
        const tileId = packedTileIdFromGrid(45, 27, 6);
        const expectedShapes = [
            [1, 1],
            [2, 1],
            [2, 2],
            [4, 2],
            [4, 4]
        ];
        let previousMembers = new Set<number>();

        for (let bits = 0; bits <= 4; ++bits) {
            const block = mortonBlockBatch(tileId, bits);
            expect([block.width, block.height]).toEqual(
                expectedShapes[bits]
            );
            expect(block.tileIds).toHaveLength(
                block.width * block.height
            );
            expect(block.tileIds).toContain(tileId);
            for (const previous of previousMembers) {
                expect(block.tileIds).toContain(previous);
            }
            previousMembers = new Set(block.tileIds);
        }
    });

    it("assigns every member of a half-level rectangle the same identity", () => {
        const tileId = packedTileIdFromGrid(45, 27, 6);
        const batch = mortonBlockBatch(tileId, 3);

        for (const member of batch.tileIds) {
            const block = mortonPresentationBlock(member, 3);
            expect(block.key).toBe(batch.key);
            expect(block.origin).toEqual(batch.origin);
        }
    });

    it("clamps low levels to their available Morton suffix bits", () => {
        const block = mortonBlockBatch(
            packedTileIdFromGrid(1, 0, 0),
            4
        );

        expect([block.width, block.height]).toEqual([2, 1]);
        expect(block.tileIds).toHaveLength(2);
    });

    it("uses 16k vertices as a soft aggregate limit", () => {
        expect(fitsMortonPresentationVertexBudget([
            8_192,
            8_192
        ])).toBe(true);
        expect(fitsMortonPresentationVertexBudget([
            8_192,
            8_193
        ])).toBe(false);
        expect(fitsMortonPresentationVertexBudget([
            20_000
        ])).toBe(true);
    });
});
