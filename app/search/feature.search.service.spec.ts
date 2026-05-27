import {beforeAll, describe, expect, it} from 'vitest';
import "@angular/compiler";
import {coreLib, initializeLibrary} from "../integrations/wasm";
import {SearchResultPinIndex, SearchResultPoint} from "./feature.search.service";

beforeAll(async () => {
    await initializeLibrary();
});

/** Builds a mapget tile id with the same bit layout used by the native helpers. */
function tileId(x: number, y: number, level: number): bigint {
    return (BigInt(x) << 32n) | (BigInt(y) << 16n) | BigInt(level);
}

/** Creates one positioned search-result point for pin-index tests. */
function searchResultPoint(featureId: string, sourceTileId: bigint, coordinates: [number, number]): SearchResultPoint {
    const sourceTileKey = coreLib.getTileFeatureLayerKey("TestMap", "WayLayer", sourceTileId);
    return {
        coordinates,
        mapId: "TestMap",
        layerId: "WayLayer",
        tileId: sourceTileId,
        sourceTileKey,
        sourceMapId: "TestMap",
        sourceLayerId: "WayLayer",
        sourceTileId,
        featureId,
        featureKey: `TestMap/WayLayer/${featureId}`
    };
}

describe('SearchResultPinIndex', () => {
    it('aggregates source-tile contributions at the requested ancestor tile level', () => {
        const index = new SearchResultPinIndex();
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
        expect(markers[0].coordinates).toEqual([11, 22]);
        expect(markers[0].featureKeys).toEqual([
            "TestMap/WayLayer/first",
            "TestMap/WayLayer/second"
        ]);
    });

    it('removes one source-tile contribution without clearing unrelated markers', () => {
        const index = new SearchResultPinIndex();
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

    it('materializes only the source tiles requested by one view', () => {
        const index = new SearchResultPinIndex();
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
});
