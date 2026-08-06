import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";

import {SceneMode} from "../../integrations/geo";
import {coreLib} from "../../integrations/wasm";
import {TileSubsetLayerVisualization} from
    "./tile-subset-layer.visualization";
import {
    deckSubsetInteractionProps,
    remapGltfPickContributions
} from "./deck-subset-picking";
import {DeckVariablePathOffsetExtension} from
    "./deck-variable-path-offset.extension";

function visualization(
    presentationKind: "regular" | "search" | "hover" | "selection",
    highlightMode: {value: number}
): TileSubsetLayerVisualization {
    const result = Object.create(
        TileSubsetLayerVisualization.prototype
    ) as TileSubsetLayerVisualization;
    Object.assign(result, {
        owner: {
            identity: {presentationKind},
            highlightMode
        }
    });
    return result;
}

describe("TileSubsetLayerVisualization picking integration", () => {
    it("makes only ordinary map layers eligible for drill picking", () => {
        expect(deckSubsetInteractionProps(
            "regular",
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            SceneMode.SCENE3D
        )).toEqual({
            pickable: "3d",
            drillPickEligible: true
        });
        expect(deckSubsetInteractionProps(
            "search",
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            SceneMode.SCENE3D
        )).toEqual({
            pickable: "3d",
            drillPickEligible: false
        });
        expect(deckSubsetInteractionProps(
            "selection",
            coreLib.HighlightMode.SELECTION_HIGHLIGHT.value,
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            SceneMode.SCENE3D
        )).toEqual({
            pickable: false,
            drillPickEligible: false
        });
    });

    it("does not reapply interaction materials to hover or selection subsets", () => {
        const overlay = {
            id: "selection",
            targets: [],
            effect: {
                tintMix: 1,
                opacity: 1,
                edgeWidth: 2,
                haloRadius: 0,
                haloOpacity: 0,
                stripeSpacing: 0,
                stripeWidth: 0,
                stripeOpacity: 0,
                stripeAngle: 45,
                stripeOffset: 0,
                stripeSoftness: 1
            },
            order: 1
        };
        for (const kind of ["hover", "selection"] as const) {
            const target = visualization(
                kind,
                kind === "hover"
                    ? coreLib.HighlightMode.HOVER_HIGHLIGHT
                    : coreLib.HighlightMode.SELECTION_HIGHLIGHT
            ) as any;
            target.refreshInteractionOverlays = vi.fn();

            target.setInteractionOverlays([overlay]);

            expect(target.interactionOverlays).toEqual([]);
            expect(target.refreshInteractionOverlays).toHaveBeenCalledOnce();
        }
    });

    it("exposes path identity and centerline anchors on subset layers", () => {
        const target = visualization(
            "regular",
            coreLib.HighlightMode.NO_HIGHLIGHT
        ) as any;
        const positions = new Float32Array([
            0, 0, 0,
            10, 0, 0
        ]);
        const startIndices = new Uint32Array([0, 2]);
        const resolver = vi.fn();
        const layer = target.pathLayer(
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
            {pickable: "3d", drillPickEligible: true}
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

    it("isolates transition vectors behind the one-location offset extension", () => {
        const target = visualization(
            "regular",
            coreLib.HighlightMode.NO_HIGHLIGHT
        ) as any;
        const layer = target.pathLayer(
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
            {pickable: "3d", drillPickEligible: true}
        );

        expect(layer.props.extensions).toHaveLength(2);
        expect((layer.props.extensions?.[0] as any).opts).toMatchObject({
            dash: true,
            offset: false
        });
        expect(layer.props.extensions?.[1]).toBeInstanceOf(
            DeckVariablePathOffsetExtension);
    });

    it("keeps shared GLTF proxy addresses bound to their owning subset", () => {
        const firstResolver = vi.fn(() => [{
            mapTileKey: "map/tile-a",
            featureId: "a"
        }]);
        const secondResolver = vi.fn(() => [{
            mapTileKey: "map/tile-b",
            featureId: "b"
        }]);
        const remapped = remapGltfPickContributions([
            {
                sourceId: "first",
                data: [{
                    nodeIndex: 1,
                    featureAddress: 7,
                    positions: new Float32Array(9)
                }],
                pickResolver: firstResolver
            },
            {
                sourceId: "second",
                data: [{
                    nodeIndex: 2,
                    featureAddress: 7,
                    positions: new Float32Array(9)
                }],
                pickResolver: secondResolver
            }
        ]);

        expect(remapped.contributions.map(
            contribution => contribution.data[0].featureAddress
        )).toEqual([0, 1]);
        expect(remapped.pickResolver(0)[0].featureId).toBe("a");
        expect(remapped.pickResolver(1)[0].featureId).toBe("b");
        expect(firstResolver).toHaveBeenCalledWith(7);
        expect(secondResolver).toHaveBeenCalledWith(7);
    });

    it("indexes locally retained interaction targets by terminal scope", () => {
        const target = visualization(
            "regular",
            coreLib.HighlightMode.NO_HIGHLIGHT
        ) as any;
        target.interactionTargetKeys = new Set();
        target.interactionScopesByTarget = new Map();
        target.states = [{mapTileKey: "map/layer/42"}];
        target.pickResults = [
            {subsetOrdinal: 0, featureId: "Feature.1"},
            {
                subsetOrdinal: 0,
                featureId: "Feature.2",
                attributeIndex: 3,
                hasValidity: true,
                validityIndex: 1
            },
            {
                subsetOrdinal: 0,
                featureId: "Feature.3",
                relationSourceFeatureId: "Feature.4",
                relationIndex: 2
            },
            {
                subsetOrdinal: 0,
                featureId: "Group.1",
                memberFeatureIds: ["Feature.5", "Feature.6"]
            }
        ];
        target.interactionSource = {
            paths: [{featureAddressesByPath: new Uint32Array([0, 1, 2, 3])}],
            arrows: [],
            points: [],
            surfaces: [],
            labels: [],
            gltf: null
        };

        target.rebuildInteractionTargetIndex();

        expect(target.hasLocalInteractionTarget({
            mapTileKey: "map/layer/42",
            featureId: "Feature.1"
        }, "feature")).toBe(true);
        const validity = {
            mapTileKey: "map/layer/42",
            featureId: "Feature.2:attribute#3:validity#1"
        };
        expect(target.hasLocalInteractionTarget(validity, "attribute")).toBe(true);
        expect(target.hasLocalInteractionTarget(validity, "feature")).toBe(false);
        expect(target.hasLocalInteractionTarget({
            mapTileKey: "map/layer/42",
            featureId: "Feature.4:relation#2"
        }, "relation")).toBe(true);
        expect(target.hasLocalInteractionTarget({
            mapTileKey: "map/layer/42",
            featureId: "Feature.5"
        }, "group")).toBe(true);
    });

    it("preserves absolute pixel offsets when interaction width changes", () => {
        const target = visualization(
            "regular",
            coreLib.HighlightMode.NO_HIGHLIGHT
        ) as any;
        target.matchesInteractionAddress = () => true;
        const source = {
            length: 1,
            billboard: false,
            depthTest: true,
            coordinateOrigin: [11, 48, 0],
            startIndices: new Uint32Array([0, 2]),
            featureAddressesByPath: new Uint32Array([0]),
            attributes: {
                getPath: {
                    value: new Float32Array([0, 0, 0, 10, 0, 0]),
                    size: 3
                },
                instanceColors: {
                    value: new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]),
                    size: 4
                },
                instanceStrokeWidths: {
                    value: new Float32Array([4, 4]),
                    size: 1
                },
                instanceOffsets: {
                    value: new Float32Array([0.75, 0.75]),
                    size: 1
                }
            }
        };

        const highlighted = target.interactionPathData(
            source,
            null,
            {
                tintMix: 0,
                opacity: 1,
                edgeWidth: 2,
                haloRadius: 0,
                haloOpacity: 0,
                stripeSpacing: 0,
                stripeWidth: 0,
                stripeOpacity: 0,
                stripeAngle: 45,
                stripeOffset: 0,
                stripeSoftness: 1
            }
        );

        expect([...highlighted.attributes.instanceStrokeWidths.value])
            .toEqual([6, 6]);
        expect([...highlighted.attributes.instanceOffsets.value])
            .toEqual([0.5, 0.5]);
    });

    it("feeds authored path width and semantic identity into the shared GPU mask", () => {
        const target = visualization(
            "regular",
            coreLib.HighlightMode.NO_HIGHLIGHT
        ) as any;
        target.matchesInteractionAddress = () => true;
        const source = {
            length: 1,
            billboard: false,
            depthTest: true,
            coordinateOrigin: [11, 48, 0],
            startIndices: new Uint32Array([0, 2]),
            featureAddressesByPath: new Uint32Array([7]),
            attributes: {
                getPath: {
                    value: new Float32Array([0, 0, 0, 10, 0, 0]),
                    size: 3
                },
                instanceColors: {
                    value: new Uint8Array([10, 20, 30, 255, 10, 20, 30, 255]),
                    size: 4
                },
                instanceStrokeWidths: {
                    value: new Float32Array([4, 4]),
                    size: 1
                },
                instanceOffsets: {
                    value: new Float32Array([0.75, 0.75]),
                    size: 1
                }
            }
        };
        const identityColor = vi.fn(() => [17, 34, 51, 255]);

        const mask = target.interactionPathMaskData(
            source,
            null,
            identityColor
        );

        expect([...mask.attributes.instanceStrokeWidths.value]).toEqual([4, 4]);
        expect([...mask.attributes.instanceOffsets.value]).toEqual([0.75, 0.75]);
        expect([...mask.attributes.instancePickingColors.value])
            .toEqual([17, 34, 51, 17, 34, 51]);
        expect(identityColor).toHaveBeenCalledOnce();
        expect(identityColor).toHaveBeenCalledWith(7);
    });

    it("builds a stable feature-id mask for polygon and mesh surface triangles", () => {
        const target = visualization(
            "regular",
            coreLib.HighlightMode.NO_HIGHLIGHT
        ) as any;
        target.matchesInteractionAddress = () => true;
        // Two separately emitted triangles model mapget Mesh input. Their
        // duplicated diagonal endpoints must still cancel geometrically.
        const source = {
            length: 2,
            depthTest: true,
            coordinateOrigin: [11, 48, 0],
            startIndices: new Uint32Array([0, 3, 6]),
            featureAddresses: new Uint32Array([7, 7]),
            attributes: {
                getPolygon: {
                    value: new Float32Array([
                        0, 0, 0,
                        1, 0, 0,
                        1, 1, 0,
                        0, 0, 0,
                        1, 1, 0,
                        0, 1, 0
                    ]),
                    size: 3
                },
                indices: {
                    value: new Uint32Array([0, 1, 2, 3, 4, 5]),
                    size: 1
                },
                fillColors: {
                    value: new Uint8Array([
                        255, 0, 0, 255,
                        255, 0, 0, 255,
                        255, 0, 0, 255,
                        255, 0, 0, 255,
                        255, 0, 0, 255,
                        255, 0, 0, 255
                    ]),
                    size: 4
                }
            }
        };
        const identityColor = vi.fn(() => [17, 0, 0, 255]);
        const mask = target.interactionSurfaceMaskData(
            source,
            null,
            identityColor
        );

        expect(mask.length).toBe(2);
        expect([...mask.startIndices]).toEqual([0, 3, 6]);
        expect([...mask.attributes.indices.value]).toEqual([0, 1, 2, 3, 4, 5]);
        expect([...mask.attributes.getPolygon.value])
            .toEqual([...source.attributes.getPolygon.value]);
        expect([...mask.attributes.fillColors.value])
            .toEqual([...source.attributes.fillColors.value]);
        expect([...mask.attributes.pickingColors.value])
            .toEqual(new Array(6).fill([17, 0, 0, 255]).flat());
        expect(identityColor).toHaveBeenCalledTimes(2);
        expect(identityColor).toHaveBeenNthCalledWith(1, 7);
        expect(identityColor).toHaveBeenNthCalledWith(2, 7);
    });
});
