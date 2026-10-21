import { describe, expect, it } from 'vitest';
import { parseWgs84CoordinateString } from './wgs84-coordinate.util';

describe('shared WGS84 coordinate parser', () => {
    it('preserves decimal order and the optional tile level', () => {
        expect(parseWgs84CoordinateString('11.5,48.25,13', true)).toEqual({ lon: 11.5, lat: 48.25, level: 13 });
        expect(parseWgs84CoordinateString('48.25,11.5')).toEqual({ lon: 11.5, lat: 48.25, level: 0 });
    });
    it('applies southern and western hemispheres in both degree-minute-second orders', () => {
        expect(parseWgs84CoordinateString('11°30\'00"W 48°15\'00"S', true)).toEqual({ lon: -11.5, lat: -48.25, level: 0 });
        expect(parseWgs84CoordinateString('48°15\'00"S 11°30\'00"W')).toEqual({ lon: -11.5, lat: -48.25, level: 0 });
    });
    it.each(['91,11', '48,181', 'ordinary text'])('rejects unavailable coordinates: %s', value => {
        expect(parseWgs84CoordinateString(value)).toBeUndefined();
    });
});
