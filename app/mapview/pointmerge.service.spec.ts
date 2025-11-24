import {beforeAll, describe, expect, it, vi} from 'vitest';
import {initializeLibrary} from '../integrations/wasm';

beforeAll(async () => {
    await initializeLibrary();
});

import {MergedPointsTile, PointMergeService} from './pointmerge.service';

describe('MergedPointsTile', () => {
    it('adds new points and merges feature IDs, updating parameters only when new IDs are added', () => {
        const tile = new MergedPointsTile(1n, '0:map:layer:style:1');
        const hash = 'pos-hash';

        const point1 = {
            position: {x: 0, y: 0, z: 0},
            positionHash: hash,
            pointParameters: {p: 1},
            labelParameters: {l: 1},
            featureIds: [
                {mapTileKey: 'k', featureId: 'f1'},
                {mapTileKey: 'k', featureId: 'f2'},
            ],
        } as any;

        tile.add(point1);
        expect(tile.features.size).toBe(1);
        expect(tile.count(hash)).toBe(2);

        const stored1 = tile.features.get(hash)!;
        expect(stored1.pointParameters).toBe(point1.pointParameters);
        expect(stored1.labelParameters).toBe(point1.labelParameters);

        const point2 = {
            position: {x: 0, y: 0, z: 0},
            positionHash: hash,
            pointParameters: {p: 2},
            labelParameters: {l: 2},
            featureIds: [
                {mapTileKey: 'k', featureId: 'f2'},
                {mapTileKey: 'k', featureId: 'f3'},
            ],
        } as any;

        tile.add(point2);

        const stored2 = tile.features.get(hash)!;
        expect(stored2.featureIds.map((f: any) => f.featureId).sort()).toEqual(['f1', 'f2', 'f3']);
        expect(stored2.pointParameters).toBe(point2.pointParameters);
        expect(stored2.labelParameters).toBe(point2.labelParameters);
        expect(tile.count('unknown-hash')).toBe(0);
    });
});

describe('PointMergeService', () => {
    it('inserts points into corner tiles and tracks references', () => {
        const service = new PointMergeService();
        const ruleId = '0:map:layer:style:1';
        const point = {
            position: {x: 0, y: 0, z: 0},
            positionHash: 'h1',
            pointParameters: null,
            labelParameters: null,
            featureIds: [{mapTileKey: 'k', featureId: 'f1'}],
        } as any;

        const sourceTileId = 5n;
        const yielded = Array.from(service.insert([point], sourceTileId, ruleId));

        const styleMap = service.mergedPointsTiles.get(ruleId)!;
        expect(styleMap).toBeDefined();
        expect(styleMap.size).toBeGreaterThan(0);

        const tiles = Array.from(styleMap.values());
        const tilesWithPoint = tiles.filter(t => t.count('h1') > 0);
        expect(tilesWithPoint).toHaveLength(1);
        expect(tilesWithPoint[0].count('h1')).toBe(1);

        expect(yielded.length).toBeGreaterThan(0);
        for (const tile of yielded) {
            expect(tile.referencingTiles).toContain(sourceTileId);
        }
    });

    it('remove yields and deletes tiles whose references are cleared, retaining others', () => {
        const service = new PointMergeService();
        const ruleId = '0:map:layer:style:1';

        const tileA = new MergedPointsTile(1n, ruleId);
        tileA.referencingTiles = [10n];
        const tileB = new MergedPointsTile(2n, ruleId);
        tileB.referencingTiles = [10n, 20n];

        service.mergedPointsTiles.set(ruleId, new Map<bigint, MergedPointsTile>([
            [1n, tileA],
            [2n, tileB],
        ]));

        const removed = Array.from(service.remove(10n, '0:map'));
        expect(removed).toEqual([tileA]);
        const remainingMap = service.mergedPointsTiles.get(ruleId)!;
        expect(remainingMap.has(1n)).toBe(false);
        expect(remainingMap.get(2n)!.referencingTiles).toEqual([20n]);
    });

    it('clear yields and removes all tiles whose style-rule ID matches the prefix', () => {
        const service = new PointMergeService();

        const ruleA = '0:map:layer:style:1';
        const ruleB = '1:other:layer:style:1';

        const tile1 = new MergedPointsTile(1n, ruleA);
        const tile2 = new MergedPointsTile(2n, ruleA);
        const tileOther = new MergedPointsTile(3n, ruleB);

        service.mergedPointsTiles.set(ruleA, new Map<bigint, MergedPointsTile>([
            [1n, tile1],
            [2n, tile2],
        ]));
        service.mergedPointsTiles.set(ruleB, new Map<bigint, MergedPointsTile>([
            [3n, tileOther],
        ]));

        const cleared = Array.from(service.clear('0:map'));
        expect(cleared).toEqual(expect.arrayContaining([tile1, tile2]));
        expect(cleared).toHaveLength(2);
        expect(service.mergedPointsTiles.has(ruleA)).toBe(false);
        expect(service.mergedPointsTiles.has(ruleB)).toBe(true);
    });
});
