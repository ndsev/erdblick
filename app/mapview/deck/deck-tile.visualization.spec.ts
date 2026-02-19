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

        visu.renderWasm = async () => ({
            length: 1,
            coordinateOrigin: [11, 48, 0] as [number, number, number],
            startIndices: new Uint32Array([0, 2]),
            featureIds: [null],
            featureIdsByVertex: [null, null],
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
                },
                instanceDashArrays: {
                    value: new Float32Array([1, 0]),
                    size: 2
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

    it("renders arrows as a dedicated deck path layer", async () => {
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

        visu.renderWasm = async function() {
            this.latestArrowLayerData = {
                length: 1,
                coordinateOrigin: [11, 48, 0],
                startIndices: new Uint32Array([0, 3]),
                featureIds: [123],
                featureIdsByVertex: [123, 123, 123],
                attributes: {
                    getPath: {
                        value: new Float32Array([
                            0, 0, 0,
                            1, 1, 0,
                            2, 0, 0
                        ]),
                        size: 3
                    },
                    instanceColors: {
                        value: new Uint8Array([
                            255, 0, 0, 255,
                            255, 0, 0, 255,
                            255, 0, 0, 255
                        ]),
                        size: 4
                    },
                    instanceStrokeWidths: {
                        value: new Float32Array([2, 2, 2]),
                        size: 1
                    },
                    instanceDashArrays: {
                        value: new Float32Array([1, 0, 1, 0, 1, 0]),
                        size: 2
                    }
                }
            };
            return {
                length: 1,
                coordinateOrigin: [11, 48, 0] as [number, number, number],
                startIndices: new Uint32Array([0, 2]),
                featureIds: [123],
                featureIdsByVertex: [123, 123],
                attributes: {
                    getPath: {
                        value: new Float32Array([11, 48, 0, 11.001, 48.001, 0]),
                        size: 3
                    },
                    instanceColors: {
                        value: new Uint8Array([32, 196, 255, 220, 32, 196, 255, 220]),
                        size: 4
                    },
                    instanceStrokeWidths: {
                        value: new Float32Array([2, 2]),
                        size: 1
                    },
                    instanceDashArrays: {
                        value: new Float32Array([1, 0, 1, 0]),
                        size: 2
                    }
                }
            };
        };

        const rendered = await visu.render({
            renderer: "deck",
            scene: {layerRegistry: registry}
        });
        registry.flush();

        expect(rendered).toBe(true);
        expect(deck.commits).toHaveLength(1);
        expect(deck.commits[0]).toHaveLength(2);
        expect(deck.commits[0][0].id).toContain("/path");
        expect(deck.commits[0][1].id).toContain("/arrow");
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

        visu.renderWasm = async () => null;
        visu.renderWasmOnMainThread = async () => null;

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

        visu.renderWasm = async () => null;
        visu.renderWasmOnMainThread = async () => null;

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

        visu.renderWasm = async () => null;

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

    it("uses worker timing samples for render and parse stats when available", async () => {
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

        visu.renderWasm = async function() {
            this.latestWorkerTimings = {
                deserializeMs: 3.5,
                renderMs: 7.25,
                totalMs: 11.75
            };
            return null;
        };

        await visu.render({
            renderer: "deck",
            scene: {layerRegistry: registry}
        });

        const renderSamples = tile.stats.get("Rendering/Basic/test-style#ms");
        expect(renderSamples).toBeDefined();
        expect(renderSamples!.length).toBe(1);
        expect(renderSamples![0]).toBe(11.75);

        const parseSamples = tile.stats.get("Rendering/Feature-Model-Parsing#ms");
        expect(parseSamples).toBeDefined();
        expect(parseSamples!.length).toBe(1);
        expect(parseSamples![0]).toBe(3.5);
    });

    it("maps raw WASM line style buffers without hardcoded fallback colors", () => {
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            hasData: () => true,
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

        const pathData = visu.buildPathLayerData({
            coordinateOrigin: new Float64Array([11, 48, 0]),
            positions: new Float32Array([
                11, 48, 0,
                11.001, 48.001, 0,
                11.01, 48.01, 0,
                11.02, 48.02, 0
            ]),
            startIndices: new Uint32Array([0, 2, 4]),
            colors: new Uint8Array([
                255, 228, 181, 255,
                1, 2, 3, 4
            ]),
            widths: new Float32Array([3, 7]),
            featureIds: new Uint32Array([101, 202]),
            dashArrays: new Float32Array([6, 2, 1, 0]),
            dashOffsets: new Float32Array([0, 0])
        });

        expect(pathData).toBeTruthy();
        expect(pathData!.featureIds).toEqual([101, 202]);
        expect(pathData!.featureIdsByVertex).toEqual([101, 101, 202, 202]);
        expect(Array.from(pathData!.attributes.instanceColors.value.slice(0, 8))).toEqual([
            255, 228, 181, 255,
            255, 228, 181, 255
        ]);
        expect(Array.from(pathData!.attributes.instanceColors.value.slice(8, 16))).toEqual([
            1, 2, 3, 4,
            1, 2, 3, 4
        ]);
        expect(Array.from(pathData!.attributes.instanceStrokeWidths.value)).toEqual([3, 3, 7, 7]);
        expect(Array.from(pathData!.attributes.instanceDashArrays.value)).toEqual([
            6, 2, 6, 2,
            1, 0, 1, 0
        ]);
    });
});
