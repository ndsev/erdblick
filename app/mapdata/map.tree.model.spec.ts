import {describe, expect, it} from 'vitest';
import {
    dataSourceCatalogStatus,
    dataSourceProgressPercent,
    isDataSourceCatalogEntryReady,
    MapInfoItem,
    sortDataSourceCatalogEntries
} from './map.tree.model';

function source(mapId: string, configIndex?: number, status?: string): MapInfoItem {
    return {
        extraJsonAttachment: {},
        layers: {},
        mapId,
        maxParallelJobs: 0,
        sourceId: mapId,
        stringPoolId: mapId,
        protocolVersion: {major: 1, minor: 0, patch: 0},
        addOn: false,
        ...(configIndex === undefined ? {} : {configIndex}),
        ...(status === undefined ? {} : {status})
    };
}

describe('datasource catalog tree helpers', () => {
    it('treats legacy entries without a status as ready', () => {
        const legacy = source('Legacy');

        expect(dataSourceCatalogStatus(legacy)).toBe('ready');
        expect(isDataSourceCatalogEntryReady(legacy)).toBe(true);
    });

    it('recognizes initializing and failed catalog entries as not ready', () => {
        expect(isDataSourceCatalogEntryReady(source('Init', 0, 'initializing'))).toBe(false);
        expect(isDataSourceCatalogEntryReady(source('Failed', 1, 'failed'))).toBe(false);
    });

    it('preserves backend config order when catalog entries are sorted', () => {
        const sorted = sortDataSourceCatalogEntries([
            source('third', 2),
            source('legacy'),
            source('first', 0),
            source('second', 1)
        ]);

        expect(sorted.map(entry => entry.mapId)).toEqual(['first', 'second', 'third', 'legacy']);
    });

    it('normalizes datasource progress values for display', () => {
        expect(dataSourceProgressPercent({...source('fraction'), progress: 0.42})).toBe(42);
        expect(dataSourceProgressPercent({...source('percent'), progress: 73})).toBe(73);
        expect(dataSourceProgressPercent({...source('missing'), progress: null})).toBeNull();
    });
});
