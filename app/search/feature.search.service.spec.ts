import {describe, expect, it} from 'vitest';

import {FeatureSearchService, SearchState} from './feature.search.service';

describe('FeatureSearchService area bookkeeping', () => {
    it('reports progress over the current search area, not only the latest batch', () => {
        const service = Object.create(FeatureSearchService.prototype) as any;
        service.currentSearchScopeTileKeys = new Set<string>(['tile-a', 'tile-b', 'tile-c']);
        service.coveredTileKeys = new Set<string>(['tile-a', 'tile-b']);
        service.searchedTileDataVersionByKey = new Map<string, number>([
            ['tile-a', 1],
            ['tile-b', 1],
        ]);
        service.pendingSearchTileKeys = new Set<string>(['tile-c']);
        service.mapService = {
            loadedTileLayers: new Map<string, any>([
                ['tile-a', {dataVersion: 1, disposed: false, hasData: () => true}],
                ['tile-b', {dataVersion: 2, disposed: false, hasData: () => true}],
            ])
        };

        expect(service.searchAreaTileCount).toBe(3);
        expect(service.coveredSearchAreaTileCount).toBe(1);
        expect(service.pendingSearchAreaTileCount).toBe(1);
        expect(service.searchAreaPercentDone).toBeCloseTo(100 / 3);
    });

    it('releases active search progress when a pending tile is removed from scope', () => {
        const service = Object.create(FeatureSearchService.prototype) as any;
        const search = new SearchState('query', 'group-1');
        search.markTilePending('tile-a');

        service.currentSearch = search;
        service.pendingSearchTileKeys = new Set<string>(['tile-a']);
        service.tileContributions = new Map([['tile-a', {}]]);
        service.resultsPerTile = new Map([['tile-a', {}]]);
        service.coveredTileKeys = new Set<string>(['tile-a']);
        service.searchedTileDataVersionByKey = new Map([['tile-a', 1]]);
        service.tileDiagnosticsByKey = new Map([['tile-a', new Uint8Array()]]);

        service.removeTileState('tile-a');

        expect(service.pendingSearchTileKeys.has('tile-a')).toBe(false);
        expect(search.getPendingTileCount()).toBe(0);
        expect(service.tileContributions.has('tile-a')).toBe(false);
        expect(service.resultsPerTile.has('tile-a')).toBe(false);
    });
});
