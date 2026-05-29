import {beforeAll, describe, expect, it} from "vitest";
import "@angular/compiler";
import type {TileLayerParser} from "../../build/libs/core/erdblick-core";
import {coreLib, initializeLibrary} from "../integrations/wasm";
import {DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY} from "../shared/feature-search-state";
import type {FeatureSearchStateEntry} from "../shared/feature-search-state";
import {FeatureSearchRuntimeState} from "./feature-search-runtime-state.model";
import type {SearchLayerTileSet} from "./map-runtime.model";

beforeAll(async () => {
    await initializeLibrary();
});

/** Creates the minimal persisted search definition needed by runtime request tests. */
function searchDefinition(patch: Partial<FeatureSearchStateEntry> = {}): FeatureSearchStateEntry {
    return {
        id: "search-1",
        query: "typeId == 'Road'",
        scope: "auto",
        autoUpdate: true,
        paused: false,
        showResultsOnMap: true,
        pinColor: "#ea4336",
        searchStyleRules: [],
        renderStrategy: DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY,
        ...patch
    };
}

/** Creates one visible source-tile coverage set for a map/layer pair. */
function visibleLayerTiles(
    mapId: string,
    layerId: string,
    tileIds: number[],
    priorityTileIds = new Set<number>(),
    requestOrderOffset = 0
): Map<string, SearchLayerTileSet> {
    return new Map([[
        FeatureSearchRuntimeState.layerKey(mapId, layerId),
        {
            mapId,
            layerId,
            tiles: new Map(tileIds.map((tileId, index) => [
                tileId,
                {
                    tileId,
                    requestOrder: requestOrderOffset + index,
                    priority: priorityTileIds.has(tileId)
                }
            ]))
        }
    ]]);
}

/** Creates multi-layer visible coverage while keeping the caller-provided first-seen order. */
function visibleLayerTilePlan(
    entries: Array<{mapId: string; layerId: string; tileId: number; priority?: boolean}>
): Map<string, SearchLayerTileSet> {
    const result = new Map<string, SearchLayerTileSet>();
    entries.forEach((entry, requestOrder) => {
        const key = FeatureSearchRuntimeState.layerKey(entry.mapId, entry.layerId);
        let layerTiles = result.get(key);
        if (!layerTiles) {
            layerTiles = {mapId: entry.mapId, layerId: entry.layerId, tiles: new Map()};
            result.set(key, layerTiles);
        }
        if (!layerTiles.tiles.has(entry.tileId)) {
            layerTiles.tiles.set(entry.tileId, {
                tileId: entry.tileId,
                requestOrder,
                priority: entry.priority ?? false
            });
        }
    });
    return result;
}

describe("FeatureSearchRuntimeState", () => {
    it("sends resolver-normalized backend queries with search tile requests", () => {
        const definition = searchDefinition({query: "WARNING_SIGN"});
        const runtime = new FeatureSearchRuntimeState(definition, {} as TileLayerParser);
        runtime.adoptVisibleTiles(visibleLayerTiles("m1", "layerA", [65537]));

        const requests = runtime.buildPendingRequests(
            () => "attribute",
            () => '$name == "WARNING_SIGN"'
        );

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            mapId: "m1",
            layerId: "layerA",
            tileIds: [65537],
            searchId: "search-1",
            searchQuery: '$name == "WARNING_SIGN"',
            searchScope: "attribute"
        });
    });

    it("treats backend query changes as a new search generation", () => {
        const definition = searchDefinition({query: "WARNING_SIGN"});
        const runtime = new FeatureSearchRuntimeState(definition, {} as TileLayerParser);
        runtime.adoptVisibleTiles(visibleLayerTiles("m1", "layerA", [65537]));

        runtime.applyDefinition(definition, () => "attribute", () => "WARNING_SIGN");
        expect(runtime.refresh).toBe(1);

        const sourceTileKey = coreLib.getTileFeatureLayerKey("m1", "layerA", 65537n);
        runtime.adoptVisibleTiles(visibleLayerTiles("m1", "layerA", [65537]));
        expect(runtime.tilesBySourceKey.has(sourceTileKey)).toBe(true);

        const removedTiles = runtime.applyDefinition(
            definition,
            () => "attribute",
            () => '$name == "WARNING_SIGN"'
        );

        expect(runtime.refresh).toBe(2);
        expect(removedTiles).toHaveLength(1);
        expect(runtime.tilesBySourceKey.size).toBe(0);
    });

    it("preserves visible tile order for backend search requests", () => {
        const runtime = new FeatureSearchRuntimeState(searchDefinition(), {} as TileLayerParser);
        runtime.adoptVisibleTiles(visibleLayerTiles(
            "m1",
            "layerA",
            [393218, 65538, 262146]
        ));

        const requests = runtime.buildPendingRequests(() => "feature", definition => definition.query);

        expect(requests).toHaveLength(1);
        expect(requests[0].tileIds).toEqual([393218, 65538, 262146]);
        expect(requests[0].priorityTileIds).toBeUndefined();
    });

    it("moves priority search tiles ahead while keeping their visible order", () => {
        const runtime = new FeatureSearchRuntimeState(searchDefinition(), {} as TileLayerParser);
        runtime.adoptVisibleTiles(visibleLayerTiles(
            "m1",
            "layerA",
            [393218, 65538, 262146],
            new Set([262146, 393218])
        ));

        const requests = runtime.buildPendingRequests(() => "feature", definition => definition.query);

        expect(requests).toHaveLength(1);
        expect(requests[0].tileIds).toEqual([393218, 262146, 65538]);
        expect(requests[0].priorityTileIds).toEqual([393218, 262146]);
    });

    it("orders backend search request groups by first visible tile", () => {
        const runtime = new FeatureSearchRuntimeState(searchDefinition(), {} as TileLayerParser);
        runtime.adoptVisibleTiles(visibleLayerTilePlan([
            {mapId: "m1", layerId: "layerB", tileId: 65538},
            {mapId: "m1", layerId: "layerA", tileId: 131074},
            {mapId: "m1", layerId: "layerB", tileId: 196610}
        ]));

        const requests = runtime.buildPendingRequests(() => "feature", definition => definition.query);

        expect(requests.map(request => request.layerId)).toEqual(["layerB", "layerA"]);
        expect(requests[0].tileIds).toEqual([65538, 196610]);
    });
});
