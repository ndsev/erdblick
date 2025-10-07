import {BehaviorSubject, distinctUntilChanged, map, Observable, OperatorFunction} from "rxjs";
import {z, ZodTypeAny} from "zod";
import {Params} from "@angular/router";
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
    return String(val)
        .split(':')
        .map(seg => (seg === '' ? [] : splitCSV(seg)));
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
                    const value = this.postprocess ? this.postprocess(verified as any, this.getValue()) : verified;
                    this.next(value as T);
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
                const value = this.postprocess ? this.postprocess(verified as any, this.getValue()) : verified;
                this.next(value as T);
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

    constructor(pool: Map<string, AppState<unknown>>, options: AppStateOptions<T>) {
        this.appState = new AppState(pool, {
            name: options.name,
            defaultValue: [options.defaultValue],
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
                    return options.fromStorage!(el as ZodTypeAny, i < currentValue.length ? currentValue[i] : options.defaultValue);
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
                currentValue.push(this.appState.defaultValue[0]);
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
        return arr[viewIndex] !== undefined ? arr[viewIndex] : this.appState.defaultValue[0];
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
