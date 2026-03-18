import {describe, expect, it, vi} from "vitest";
import {DeckLayerLike, DeckLayerRegistry, DeckLike} from "./deck-layer-registry";
import {DeckTileVisualization} from "./deck-tile.visualization.model";
import {PointMergeService} from "../pointmerge.service";
import {coreLib} from "../../integrations/wasm";
import {FeatureTile} from "../../mapdata/features.model";

class DeckStub implements DeckLike {
    readonly commits: DeckLayerLike[][] = [];

    setProps(props: { layers: DeckLayerLike[] }): void {
        this.commits.push(props.layers);
    }
}

function makeStyle(overrides: Record<string, unknown> = {}): any {
    return {
        name: () => "test-style",
        isDeleted: () => false,
        hasExplicitLowFidelityRules: () => false,
        hasRelationRules: () => false,
        ...overrides
    };
}

function attachDeckVisualizationStatics<T extends (...args: never[]) => unknown>(ctor: T): T {
    return Object.assign(ctor, {
        GEOMETRY_OUTPUT_ALL: () => 0,
        GEOMETRY_OUTPUT_NON_POINTS_ONLY: () => 1,
        GEOMETRY_OUTPUT_POINTS_ONLY: () => 2
    });
}

function emptyRenderResult(): any {
    return {
        pointWorld: {
            positions: new Float32Array(),
            colors: new Uint8Array(),
            radii: new Float32Array(),
            featureAddresses: new Uint32Array()
        },
        pointBillboard: {
            positions: new Float32Array(),
            colors: new Uint8Array(),
            radii: new Float32Array(),
            featureAddresses: new Uint32Array()
        },
        surface: {
            positions: new Float32Array(),
            startIndices: new Uint32Array([0]),
            colors: new Uint8Array(),
            featureAddresses: new Uint32Array()
        },
        pathWorld: {
            positions: new Float32Array(),
            startIndices: new Uint32Array([0]),
            colors: new Uint8Array(),
            widths: new Float32Array(),
            featureAddresses: new Uint32Array(),
            dashArrays: new Float32Array()
        },
        pathBillboard: {
            positions: new Float32Array(),
            startIndices: new Uint32Array([0]),
            colors: new Uint8Array(),
            widths: new Float32Array(),
            featureAddresses: new Uint32Array(),
            dashArrays: new Float32Array()
        },
        arrowWorld: {
            positions: new Float32Array(),
            startIndices: new Uint32Array([0]),
            colors: new Uint8Array(),
            widths: new Float32Array(),
            featureAddresses: new Uint32Array()
        },
        arrowBillboard: {
            positions: new Float32Array(),
            startIndices: new Uint32Array([0]),
            colors: new Uint8Array(),
            widths: new Float32Array(),
            featureAddresses: new Uint32Array()
        },
        coordinateOrigin: new Float64Array([0, 0, 0]),
        lowFiBundles: [],
        mergedPointFeatures: {}
    };
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
            highestLoadedStage: () => 1,
            peekAsync: async () => undefined,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle();
        const pointMergeService = new PointMergeService();

        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
            {value: 0} as any
        ) as any;

        visu.renderWasm = async () => [{
            length: 1,
            coordinateOrigin: [11, 48, 0] as [number, number, number],
            startIndices: new Uint32Array([0, 2]),
            billboard: false,
            featureAddressesByPath: [null],
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

    it("renders arrows as a dedicated deck path layer", async () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            hasData: () => true,
            highestLoadedStage: () => 1,
            peekAsync: async () => undefined,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle();
        const pointMergeService = new PointMergeService();

        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
            {value: 0} as any
        ) as any;

        visu.renderWasm = async function() {
            this.latestArrowLayerData = [{
                length: 1,
                billboard: false,
                coordinateOrigin: [11, 48, 0],
                startIndices: new Uint32Array([0, 3]),
                featureAddressesByPath: [123],
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
            }];
            return [{
                length: 1,
                coordinateOrigin: [11, 48, 0] as [number, number, number],
                startIndices: new Uint32Array([0, 2]),
                billboard: false,
                featureAddressesByPath: [123],
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
            }];
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

    it("renders polygon and mesh output as a dedicated deck surface layer", async () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const tile = {
            mapTileKey: "Island-6-Local/Road/42",
            layerName: "Road",
            tileId: 42n,
            hasData: () => true,
            highestLoadedStage: () => 1,
            peekAsync: async () => undefined,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle();
        const pointMergeService = new PointMergeService();

        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
            {value: 0} as any
        ) as any;

        visu.renderWasm = async function() {
            this.latestSurfaceLayerData = [{
                length: 2,
                coordinateOrigin: [11, 48, 0],
                startIndices: new Uint32Array([0, 3, 6]),
                featureAddresses: new Uint32Array([10, 11]),
                attributes: {
                    getPolygon: {
                        value: new Float32Array([
                            0, 0, 0,
                            1, 0, 0,
                            0, 1, 0,
                            2, 0, 0,
                            3, 0, 0,
                            2, 1, 0
                        ]),
                        size: 3
                    },
                    fillColors: {
                        value: new Uint8Array([
                            255, 0, 0, 255,
                            255, 0, 0, 255,
                            255, 0, 0, 255,
                            0, 128, 255, 255,
                            0, 128, 255, 255,
                            0, 128, 255, 255
                        ]),
                        size: 4
                    }
                }
            }];
            return [];
        };

        const rendered = await visu.render({
            renderer: "deck",
            scene: {layerRegistry: registry}
        });
        registry.flush();

        expect(rendered).toBe(true);
        expect(deck.commits).toHaveLength(1);
        expect(deck.commits[0]).toHaveLength(1);
        expect(deck.commits[0][0].id).toContain("/surface");
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
            highestLoadedStage: () => 0,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle();
        const pointMergeService = new PointMergeService();

        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
            {value: 0} as any
        ) as any;

        visu.renderWasm = async () => [];
        visu.renderWasmOnMainThread = async () => ({
            pathLayerData: [],
            pointLayerData: [],
            arrowLayerData: [],
            lowFiBundles: [],
            mergedPointFeatures: null,
            vertexCount: 0,
            workerTimings: null
        });

        await visu.render({renderer: "deck", scene: {layerRegistry: registry}});
        expect(visu.isDirty()).toBe(false);

        hasData = true;
        tile.numFeatures = 12;
        expect(visu.isDirty()).toBe(true);

        await visu.render({renderer: "deck", scene: {layerRegistry: registry}});
        expect(visu.isDirty()).toBe(false);
    });

    it("in low-fidelity mode does not track per-stage version bumps", async () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            numFeatures: 2,
            dataVersion: 10,
            hasData: () => true,
            highestLoadedStage: () => 2,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle({
            minimumStage: () => 0
        });
        const pointMergeService = new PointMergeService();

        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            false,
            null,
            {value: 0} as any
        ) as any;

        visu.renderWasm = async () => [{
            length: 1,
            coordinateOrigin: [11, 48, 0] as [number, number, number],
            startIndices: new Uint32Array([0, 2]),
            billboard: false,
            featureAddressesByPath: [null],
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
        }];

        await visu.render({renderer: "deck", scene: {layerRegistry: registry}});
        expect(visu.isDirty()).toBe(false);
    });

    it("in high-fidelity mode tracks newly loaded stages", async () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        let highestLoadedStage = 0;
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            numFeatures: 2,
            hasData: () => true,
            highestLoadedStage: () => highestLoadedStage,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle({
            minimumStage: () => 0
        });
        const pointMergeService = new PointMergeService();

        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
            {value: 0} as any
        ) as any;

        visu.renderWasm = async () => [{
            length: 1,
            coordinateOrigin: [11, 48, 0] as [number, number, number],
            startIndices: new Uint32Array([0, 2]),
            billboard: false,
            featureAddressesByPath: [null],
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
        }];

        await visu.render({renderer: "deck", scene: {layerRegistry: registry}});
        expect(visu.isDirty()).toBe(false);

        highestLoadedStage = 1;
        expect(visu.isDirty()).toBe(true);
    });

    it("does not upsert deck geometry layers when no geometry is available", async () => {
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
        const style = makeStyle();
        const pointMergeService = new PointMergeService();

        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
            {value: 0} as any
        ) as any;

        visu.renderWasm = async () => [];
        visu.renderWasmOnMainThread = async () => ({
            pathLayerData: [],
            pointLayerData: [],
            arrowLayerData: [],
            lowFiBundles: [],
            mergedPointFeatures: null,
            vertexCount: 0,
            workerTimings: null
        });

        await visu.render({renderer: "deck", scene: {layerRegistry: registry}});
        registry.flush();

        expect(deck.commits).toHaveLength(0);
        expect(registry.size).toBe(0);
    });

    it("records render-time samples in tile stats using legacy-compatible keys", async () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            hasData: () => true,
            highestLoadedStage: () => 1,
            peekAsync: async () => undefined,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle();
        const pointMergeService = new PointMergeService();

        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
            {value: 0} as any
        ) as any;

        visu.renderWasm = async () => [];

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
            highestLoadedStage: () => 1,
            peekAsync: async () => undefined,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle();
        const pointMergeService = new PointMergeService();

        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
            {value: 0} as any
        ) as any;

        visu.renderWasm = async function() {
            this.latestWorkerTimings = {
                deserializeMs: 3.5,
                renderMs: 7.25,
                totalMs: 11.75
            };
            return [];
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
        const style = makeStyle();
        const pointMergeService = new PointMergeService();
        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
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
                255, 228, 181, 255,
                1, 2, 3, 4,
                1, 2, 3, 4
            ]),
            widths: new Float32Array([3, 3, 7, 7]),
            featureAddresses: new Uint32Array([101, 202]),
            dashArrays: new Float32Array([6, 2, 6, 2, 1, 0, 1, 0])
        }, false);

        expect(pathData).toHaveLength(1);
        expect(pathData[0].billboard).toBe(false);
        expect(Array.from(pathData[0].featureAddressesByPath as Uint32Array)).toEqual([101, 202]);
        expect(Array.from(pathData[0].attributes.instanceColors.value.slice(0, 8))).toEqual([
            255, 228, 181, 255,
            255, 228, 181, 255
        ]);
        expect(Array.from(pathData[0].attributes.instanceColors.value.slice(8, 16))).toEqual([
            1, 2, 3, 4,
            1, 2, 3, 4
        ]);
        expect(Array.from(pathData[0].attributes.instanceStrokeWidths.value)).toEqual([3, 3, 7, 7]);
        expect(Array.from(pathData[0].attributes.instanceDashArrays.value)).toEqual([
            6, 2, 6, 2,
            1, 0, 1, 0
        ]);
    });

    it("derives screen-space arrow markers from arrow path data", () => {
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            hasData: () => true,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle();
        const pointMergeService = new PointMergeService();
        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
            {value: 0} as any
        ) as any;

        const arrowPathData = {
            length: 1,
            coordinateOrigin: [11, 48, 0] as [number, number, number],
            startIndices: new Uint32Array([0, 3]),
            featureAddressesByPath: [123],
            attributes: {
                getPath: {
                    value: new Float32Array([
                        0, 0, 0,
                        10, 20, 0,
                        20, 0, 0
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
                    value: new Float32Array([3, 3, 3]),
                    size: 1
                },
                instanceDashArrays: {
                    value: new Float32Array([1, 0, 1, 0, 1, 0]),
                    size: 2
                }
            }
        };

        const markers = visu.buildArrowMarkers(arrowPathData);
        expect(markers).toHaveLength(1);
        expect(markers[0].featureAddress).toBe(123);
        expect(markers[0].sizePx).toBe(12);
        expect(Number.isFinite(markers[0].angleDeg)).toBe(true);
        expect(markers[0].position).toEqual([10, 20, 0]);
    });

    it("maps raw WASM point buffers into scatterplot attributes", () => {
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            hasData: () => true,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle();
        const pointMergeService = new PointMergeService();
        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            null,
            {value: 0} as any
        ) as any;

        const pointData = visu.buildPointLayerData({
            coordinateOrigin: new Float64Array([11, 48, 0]),
            positions: new Float32Array([
                0, 0, 0,
                10, 20, 0
            ]),
            colors: new Uint8Array([
                255, 128, 0, 255,
                32, 196, 255, 200
            ]),
            radii: new Float32Array([4, 6]),
            featureAddresses: new Uint32Array([101, 0xffffffff])
        }, false);

        expect(pointData).toHaveLength(1);
        expect(pointData[0].billboard).toBe(false);
        expect(pointData[0].length).toBe(2);
        expect(pointData[0].coordinateOrigin).toEqual([11, 48, 0]);
        expect(Array.from(pointData[0].featureAddresses as Uint32Array)).toEqual([101, 0xffffffff]);
        expect(Array.from(pointData[0].attributes.getPosition.value)).toEqual([0, 0, 0, 10, 20, 0]);
        expect(Array.from(pointData[0].attributes.getFillColor.value)).toEqual([255, 128, 0, 255, 32, 196, 255, 200]);
        expect(Array.from(pointData[0].attributes.getRadius.value)).toEqual([4, 6]);
    });

    it("treats a switch to an empty low-fi bundle selection as pending", () => {
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            numFeatures: 1,
            hasData: () => true,
            highestLoadedStage: () => 0,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle({
            hasExplicitLowFidelityRules: () => true
        });
        const pointMergeService = new PointMergeService();
        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            0,
            false,
            0
        ) as any;

        visu.rendered = true;
        visu.activeRenderedFidelity = "low";
        visu.activeRenderedLowFiLods = [1];
        visu.lowFiBundleByLod.clear();

        expect(visu.hasPendingLowFiSwitch()).toBe(true);
    });

    it("does not apply a cached low-fi switch when the requested selection is empty", () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            numFeatures: 1,
            hasData: () => true,
            highestLoadedStage: () => 0,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle({
            hasExplicitLowFidelityRules: () => true
        });
        const pointMergeService = new PointMergeService();
        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            0,
            false,
            0
        ) as any;

        visu.rendered = true;
        visu.activeRenderedFidelity = "low";
        visu.activeRenderedLowFiLods = [1];
        visu.lowFiBundleByLod.clear();
        visu.clearMergedPointVisualizations = () => {};
        visu.completeRender = vi.fn();
        visu.applyLowFiBundleDataToRegistry = vi.fn();

        const switched = visu.tryApplyCachedLowFiSwitch(
            {renderer: "deck", scene: {layerRegistry: registry}},
            registry,
            "low"
        );

        expect(switched).toBe(false);
        expect(visu.applyLowFiBundleDataToRegistry).not.toHaveBeenCalled();
        expect(visu.completeRender).not.toHaveBeenCalled();
    });

    it("keeps the active low-fi render when a requested high-fi render returns empty", async () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            numFeatures: 1,
            dataVersion: 1,
            hasData: () => true,
            highestLoadedStage: () => 1,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle({
            hasExplicitLowFidelityRules: () => true
        });
        const pointMergeService = new PointMergeService();
        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            0
        ) as any;

        visu.rendered = true;
        visu.activeRenderedFidelity = "low";
        visu.activeRenderedLowFiLods = [0];
        visu.clearMergedPointVisualizations = vi.fn();
        visu.applyLayerDataToRegistry = vi.fn();
        visu.renderWasm = async () => [];

        const rendered = await visu.render({
            renderer: "deck",
            scene: {layerRegistry: registry}
        });

        expect(rendered).toBe(true);
        expect(visu.clearMergedPointVisualizations).not.toHaveBeenCalled();
        expect(visu.applyLayerDataToRegistry).not.toHaveBeenCalled();
        expect(visu.activeRenderedFidelity).toBe("high");
    });

    it("becomes dirty when tile data changes without changing the feature count", () => {
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            tileId: 42n,
            numFeatures: 1,
            dataVersion: 1,
            hasData: () => true,
            highestLoadedStage: () => 1,
            stats: new Map<string, number[]>()
        } as any;
        const style = makeStyle({
            hasExplicitLowFidelityRules: () => true
        });
        const pointMergeService = new PointMergeService();
        const visu = new DeckTileVisualization(
            0,
            tile,
            pointMergeService,
            style,
            "",
            1,
            true,
            0
        ) as any;

        visu.rendered = true;
        visu.hadTileDataAtLastRender = true;
        visu.tileFeatureCountAtLastRender = 1;
        visu.tileDataVersionAtLastRender = 1;
        visu.lastSignature = visu.renderSignature();

        tile.dataVersion = 2;

        expect(visu.isDirty()).toBe(true);
    });

    it("does not add auxiliary tiles before locate on the main thread", async () => {
        const addedLayers: any[] = [];
        const fakeDeckVisualization = {
            addTileFeatureLayer: (layer: any) => addedLayers.push(layer),
            run: vi.fn(),
            renderResult: () => emptyRenderResult(),
            mergedPointFeatures: () => ({}),
            externalRelationReferences: () => [],
            processResolvedExternalReferences: vi.fn(),
            delete: vi.fn()
        };
        const deckVisualizationCtor = attachDeckVisualizationStatics(vi.fn(() => fakeDeckVisualization));
        const previousDeckVisualizationCtor = (coreLib as any).DeckFeatureLayerVisualization;
        const previousPeekMany = FeatureTile.peekMany;
        (coreLib as any).DeckFeatureLayerVisualization = deckVisualizationCtor;

        const baseLayer = {numVertices: () => 7};
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            mapName: "Island-6-Local",
            tileId: 42n,
            numFeatures: 1,
            hasData: () => true,
            highestLoadedStage: () => 1,
            peekAsync: async (callback: (layer: any) => Promise<any>) => await callback(baseLayer),
            stats: new Map<string, number[]>()
        } as any;
        FeatureTile.peekMany = vi.fn();

        try {
            const style = makeStyle({
                hasRelationRules: () => true
            });
            const pointMergeService = new PointMergeService();
            const visu = new DeckTileVisualization(
                0,
                tile,
                pointMergeService,
                style,
                "",
                1,
                true,
                null,
                coreLib.HighlightMode.SELECTION_HIGHLIGHT,
                [],
                "",
                false,
                {}
            ) as any;

            await visu.renderWasmOnMainThread("high", 0);

            expect(deckVisualizationCtor).toHaveBeenCalledOnce();
            expect(FeatureTile.peekMany).not.toHaveBeenCalled();
            expect(addedLayers).toEqual([baseLayer]);
        } finally {
            (coreLib as any).DeckFeatureLayerVisualization = previousDeckVisualizationCtor;
            FeatureTile.peekMany = previousPeekMany;
        }
    });

    it("loads and resolves unresolved external relation targets on the main thread", async () => {
        const addedLayers: any[] = [];
        let currentRequests = [{
            mapId: "Island-6-Local",
            typeId: "LaneGroup",
            featureId: ["laneGroupId", 123]
        }];
        const deckVisualization = {
            addTileFeatureLayer: (layer: any) => addedLayers.push(layer),
            run: vi.fn(),
            renderResult: () => emptyRenderResult(),
            mergedPointFeatures: () => ({}),
            externalRelationReferences: () => currentRequests,
            processResolvedExternalReferences: vi.fn(() => {
                currentRequests = [];
            }),
            delete: vi.fn()
        };
        const deckVisualizationCtor = attachDeckVisualizationStatics(
            vi.fn().mockImplementation(() => deckVisualization)
        );
        const previousDeckVisualizationCtor = (coreLib as any).DeckFeatureLayerVisualization;
        const previousPeekMany = FeatureTile.peekMany;
        (coreLib as any).DeckFeatureLayerVisualization = deckVisualizationCtor;

        const baseLayer = {numVertices: () => 7, key: "base"};
        const locatedLayer = {numVertices: () => 5, key: "located"};
        const tile = {
            mapTileKey: "Island-6-Local/Lane/42",
            layerName: "Lane",
            mapName: "Island-6-Local",
            tileId: 42n,
            numFeatures: 1,
            hasData: () => true,
            highestLoadedStage: () => 1,
            peekAsync: async (callback: (layer: any) => Promise<any>) => await callback(baseLayer),
            stats: new Map<string, number[]>()
        } as any;
        const locatedTile = {
            mapTileKey: "Island-6-Local/Lane/44",
            hasData: () => true
        } as any;
        FeatureTile.peekMany = vi.fn(async (tiles: any[], callback) => {
            const layers = tiles.map(() => locatedLayer);
            return await callback(layers);
        });

        try {
            const style = makeStyle({
                hasRelationRules: () => true
            });
            const pointMergeService = new PointMergeService();
            const relationExternalTileLoader = vi.fn(async () => ({
                responses: [[{
                    tileId: locatedTile.mapTileKey,
                    typeId: "LaneGroupCanonical",
                    featureId: ["laneGroupId", 987]
                }]],
                tiles: [locatedTile]
            }));
            const visu = new DeckTileVisualization(
                0,
                tile,
                pointMergeService,
                style,
                "",
                1,
                true,
                null,
                coreLib.HighlightMode.SELECTION_HIGHLIGHT,
                [],
                "",
                false,
                {},
                relationExternalTileLoader
            ) as any;

            await visu.renderWasmOnMainThread("high", 0);

            expect(deckVisualizationCtor).toHaveBeenCalledOnce();
            expect(relationExternalTileLoader).toHaveBeenCalledWith([{
                mapId: "Island-6-Local",
                typeId: "LaneGroup",
                featureId: ["laneGroupId", 123]
            }]);
            expect(deckVisualization.processResolvedExternalReferences).toHaveBeenCalledWith([[
                {
                    tileId: locatedTile.mapTileKey,
                    typeId: "LaneGroupCanonical",
                    featureId: ["laneGroupId", 987]
                }
            ]]);
            expect(addedLayers).toEqual([baseLayer, locatedLayer]);
        } finally {
            (coreLib as any).DeckFeatureLayerVisualization = previousDeckVisualizationCtor;
            FeatureTile.peekMany = previousPeekMany;
        }
    });
});
