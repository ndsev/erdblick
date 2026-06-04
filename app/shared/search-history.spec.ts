// @vitest-environment node
import {describe, expect, it} from 'vitest';

import {
    historyEntryDedupeKey,
    isLegacySearchHistoryEntry,
    normalizeResolvedSearchHistoryEntry,
    normalizeSearchHistoryEntry,
    normalizeSearchHistoryPayload,
    normalizeSearchStateValue,
    sameSearchHistoryEntry,
    serializeSearchStateValue
} from './search-history';

describe('search history helpers', () => {
    it('normalizes v2 object entries and trims input metadata', () => {
        expect(normalizeResolvedSearchHistoryEntry({
            version: 2,
            actionId: ' j:wgs84-lon-lat ',
            input: ' 1, 2 ',
            actionName: ' WGS84 Lon-Lat Coordinates ',
        })).toEqual({
            version: 2,
            actionId: 'j:wgs84-lon-lat',
            input: '1, 2',
            actionName: 'WGS84 Lon-Lat Coordinates',
        });
    });

    it('recognizes compact v2 tuples and legacy v1 tuples separately', () => {
        const compact = normalizeSearchHistoryEntry(['features', '**.speed > 80']);
        const legacy = normalizeSearchHistoryEntry([2, '48.1, 11.2']);

        expect(compact).toEqual({
            version: 2,
            actionId: 'features',
            input: '**.speed > 80',
        });
        expect(isLegacySearchHistoryEntry(compact)).toBe(false);
        expect(legacy).toEqual([2, '48.1, 11.2']);
        expect(isLegacySearchHistoryEntry(legacy)).toBe(true);
    });

    it('rejects malformed and blank entries', () => {
        expect(normalizeSearchHistoryEntry(null)).toBeNull();
        expect(normalizeSearchHistoryEntry(['features', '   '])).toBeNull();
        expect(normalizeSearchHistoryEntry({version: 2, actionId: '', input: 'abc'})).toBeNull();
    });

    it('normalizes the empty search state without treating it as history', () => {
        expect(normalizeSearchStateValue([])).toEqual([]);
    });

    it('serializes active v2 search state as compact URL/storage tuples', () => {
        expect(serializeSearchStateValue({
            version: 2,
            actionId: ' j:wgs84-lon-lat ',
            input: ' 1, 2 ',
            actionName: 'WGS84 Lon-Lat Coordinates',
            savedAt: 42,
        })).toEqual(['j:wgs84-lon-lat', '1, 2']);

        expect(serializeSearchStateValue([2, ' 48.1, 11.2 '])).toEqual([2, '48.1, 11.2']);
        expect(serializeSearchStateValue([])).toEqual([]);
    });

    it('preserves small JSON payloads without adding them to compact URL state', () => {
        const payload = {
            id: 'geonames:2867714',
            name: 'Munich, DE',
            lonLat: [11.57549, 48.13743],
            aabb: [[11.57549, 48.13743], [0, 0]],
            source: 'geonames-cities5000',
            providerId: 'mapget-offline',
            providerName: 'Place',
        };
        const entry = normalizeResolvedSearchHistoryEntry({
            version: 2,
            actionId: 'loc:mapget-offline:geonames:2867714',
            input: 'munich',
            payload,
        });

        expect(entry?.payload).toEqual(payload);
        expect(serializeSearchStateValue(entry!)).toEqual(['loc:mapget-offline:geonames:2867714', 'munich']);
    });

    it('drops unserializable and oversized payloads', () => {
        const circular: any = {};
        circular.self = circular;

        expect(normalizeSearchHistoryPayload(circular)).toBeUndefined();
        expect(normalizeSearchHistoryPayload({value: 'x'.repeat(9000)})).toBeUndefined();
    });

    it('compares and deduplicates by action id and input', () => {
        const first = {
            version: 2 as const,
            actionId: 'j:wgs84-lat-lon',
            input: '48.1, 11.2',
            savedAt: 1,
        };
        const second = {
            ...first,
            savedAt: 2,
        };

        expect(sameSearchHistoryEntry(first, second)).toBe(true);
        expect(historyEntryDedupeKey(first)).toBe(historyEntryDedupeKey(second));
    });
});
