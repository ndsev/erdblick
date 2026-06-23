import {describe, expect, it} from "vitest";
import type {FeatureSearchMapLayerRef, FeatureSearchStateEntry} from "../shared/feature-search-state";
import type {FeatureSearchResultEntry} from "./feature.search.service";
import {
    featureSearchDefinitionFromImportPayload,
    featureSearchDefinitionExport,
    featureSearchExportFilename,
    featureSearchExportPayload,
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
            selectedTileLevels: [13],
            selectedViewIndices: [0, 1],
            searchStyleRules: [],
            renderStrategy: {
                showLowFiDots: true,
                showBucketLabels: true,
                showHighFiGeometry: true,
                showHighFiResultDots: false,
                highFidelityMaxVisibleTiles: 512,
                densityHeatGradient: false,
                densitySizeMultiplier: 1
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
            "selectedMapLayersManual",
            "selectedTileLevels",
            "selectedViewIndices",
            "searchStyleRules",
            "renderStrategy"
        ]);
        expect(exported.selectedMapLayers).toEqual([{mapId: "MapA", layerId: "LayerA"}]);
        expect(exported.selectedMapLayersManual).toBe(false);
        expect(exported.selectedTileLevels).toEqual([13]);
        expect(exported.selectedViewIndices).toEqual([0, 1]);
    });

    it("exports ungrouped result leaves with JSON-safe tile ids", () => {
        const exported = featureSearchResultsExport([result("Road.1", "MapA", "LayerA", 120n)], [], "");

        expect(exported.mapLayers).toEqual({
            activated: [{mapId: "MapA", layerId: "LayerA", label: "MapA/LayerA"}],
            exported: [{mapId: "MapA", layerId: "LayerA", label: "MapA/LayerA"}]
        });
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

    it("filters exported results by the selected active map layers", () => {
        const exported = featureSearchResultsExport([
            result("Road.1", "MapA", "LayerA", 120n),
            result("Lane.1", "MapA", "LayerB", 121n)
        ], [], "", [
            mapLayer("MapA", "LayerA"),
            mapLayer("MapA", "LayerB")
        ], [
            mapLayer("MapA", "LayerA")
        ]);

        expect(exported.mapLayers).toEqual({
            activated: [
                {mapId: "MapA", layerId: "LayerA", label: "MapA/LayerA"},
                {mapId: "MapA", layerId: "LayerB", label: "MapA/LayerB"}
            ],
            exported: [
                {mapId: "MapA", layerId: "LayerA", label: "MapA/LayerA"}
            ]
        });
        expect(exported.tree).toHaveLength(1);
        expect(exported.tree[0]).toMatchObject({
            type: "result",
            label: "Road.1"
        });
    });

    it("builds a combined export payload only when both categories are selected", () => {
        const definition = searchDefinition();
        const exported = featureSearchExportPayload(
            definition,
            [result("Road.1", "MapA", "LayerA", 120n)],
            [{id: 1, name: "Maps"}],
            "",
            {includeConfiguration: true, includeResults: true},
            definition.selectedMapLayers,
            definition.selectedMapLayers,
            "2026-06-01T00:00:00.000Z"
        );

        expect(exported).toMatchObject({
            exportedAt: "2026-06-01T00:00:00.000Z",
            searchId: "feature/search:1",
            configuration: expect.objectContaining({id: "feature/search:1"}),
            results: expect.objectContaining({grouping: [{id: 1, name: "Maps"}]})
        });
        expect(featureSearchExportFilename(definition.id, {includeConfiguration: true, includeResults: true}))
            .toBe("feature-search-feature_search_1.json");
    });

    it("builds single-category export payloads and filenames", () => {
        const definition = searchDefinition();
        const results = [result("Road.1", "MapA", "LayerA", 120n)];

        expect(featureSearchExportPayload(
            definition,
            results,
            [],
            "",
            {includeConfiguration: true, includeResults: false}
        )).toEqual(featureSearchDefinitionExport(definition));
        expect(featureSearchExportFilename(definition.id, {includeConfiguration: true, includeResults: false}))
            .toBe("feature-search-feature_search_1-configuration.json");

        expect(featureSearchExportPayload(
            definition,
            results,
            [],
            "",
            {includeConfiguration: false, includeResults: true}
        )).toEqual(featureSearchResultsExport(results, [], ""));
        expect(featureSearchExportFilename(definition.id, {includeConfiguration: false, includeResults: true}))
            .toBe("feature-search-feature_search_1-results.json");

        expect(featureSearchExportPayload(
            definition,
            results,
            [],
            "",
            {includeConfiguration: false, includeResults: false}
        )).toBeNull();
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

    it("imports configuration-only search JSON", () => {
        const imported = featureSearchDefinitionFromImportPayload(featureSearchDefinitionExport(searchDefinition()));

        expect(imported.source).toBe("configuration");
        expect(imported.definition.query).toBe("**.speed > 80");
        expect(imported.definition.selectedMapLayers).toEqual([{mapId: "MapA", layerId: "LayerA"}]);
        expect(imported.definition.selectedMapLayersManual).toBe(false);
        expect(imported.definition.selectedViewIndices).toEqual([0, 1]);
    });

    it("imports combined search JSON from the configuration entry", () => {
        const definition = searchDefinition();
        const payload = featureSearchExportPayload(
            definition,
            [result("Road.1", "MapA", "LayerA", 120n)],
            [],
            "",
            {includeConfiguration: true, includeResults: true},
            definition.selectedMapLayers,
            definition.selectedMapLayers,
            "2026-06-01T00:00:00.000Z"
        );

        const imported = featureSearchDefinitionFromImportPayload(payload);

        expect(imported.source).toBe("combined");
        expect(imported.definition.query).toBe(definition.query);
        expect(imported.definition.searchStyleRules).toEqual(definition.searchStyleRules);
    });

    it("rejects result-only search JSON imports", () => {
        const payload = featureSearchResultsExport([result("Road.1", "MapA", "LayerA", 120n)], [], "");

        expect(() => featureSearchDefinitionFromImportPayload(payload))
            .toThrow("Search JSON contains results but no importable search configuration.");
    });
});

function searchDefinition(): FeatureSearchStateEntry {
    return {
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
        selectedTileLevels: [13],
        selectedViewIndices: [0, 1],
        searchStyleRules: [],
        renderStrategy: {
            showLowFiDots: true,
            showBucketLabels: true,
            showHighFiGeometry: true,
            showHighFiResultDots: false,
            highFidelityMaxVisibleTiles: 512,
            densityHeatGradient: false,
            densitySizeMultiplier: 1
        }
    };
}

function mapLayer(mapId: string, layerId: string): FeatureSearchMapLayerRef {
    return {mapId, layerId};
}

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
