import {describe, expect, it, vi} from "vitest";
import {
    DeckLayerRegistry,
    DeckLike,
    DeckLayerLike,
    makeDeckLayerKey,
    makeDeckLayerTilePrefix
} from "./deck-layer-registry";

class DeckStub implements DeckLike {
    readonly commits: DeckLayerLike[][] = [];

    setProps(props: Parameters<DeckLike['setProps']>[0]): void {
        this.commits.push((props.layers ?? []) as DeckLayerLike[]);
    }
}

describe("DeckLayerRegistry", () => {
    it("builds deterministic layer keys from parts", () => {
        const key = makeDeckLayerKey({
            tileKey: "Island-6/Lane/42",
            styleId: "default",
            hoverMode: "base",
            kind: "path"
        });
        expect(key).toBe("Island-6/Lane/42/default/base/path");
    });

    it("upserts layers and flushes a deterministic order", () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);

        registry.upsert("tile-2/style-1/path", {id: "path-layer"});
        registry.upsert("tile-1/style-1/point", {id: "point-layer"});
        registry.flush();

        expect(deck.commits).toHaveLength(1);
        expect(deck.commits[0].map(layer => layer.id)).toEqual([
            "point-layer",
            "path-layer",
        ]);
    });

    it("removes layers by prefix and commits the reduced set", () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);

        registry.upsert("tile-a/style/path", {id: "a-path"});
        registry.upsert("tile-a/style/label", {id: "a-label"});
        registry.upsert("tile-b/style/path", {id: "b-path"});
        registry.flush();

        const removed = registry.removeByPrefix(makeDeckLayerTilePrefix("tile-a"));
        registry.flush();

        expect(removed).toBe(2);
        expect(registry.size).toBe(1);
        expect(deck.commits).toHaveLength(2);
        expect(deck.commits[1].map(layer => layer.id)).toEqual(["b-path"]);
    });

    it("batches multiple mutations into one scheduled commit", () => {
        const deck = new DeckStub();
        const scheduled: Array<() => void> = [];
        const schedule = (cb: () => void) => {
            scheduled.push(cb);
            return scheduled.length - 1;
        };
        const cancel = vi.fn();

        const registry = new DeckLayerRegistry(deck, schedule, cancel);
        registry.upsert("k1", {id: "l1"});
        registry.upsert("k2", {id: "l2"});
        registry.remove("k1");

        expect(deck.commits).toHaveLength(0);
        expect(scheduled).toHaveLength(1);

        scheduled[0]();

        expect(deck.commits).toHaveLength(1);
        expect(deck.commits[0].map(layer => layer.id)).toEqual(["l2"]);
        registry.destroy();
    });
});
