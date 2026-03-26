import {beforeAll, describe, expect, it} from 'vitest';
import {initializeLibrary} from '../integrations/wasm';
import {DeckLayerLike, DeckLayerRegistry, DeckLike} from './deck/deck-layer-registry';

beforeAll(async () => {
    await initializeLibrary();
});

import {MergedPointsTile, PointMergeService} from './pointmerge.service';

class DeckStub implements DeckLike {
    readonly commits: DeckLayerLike[][] = [];

    setProps(props: Parameters<DeckLike['setProps']>[0]): void {
        this.commits.push((props.layers ?? []) as DeckLayerLike[]);
    }
}

describe('MergedPointsTile', () => {
    it('adds new points and merges feature IDs, updating parameters only when new IDs are added', () => {
        const tile = new MergedPointsTile(1n, '0:map:layer:style:1');
        const hash = 'pos-hash';

        const point1 = {
            position: {x: 0, y: 0, z: 0},
            positionHash: hash,
            pointParameters: {p: 1},
            labelParameters: {l: 1},
            featureAddresses: [1, 2],
        } as any;

        tile.add(point1, 'k');
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
            featureAddresses: [2, 3],
        } as any;

        tile.add(point2, 'k');

        const stored2 = tile.features.get(hash)!;
        expect(stored2.featureAddresses.sort()).toEqual([1, 2, 3]);
        expect(stored2.pointParameters).toBe(point2.pointParameters);
        expect(stored2.labelParameters).toBe(point2.labelParameters);
        expect(tile.count('unknown-hash')).toBe(0);
    });

    it('renders and removes merged points through deck scene handles', () => {
        const tile = new MergedPointsTile(1n, '0:map:layer:style:0:7');
        tile.add({
            position: {x: 8, y: 49, z: 0},
            positionHash: 'deck-pos',
            pointParameters: {
                position: {x: 123, y: 456, z: 0},
                pixelSize: 6,
                color: [255, 0, 0, 255],
                outlineColor: [0, 0, 0, 255],
                outlineWidth: 1
            },
            labelParameters: {
                position: {x: 8, y: 49, z: 0},
                text: 'A',
                fillColor: [255, 255, 255, 255],
                outlineColor: [0, 0, 0, 255],
                outlineWidth: 1,
                scale: 1,
                pixelOffset: [0, 0]
            },
            featureAddresses: [3]
        } as any, 'tile-key');

        const deck = new DeckStub();
        const registry = new DeckLayerRegistry(deck);

        tile.renderScene({
            renderer: 'deck',
            scene: {layerRegistry: registry}
        } as any);
        registry.flush();

        expect(deck.commits).toHaveLength(1);
        expect(deck.commits[0].length).toBeGreaterThan(0);
        const mergedPointLayer: any = deck.commits[0].find(layer =>
            typeof layer.id === 'string' && layer.id.includes('/merged-point'));
        expect(mergedPointLayer).toBeTruthy();
        const firstDatum = mergedPointLayer.props.data[0];
        expect(mergedPointLayer.props.getPosition(firstDatum)).toEqual([8, 49, 0]);

        tile.removeScene({
            renderer: 'deck',
            scene: {layerRegistry: registry}
        } as any);
        registry.flush();

        expect(deck.commits).toHaveLength(2);
        expect(deck.commits[1]).toHaveLength(0);
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
            featureAddresses: [1],
        } as any;

        const sourceTileId = 5n;
        const yielded = Array.from(service.insert([point], sourceTileId, 'k', ruleId));

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

    it('removes source tile feature contributions from surviving corner tiles', () => {
        const service = new PointMergeService();
        const ruleId = '0:map:layer:style:1';
        const tile = new MergedPointsTile(1n, ruleId);
        tile.referencingTiles = [10n, 20n];
        tile.features.set('h', {
            position: {x: 0, y: 0, z: 0},
            positionHash: 'h',
            pointParameters: null,
            labelParameters: null,
            featureAddresses: [11, 22],
            featureTileKeys: ['tile-a', 'tile-b']
        } as any);

        service.mergedPointsTiles.set(ruleId, new Map<bigint, MergedPointsTile>([
            [1n, tile]
        ]));

        const touched = Array.from(service.remove(10n, 'tile-a', '0:map'));
        expect(touched).toEqual([tile]);
        expect(tile.referencingTiles).toEqual([20n]);
        expect(tile.features.get('h')?.featureAddresses).toEqual([22]);
        expect(tile.features.get('h')?.featureTileKeys).toEqual(['tile-b']);
    });

    it('captures merge-count snapshot for surrounding corner tiles', () => {
        const service = new PointMergeService();
        const ruleId = '0:map:layer:style:0:7';
        const sourceTileId = 5n;
        const cornerTile = new MergedPointsTile(sourceTileId, ruleId);
        cornerTile.features.set('h', {
            position: {x: 0, y: 0, z: 0},
            positionHash: 'h',
            pointParameters: null,
            labelParameters: null,
            featureAddresses: [11, 22]
        } as any);

        service.mergedPointsTiles.set(ruleId, new Map<bigint, MergedPointsTile>([
            [sourceTileId, cornerTile]
        ]));

        const snapshot = service.makeMergeCountSnapshot(sourceTileId, '0:map:layer:style:0');
        expect(snapshot[`${ruleId}|h`]).toBe(2);
    });

    it('excludes the current source tile from merge-count snapshot and direct counts', () => {
        const service = new PointMergeService();
        const ruleId = '0:map:layer:style:0:7';
        const sourceTileId = 5n;
        const cornerTile = new MergedPointsTile(sourceTileId, ruleId);
        cornerTile.features.set('h', {
            position: {x: 0, y: 0, z: 0},
            positionHash: 'h',
            pointParameters: null,
            labelParameters: null,
            featureAddresses: [11, 22],
            featureTileKeys: ['tile-a', 'tile-b']
        } as any);

        service.mergedPointsTiles.set(ruleId, new Map<bigint, MergedPointsTile>([
            [sourceTileId, cornerTile]
        ]));

        expect(cornerTile.count('h', 'tile-a')).toBe(1);

        const snapshot = service.makeMergeCountSnapshot(
            sourceTileId,
            '0:map:layer:style:0',
            'tile-a'
        );
        expect(snapshot[`${ruleId}|h`]).toBe(1);
    });

    it('remove yields touched tiles and deletes tiles whose references are cleared, retaining others', () => {
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

        const removed = Array.from(service.remove(10n, 'tile-key', '0:map'));
        expect(removed).toEqual([tileA, tileB]);
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
