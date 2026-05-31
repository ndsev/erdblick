import {describe, expect, it} from "vitest";
import type {FeatureSearchStateEntry} from "../shared/feature-search-state";
import type {FeatureSearchResultEntry} from "./feature.search.service";
import {
    featureSearchDefinitionExport,
    featureSearchJsonReplacer,
    featureSearchResultsExport,
    safeFeatureSearchExportId
} from "./feature-search-export.util";

describe("feature search JSON export helpers", () => {
    it("exports only the current normalized definition fields", () => {
        const definition: FeatureSearchStateEntry = {
            id: "feature/search:1",
            query: "**.speed > 80",
            scope: "auto",
            autoUpdate: false,
            bookmarked: true,
            enabled: false,
            paused: true,
            showResultsOnMap: true,
            pinColor: "#ea4336",
            selectedMapLayers: [{mapId: "MapA", layerId: "LayerA"}],
            searchStyleRules: [],
            renderStrategy: {
                showLowFiDots: true,
                showBucketLabels: true,
                showHighFiGeometry: true,
                showHighFiResultDots: false,
                highFidelityMaxVisibleTiles: 512
            }
        };

        const exported = featureSearchDefinitionExport(definition);

        expect(Object.keys(exported)).toEqual([
            "id",
            "query",
            "scope",
            "autoUpdate",
            "bookmarked",
            "enabled",
            "paused",
            "showResultsOnMap",
            "pinColor",
            "selectedMapLayers",
            "searchStyleRules",
            "renderStrategy"
        ]);
        expect(exported.selectedMapLayers).toEqual([{mapId: "MapA", layerId: "LayerA"}]);
    });

    it("exports ungrouped result leaves with JSON-safe tile ids", () => {
        const exported = featureSearchResultsExport([result("Road.1", "MapA", "LayerA", 120n)], [], "");

        expect(exported.grouping).toEqual([]);
        expect(exported.filters.tree).toEqual({value: "", filterBy: "label", filterMode: "lenient"});
        expect(exported.tree).toEqual([
            expect.objectContaining({
                type: "result",
                label: "Road.1",
                result: expect.objectContaining({sourceTileId: "120"})
            })
        ]);
    });

    it("preserves grouping order and filtered group counts", () => {
        const exported = featureSearchResultsExport([
            result("Road.1", "MapA", "LayerA", 120n),
            result("Lane.1", "MapA", "LayerB", 121n),
            result("Road.2", "MapB", "LayerA", 122n)
        ], [
            {id: 3, name: "Features"},
            {id: 1, name: "Maps"}
        ], "MapA");

        expect(exported.grouping).toEqual([
            {id: 3, name: "Features"},
            {id: 1, name: "Maps"}
        ]);
        expect(exported.tree).toHaveLength(2);
        expect(exported.tree[0]).toMatchObject({
            type: "group",
            label: "Features: Road (1)",
            count: 1
        });
        expect(exported.tree[1]).toMatchObject({
            type: "group",
            label: "Features: Lane (1)",
            count: 1
        });
    });

    it("includes a full subtree when the group label matches", () => {
        const exported = featureSearchResultsExport([
            result("Road.1", "MapA", "LayerA", 120n),
            result("Lane.1", "MapA", "LayerB", 121n),
            result("Road.2", "MapB", "LayerA", 122n)
        ], [
            {id: 1, name: "Maps"},
            {id: 2, name: "Layers"}
        ], "Map: MapA");

        expect(exported.tree).toHaveLength(1);
        expect(exported.tree[0]).toMatchObject({
            type: "group",
            label: "Map: MapA (2)",
            count: 2
        });
    });

    it("serializes bigints and sanitizes file ids", () => {
        expect(JSON.stringify({sourceTileId: 42n}, featureSearchJsonReplacer))
            .toBe('{"sourceTileId":"42"}');
        expect(safeFeatureSearchExportId("feature/search:1")).toBe("feature_search_1");
    });
});

function result(
    featureId: string,
    mapId: string,
    layerId: string,
    sourceTileId: bigint
): FeatureSearchResultEntry {
    const resultKey = `${mapId}:${layerId}:${featureId}:${sourceTileId}`;
    return {
        label: featureId,
        mapId,
        layerId,
        featureId,
        resultIndex: 0,
        resultKey,
        mapTileKey: `${mapId}:${layerId}:${sourceTileId}`,
        sourceTileKey: `${mapId}:${layerId}:${sourceTileId}`,
        sourceMapId: mapId,
        sourceLayerId: layerId,
        sourceTileId,
        hoverFeatureId: featureId
    };
}
