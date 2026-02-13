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
            peekAsync: async () => undefined,
            stats: new Map<string, number[]>()
        } as any;
        const style = {
            name: () => "test-style",
            isDeleted: () => false
        } as any;

        const visu = new DeckTileVisualization(
            0,
            tile,
            style,
            "",
            true,
            {value: 0} as any
        ) as any;

        visu.extractPathData = async () => ({
            length: 1,
            startIndices: new Uint32Array([0, 2]),
            attributes: {
                getPath: {
                    value: new Float32Array([11, 48, 0, 11.001, 48.001, 0]),
                    size: 3
                },
                instanceColors: {
                    value: new Uint8Array([32, 196, 255, 220]),
                    size: 4
                },
                instanceStrokeWidths: {
                    value: new Float32Array([2]),
                    size: 1
                }
            }
        });

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
            hasData: () => hasData,
            stats: new Map<string, number[]>()
        } as any;
        const style = {
            name: () => "test-style",
            isDeleted: () => false
        } as any;

        const visu = new DeckTileVisualization(
            0,
            tile,
            style,
            "",
            true,
            {value: 0} as any
        ) as any;

        visu.extractPathData = async () => null;
        visu.extractPathDataOnMainThread = async () => null;

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
            tileId: 42n,
            hasData: () => false,
            numFeatures: 0,
            stats: new Map<string, number[]>()
        } as any;
        const style = {
            name: () => "test-style",
            isDeleted: () => false
        } as any;

        const visu = new DeckTileVisualization(
            0,
            tile,
            style,
            "",
            true,
            {value: 0} as any
        ) as any;

        visu.extractPathData = async () => null;
        visu.extractPathDataOnMainThread = async () => null;

        await visu.render({renderer: "deck", scene: {layerRegistry: registry}});
        registry.flush();

        expect(deck.commits).toHaveLength(0);
        expect(registry.size).toBe(0);
    });

    it("records render-time samples in tile stats using Cesium-compatible keys", async () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            hasData: () => true,
            peekAsync: async () => undefined,
            stats: new Map<string, number[]>()
        } as any;
        const style = {
            name: () => "test-style",
            isDeleted: () => false
        } as any;

        const visu = new DeckTileVisualization(
            0,
            tile,
            style,
            "",
            true,
            {value: 0} as any
        ) as any;

        visu.extractPathData = async () => null;

        await visu.render({
            renderer: "deck",
            scene: {layerRegistry: registry}
        });

        const samples = tile.stats.get("Rendering/Basic/test-style#ms");
        expect(samples).toBeDefined();
        expect(samples!.length).toBe(1);
        expect(Number.isFinite(samples![0])).toBe(true);
        expect(samples![0]).toBeGreaterThanOrEqual(0);
    });
});
