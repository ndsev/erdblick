import {describe, expect, it} from "vitest";

import {
    createFeatureSearchStateEntry,
    defaultFeatureSearchViewIndicesForMapLayers,
    normalizeFeatureSearchState
} from "./feature-search-state";

describe("FeatureSearchState", () => {
    it("defaults selected map-layer intent to automatic", () => {
        const entry = createFeatureSearchStateEntry({query: "typeId == 'Road'"});

        expect(entry.selectedMapLayersManual).toBe(false);
    });

    it("preserves manual selected map-layer intent during normalization", () => {
        const [entry] = normalizeFeatureSearchState([{
            query: "typeId == 'Road'",
            selectedMapLayers: [{mapId: "Classic", layerId: "Lane"}],
            selectedMapLayersManual: true
        }]);

        expect(entry.selectedMapLayers).toEqual([{mapId: "Classic", layerId: "Lane"}]);
        expect(entry.selectedMapLayersManual).toBe(true);
    });

    it("normalizes selected feature types as a sorted unique filter list", () => {
        const [entry] = normalizeFeatureSearchState([{
            query: "typeId == 'Road'",
            selectedFeatureTypes: ["Lane", "", "Road", "Lane"]
        }]);

        expect(entry.selectedFeatureTypes).toEqual(["Lane", "Road"]);
    });

    it("defaults selected views from visible selected map layers", () => {
        const selectedMapLayers = [
            {mapId: "Classic", layerId: "Road"},
            {mapId: "Live", layerId: "Lane"}
        ];
        const visibleLayers = new Set([
            JSON.stringify([0, "Classic", "Road"]),
            JSON.stringify([1, "Live", "Lane"])
        ]);

        expect(defaultFeatureSearchViewIndicesForMapLayers(
            selectedMapLayers,
            2,
            (viewIndex, ref) => visibleLayers.has(JSON.stringify([viewIndex, ref.mapId, ref.layerId]))
        )).toEqual([0, 1]);
    });

    it("falls back to all current views when selected layers are hidden", () => {
        expect(defaultFeatureSearchViewIndicesForMapLayers(
            [{mapId: "Classic", layerId: "Road"}],
            2,
            () => false
        )).toEqual([0, 1]);
    });

    it("normalizes default selected views to the current view count", () => {
        expect(defaultFeatureSearchViewIndicesForMapLayers(
            [{mapId: "Classic", layerId: "Road"}],
            1,
            () => true
        )).toEqual([0]);
    });
});
