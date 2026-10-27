// @vitest-environment node
import {describe, expect, it} from 'vitest';

import {
    historyEntryDedupeKey,
    isLegacyOmnibarHistoryEntry,
    normalizeResolvedOmnibarHistoryEntry,
    normalizeOmnibarHistoryEntry,
    normalizeOmnibarHistoryPayload
} from '../../../app/omnibar/omnibar-history';

describe('omnibar history helpers', () => {
    it('normalizes v2 object entries and trims input metadata', () => {
        expect(normalizeResolvedOmnibarHistoryEntry({
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
        const compact = normalizeOmnibarHistoryEntry(['features', '**.speed > 80']);
        const legacy = normalizeOmnibarHistoryEntry([2, '48.1, 11.2']);

        expect(compact).toEqual({
            version: 2,
            actionId: 'features',
            input: '**.speed > 80',
        });
        expect(isLegacyOmnibarHistoryEntry(compact)).toBe(false);
        expect(legacy).toEqual([2, '48.1, 11.2']);
        expect(isLegacyOmnibarHistoryEntry(legacy)).toBe(true);
    });

    it('rejects malformed and blank entries', () => {
        expect(normalizeOmnibarHistoryEntry(null)).toBeNull();
        expect(normalizeOmnibarHistoryEntry(['features', '   '])).toBeNull();
        expect(normalizeOmnibarHistoryEntry({version: 2, actionId: '', input: 'abc'})).toBeNull();
    });

    it('preserves small JSON payloads for replay', () => {
        const payload = {
            id: 'geonames:2867714',
            name: 'Munich, DE',
            lonLat: [11.57549, 48.13743],
            aabb: [[11.57549, 48.13743], [0, 0]],
            source: 'geonames-cities5000',
            providerId: 'mapget-offline',
            providerName: 'Place',
        };
        const entry = normalizeResolvedOmnibarHistoryEntry({
            version: 2,
            actionId: 'loc:mapget-offline:geonames:2867714',
            input: 'munich',
            payload,
        });

        expect(entry?.payload).toEqual(payload);
    });

    it('drops unserializable and oversized payloads', () => {
        const circular: any = {};
        circular.self = circular;

        expect(normalizeOmnibarHistoryPayload(circular)).toBeUndefined();
        expect(normalizeOmnibarHistoryPayload({value: 'x'.repeat(9000)})).toBeUndefined();
    });

    it('deduplicates by action id and input', () => {
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

        expect(historyEntryDedupeKey(first)).toBe(historyEntryDedupeKey(second));
    });
});
