import {describe, expect, it, vi} from "vitest";
import {DeckLayerRegistry} from "./deck-layer-registry";
import {DeckRenderBufferArena} from "./deck-render-buffer-arena";

describe("DeckRenderBufferArena", () => {
    it("packs compatible blocks into bounded stable pages", () => {
        const registry = new DeckLayerRegistry(null);
        const arena = new DeckRenderBufferArena(registry, 16);
        const buildLayer = vi.fn(() => ({
            layer: {id: "page"},
            order: 0
        }));

        const first = arena.upsert({
            groupKey: "paths",
            sourceId: "block-a",
            vertexCount: 8,
            contribution: "a",
            buildLayer
        });
        const second = arena.upsert({
            groupKey: "paths",
            sourceId: "block-b",
            vertexCount: 8,
            contribution: "b",
            buildLayer
        });
        const third = arena.upsert({
            groupKey: "paths",
            sourceId: "block-c",
            vertexCount: 1,
            contribution: "c",
            buildLayer
        });

        expect(first).toBe("paths/page-0");
        expect(second).toBe(first);
        expect(third).toBe("paths/page-1");
        expect(registry.size).toBe(2);
    });

    it("removes one block while retaining and reusing its page capacity", () => {
        const registry = new DeckLayerRegistry(null);
        const arena = new DeckRenderBufferArena(registry, 16);
        const buildLayer = () => ({layer: {id: "page"}, order: 0});
        arena.upsert({
            groupKey: "paths",
            sourceId: "block-a",
            vertexCount: 8,
            contribution: "a",
            buildLayer
        });
        arena.upsert({
            groupKey: "paths",
            sourceId: "block-b",
            vertexCount: 8,
            contribution: "b",
            buildLayer
        });

        expect(arena.remove("paths", "block-a")).toBe(true);
        const replacement = arena.upsert({
            groupKey: "paths",
            sourceId: "block-c",
            vertexCount: 8,
            contribution: "c",
            buildLayer
        });

        expect(replacement).toBe("paths/page-0");
        expect(registry.size).toBe(1);
    });

    it("retains one coordinate origin for the view lifetime", () => {
        const arena = new DeckRenderBufferArena(
            new DeckLayerRegistry(null),
            16
        );

        expect(arena.coordinateOrigin([11, 48, 0])).toEqual([11, 48, 0]);
        expect(arena.coordinateOrigin([12, 49, 10])).toEqual([11, 48, 0]);
    });
});
