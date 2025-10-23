// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { AppState, Boolish, MapViewState, StyleState } from './app-state';

describe('AppState', () => {
    it('serializes boolean values to compact JSON for storage', () => {
        const pool = new Map<string, AppState<unknown>>();
        const state = new AppState(pool, {
            name: 'testBool',
            defaultValue: false,
            schema: Boolish,
        });

        state.next(true);

        expect(state.serialize(false)).toEqual({
            testBool: '1',
        });
    });

    it('serializes primitive arrays as CSV when targeting the URL', () => {
        const pool = new Map<string, AppState<unknown>>();
        const state = new AppState(pool, {
            name: 'numbers',
            defaultValue: [0],
            schema: z.array(z.number()),
            urlParamName: 'n',
        });

        state.next([3, 4, 5]);

        expect(state.serialize(true)).toEqual({
            n: '3,4,5',
        });
    });

    it('serializes arrays of primitive arrays using colon-separated CSV groups', () => {
        const pool = new Map<string, AppState<unknown>>();
        const state = new AppState(pool, {
            name: 'matrix',
            defaultValue: [[0]],
            schema: z.array(z.array(z.number())),
            urlParamName: 'mx',
        });

        state.next([[1, 2], [3], []]);

        expect(state.serialize(true)).toEqual({
            mx: '1,2:3:',
        });
    });

    it('deserializes stored JSON payloads', () => {
        const pool = new Map<string, AppState<unknown>>();
        const state = new AppState(pool, {
            name: 'count',
            defaultValue: 0,
            schema: z.number(),
        });

        state.deserialize('5');

        expect(state.getValue()).toBe(5);
    });

    it('deserializes Boolish URL params', () => {
        const pool = new Map<string, AppState<unknown>>();
        const state = new AppState(pool, {
            name: 'flag',
            defaultValue: true,
            schema: Boolish,
            urlParamName: 'flag',
        });

        state.deserialize({ flag: '0' });

        expect(state.getValue()).toBe(false);
    });

    it('deserializes colon-separated CSV payloads into arrays of primitive arrays', () => {
        const pool = new Map<string, AppState<unknown>>();
        const state = new AppState(pool, {
            name: 'matrix',
            defaultValue: [[0]],
            schema: z.array(z.array(z.number())),
            urlParamName: 'mx',
        });

        state.deserialize({ mx: '4,5:6,7:' });

        expect(state.getValue()).toEqual([[4, 5], [6, 7], []]);
    });

    it('exposes field names for form-encoded objects', () => {
        const pool = new Map<string, AppState<unknown>>();
        const state = new AppState(pool, {
            name: 'formState',
            defaultValue: {
                foo: 'a',
                bar: 1,
            },
            schema: z.object({
                foo: z.string(),
                bar: z.number(),
            }),
            urlFormEncode: true,
        });

        expect(state.getFormFieldNames()).toEqual(['foo', 'bar']);
    });
});

describe('MapViewState', () => {
    it('extends the underlying array when writing to a higher view index', () => {
        const pool = new Map<string, AppState<unknown>>();
        const viewState = new MapViewState(pool, {
            name: 'views',
            defaultValue: 0,
            schema: z.number(),
        });

        viewState.next(2, 10);

        expect(viewState.getValue(0)).toBe(0);
        expect(viewState.getValue(1)).toBe(0);
        expect(viewState.getValue(2)).toBe(10);
        expect(viewState.length()).toBe(3);
    });
});

describe('StyleState', () => {
    function createLayerAndViewStates(pool: Map<string, AppState<unknown>>, layerNames: string[], numViews: number) {
        new AppState(pool, {
            name: 'layerNames',
            defaultValue: layerNames,
            schema: z.array(z.string()),
        });
        new AppState(pool, {
            name: 'numberOfViews',
            defaultValue: numViews,
            schema: z.number().int().positive(),
        });
    }

    it('serializes per-style option values across layers and views', () => {
        const pool = new Map<string, AppState<unknown>>();
        const layers = ['Bavaria/Island2/Lane', 'Bavaria/Island6/Lane'];
        createLayerAndViewStates(pool, layers, 2);
        const styles = new StyleState(pool);

        const key = (layer: string, style: string, opt: string) => {
            // Split mapId/layerId for the helper
            const [mapId, ...rest] = layer.split('/');
            return styles.styleOptionKey(mapId, rest.join('/'), style, opt);
        };

        const store = new Map<string, (string|number|boolean)[]>();
        // showLanes: [true,true] for first layer; [false,false] for second
        store.set(key('Bavaria/Island2/Lane', 'NY0X', 'showLanes'), [true, true]);
        store.set(key('Bavaria/Island6/Lane', 'NY0X', 'showLanes'), [false, false]);
        // showLaneGroups: [true,false] for both layers
        store.set(key('Bavaria/Island2/Lane', 'NY0X', 'showLaneGroups'), [true, false]);
        store.set(key('Bavaria/Island6/Lane', 'NY0X', 'showLaneGroups'), [true, false]);

        styles.next(store);

        const encoded = styles.serialize(true)!;
        expect(Object.keys(encoded)).toEqual(['NY0X~0-1~showLanes~showLaneGroups']);
        expect(encoded['NY0X~0-1~showLanes~showLaneGroups']).toBe('1,0:1,0~1,1:0,0');
    });

    it('deserializes URL params back into the internal map', () => {
        const pool = new Map<string, AppState<unknown>>();
        const layers = ['Bavaria/Island2/Lane', 'Bavaria/Island6/Lane'];
        createLayerAndViewStates(pool, layers, 2);
        const styles = new StyleState(pool);

        styles.resetToDefault();
        styles.deserialize({
            'NY0X~0-1~showLanes~showLaneGroups': '1,0:1,0~1,1:0,0',
        });

        const v = styles.getValue();
        const k = (layer: string, style: string, opt: string) => {
            const [mapId, ...rest] = layer.split('/');
            return styles.styleOptionKey(mapId, rest.join('/'), style, opt);
        };
        expect(v.get(k('Bavaria/Island2/Lane', 'NY0X', 'showLanes'))).toEqual(['1', '1']);
        expect(v.get(k('Bavaria/Island6/Lane', 'NY0X', 'showLanes'))).toEqual(['0', '0']);
        expect(v.get(k('Bavaria/Island2/Lane', 'NY0X', 'showLaneGroups'))).toEqual(['1', '0']);
        expect(v.get(k('Bavaria/Island6/Lane', 'NY0X', 'showLaneGroups'))).toEqual(['1', '0']);
    });

    it('throws on serialization if a value has fewer entries than views', () => {
        const pool = new Map<string, AppState<unknown>>();
        const layers = ['Bavaria/Island2/Lane'];
        createLayerAndViewStates(pool, layers, 2);
        const styles = new StyleState(pool);

        const k = styles.styleOptionKey('Bavaria', 'Island2/Lane', 'NY0X', 'showLanes');
        styles.next(new Map([[k, [true]]]));

        expect(() => styles.serialize(true)).toThrowError(/Expected length: 2/);
    });

    it('slices extra per-view values beyond the current number of views', () => {
        const pool = new Map<string, AppState<unknown>>();
        const layers = ['Bavaria/Island2/Lane'];
        createLayerAndViewStates(pool, layers, 2);
        const styles = new StyleState(pool);

        const k = styles.styleOptionKey('Bavaria', 'Island2/Lane', 'NY0X', 'opt');
        styles.next(new Map([[k, [true, false, true]]]))

        const encoded = styles.serialize(true)!;
        expect(encoded['NY0X~0~opt']).toBe('1:0'); // only first two views kept
    });

    it('coerceOptionValue converts by declared type', () => {
        const pool = new Map<string, AppState<unknown>>();
        createLayerAndViewStates(pool, [], 1);
        const styles = new StyleState(pool);

        expect(styles.coerceOptionValue('1', 'bool')).toBe(true);
        expect(styles.coerceOptionValue('true', 'boolean')).toBe(true);
        expect(styles.coerceOptionValue(0, 'boolean')).toBe(false);
        expect(styles.coerceOptionValue('foo', 'number')).toBe(0);
        expect(styles.coerceOptionValue('42', 'number')).toBe(42);
        expect(styles.coerceOptionValue(undefined, 'string')).toBe('');
        expect(styles.coerceOptionValue('abc', 'string')).toBe('abc');
    });

    it('styleOptionKey composes the compound key correctly', () => {
        const pool = new Map<string, AppState<unknown>>();
        createLayerAndViewStates(pool, [], 1);
        const styles = new StyleState(pool);
        expect(styles.styleOptionKey('Bavaria', 'Island2/Lane', 'NY0X', 'opt')).toBe('Bavaria/Island2/Lane/NY0X/opt');
    });

    it('isUrlState always returns true', () => {
        const pool = new Map<string, AppState<unknown>>();
        createLayerAndViewStates(pool, [], 1);
        const styles = new StyleState(pool);
        expect(styles.isUrlState()).toBe(true);
    });

    it('serialize returns empty object when no styles set', () => {
        const pool = new Map<string, AppState<unknown>>();
        createLayerAndViewStates(pool, ['Bavaria/Island2/Lane'], 1);
        const styles = new StyleState(pool);
        expect(styles.serialize(true)).toEqual({});
    });

    it('serialize excludes layers not present in layerNames', () => {
        const pool = new Map<string, AppState<unknown>>();
        createLayerAndViewStates(pool, ['Bavaria/Island2/Lane'], 1);
        const styles = new StyleState(pool);

        const kPresent = styles.styleOptionKey('Bavaria', 'Island2/Lane', 'NY0X', 'opt');
        const kMissing = styles.styleOptionKey('Unknown', 'Layer', 'NY0X', 'opt');
        styles.next(new Map([
            [kPresent, [true]],
            [kMissing, [false]],
        ]));

        const encoded = styles.serialize(true)!;
        expect(Object.keys(encoded)).toEqual(['NY0X~0~opt']);
        expect(encoded['NY0X~0~opt']).toBe('1');
    });

    it('serialize skips a style entirely if no layers match', () => {
        const pool = new Map<string, AppState<unknown>>();
        createLayerAndViewStates(pool, ['Bavaria/Island2/Lane'], 1);
        const styles = new StyleState(pool);
        const kMissing = styles.styleOptionKey('Unknown', 'Layer', 'NY0X', 'opt');
        styles.next(new Map([[kMissing, [true]]]));
        expect(styles.serialize(true)).toEqual({});
    });

    it('deserialize ignores keys that do not match the style option pattern', () => {
        const pool = new Map<string, AppState<unknown>>();
        createLayerAndViewStates(pool, ['Bavaria/Island2/Lane'], 1);
        const styles = new StyleState(pool);
        styles.resetToDefault();
        styles.deserialize({ notAStyleKey: '1,0' });
        expect(styles.getValue().size).toBe(0);
    });

    it('deserialize uses only in-range layer indices', () => {
        const pool = new Map<string, AppState<unknown>>();
        const layers = ['Bavaria/Island2/Lane', 'Bavaria/Island6/Lane'];
        createLayerAndViewStates(pool, layers, 1);
        const styles = new StyleState(pool);
        styles.resetToDefault();

        // Indices 0 and 1 exist; 99 must be ignored
        styles.deserialize({ 'NY0X~0-99-1~opt': 'A,B,C' });

        const v = styles.getValue();
        const k = (layer: string, style: string, opt: string) => {
            const [mapId, ...rest] = layer.split('/');
            return styles.styleOptionKey(mapId, rest.join('/'), style, opt);
        };
        expect(v.get(k(layers[0], 'NY0X', 'opt'))).toEqual(['A']);
        expect(v.get(k(layers[1], 'NY0X', 'opt'))).toEqual(['C']);
    });

    it('deserialize accepts raw JSON storage string', () => {
        const pool = new Map<string, AppState<unknown>>();
        createLayerAndViewStates(pool, ['Bavaria/Island2/Lane'], 1);
        const styles = new StyleState(pool);
        styles.resetToDefault();
        styles.deserialize('{"NY0X~0~opt":"1"}');
        const k = styles.styleOptionKey('Bavaria', 'Island2/Lane', 'NY0X', 'opt');
        expect(styles.getValue().get(k)).toEqual(['1']);
    });
});
