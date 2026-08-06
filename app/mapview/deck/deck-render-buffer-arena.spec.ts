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
        expect(arena.debugSnapshot()).toEqual({
            groups: 1,
            pages: 2,
            reusablePages: 0,
            contributions: 3,
            usedVertices: 17,
            capacityVertices: 32,
            maxContributionsPerPage: 2
        });
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

    it("reports retained empty pages separately from active pages", () => {
        const arena = new DeckRenderBufferArena(
            new DeckLayerRegistry(null),
            16
        );
        const buildLayer = () => ({layer: {id: "page"}, order: 0});
        arena.upsert({
            groupKey: "paths",
            sourceId: "block-a",
            vertexCount: 8,
            contribution: "a",
            buildLayer
        });
        arena.remove("paths", "block-a");

        expect(arena.debugSnapshot()).toEqual({
            groups: 0,
            pages: 0,
            reusablePages: 1,
            contributions: 0,
            usedVertices: 0,
            capacityVertices: 0,
            maxContributionsPerPage: 0
        });
    });

    it("retains one coordinate origin inside a local render region", () => {
        const arena = new DeckRenderBufferArena(
            new DeckLayerRegistry(null),
            16
        );

        expect(arena.coordinateOrigin([11, 48, 0])).toEqual([11, 48, 0]);
        expect(arena.coordinateOrigin([11.5, 48.5, 10])).toEqual([11, 48, 0]);
    });

    it("keeps stable independent origins across continental jumps", () => {
        const arena = new DeckRenderBufferArena(
            new DeckLayerRegistry(null),
            16
        );
        const berlin: [number, number, number] = [13.405, 52.52, 0];
        const losAngeles: [number, number, number] = [-118.2437, 34.0522, 0];

        expect(arena.coordinateOrigin(berlin)).toEqual(berlin);
        expect(arena.coordinateOrigin(losAngeles)).toEqual(losAngeles);
        expect(arena.coordinateOrigin([13.45, 52.5, 20])).toEqual(berlin);
        expect(arena.coordinateOrigin([-118.2, 34.1, 10])).toEqual(losAngeles);
    });

    it("forgets retained coordinate origins when cleared", () => {
        const arena = new DeckRenderBufferArena(
            new DeckLayerRegistry(null),
            16
        );

        expect(arena.coordinateOrigin([11, 48, 0])).toEqual([11, 48, 0]);
        arena.clear();
        expect(arena.coordinateOrigin([12, 49, 10])).toEqual([12, 49, 10]);
    });
});
