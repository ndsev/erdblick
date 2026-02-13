import {describe, expect, it} from "vitest";
import {DeckLayerLike, DeckLayerRegistry, DeckLike} from "./deck-layer-registry";
import {DeckTileVisualization} from "./deck-tile.visualization.model";

class DeckStub implements DeckLike {
    readonly commits: DeckLayerLike[][] = [];

    setProps(props: { layers: DeckLayerLike[] }): void {
        this.commits.push(props.layers);
    }
}

describe("DeckTileVisualization", () => {
    it("upserts and removes path layers via DeckLayerRegistry", async () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            hasData: () => true,
            peekAsync: async () => undefined
        } as any;
        const style = {
            name: () => "test-style",
            isDeleted: () => false
        } as any;

        const visu = new DeckTileVisualization(
            0,
            tile,
            style,
            true,
            {value: 0} as any
        ) as any;

        visu.extractPathData = async () => [{
            path: [[11, 48, 0], [11.001, 48.001, 0]],
            color: [32, 196, 255, 220],
            width: 2
        }];

        const rendered = await visu.render({
            renderer: "deck",
            scene: {layerRegistry: registry}
        });
        registry.flush();

        expect(rendered).toBe(true);
        expect(deck.commits).toHaveLength(1);
        expect(deck.commits[0]).toHaveLength(1);
        expect(deck.commits[0][0].id).toContain("/path");

        visu.destroy({
            renderer: "deck",
            scene: {layerRegistry: registry}
        });
        registry.flush();

        expect(deck.commits).toHaveLength(2);
        expect(deck.commits[1]).toHaveLength(0);
    });

    it("becomes dirty when tile data arrives after an initial empty render", async () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        let hasData = false;
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            numFeatures: 0,
            hasData: () => hasData
        } as any;
        const style = {
            name: () => "test-style",
            isDeleted: () => false
        } as any;

        const visu = new DeckTileVisualization(
            0,
            tile,
            style,
            true,
            {value: 0} as any
        );

        await visu.render({renderer: "deck", scene: {layerRegistry: registry}});
        expect(visu.isDirty()).toBe(false);

        hasData = true;
        tile.numFeatures = 12;
        expect(visu.isDirty()).toBe(true);

        await visu.render({renderer: "deck", scene: {layerRegistry: registry}});
        expect(visu.isDirty()).toBe(false);
    });

    it("does not emit placeholder label layers when no path geometry is available", async () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n
        } as any;
        const style = {
            name: () => "test-style",
            isDeleted: () => false
        } as any;

        const visu = new DeckTileVisualization(
            0,
            tile,
            style,
            true,
            {value: 0} as any
        );

        await visu.render({renderer: "deck", scene: {layerRegistry: registry}});
        registry.flush();

        expect(deck.commits).toHaveLength(0);
        expect(registry.size).toBe(0);
    });
});
