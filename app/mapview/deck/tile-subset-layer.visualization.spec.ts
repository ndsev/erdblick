import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";

import {SceneMode} from "../../integrations/geo";
import {coreLib} from "../../integrations/wasm";
import {
    deckSubsetInteractionProps,
    remapGltfPickContributions
} from "./deck-subset-picking";

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
