import type { Params } from "@angular/router";
import { distinctUntilChanged, map, Observable, OperatorFunction, Subject } from "rxjs";
import { z, ZodTypeAny } from "zod";
import { environment } from "../environments/environment";

/** Converts an app-state value into the representation stored in URL or local storage. */
export type AppStateToStorageFun<T> = (value: T) => unknown;
/** Restores an app-state value from persisted storage using the current value as context. */
export type AppStateFromStorageFun<T> = (value: ZodTypeAny, currentValue: T) => T;
export type AppStateSerializedValue = string | null;

/** A stored compatibility key derived from an owner's authoritative state. */
export interface AppStateProjection<T> {
    /** The compatibility key inherits persistence ownership from this authoritative slot. */
    sourceState: AppState<any>;
    read(): T;
    write(value: T): void;
    changes: Observable<T>;
}

/** Describes one persisted application state slot. */
export interface AppStateOptions<T> {
    name: string;
    defaultValue: T;
    schema: ZodTypeAny;
    toStorage?: AppStateToStorageFun<T>;
    fromStorage?: AppStateFromStorageFun<T>;
    urlParamName?: string;
    urlFormEncode?: boolean;
    urlIncludeInVisualizationOnly?: boolean;
    snapshotPersist?: boolean;
    configDefault?: boolean;
    normalize?: (value: T) => T;
}

/**
 * Shared boolean schema for storage/URL parsing.
 * Accepts booleans and common scalar encodings (`1/0`, `true/false`).
 */
export const Boolish = z.union([
    z.boolean(),
    z.string()
        .transform(value => value.trim().toLowerCase())
        .refine(value => ['true', 'false', '1', '0'].includes(value))
        .transform(value => value === 'true' || value === '1'),
    z.number().refine(value => value === 0 || value === 1).transform(value => value === 1),
]);

/**
 * Optional/default/nullable/lazy wrappers retain the primitive's compact URL encoding.
 * Inspect the underlying schema when coercing text; the original schema still validates
 * the resulting value and supplies optional/default behavior.
 */
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

/** Returns whether the schema encodes a scalar value that can be CSV-compacted. */
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
        z.ZodEnum,
        z.ZodLiteral,
        z.ZodSymbol,
        z.ZodUndefined,
        z.ZodNull,
    ];
    return scalarKinds.some(type => unwrapped instanceof type);
}

/** Coerces one URL/storage token into the primitive shape expected by the schema. */
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

/** Checks whether a compact run-length token is safe to expand for the given schema. */
function schemaAcceptsRunLengthValue(token: string, schema: ZodTypeAny): boolean {
    const unwrapped = unwrapScalar(schema);

    if (unwrapped === Boolish || unwrapped instanceof z.ZodBoolean) {
        return /^(?:0|1|true|false)$/i.test(token.trim());
    }
    if (unwrapped instanceof z.ZodNumber) {
        return Number.isFinite(Number(token));
    }
    if (unwrapped instanceof z.ZodEnum) {
        const values = Object.values((unwrapped as z.ZodEnum<any>).enum);
        return values.includes(token);
    }
    if (unwrapped instanceof z.ZodLiteral) {
        return String((unwrapped as z.ZodLiteral<any>).value) === token;
    }
    if (unwrapped instanceof z.ZodUnion) {
        return (unwrapped as z.ZodUnion<any>).options.some((opt: unknown) =>
            schemaAcceptsRunLengthValue(token, opt as ZodTypeAny)
        );
    }
    return false;
}

/** Expands compact `<value>x<count>` URL tokens when the schema supports them. */
function expandRunLengthTokens(parts: string[], schema: ZodTypeAny): string[] {
    const expanded: string[] = [];
    for (const token of parts) {
        // Compact URL values can use `<value>x<count>` (for example `1x5`).
        const match = token.match(/^(.*)x(\d+)$/);
        if (!match) {
            expanded.push(token);
            continue;
        }
        const valueToken = match[1];
        const count = Number(match[2]);
        if (!Number.isInteger(count) || count <= 1 || !schemaAcceptsRunLengthValue(valueToken, schema)) {
            expanded.push(token);
            continue;
        }
        for (let i = 0; i < count; i++) {
            expanded.push(valueToken);
        }
    }
    return expanded;
}

/** Splits a CSV string while URL-decoding individual segments. */
function splitCSV(val: string): string[] {
    if (!val) {
        return [];
    }
    return String(val)
        .split(',')
        .map(s => {
            try {
                return decodeURIComponent(s);
            } catch {
                return s;
            }
        })
        .filter(s => s.length > 0 || s === '');
}

/** Joins primitive values into the compact CSV form used in URLs. */
function joinCSV(values: unknown[]): string {
    return values.map(v => String(compactBooleans(v))).join(',');
}

/** Detects array values that were stored as JSON rather than compact CSV. */
function looksLikeJsonArray(raw: string): boolean {
    const trimmed = raw.trim();
    return trimmed.startsWith('[') && trimmed.endsWith(']');
}

/** Detect array-of-arrays-of-primitives */
function isArrayOfPrimitiveArrays(schema: z.ZodTypeAny): schema is z.ZodArray<z.ZodArray<ZodTypeAny>> {
    if (!(schema instanceof z.ZodArray)) return false;
    const el = (schema as z.ZodArray<any>).element;
    if (!(el instanceof z.ZodArray)) return false;
    const inner = (el as z.ZodArray<any>).element as ZodTypeAny;
    return isScalar(inner);
}

/** Joins arrays-of-arrays into the colon-delimited compact URL representation. */
function joinColonCSV(groups: unknown[][]): string {
    return groups.map(g => joinCSV(g)).join(':');
}

/** Splits colon-delimited CSV groups, preserving empty segments as empty arrays. */
function splitColonCSV(val: string): string[][] {
    if (!val) {
        return [];
    }
    return String(val)
        .split(':')
        .map(seg => (seg === '' ? [] : splitCSV(seg)));
}

/** Performs a structural equality check tailored to persisted state values. */
export function deepEquals(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (a instanceof Map && b instanceof Map) {
        return a.size === b.size && [...a].every(([key, value]) => b.has(key) && deepEquals(value, b.get(key)));
    }
    if (a instanceof Set && b instanceof Set) {
        return a.size === b.size && [...a].every(value => b.has(value));
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

/** Produces a defensive deep copy for state snapshots and change detection. */
export function deepCopy<V>(value: V): V {
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (value instanceof Date) {
        return new Date(value.getTime()) as unknown as V;
    }
    if (value instanceof Map) {
        return new Map([...value].map(([key, entry]) => [deepCopy(key), deepCopy(entry)])) as V;
    }
    if (value instanceof Set) {
        return new Set([...value].map(entry => deepCopy(entry))) as V;
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

/**
 * One persisted application state slot with schema validation and URL/storage codecs.
 *
 * URL encoding strategy is schema-aware:
 * - scalar arrays -> CSV (with optional run-length tokens),
 * - nested primitive arrays -> colon-separated CSV groups,
 * - form-encoded object arrays -> per-field CSV columns,
 * - everything else -> JSON.
 */
export class AppState<T> extends Observable<T> {
    private currentValue: T;
    private readonly normalize?: (value: T) => T;
    private readonly changes: Subject<T>;
    /** The persistence registry installs a synchronous publication boundary. */
    writeValue: ((value: T) => void) | undefined;
    readonly name: string;
    readonly defaultValue: T;

    readonly urlParamName?: string;
    readonly urlFormEncode: boolean;
    readonly urlIncludeInVisualizationOnly?: boolean;
    readonly snapshotPersist: boolean;
    readonly configDefault: boolean;

    protected readonly preprocess?: AppStateToStorageFun<T>;
    protected readonly postprocess?: AppStateFromStorageFun<T>;
    protected readonly schema: ZodTypeAny;

    /** Registers the state slot in the shared pool and seeds it with the default value. */
    constructor(pool: Map<string, AppState<unknown>>, options: AppStateOptions<T>, private readonly projection?: AppStateProjection<T>) {
        const changes = new Subject<T>();
        super(subscriber => {
            if (projection) return projection.changes.subscribe(subscriber);
            const subscription = changes.subscribe(subscriber);
            if (!subscriber.closed) subscriber.next(this.currentValue);
            return subscription;
        });
        this.changes = changes;
        this.normalize = options.normalize;
        this.currentValue = deepCopy(options.defaultValue);
        this.name = options.name;
        this.defaultValue = deepCopy(options.defaultValue);

        this.schema = options.schema;
        this.preprocess = options.toStorage ?? (value => compactBooleans(value));
        this.postprocess = options.fromStorage;

        this.urlParamName = options.urlParamName;
        this.urlFormEncode = options.urlFormEncode ?? false;
        this.urlIncludeInVisualizationOnly = options.urlIncludeInVisualizationOnly;
        this.snapshotPersist = options.snapshotPersist ?? true;
        this.configDefault = options.configDefault ?? this.snapshotPersist;

        if (pool.has(options.name)) {
            throw new Error(`Duplicate state registration: ${options.name}`);
        }
        pool.set(options.name, this as unknown as AppState<unknown>);
    }

    /** Reads staged values during a coordinated edit, before observers are notified. */
    getValue(): T {
        return this.projection ? this.projection.read() : this.currentValue;
    }

    get value(): T {
        return this.getValue();
    }

    /** Publishes immediately for a single edit, or at the enclosing transaction boundary. */
    next(value: T): void {
        if (this.normalize) value = this.normalize(value);
        if (this.projection) {
            if (!deepEquals(this.getValue(), value)) this.projection.write(value);
            return;
        }
        if (this.writeValue) { this.writeValue(value); return; }
        if (deepEquals(this.currentValue, value)) return;
        this.stage(deepCopy(value));
        this.publish();
    }

    /** Registry-only phase: install a value before any slot observer is notified. */
    stage(value: T): void {
        if (this.projection) throw new Error("A derived persistence value cannot be staged independently.");
        this.currentValue = value;
    }

    /** Registry-only phase: notify readers after every participating slot is installed. */
    publish(): void {
        this.changes.next(this.currentValue);
    }

    /** Restores the state to its configured default value. */
    resetToDefault(): void {
        // Callers can mutate live arrays/records; never let those edits become reset defaults.
        this.next(deepCopy(this.defaultValue));
    }

    /** Returns a detached value suitable for snapshot export. */
    toSnapshotValue(): unknown {
        const value = this.getValue();
        const payload = this.preprocess ? this.preprocess(value) : value;
        return deepCopy(payload);
    }

    /** Returns whether this state slot participates in snapshot import/export. */
    isSnapshotState(): boolean {
        return this.snapshotPersist;
    }

    /** Returns whether config-provided default state may seed this slot. */
    isConfigDefaultState(): boolean {
        return this.configDefault;
    }

    /** Validates a snapshot-import value against the state schema. */
    validateSnapshotValue(value: unknown): T {
        const verified = this.schema.parse(value);
        const currentValue = this.getValue();
        return (this.postprocess ? this.postprocess(verified as any, currentValue) : verified) as T;
    }

    /** Applies a validated snapshot-import value to this state slot. */
    applySnapshotValue(value: unknown): void {
        const currentValue = this.getValue();
        const nextValue = this.validateSnapshotValue(value);
        if (!deepEquals(currentValue, nextValue as T)) {
            this.next(nextValue as T);
        }
    }

    /** Returns whether the state schema encodes an array. */
    private isArray(): this is AppState<unknown[]> {
        return this.schema instanceof z.ZodArray;
    }

    /** Returns the element schema when the state value is an array. */
    private arrayElemSchema(): ZodTypeAny | undefined {
        return this.isArray() ? (this.schema as z.ZodArray<any>).element : undefined;
    }

    /** Returns whether the state is an array of primitive values. */
    private arrayIsPrimitive(): boolean {
        const el = this.arrayElemSchema();
        return !!el && isScalar(el);
    }

    /** Returns whether the state is an array of object values encoded via form fields. */
    private arrayIsFormObject(): boolean {
        const el = this.arrayElemSchema();
        return !!el && (unwrapScalar(el) instanceof z.ZodObject) && this.urlFormEncode;
    }

    /** Returns whether this state slot should participate in URL serialization. */
    isUrlState(): boolean {
        return (this.urlParamName !== undefined || this.urlFormEncode) &&
            !(environment.visualizationOnly && this.urlIncludeInVisualizationOnly === false);
    }

    /** Returns URL keys that must be cleared when this state encodes an empty value. */
    private urlKeys(): string[] {
        if (this.urlFormEncode) {
            if (this.isArray() && this.arrayIsFormObject()) {
                const elementSchema = this.arrayElemSchema() as z.ZodObject<any>;
                const shape = (unwrapScalar(elementSchema) as z.ZodObject<any>).shape as Record<string, ZodTypeAny>;
                return Object.keys(shape);
            }
            const formFieldNames = this.getFormFieldNames();
            if (formFieldNames.length) {
                return [...formFieldNames];
            }
        }
        return [this.urlParamName ?? this.name];
    }

    /** Returns whether the URL value is an old empty-array encoding that should not override storage. */
    private isEmptyArrayUrlValue(value: unknown): boolean {
        if (value === undefined || value === null) {
            return false;
        }
        const defaultPayload = this.preprocess ? this.preprocess(this.defaultValue) : this.defaultValue;
        if (!Array.isArray(defaultPayload) || defaultPayload.length !== 0) {
            return false;
        }
        const text = String(value).trim();
        return text === "" || text === "[]";
    }

    /** Serializes URL parameters (`forUrl=true`) or deployed local-storage key/value pairs. */
    serialize(forUrl: boolean): Record<string, AppStateSerializedValue> | undefined {
        if (forUrl && !this.isUrlState()) {
            return undefined;
        }

        try {
            const result: Record<string, AppStateSerializedValue> = {};
            const value = this.getValue();
            const payload = this.preprocess ? this.preprocess(value) : value;

            if (forUrl && Array.isArray(payload) && payload.length === 0) {
                for (const key of this.urlKeys()) {
                    result[key] = null;
                }
                return result;
            }

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

    /**
     * Deserialize from either a storage JSON string or URL params.
     * URL parsing mirrors `serialize()` and supports compact CSV/run-length forms.
     */
    /** Restores the state slot from URL params or local-storage key/value input. */
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
            if (this.isEmptyArrayUrlValue(raw[base])) {
                return;
            }

            // Array path
            if (this.isArray()) {
                const elSchema = this.arrayElemSchema()!;

                // Array of primitives from CSV
                if (this.arrayIsPrimitive() && raw[base] !== undefined) {
                    const rawValue = String(raw[base]);
                    if (looksLikeJsonArray(rawValue)) {
                        parsed = JSON.parse(rawValue);
                    } else {
                        const parts = expandRunLengthTokens(splitCSV(rawValue), elSchema);
                        parsed = parts.map(s => coerceFromString(s, elSchema));
                    }
                }
                // Array of arrays of primitives from colon-separated CSV
                else if (isArrayOfPrimitiveArrays(this.schema) && raw[base] !== undefined) {
                    const inner = (elSchema as z.ZodArray<any>).element as ZodTypeAny; // inner primitive schema
                    const groups = splitColonCSV(String(raw[base])); // string[][]
                    parsed = groups.map(group =>
                        expandRunLengthTokens(group, inner).map(s => coerceFromString(s, inner))
                    );
                }
                // Array of objects from per-field CSV
                else if (this.arrayIsFormObject()) {
                    const shape = (unwrapScalar(elSchema) as z.ZodObject<any>).shape as Record<string, ZodTypeAny>;
                    const fieldArrays: Record<string, string[]> = {};
                    let maxLen = 0;

                    for (const field of Object.keys(shape)) {
                        if (raw[field] === undefined)
                            continue;
                        const arr = expandRunLengthTokens(splitCSV(String(raw[field])), shape[field]);
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
                if (this.isEmptyArrayUrlValue(raw[this.urlParamName!])) {
                    return;
                }
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

    /** Returns flattened field names for object-array URL form encoding. */
    getFormFieldNames(): readonly string[] {
        // Keep original behavior for non-array object states
        if (!this.urlFormEncode || !(unwrapScalar(this.schema) instanceof z.ZodObject)) return [];
        return Object.keys((unwrapScalar(this.schema) as z.ZodObject<any>).shape);
    }
}

/**
 * Stores values by logical view identity. Only the deployed storage and URL formats
 * are positional: they project through the owner's current ordered identity list.
 * Numeric accessors are UI boundaries; subscriptions capture the resolved identity.
 */
export class MapViewState<T> {
    readonly appState: AppState<Record<string, T>>;
    private readonly defaultValue: T;

    constructor(
        pool: Map<string, AppState<unknown>>,
        options: AppStateOptions<T>,
        private readonly viewIds: () => readonly string[]
    ) {
        this.defaultValue = deepCopy(options.defaultValue);
        this.appState = new AppState<Record<string, T>>(pool, {
            ...options,
            defaultValue: {},
            normalize: options.normalize ? values => Object.fromEntries(Object.entries(values).map(([id, value]) => [id, options.normalize!(value)])) : undefined,
            schema: z.array(options.schema),
            toStorage: values => this.viewIds().map(id => {
                const value = values[id] ?? this.defaultValue;
                // Per-view storage/snapshot values retain their deployed boolean shape.
                // URL CSV encoding compacts them separately when required.
                return options.toStorage ? options.toStorage(value) : value;
            }),
            fromStorage: (payload, current) => Object.fromEntries(this.viewIds().map((id, index) => {
                const value = (payload as unknown as T[])[index];
                const previous = current[id] ?? deepCopy(this.defaultValue);
                return [id, value === undefined ? previous : options.fromStorage
                    ? options.fromStorage(value as ZodTypeAny, previous) : value];
            }))
        });
    }

    private resolve(view: number | string): string {
        const id = typeof view === "number" ? this.viewIds()[view] : view;
        if (id === undefined || !this.viewIds().includes(id)) throw new Error(`View ${view} is unavailable.`);
        return id;
    }

    next(view: number | string, value: T): void {
        const id = this.resolve(view);
        this.appState.next({ ...this.appState.value, [id]: value });
    }

    subscribe(view: number | string, callback: (value: T) => void) {
        return this.pipe(view).subscribe(callback);
    }

    pipe<R = T>(view: number | string, ...operators: OperatorFunction<T, any>[]): Observable<R> {
        const id = this.resolve(view);
        const changes = this.appState.pipe(
            map(values => values[id] ?? this.defaultValue),
            distinctUntilChanged(deepEquals)
        );
        return operators.length ? (changes as any).pipe(...operators) : changes as unknown as Observable<R>;
    }

    getValue(view: number | string): T {
        return this.appState.value[this.resolve(view)] ?? deepCopy(this.defaultValue);
    }

    /** Preserves positional defaults while a legacy import receives its first logical identities. */
    rekey(previousIds: readonly string[], ids: readonly string[]): void {
        const current = this.appState.value;
        this.appState.next(Object.fromEntries(ids.map((id, index) => [id,
            current[id] ?? current[previousIds[Math.min(index, previousIds.length - 1)]] ?? deepCopy(this.defaultValue)
        ])));
    }

    /** Removes retired values without changing any surviving identity association. */
    retain(ids: readonly string[]): void {
        this.appState.next(Object.fromEntries(Object.entries(this.appState.value).filter(([id]) => ids.includes(id))));
    }

    length(): number {
        return this.viewIds().length;
    }
}

/** Compacts booleans to `1`/`0` for shorter URL output, recursively. */
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

/** One scalar value supported by the style option editor and persistence codecs. */
export type StyleOptionValue = string | number | boolean;

/**
 * Stores style options by map/layer/style key and logical view identity.
 * The deployed URL format projects those values into positional arrays:
 *
 *    Style option values are encoded per style sheet, per referenced layer index
 *    and per view. One URL parameter stores all option bodies for one style key:
 *
 *    <short-style-id>~<dash-separated-layerName-indices>~<tilde-separated-option-names>=
 *    <tilde-separated-array-per-option-of-colon-separated-array-per-view-of-comma-separated-values-per-layer>
 *
 * For example:
 *
 *    STY0~0-2~showOptionA~showOptionB=1,0:1,1~5,7:6,8
 *
 *    STY0           - short style id.
 *    0-2            - indices into `layerNames`.
 *    showOptionA~showOptionB - option ids stored in-order.
 *    1,0:1,1        - option A values (`view0`, `view1`) for layer indices `0` and `2`.
 *    5,7:6,8        - option B values (`view0`, `view1`) for layer indices `0` and `2`.
 *
 */
export class StyleState extends AppState<Map<string, Record<string, StyleOptionValue>>> {
    layerNamesState: AppState<string[]>;

    /** Creates the specialized style state used for per-style option persistence. */
    constructor(pool: Map<string, AppState<unknown>>, private readonly viewIds: () => readonly string[]) {
        super(pool, {
            name: "styleOptions",
            schema: z.record(z.string(), z.string()),
            defaultValue: new Map<string, Record<string, StyleOptionValue>>(),
            snapshotPersist: false
        });
        const layerNamesState = pool.get("layerNames");
        if (layerNamesState === undefined) {
            throw Error("Expected layerNames state, got undefined!");
        }
        this.layerNamesState = layerNamesState as AppState<string[]>;
    }

    override isUrlState(): boolean {
        return true;
    }

    /** Positional projection used only at compatibility boundaries. */
    positionalValues(): Map<string, StyleOptionValue[]> {
        return new Map([...this.value].map(([key, values]) => [key, this.viewIds().map(id => values[id])]));
    }

    replacePositional(values: ReadonlyMap<string, readonly StyleOptionValue[]>): void {
        this.next(this.fromPositional(values));
    }

    private fromPositional(values: ReadonlyMap<string, readonly StyleOptionValue[]>): Map<string, Record<string, StyleOptionValue>> {
        return new Map([...values].map(([key, values]) => [key, Object.fromEntries(
            this.viewIds().flatMap((id, index) => values[index] === undefined ? [] : [[id, values[index]]])
        )]));
    }

    rekey(previousIds: readonly string[], ids: readonly string[]): void {
        this.next(new Map([...this.value].map(([key, values]) => [key, Object.fromEntries(ids.flatMap((id, index) => {
            const value = values[id] ?? values[previousIds[Math.min(index, previousIds.length - 1)]];
            return value === undefined ? [] : [[id, value]];
        }))])));
    }

    retain(ids: readonly string[]): void {
        this.next(new Map([...this.value].map(([key, values]) => [key,
            Object.fromEntries(Object.entries(values).filter(([id]) => ids.includes(id)))
        ])));
    }

    override toSnapshotValue(): unknown {
        return Object.fromEntries(this.positionalValues());
    }

    override validateSnapshotValue(value: unknown): Map<string, Record<string, StyleOptionValue>> {
        const parsed = z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))).parse(value);
        return this.fromPositional(new Map(Object.entries(parsed)));
    }

    override serialize(_: boolean): Record<string, string> | undefined {
        const result: Record<string, string> = {};
        if (this.value.size === 0) {
            return result;
        }

        const layerNames = this.layerNamesState.getValue();
        const numViews = this.viewIds().length;

        // Group by style -> option -> mapLayerId
        // E.g. {
        //   'STY0': {
        //     'showOptionA': {'MapA/LayerX': [0, 1], 'MapB/LayerX': [0, 0]},
        //     'showOptionB': {'MapA/LayerX': [0, 0], 'MapB/LayerX': [1, 1]}
        //   }
        // }
        const grouped = new Map<string, Map<string, Map<string, (string | number | boolean)[]>>>();

        for (const [fullKey, values] of this.positionalValues()) {
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

            if (values.length < numViews || values.some(value => value === undefined)) {
                console.warn(`[StyleState.serialize]: Omitting option ${fullKey}: Expected ${numViews} values, got: ${values.length}!`);
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
        try {
            // A raw local storage string must be converted to the Record<string, string>
            if (typeof raw === 'string') {
                raw = JSON.parse(raw);
                z.parse(this.schema, raw);
            }

            const layerNames = this.layerNamesState.getValue();
            const numViews = this.viewIds().length;

            const nextValues = this.positionalValues();
            for (const [key, value] of Object.entries(raw)) {
                if (!this.isStyleOptionUrlParamKey(key)) {
                    continue;
                }
                if (typeof value !== 'string') {
                    console.warn(`[StyleState.deserialize]: Skipping style option ${key}: expected string payload.`);
                    continue;
                }
                const parts = key.split('~');
                const shortStyleId = parts[0];
                const layerPart = parts[1] ?? '';
                const layerIndices = layerPart.split('-').map(s => Number(s)).filter(n => Number.isFinite(n));
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
                    const optionId = this.normalizeStyleOptionId(optionIds[oi]);
                    const optionBody = optionValueSegments[oi] ?? '';
                    const perView = optionBody.split(':'); // per-view strings
                    const effectivePerView = perView.length === 1 && numViews > 1
                        ? Array.from({ length: numViews }, () => perView[0])
                        : perView;

                    for (let view = 0; view < numViews; view++) {
                        const layerCsv = effectivePerView[view] ?? '';
                        const perLayer = layerCsv.length
                            ? this.expandStyleRunLengthTokens(layerCsv.split(','))
                            : [];
                        for (let li = 0; li < layerIndices.length; li++) {
                            const layerIndex = layerIndices[li];
                            if (layerIndex < 0 || layerIndex >= layerNames.length) {
                                continue;
                            }
                            const mapLayerId = layerNames[layerIndex];
                            const storeKey = this.styleOptionKeyFromMapLayer(mapLayerId, shortStyleId, optionId);
                            const valuesForStoreKey = [...(nextValues.get(storeKey) ?? [])];
                            const rawVal = perLayer[li] ?? '';

                            // Ensure length up to current view
                            while (valuesForStoreKey.length <= view) {
                                valuesForStoreKey.push(false);
                            }
                            valuesForStoreKey[view] = rawVal;
                            nextValues.set(storeKey, valuesForStoreKey);
                        }
                    }
                }
            }
            this.replacePositional(nextValues);
        } catch (error) {
            console.error(`[StyleState.deserialize]: Failed to deserialize style options from `, raw, error);
        }
    }

    /** Returns whether the key belongs to the compact style-option URL namespace. */
    public isStyleOptionUrlParamKey(key: string): boolean {
        // Example: STY0~0-2~showOptionA~showOptionB
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

    /** Builds the canonical storage key for one style option value. */
    public styleOptionKey(mapId: string, layerId: string, shortStyleId: string, optionId: string): string {
        // Use a slash-delimited compound key; mapId may contain '/'.
        const mapLayerId = `${mapId}/${layerId}`;
        return `${mapLayerId}/${shortStyleId}/${optionId}`;
    }

    /** Builds the canonical style-option key from a combined map/layer id. */
    private styleOptionKeyFromMapLayer(mapLayerId: string, shortStyleId: string, optionId: string): string {
        return `${mapLayerId}/${shortStyleId}/${optionId}`;
    }

    /** Normalizes style option ids so legacy delimiters do not leak into storage keys. */
    private normalizeStyleOptionId(optionId: string): string {
        if (optionId.startsWith(".")) {
            return `show${optionId.slice(1)}`;
        }
        return optionId;
    }

    /** Expands run-length tokens used by compact style-option URL values. */
    private expandStyleRunLengthTokens(tokens: string[]): string[] {
        const expanded: string[] = [];
        for (const token of tokens) {
            const match = token.match(/^(.*)x(\d+)$/);
            if (!match) {
                expanded.push(token);
                continue;
            }
            const value = match[1];
            const count = Number(match[2]);
            if (!this.isStylePrimitiveToken(value) || !Number.isInteger(count) || count <= 1) {
                expanded.push(token);
                continue;
            }
            for (let i = 0; i < count; i++) {
                expanded.push(value);
            }
        }
        return expanded;
    }

    /** Returns whether the token looks like a compact primitive style-option value. */
    private isStylePrimitiveToken(token: string): boolean {
        return /^(?:true|false|0|1|-?\d+(?:\.\d+)?)$/i.test(token);
    }

    /** Coerces a raw URL/storage style-option value to the declared option type. */
    public coerceOptionValue(value: any, optionType: string): string | number | boolean {
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
