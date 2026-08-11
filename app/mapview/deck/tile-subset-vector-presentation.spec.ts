import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";

import type {DeckLayerLike, DeckLike} from "./deck-layer-registry";
import {DeckLayerRegistry} from "./deck-layer-registry";
import {DeckRenderBufferArena} from "./deck-render-buffer-arena";
import {DeckVariablePathOffsetExtension} from
    "./deck-variable-path-offset.extension";
import {DeckZIndexExtension} from "./deck-z-index.extension";
import type {
    TileSubsetLayerRenderBuffers,
    TileSubsetPathBuffers,
    TileSubsetPointBuffers,
    TileSubsetSurfaceBuffers
} from "./tile-subset-layer-render.worker.protocol";
import {
    createTileSubsetPathLayer,
    createTileSubsetPointLayer,
    TileSubsetVectorPresentation
} from "./tile-subset-vector-presentation";

class DeckStub implements DeckLike {
    readonly commits: DeckLayerLike[][] = [];

    setProps(props: Parameters<DeckLike["setProps"]>[0]): void {
        this.commits.push((props.layers ?? []) as DeckLayerLike[]);
    }
}

const interaction = {
    pickable: "3d" as const,
    drillPickEligible: true
};

function emptyPointBuffers(): TileSubsetPointBuffers {
    return {
        positions: new Float32Array(),
        colors: new Uint8Array(),
        radii: new Float32Array(),
        zIndices: new Float64Array(),
        depthTests: new Uint8Array(),
        featureAddresses: new Uint32Array(),
        glowColors: new Uint8Array(),
        glowRadii: new Float32Array()
    };
}

function emptySurfaceBuffers(): TileSubsetSurfaceBuffers {
    return {
        positions: new Float32Array(),
        startIndices: new Uint32Array(),
        holeIndices: new Uint32Array(),
        holeIndexStarts: new Uint32Array(),
        colors: new Uint8Array(),
        zIndices: new Float64Array(),
        depthTests: new Uint8Array(),
        featureAddresses: new Uint32Array(),
        glowColors: new Uint8Array(),
        glowRadii: new Float32Array()
    };
}

function emptyPathBuffers(): TileSubsetPathBuffers {
    return {
        positions: new Float32Array(),
        startIndices: new Uint32Array(),
        colors: new Uint8Array(),
        widths: new Float32Array(),
        lateralOffsetsPx: new Float32Array(),
        lateralOffsetVectorsPx: new Float32Array(),
        lateralOffsetScaleThresholds: new Float32Array(),
        zIndices: new Float64Array(),
        depthTests: new Uint8Array(),
        featureAddresses: new Uint32Array(),
        glowColors: new Uint8Array(),
        glowRadii: new Float32Array()
    };
}

function pathBuffers(
    featureAddress: number,
    variableOffset = false
): TileSubsetPathBuffers {
    return {
        positions: new Float32Array([
            0, 0, 0,
            10, 0, 0
        ]),
        startIndices: new Uint32Array([0, 2]),
        colors: new Uint8Array([
            255, 0, 0, 255,
            255, 0, 0, 255
        ]),
        widths: new Float32Array([2, 2]),
        lateralOffsetsPx: new Float32Array([2, 4]),
        lateralOffsetVectorsPx: variableOffset
            ? new Float32Array([1, 2, 3, 4])
            : new Float32Array(),
        lateralOffsetScaleThresholds: new Float32Array([0.25]),
        zIndices: new Float64Array([Number.NaN]),
        depthTests: new Uint8Array([1]),
        featureAddresses: new Uint32Array([featureAddress]),
        glowColors: new Uint8Array([0, 0, 0, 0]),
        glowRadii: new Float32Array([0]),
        dashArrays: new Float32Array([4, 2, 4, 2])
    };
}

function renderBuffers(
    pathWorld = emptyPathBuffers()
): TileSubsetLayerRenderBuffers {
    const emptyGltf = {
        nodeIndices: new Uint32Array(),
        colors: new Uint8Array(),
        depthTests: new Uint8Array(),
        featureAddresses: new Uint32Array()
    };
    return {
        pointWorld: emptyPointBuffers(),
        pointBillboard: emptyPointBuffers(),
        labelWorld: [],
        labelBillboard: [],
        surface: emptySurfaceBuffers(),
        pathWorld,
        pathBillboard: emptyPathBuffers(),
        transitionPathWorld: emptyPathBuffers(),
        transitionPathBillboard: emptyPathBuffers(),
        arrowWorld: emptyPathBuffers(),
        arrowBillboard: emptyPathBuffers(),
        gltfNodes: emptyGltf,
        gltfPickProxies: {
            positions: new Float32Array(),
            startIndices: new Uint32Array(),
            nodeIndices: new Uint32Array(),
            featureAddresses: new Uint32Array()
        },
        coordinateOrigin: new Float64Array([11, 48, 0]),
        pickRefs: new Uint32Array(),
        pickResults: [],
        subsetVertexCounts: new Uint32Array(),
        vertexCount: 0,
        styleIssues: [],
        timings: {
            deserializeMs: 0,
            deserializeMsBySubset: [],
            renderMs: 0,
            totalMs: 0
        }
    };
}

function presentation(
    visualizationId: string,
    blockKey = visualizationId
): TileSubsetVectorPresentation {
    return new TileSubsetVectorPresentation({
        visualizationId,
        ownerId: "map/layer/style",
        presentationKind: "regular",
        styleOrder: 7,
        viewIndex: 0,
        blockKey
    });
}

describe("tile-subset vector layer factories", () => {
    it("exposes path identity and centerline anchors", () => {
        const positions = new Float32Array([
            0, 0, 0,
            10, 0, 0
        ]);
        const startIndices = new Uint32Array([0, 2]);
        const resolver = vi.fn();
        const layer = createTileSubsetPathLayer(
            "path",
            {
                length: 1,
                billboard: false,
                depthTest: true,
                coordinateOrigin: [11, 48, 0],
                startIndices,
                featureAddressesByPath: new Uint32Array([0]),
                attributes: {
                    getPath: {value: positions, size: 3},
                    instanceColors: {
                        value: new Uint8Array(8),
                        size: 4
                    },
                    instanceStrokeWidths: {
                        value: new Float32Array(2),
                        size: 1
                    },
                    instanceOffsets: {
                        value: new Float32Array(2),
                        size: 1
                    }
                }
            },
            resolver,
            null,
            interaction
        );

        expect(layer.props.pickable).toBe("3d");
        expect((layer.props as any).drillPickEligible).toBe(true);
        expect((layer.props as any).navigationAnchorEligible).toBe(true);
        expect((layer.props as any).markerAnchorEligible).toBe(true);
        expect((layer.props as any).subsetPickResolver).toBe(resolver);
        expect((layer.props as any).pathCenterline).toEqual({
            positions,
            startIndices,
            coordinateOrigin: [11, 48, 0]
        });
        expect(layer.props.extensions).toHaveLength(1);
        expect((layer.props.extensions?.[0] as any).opts).toMatchObject({
            dash: true,
            offset: true
        });
    });

    it("isolates transition vectors behind the variable-offset extension", () => {
        const layer = createTileSubsetPathLayer(
            "variable-path",
            {
                length: 1,
                billboard: false,
                depthTest: true,
                coordinateOrigin: [11, 48, 0],
                startIndices: new Uint32Array([0, 3]),
                featureAddressesByPath: new Uint32Array([0]),
                attributes: {
                    getPath: {value: new Float32Array(9), size: 3},
                    instanceColors: {value: new Uint8Array(12), size: 4},
                    instanceStrokeWidths: {
                        value: new Float32Array([2, 2, 2]),
                        size: 1
                    },
                    instanceOffsets: {
                        value: new Float32Array([1, 1.5, 2]),
                        size: 1
                    },
                    instanceVariableOffsets: {
                        value: new Uint32Array(12),
                        size: 4
                    }
                }
            },
            vi.fn(),
            null,
            interaction
        );

        expect(layer.props.extensions).toHaveLength(2);
        expect((layer.props.extensions?.[0] as any).opts).toMatchObject({
            dash: true,
            offset: false
        });
        expect(layer.props.extensions?.[1]).toBeInstanceOf(
            DeckVariablePathOffsetExtension);
    });

    it("exposes point positions as navigation and marker anchors", () => {
        const positions = new Float32Array([10, 20, 30]);
        const resolver = vi.fn();
        const layer = createTileSubsetPointLayer(
            "point",
            {
                length: 1,
                billboard: false,
                depthTest: true,
                coordinateOrigin: [11, 48, 0],
                featureAddresses: new Uint32Array([7]),
                attributes: {
                    getPosition: {value: positions, size: 3},
                    getFillColor: {
                        value: new Uint8Array([255, 255, 255, 255]),
                        size: 4
                    },
                    getRadius: {value: new Float32Array([4]), size: 1}
                }
            },
            resolver,
            null,
            interaction
        );

        expect(layer.props.pickable).toBe("3d");
        expect((layer.props as any).navigationAnchorEligible).toBe(true);
        expect((layer.props as any).markerAnchorEligible).toBe(true);
        expect((layer.props as any).anchorPositions).toBe(positions);
    });

    it("installs clip-space z-order only when compiled data requests it", () => {
        const layer = createTileSubsetPathLayer(
            "ordered-path",
            {
                length: 1,
                billboard: false,
                depthTest: true,
                coordinateOrigin: [11, 48, 0],
                startIndices: new Uint32Array([0, 2]),
                featureAddressesByPath: new Uint32Array([0]),
                zIndices: new Float64Array([7]),
                attributes: {
                    getPath: {value: new Float32Array(6), size: 3},
                    instanceColors: {value: new Uint8Array(8), size: 4},
                    instanceStrokeWidths: {
                        value: new Float32Array([2, 2]),
                        size: 1
                    },
                    instanceOffsets: {
                        value: new Float32Array(2),
                        size: 1
                    },
                    zIndexOffsets: {
                        value: new Float32Array([0.001, 0.001]),
                        size: 1
                    }
                }
            },
            vi.fn(),
            null,
            interaction
        );

        expect(layer.props.extensions?.at(-1)).toBeInstanceOf(
            DeckZIndexExtension);
    });
});

describe("TileSubsetVectorPresentation", () => {
    it("reconciles direct layers and cleans up a replaced registry", () => {
        const firstRegistry = new DeckLayerRegistry(null);
        const secondRegistry = new DeckLayerRegistry(null);
        const target = presentation("block-a");
        const request = {
            arena: null,
            result: renderBuffers(pathBuffers(4)),
            origin: [11, 48, 0] as [number, number, number],
            modelMatrix: null,
            interaction,
            pickResolver: vi.fn(() => [])
        };

        target.install({registry: firstRegistry, ...request});
        expect(firstRegistry.size).toBe(1);

        target.install({registry: secondRegistry, ...request});
        expect(firstRegistry.size).toBe(0);
        expect(secondRegistry.size).toBe(1);

        target.install({
            registry: secondRegistry,
            ...request,
            result: renderBuffers()
        });
        expect(secondRegistry.size).toBe(0);

        target.destroy();
        expect(secondRegistry.size).toBe(0);
    });

    it("merges arena paths without losing their owning pick resolvers", () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const arena = new DeckRenderBufferArena(registry, 100);
        const firstPick = [{mapTileKey: "map/a", featureId: "a"}];
        const secondPick = [{mapTileKey: "map/b", featureId: "b"}];
        const first = presentation("block-a", "tile-a");
        const second = presentation("block-b", "tile-b");

        first.install({
            registry,
            arena,
            result: renderBuffers(pathBuffers(7, true)),
            origin: [11, 48, 0],
            modelMatrix: null,
            interaction,
            pickResolver: local => local === 7 ? firstPick : []
        });
        second.install({
            registry,
            arena,
            result: renderBuffers(pathBuffers(7, true)),
            origin: [11, 48, 0],
            modelMatrix: null,
            interaction,
            pickResolver: local => local === 7 ? secondPick : []
        });
        registry.flush();

        expect(registry.size).toBe(1);
        expect(arena.debugSnapshot().contributions).toBe(2);
        const layer = deck.commits.at(-1)?.[0] as any;
        expect([...layer.props.data.featureAddressesByPath]).toEqual([0, 1]);
        expect(layer.props.data.offsetVectorsPx).toHaveLength(8);
        expect(layer.props.data.attributes.instanceDashArrays.value)
            .toHaveLength(8);
        expect(layer.props.subsetPickResolver(0)).toBe(firstPick);
        expect(layer.props.subsetPickResolver(1)).toBe(secondPick);

        first.destroy();
        registry.flush();
        expect(arena.debugSnapshot().contributions).toBe(1);
        const remaining = deck.commits.at(-1)?.[0] as any;
        expect([...remaining.props.data.featureAddressesByPath]).toEqual([0]);
        expect(remaining.props.subsetPickResolver(0)).toBe(secondPick);

        second.destroy();
        expect(registry.size).toBe(0);
    });

    it("replaces an arena contribution with one direct layer", () => {
        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);
        const arena = new DeckRenderBufferArena(registry, 100);
        const target = presentation("block-a", "tile-a");
        const request = {
            registry,
            result: renderBuffers(pathBuffers(3)),
            origin: [11, 48, 0] as [number, number, number],
            modelMatrix: null,
            interaction,
            pickResolver: vi.fn(() => [])
        };

        target.install({...request, arena});
        expect(arena.debugSnapshot().contributions).toBe(1);

        target.install({...request, arena: null});
        registry.flush();
        expect(arena.debugSnapshot().contributions).toBe(0);
        expect(registry.size).toBe(1);
        expect(deck.commits.at(-1)?.[0].id).not.toContain("subset-arena");

        target.destroy();
        expect(registry.size).toBe(0);
    });
});
