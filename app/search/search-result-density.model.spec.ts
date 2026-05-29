import {beforeAll, describe, expect, it} from 'vitest';
import "@angular/compiler";
import {coreLib, initializeLibrary} from "../integrations/wasm";
import {
    SearchResultDensityIndex,
    SearchResultDensityMarker,
    SearchResultPoint
} from "./search-result-density.model";
import {
    layoutSearchResultDensityMarkers,
    SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE,
    searchResultDensityBucketLabel,
    searchResultDensityCountDomain,
    searchResultDensityRenderSizePixels
} from "../mapview/deck/deck-search-result-density.layer";

beforeAll(async () => {
    await initializeLibrary();
});

/** Builds a mapget tile id with the same bit layout used by the native helpers. */
function tileId(x: number, y: number, level: number): bigint {
    return (BigInt(x) << 32n) | (BigInt(y) << 16n) | BigInt(level);
}

/** Creates one positioned search-result point for density-index tests. */
function searchResultPoint(featureId: string, sourceTileId: bigint, coordinates: [number, number]): SearchResultPoint {
    const sourceTileKey = coreLib.getTileFeatureLayerKey("TestMap", "WayLayer", sourceTileId);
    const resultKey = `${sourceTileKey}\n${featureId}`;
    return {
        coordinates,
        mapId: "TestMap",
        layerId: "WayLayer",
        tileId: sourceTileId,
        mapTileKey: sourceTileKey,
        sourceTileKey,
        sourceMapId: "TestMap",
        sourceLayerId: "WayLayer",
        sourceTileId,
        featureId,
        resultIndex: 0,
        resultKey,
        featureKey: `TestMap/WayLayer/${featureId}`,
        hoverFeatureId: featureId
    };
}

/** Creates one already materialized density marker for low-fidelity layout tests. */
function densityMarker(featureId: string, tileIdValue: bigint, count: number): SearchResultDensityMarker {
    return {
        coordinates: [0, 0],
        count,
        mapId: "TestMap",
        layerId: "WayLayer",
        tileId: tileIdValue,
        featureId,
        resultKey: `TestMap/WayLayer/${featureId}`,
        featureKey: `TestMap/WayLayer/${featureId}`,
        featureKeys: [`TestMap/WayLayer/${featureId}`],
        resultKeys: [`TestMap/WayLayer/${featureId}`]
    };
}

describe('SearchResultDensityIndex', () => {
    it('aggregates source-tile contributions at the requested ancestor tile level', () => {
        const index = new SearchResultDensityIndex();
        const firstTileId = tileId(0, 0, 2);
        const secondTileId = tileId(1, 0, 2);
        const firstPoint = searchResultPoint("first", firstTileId, [10, 20]);
        const secondPoint = searchResultPoint("second", secondTileId, [12, 24]);

        index.addContribution(firstPoint.sourceTileKey, [firstPoint]);
        index.addContribution(secondPoint.sourceTileKey, [secondPoint]);

        const markers = index.materialize({
            sourceTileKeys: new Set([firstPoint.sourceTileKey, secondPoint.sourceTileKey]),
            targetLevel: 1
        });

        expect(markers).toHaveLength(1);
        expect(markers[0].count).toBe(2);
        const tilePosition = coreLib.getTilePosition(markers[0].tileId);
        expect(markers[0].coordinates).toEqual([tilePosition.x, tilePosition.y]);
        expect(markers[0].featureKeys).toEqual([
            "TestMap/WayLayer/first",
            "TestMap/WayLayer/second"
        ]);
    });

    it('uses aggregate tile centers instead of feature center-of-mass positions', () => {
        const index = new SearchResultDensityIndex();
        const sourceTileId = tileId(2, 1, 2);
        const firstPoint = searchResultPoint("first", sourceTileId, [10, 20]);
        const secondPoint = searchResultPoint("second", sourceTileId, [80, 70]);

        index.addContribution(firstPoint.sourceTileKey, [firstPoint, secondPoint]);

        const markers = index.materialize({
            sourceTileKeys: new Set([firstPoint.sourceTileKey]),
            targetLevel: 2
        });

        const tilePosition = coreLib.getTilePosition(sourceTileId);
        expect(markers).toHaveLength(1);
        expect(markers[0].count).toBe(2);
        expect(markers[0].coordinates).toEqual([tilePosition.x, tilePosition.y]);
    });

    it('removes one source-tile contribution without clearing unrelated markers', () => {
        const index = new SearchResultDensityIndex();
        const firstPoint = searchResultPoint("first", tileId(0, 0, 2), [10, 20]);
        const secondPoint = searchResultPoint("second", tileId(1, 0, 2), [12, 24]);

        index.addContribution(firstPoint.sourceTileKey, [firstPoint]);
        index.addContribution(secondPoint.sourceTileKey, [secondPoint]);
        expect(index.removeContribution(firstPoint.sourceTileKey)).toBe(true);

        const markers = index.materialize({
            sourceTileKeys: new Set([firstPoint.sourceTileKey, secondPoint.sourceTileKey]),
            targetLevel: 1
        });

        expect(markers).toHaveLength(1);
        expect(markers[0].count).toBe(1);
        expect(markers[0].featureKey).toBe("TestMap/WayLayer/second");
    });

    it('aggregates same-search density markers across layers when they share the same map tile', () => {
        const index = new SearchResultDensityIndex();
        const sourceTileId = tileId(0, 0, 2);
        const firstPoint = searchResultPoint("first", sourceTileId, [10, 20]);
        const secondSourceTileKey = coreLib.getTileFeatureLayerKey("TestMap", "OtherLayer", sourceTileId);
        const secondPoint: SearchResultPoint = {
            ...searchResultPoint("second", sourceTileId, [11, 21]),
            layerId: "OtherLayer",
            sourceLayerId: "OtherLayer",
            sourceTileKey: secondSourceTileKey,
            mapTileKey: secondSourceTileKey,
            resultKey: `${secondSourceTileKey}\nsecond`,
            featureKey: "TestMap/OtherLayer/second"
        };

        index.addContribution(firstPoint.sourceTileKey, [firstPoint]);
        index.addContribution(secondPoint.sourceTileKey, [secondPoint]);

        const markers = index.materialize({
            sourceTileKeys: new Set([firstPoint.sourceTileKey, secondPoint.sourceTileKey]),
            targetLevel: 2
        });

        expect(markers).toHaveLength(1);
        expect(markers[0].count).toBe(2);
        expect(markers[0].featureKeys).toEqual([
            "TestMap/WayLayer/first",
            "TestMap/OtherLayer/second"
        ]);
    });

    it('materializes only the source tiles requested by one view', () => {
        const index = new SearchResultDensityIndex();
        const firstPoint = searchResultPoint("first", tileId(0, 0, 2), [10, 20]);
        const secondPoint = searchResultPoint("second", tileId(3, 0, 2), [40, 20]);

        index.addContribution(firstPoint.sourceTileKey, [firstPoint]);
        index.addContribution(secondPoint.sourceTileKey, [secondPoint]);

        const markers = index.materialize({
            sourceTileKeys: new Set([secondPoint.sourceTileKey]),
            targetLevel: 1
        });

        expect(markers).toHaveLength(1);
        expect(markers[0].featureKey).toBe("TestMap/WayLayer/second");
    });

    it('lays out same-tile markers with size-aware pixel spacing', () => {
        const sameTileId = tileId(0, 0, 1);
        const smallMarker = densityMarker("small", sameTileId, 1);
        const largeMarker = densityMarker("large", sameTileId, 100);
        const otherTileMarker = densityMarker("other", tileId(1, 0, 1), 100);

        layoutSearchResultDensityMarkers([
            {marker: largeMarker, sortKey: "search-b"},
            {marker: smallMarker, sortKey: "search-a"},
            {marker: otherTileMarker, sortKey: "search-c"}
        ]);

        const expectedSpacing = Math.ceil(
            searchResultDensityRenderSizePixels(100, SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE) + 4
        );
        expect(Math.abs(largeMarker.pixelOffset![0] - smallMarker.pixelOffset![0])).toBe(expectedSpacing);
        expect(largeMarker.pixelOffset![1]).toBe(0);
        expect(smallMarker.pixelOffset![1]).toBe(0);
        expect(otherTileMarker.pixelOffset).toEqual([0, 0]);
    });

    it('formats aggregate count buckets for dense dot labels', () => {
        expect(searchResultDensityBucketLabel(1)).toBe("1");
        expect(searchResultDensityBucketLabel(4)).toBe("4");
        expect(searchResultDensityBucketLabel(5)).toBe("5+");
        expect(searchResultDensityBucketLabel(19)).toBe("10+");
        expect(searchResultDensityBucketLabel(500)).toBe("500+");
        expect(searchResultDensityBucketLabel(999)).toBe("500+");
        expect(searchResultDensityBucketLabel(1000)).toBe("1k+");
        expect(searchResultDensityBucketLabel(2999)).toBe("2k+");
        expect(searchResultDensityBucketLabel(10000)).toBe("10k+");
        expect(searchResultDensityBucketLabel(25000)).toBe("10k+");
    });

    it('scales dot sizes against the observed visible count domain', () => {
        const domain = {min: 10, max: 1000};
        const minSize = searchResultDensityRenderSizePixels(10, SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE, domain);
        const maxSize = searchResultDensityRenderSizePixels(1000, SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE, domain);
        const broadDomainSize = searchResultDensityRenderSizePixels(
            10,
            SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE,
            {min: 1, max: 1000}
        );

        expect(maxSize).toBeGreaterThan(minSize * 2);
        expect(minSize).toBeLessThan(broadDomainSize);
    });

    it('derives count domains from currently materialized markers', () => {
        const markers = [
            densityMarker("small", tileId(0, 0, 1), 7),
            densityMarker("large", tileId(1, 0, 1), 90)
        ];

        expect(searchResultDensityCountDomain(markers)).toEqual({min: 7, max: 90});
    });
});
