import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { AppState, Boolish, MapViewState } from './app-state';

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
