import { describe, expect, it } from "vitest";
import {
    SearchResults,
    type SearchResultDensity,
    type SearchResultPoint,
    type SearchResultTileContribution
} from "../../../app/search/search-results.model";

/** In-memory density port keeps result ownership tests independent of WASM and Angular. */
function fixture() {
    const indexed = new Map<string, readonly SearchResultPoint[]>();
    const density: SearchResultDensity = {
        get isEmpty() { return indexed.size === 0; },
        addContribution: (key, points) => { indexed.set(key, [...points]); },
        removeContribution: key => indexed.delete(key),
        clear: () => indexed.clear(),
        materialize: () => []
    };
    const results = new SearchResults(density);
    results.beginRun("run-1");
    return {results, indexed};
}

/** Prepared values are the model boundary; native tile decoding remains in the controller. */
function contribution(key: string, order = 0, labels = [key]): SearchResultTileContribution {
    return {
        refresh: 0, sourceTileKey: key, sourceMapId: "map", sourceLayerId: "layer", sourceTileId: 1,
        requestOrder: order, resultCount: labels.length, resultChannelOrdinal: 0, resultFields: [],
        results: labels.map(label => ({
            label, mapId: "map", layerId: "layer", featureId: label, resultIndex: 0, resultKey: label,
            mapTileKey: key, sourceTileKey: key, sourceMapId: "map", sourceLayerId: "layer", sourceTileId: 1,
            hoverFeatureId: label
        })),
        points: labels.map(label => ({
            coordinates: [8, 47], mapId: "map", layerId: "layer", tileId: 1, mapTileKey: key,
            sourceTileKey: key, sourceMapId: "map", sourceLayerId: "layer", sourceTileId: 1,
            featureId: label, resultIndex: 0, resultKey: label, featureKey: label, hoverFeatureId: label
        })),
        diagnostics: null, layerBlob: new Uint8Array(), valueSummary: null
    };
}

describe("SearchResults ownership", () => {
    it("replaces and removes one tile while preserving request order and other density contributions", () => {
        const {results, indexed} = fixture();
        results.add("run-1", contribution("a", 1), false, true);
        results.add("run-1", contribution("b", 0), false, true);
        expect(results.add("run-1", contribution("a", 1, ["replacement"]), false, true)).toBe("replaced");
        expect(results.rebuildPending).toBe(true);
        results.rebuildSessionResultData();
        expect(results.searchResults.map(row => row.label)).toEqual(["b", "replacement"]);
        expect(results.getSessionSearchResultPointBuckets().map(bucket => bucket.sourceTileKey)).toEqual(["b", "a"]);
        expect(indexed.get("a")?.[0].featureId).toBe("replacement");
        expect(results.remove("run-1", "a")).toBe(true);
        results.rebuildSessionResultData();
        expect(results.searchResults.map(row => row.label)).toEqual(["b"]);
        expect([...indexed.keys()]).toEqual(["b"]);
        expect(results.rebuildPending).toBe(false);
    });

    it("appends bounded batches without duplicating the header count or indexing partial density", () => {
        const {results, indexed} = fixture();
        const header = {...contribution("a", 0, []), resultCount: 2};
        results.add("run-1", header, false, false);
        results.add("run-1", contribution("a", 0, ["first"]), true, false);
        expect(indexed.size).toBe(0);
        results.add("run-1", contribution("a", 0, ["second"]), true, true);
        expect(results.searchResults.map(row => row.label)).toEqual(["first", "second"]);
        expect(results.totalFeatureCount).toBe(2);
        expect(indexed.get("a")?.map(point => point.featureId)).toEqual(["first", "second"]);
    });

    it("rejects retired runs and releases retained arrays and density when closed", () => {
        const {results, indexed} = fixture();
        results.add("run-1", contribution("a"), false, true);
        results.clear();
        results.beginRun("run-2");
        expect(results.add("run-1", contribution("late"), false, true)).toBe("ignored");
        expect(results.remove("run-1", "a")).toBe(false);
        results.add("run-2", contribution("b"), false, true);
        results.destroy();
        expect(results.add("run-2", contribution("late"), false, true)).toBe("ignored");
        expect(results.searchResults).toEqual([]);
        expect(results.searchResultTilesBySourceKey.size).toBe(0);
        expect(indexed.size).toBe(0);
    });
});
