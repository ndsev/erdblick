import {BehaviorSubject, distinctUntilChanged, map, Observable, OperatorFunction} from "rxjs";
import {z, ZodTypeAny} from "zod";
import type {Params} from "@angular/router";
import {environment} from "../environments/environment";

export type AppStateToStorageFun<T> = (value: T) => unknown;
export type AppStateFromStorageFun<T> = (value: ZodTypeAny, currentValue: T) => T;

export interface AppStateOptions<T> {
    name: string;
    defaultValue: T;
    schema: ZodTypeAny;
    toStorage?: AppStateToStorageFun<T>;
    fromStorage?: AppStateFromStorageFun<T>;
    urlParamName?: string;
    urlFormEncode?: boolean;
    urlIncludeInVisualizationOnly?: boolean;
}

export const Boolish = z.union([
    z.boolean(),
    z.string()
        .transform(value => value.trim().toLowerCase())
        .refine(value => ['true', 'false', '1', '0'].includes(value))
        .transform(value => value === 'true' || value === '1'),
    z.number().refine(value => value === 0 || value === 1).transform(value => value === 1),
]);

// TODO: Do we actually need this?
function unwrapScalar(schema: z.ZodTypeAny): z.ZodTypeAny {
    // unwrap until it stabilizes
    while (true) {
        if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
            schema = (schema as any)._def.innerType;
            continue;
        }
        if (schema instanceof z.ZodLazy) {
            schema = (schema as any).schema;
            continue;
        }
        break;
    }
    return schema;
}

function isScalar(schema: z.ZodTypeAny): boolean {
    if (schema === Boolish) {
        return true;
    }
    if (schema instanceof z.ZodUnion) {
        return schema.options.every(opt => isScalar(opt as ZodTypeAny));
    }
    const unwrapped = unwrapScalar(schema);
    const scalarKinds = [
        z.ZodString,
        z.ZodNumber,
        z.ZodBoolean,
        z.ZodBigInt,
        z.ZodDate,
        z.ZodSymbol,
        z.ZodUndefined,
        z.ZodNull,
    ];
    return scalarKinds.some(type => unwrapped instanceof type);
}

function coerceFromString(txt: string, schema: ZodTypeAny): any {
    const unwrapped = unwrapScalar(schema);

    if (unwrapped === Boolish || unwrapped instanceof z.ZodBoolean) {
        const v = txt.trim().toLowerCase();
        return v === '1' || v === 'true';
    }
    if (unwrapped instanceof z.ZodNumber) return Number(txt);
    if (unwrapped instanceof z.ZodString) return txt;
    return txt; // unions/refinements/others: let zod finalize
}

function splitCSV(val: string): string[] {
    if (!val) {
        return [];
    }
    return String(val)
        .split(',')
        .map(s => decodeURIComponent(s))
        .filter(s => s.length > 0 || s === '');
}

function joinCSV(values: unknown[]): string {
    return values.map(v => encodeURIComponent(String(compactBooleans(v)))).join(',');
}

/** Detect array-of-arrays-of-primitives */
function isArrayOfPrimitiveArrays(schema: z.ZodTypeAny): schema is z.ZodArray<z.ZodArray<ZodTypeAny>> {
    if (!(schema instanceof z.ZodArray)) return false;
    const el = (schema as z.ZodArray<any>).element;
    if (!(el instanceof z.ZodArray)) return false;
    const inner = (el as z.ZodArray<any>).element as ZodTypeAny;
    return isScalar(inner);
}

/**
 * Use colon ":" to join of CSV groups
 * */
function joinColonCSV(groups: unknown[][]): string {
    return groups.map(g => joinCSV(g)).join(':');
}

/**
 * Split by colon ":" into CSV groups; empty segment => empty array
 * */
function splitColonCSV(val: string): string[][] {
    if (!val) {
        return [];
    }
    return String(val)
        .split(':')
        .map(seg => (seg === '' ? [] : splitCSV(seg)));
}

export function deepEquals(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }

    // Handle NaN comparisons explicitly
    if (typeof a === 'number' && typeof b === 'number') {
        return Number.isNaN(a) && Number.isNaN(b);
    }

    if (a === null || b === null) {
        return false;
    }

    const typeA = typeof a;
    const typeB = typeof b;
    if (typeA !== typeB) {
        return false;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!deepEquals(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }

    if (typeA === 'object') {
        // Treat Date objects explicitly
        if (a instanceof Date && b instanceof Date) {
            return a.getTime() === b.getTime();
        }

        if (Array.isArray(a) || Array.isArray(b)) {
            return false;
        }

        const objA = a as Record<string, unknown>;
        const objB = b as Record<string, unknown>;
        const keysA = Object.keys(objA);
        const keysB = Object.keys(objB);
        if (keysA.length !== keysB.length) {
            return false;
        }
        for (const key of keysA) {
            if (!Object.prototype.hasOwnProperty.call(objB, key)) {
                return false;
            }
            if (!deepEquals(objA[key], objB[key])) {
                return false;
            }
        }
        return true;
    }

    return false;
}

function deepCopy<V>(value: V): V {
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (value instanceof Date) {
        return new Date(value.getTime()) as unknown as V;
    }
    if (Array.isArray(value)) {
        return value.map(item => deepCopy(item)) as unknown as V;
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        result[key] = deepCopy(entry);
    }
    return result as V;
}

export class AppState<T> extends BehaviorSubject<T> {
    readonly name: string;
    readonly defaultValue: T;

    readonly urlParamName?: string;
    readonly urlFormEncode: boolean;
    readonly urlIncludeInVisualizationOnly?: boolean;

    protected readonly preprocess?: AppStateToStorageFun<T>;
    protected readonly postprocess?: AppStateFromStorageFun<T>;
    protected readonly schema: ZodTypeAny;

    constructor(pool: Map<string, AppState<unknown>>, options: AppStateOptions<T>) {
        super(options.defaultValue);
        this.name = options.name;
        this.defaultValue = options.defaultValue;

        this.schema = options.schema;
        this.preprocess = options.toStorage ?? (value => compactBooleans(value));
        this.postprocess = options.fromStorage;

        this.urlParamName = options.urlParamName;
        this.urlFormEncode = options.urlFormEncode ?? false;
        this.urlIncludeInVisualizationOnly = options.urlIncludeInVisualizationOnly;

        if (pool.has(options.name)) {
            console.warn(`[AppState] Duplicate state name detected: ${options.name}. Overwriting previous instance.`);
        }
        pool.set(options.name, this as unknown as AppState<unknown>);
    }

    resetToDefault(): void {
        this.next(this.defaultValue);
    }

    private isArray(): this is AppState<unknown[]> {
        return this.schema instanceof z.ZodArray;
    }

    private arrayElemSchema(): ZodTypeAny | undefined {
        return this.isArray() ? (this.schema as z.ZodArray<any>).element : undefined;
    }

    private arrayIsPrimitive(): boolean {
        const el = this.arrayElemSchema();
        return !!el && isScalar(el);
    }

    private arrayIsFormObject(): boolean {
        const el = this.arrayElemSchema();
        return !!el && (unwrapScalar(el) instanceof z.ZodObject) && this.urlFormEncode;
    }

    isUrlState(): boolean {
        return (this.urlParamName !== undefined || this.urlFormEncode) &&
            !(environment.visualizationOnly && this.urlIncludeInVisualizationOnly === false);
    }

    serialize(forUrl: boolean): Record<string, string> | undefined {
        if (forUrl && !this.isUrlState()) {
            return undefined;
        }

        try {
            const result: Record<string, string> = {};
            const value = this.getValue();
            const payload = this.preprocess ? this.preprocess(value) : value;

            // Array-aware URL encoding
            if (forUrl && this.isArray()) {
                const base = this.urlParamName ?? this.name;

                // Array of primitives -> single CSV
                if (this.arrayIsPrimitive()) {
                    result[base] = joinCSV(payload as unknown[]);
                    return result;
                }

                // Array of arrays of primitives -> colon-separated CSV groups
                if (isArrayOfPrimitiveArrays(this.schema)) {
                    result[base] = joinColonCSV(payload as unknown[][]);
                    return result;
                }

                // Array of objects w/ form encoding -> base_field=csv
                if (this.arrayIsFormObject()) {
                    const elSchema = this.arrayElemSchema() as z.ZodObject<any>;
                    const shape = (unwrapScalar(elSchema) as z.ZodObject<any>).shape as Record<string, ZodTypeAny>;
                    for (const field of Object.keys(shape)) {
                        const column = (payload as any[]).map(item => (item ?? {})[field]);
                        result[field] = joinCSV(column);
                    }
                    return result;
                }

                // Other arrays -> JSON
                result[base] = JSON.stringify(payload);
                return result;
            }

            // Non-URL path OR non-arrays
            if (forUrl) {
                if (this.urlFormEncode) {
                    for (const formField of this.getFormFieldNames()) {
                        result[formField] = String((payload as Record<string, any>)[formField]);
                    }
                    return result;
                }
                result[this.urlParamName!] = isScalar(this.schema) ? String(payload) : JSON.stringify(payload);
                return result;
            } else {
                result[this.name] = JSON.stringify(payload);
            }
            return result;
        } catch (error) {
            console.warn(`[AppState:${this.name}] Failed to serialize value`, error);
            return undefined;
        }
    }

    deserialize(raw: string | Params) {
        try {
            // Raw storage path (JSON string)
            if (typeof raw === 'string') {
                if (raw) {
                    const parsed = JSON.parse(raw);
                    const verified = this.schema.parse(parsed);
                    const currentValue = this.getValue();
                    const value = this.postprocess ? this.postprocess(verified as any, currentValue) : verified;
                    if (!deepEquals(currentValue, value as T)) {
                        this.next(value as T);
                    }
                }
                return;
            }

            // No need to update from URL params if this is not a URL state.
            if (!this.isUrlState())
                return;

            let parsed: unknown = undefined;
            const base = this.urlParamName ?? this.name;

            // Array path
            if (this.isArray()) {
                const elSchema = this.arrayElemSchema()!;

                // Array of primitives from CSV
                if (this.arrayIsPrimitive() && raw[base] !== undefined) {
                    const parts = splitCSV(String(raw[base]));
                    parsed = parts.map(s => coerceFromString(s, elSchema));
                }
                // Array of arrays of primitives from colon-separated CSV
                else if (isArrayOfPrimitiveArrays(this.schema) && raw[base] !== undefined) {
                    const inner = (elSchema as z.ZodArray<any>).element as ZodTypeAny; // inner primitive schema
                    const groups = splitColonCSV(String(raw[base])); // string[][]
                    parsed = groups.map(group => group.map(s => coerceFromString(s, inner)));
                }
                // Array of objects from per-field CSV
                else if (this.arrayIsFormObject()) {
                    const shape = (unwrapScalar(elSchema) as z.ZodObject<any>).shape as Record<string, ZodTypeAny>;
                    const fieldArrays: Record<string, string[]> = {};
                    let maxLen = 0;

                    for (const field of Object.keys(shape)) {
                        if (raw[field] === undefined)
                            continue;
                        const arr = splitCSV(String(raw[field]));
                        fieldArrays[field] = arr;
                        if (arr.length > maxLen) maxLen = Math.max(maxLen, arr.length);
                    }

                    if (maxLen > 0) {
                        const items: any[] = new Array(maxLen).fill(null).map(() => ({}));
                        for (const field of Object.keys(shape)) {
                            const col = fieldArrays[field] ?? [];
                            const singleton = col.length === 1 ? col[0] : undefined;
                            for (let i = 0; i < maxLen; i++) {
                                const rawVal = col[i] ?? singleton;
                                if (rawVal === undefined) continue;
                                items[i][field] = coerceFromString(rawVal, shape[field]);
                            }
                        }
                        parsed = items;
                    }
                }
                // Other arrays -> JSON param
                else if (raw[base] !== undefined) {
                    parsed = JSON.parse(String(raw[base]));
                }
            }
            // Non-array
            else if (this.urlFormEncode) {
                const collected: Record<string, string> = {};
                for (const field of this.getFormFieldNames()) {
                    if (raw[field] !== undefined) collected[field] = raw[field];
                }
                parsed = Object.keys(collected).length ? collected : undefined;
            }
            // Accept `"0"` and `""` etc. (only skip if truly undefined)
            else if (raw[this.urlParamName!] !== undefined) {
                parsed = isScalar(this.schema) ? raw[this.urlParamName!] : JSON.parse(raw[this.urlParamName!]);
            }

            if (parsed !== undefined) {
                const verified = this.schema.parse(parsed);
                const currentValue = this.getValue();
                const value = this.postprocess ? this.postprocess(verified as any, currentValue) : verified;
                if (!deepEquals(currentValue, value as T)) {
                    this.next(value as T);
                }
            }
        } catch (error) {
            console.error(`[AppState:${this.name}:${this.urlParamName}] Failed to deserialize value from `, raw, error);
        }
    }

    getFormFieldNames(): readonly string[] {
        // Keep original behavior for non-array object states
        if (!this.urlFormEncode || !(unwrapScalar(this.schema) instanceof z.ZodObject)) return [];
        return Object.keys((unwrapScalar(this.schema) as z.ZodObject<any>).shape);
    }
}

export class MapViewState<T> {
    public appState: AppState<Array<T>>;
    private readonly defaultValue: T;

    constructor(pool: Map<string, AppState<unknown>>, options: AppStateOptions<T>) {
        this.defaultValue = deepCopy(options.defaultValue);
        this.appState = new AppState(pool, {
            name: options.name,
            defaultValue: [deepCopy(options.defaultValue)],
            schema: z.array(options.schema),
            toStorage: (array: Array<T>) => {
                if (options.toStorage === undefined) {
                    return array;
                }
                return array.map(options.toStorage);
            },
            fromStorage: (value: ZodTypeAny, currentValue: Array<T>): Array<T> => {
                if (options.fromStorage === undefined) {
                    return value as unknown as Array<T>;
                }
                return (value as unknown as Array<any>).map((el, i) => {
                    const current = i < currentValue.length ? currentValue[i] : deepCopy(this.defaultValue);
                    return options.fromStorage!(el as ZodTypeAny, current);
                })
            },
            urlParamName: options.urlParamName,
            urlFormEncode: options.urlFormEncode,
            urlIncludeInVisualizationOnly: options.urlIncludeInVisualizationOnly
        });
    }

    next(viewIndex: number, value: T) {
        const currentValue = [...this.appState.getValue()];
        if (viewIndex >= currentValue.length) {
            for (let i = currentValue.length; i <= viewIndex; ++i) {
                currentValue.push(deepCopy(this.defaultValue));
            }
        }
        currentValue[viewIndex] = value;
        this.appState.next(currentValue);
    }

    subscribe(viewIndex: number, cb: (value: T) => void) {
        return this.appState.pipe(
            map(arr => (arr[viewIndex] !== undefined ? arr[viewIndex] : this.appState.defaultValue[0])),
            distinctUntilChanged()
        ).subscribe(cb);
    }

    pipe<R = T>(viewIndex: number, ...ops: OperatorFunction<T, any>[]): Observable<R> {
        const base$ = this.appState.pipe(
            map(arr => (arr[viewIndex] !== undefined ? arr[viewIndex] : this.appState.defaultValue[0])),
            distinctUntilChanged()
        );
        return ops.length ? (base$ as any).pipe(...ops) : (base$ as unknown as Observable<R>);
    }

    getValue(viewIndex: number): T {
        const arr = this.appState.getValue();
        if (arr[viewIndex] !== undefined) {
            return arr[viewIndex];
        }
        return deepCopy(this.defaultValue);
    }

    length() {
        return this.appState.getValue().length;
    }
}

function compactBooleans(value: unknown): unknown {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    if (Array.isArray(value)) {
        return value.map(item => compactBooleans(item));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, compactBooleans(entry)]));
    }
    return value;
}

/**
 * Style Option State Encoding:
 *
 *    We have a compact schema for encoding style option values on a
 *    per-stylesheet per-map-layer per-view basis. For each style sheet,
 *    we encode its option values in a single URL parameter. This URL
 *    parameter is composed as follows:
 *
 *    <short-style-id>~<dash-separated-layerName-indices>~<tilde-separated-option-names>=
 *    <tilde-separated-array-per-option-of-colon-separated-array-per-view-of-comma-separated-values-per-layer>
 *
 * For example:
 *
 *    NY0X~1-2-3~showLanes~showLaneGroups~ADAS=1,0,0:1,0,0~1,1,1:0,0,0~0,0,0:0,0,0
 *
 *    NY0X   - is the short style id.
 *    1-2-3  - The indices of the layer names in the layerNames state for which values are stored.
 *    showLanes~showLaneGroups~ADAS - The style option IDs for which values are stored.
 *    1,0,0:1,0,0~1,1,1:0,0,0~0,0,0:0,0,0 - breaks down into three pairs of tilde-separated per-view-per-layer option value arrays:
 *    a) 1,0,0:1,0,0 - The values for the showLanes option. Two arrays of values (one for each map view).
 *                     Three values, as there are three affected layers (1-2-3).
 *    b) 1,1,1:0,0,0 - The values for the showLaneGroups option. Again, two sets of values (per view) and three values
 *                     (one per layer) per view.
 *    b) 0,0,0:0,0,0 - The values for the ADAS option. Same encoding as for showLanes and showLaneGroups.
 */
export class StyleState extends AppState<Map<string, (string|number|boolean)[]>> {
    layerNamesState: AppState<string[]>;
    numViewsState: AppState<number>;

    constructor(pool: Map<string, AppState<unknown>>) {
        super(pool, {
            name: "styleOptions",
            schema: z.record(z.string(), z.string()),
            defaultValue: new Map<string, (string|number|boolean)[]>()
        });
        const layerNamesState = pool.get("layerNames");
        if (layerNamesState === undefined) {
            throw Error("Expected layerNames state, got undefined!");
        }
        // Backward-compat: accept either 'numberOfViews' or legacy 'numViews'
        const numViewsState = pool.get("numberOfViews");
        if (numViewsState === undefined) {
            throw Error("Expected numberOfViews state, got undefined!");
        }
        this.layerNamesState = layerNamesState as AppState<string[]>;
        this.numViewsState = numViewsState as AppState<number>;
    }

    override isUrlState(): boolean {
        return true;
    }

    override serialize(_: boolean): Record<string, string> | undefined {
        const result: Record<string, string> = {};
        if (this.value.size === 0) {
            return result;
        }

        const layerNames = this.layerNamesState.getValue();
        const numViews = this.numViewsState.getValue();

        // Group by style -> option -> mapLayerId
        // E.g. {
        //   'NY0X': {
        //     'showLanes': {'Bavaria/Island2/Lane': [0, 1], 'Bavaria/Island6/Lane': [0, 0]},
        //     'showLaneGroups': {'Bavaria/Island2/Lane': [0, 0], 'Bavaria/Island6/Lane': [1, 1]}
        //   }
        // }
        const grouped = new Map<string, Map<string, Map<string, (string|number|boolean)[]>>>();

        for (const [fullKey, values] of this.value.entries()) {
            const fullKeyParts = fullKey.split("/");
            const optionId = fullKeyParts[fullKeyParts.length - 1];
            const shortStyleId = fullKeyParts[fullKeyParts.length - 2];
            const mapLayerId = fullKeyParts.slice(0, -2).join("/");
            const layerIndex = layerNames.indexOf(mapLayerId);
            if (layerIndex < 0) {
                continue; // ignore layers not present anymore
            }
            if (!grouped.has(shortStyleId)) {
                grouped.set(shortStyleId, new Map());
            }
            const byOption = grouped.get(shortStyleId)!;
            if (!byOption.has(optionId)) {
                byOption.set(optionId, new Map());
            }
            const byLayer = byOption.get(optionId)!;

            if (values.length < numViews) {
                throw new Error(`Styles serialization error: Expected length: ${numViews}, got: ${values.length}!`);
            } else if (values.length > numViews) {
                byLayer.set(mapLayerId, values.slice(0, numViews));
            } else {
                byLayer.set(mapLayerId, values);
            }
        }

        // Build one param per style id
        for (const [shortStyleId, byOption] of grouped.entries()) {
            // Determine layer indices to include (union across options)
            const layerSet = new Set<number>();
            for (const byLayer of byOption.values()) {
                for (const mapLayerId of byLayer.keys()) {
                    const idx = layerNames.indexOf(mapLayerId);
                    if (idx >= 0) {
                        layerSet.add(idx);
                    }
                }
            }
            if (layerSet.size === 0) {
                continue;
            }

            // Build value body per option
            const optionBodies: string[] = [];
            for (const optionId of byOption.keys()) {
                const byLayer = byOption.get(optionId)!;
                const perViewStrings: string[] = [];
                for (let view = 0; view < numViews; view++) {
                    const perLayerValues: string[] = [];
                    for (const li of layerSet) {
                        const mapLayerId = layerNames[li];
                        const arr = byLayer.get(mapLayerId) ?? [];
                        const raw = arr[view];
                        const enc = (val: any) => {
                            if (typeof val === 'boolean') return val ? '1' : '0';
                            if (typeof val === 'number') return String(val);
                            if (val === null || val === undefined) return '';
                            return String(val);
                        };
                        perLayerValues.push(enc(raw));
                    }
                    perViewStrings.push(perLayerValues.join(','));
                }
                optionBodies.push(perViewStrings.join(':'));
            }

            const paramKey = `${shortStyleId}~${[...layerSet].join('-')}~${[...byOption.keys()].join('~')}`;
            result[paramKey] = optionBodies.join('~');
        }

        return result;
    }

    override deserialize(raw: string | Params) {
        // A raw local storage string must be converted to the Record<string, string>
        if (typeof raw === 'string') {
            raw = JSON.parse(raw);
            z.parse(this.schema, raw);
        }

        const layerNames = this.layerNamesState.getValue();
        const numViews = this.numViewsState.getValue();

        for (const [key, value] of Object.entries(raw)) {
            if (!this.isStyleOptionUrlParamKey(key)) {
                continue;
            }
            const parts = key.split('~');
            const shortStyleId = parts[0];
            const layerIndices = parts[1].split('-').map(s => Number(s)).filter(n => Number.isFinite(n));
            const optionIds = parts.slice(2); // remaining parts are option IDs

            if (!optionIds.length || !layerIndices.length) {
                continue;
            }

            // Split value by '~' per option, same order as in key
            const optionValueSegments = value.split('~');
            if (optionValueSegments.length < optionIds.length) {
                // If fewer bodies than option ids, skip
                continue;
            }

            for (let oi = 0; oi < optionIds.length; oi++) {
                const optionId = optionIds[oi];
                const optionBody = optionValueSegments[oi] ?? '';
                const perView = optionBody.split(':'); // per-view strings

                for (let view = 0; view < numViews; view++) {
                    const layerCsv = perView[view] ?? '';
                    const perLayer = layerCsv.length ? layerCsv.split(',') : [];
                    for (let li = 0; li < layerIndices.length; li++) {
                        const layerIndex = layerIndices[li];
                        if (layerIndex < 0 || layerIndex >= layerNames.length) {
                            continue;
                        }
                        const mapLayerId = layerNames[layerIndex];
                        const storeKey = this.styleOptionKeyFromMapLayer(mapLayerId, shortStyleId, optionId);
                        const valuesForStoreKey = this.value.get(storeKey) || [];
                        const rawVal = perLayer[li] ?? '';

                        // Ensure length up to current view
                        while (valuesForStoreKey.length <= view) {
                            valuesForStoreKey.push(false);
                        }
                        valuesForStoreKey[view] = rawVal;
                        this.value.set(storeKey, valuesForStoreKey);
                    }
                }
            }
        }
    }

    private isStyleOptionUrlParamKey(key: string): boolean {
        // Example: NY0X~1-2-3~showLanes~showLaneGroups
        // Constraints: at least 3 segments separated by '~' (styleId, layers, one option)
        if (!key) {
            return false;
        }
        const parts = key.split('~');
        if (parts.length < 3) return false;
        // layers part must be dash-separated indices
        const layerPart = parts[1];
        return /^\d+(?:-\d+)*$/.test(layerPart);
    }

    public styleOptionKey(mapId: string, layerId: string, shortStyleId: string, optionId: string): string {
        // Use a slash-delimited compound key; mapId may contain '/'.
        const mapLayerId = `${mapId}/${layerId}`;
        return `${mapLayerId}/${shortStyleId}/${optionId}`;
    }

    private styleOptionKeyFromMapLayer(mapLayerId: string, shortStyleId: string, optionId: string): string {
        return `${mapLayerId}/${shortStyleId}/${optionId}`;
    }

    public coerceOptionValue(value: any, optionType: string): string|number|boolean {
        const t = (optionType || '').toLowerCase();
        if (t === 'bool' || t === 'boolean') {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'number') return value !== 0;
            if (typeof value === 'string') {
                const v = value.trim().toLowerCase();
                return v === '1' || v === 'true';
            }
            return false;
        }
        if (t === 'number') {
            if (typeof value === 'number') return value;
            const n = Number(value);
            return Number.isNaN(n) ? 0 : n;
        }
        if (t === 'string') {
            if (value === null || value === undefined) return '';
            return String(value);
        }
        // Default to boolean semantics
        return typeof value === 'boolean' ? value : false;
    }
}
