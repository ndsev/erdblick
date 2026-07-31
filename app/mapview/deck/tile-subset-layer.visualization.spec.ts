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
});
