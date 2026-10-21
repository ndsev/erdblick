import type {Signal} from "@angular/core";
import type {Params} from "@angular/router";
import {distinctUntilChanged, map, Observable, OperatorFunction} from "rxjs";
import {z, ZodTypeAny} from "zod";
import {environment} from "../environments/environment";
import {
    AppStateFromStorageFun,
    AppStateOptions,
    AppStateSerializedValue,
    AppStateToStorageFun,
    Boolish,
    deepCopy,
    deepEquals
} from "./state-value";
import {type StateBinding} from "./viewer-state";
export {Boolish, deepCopy, deepEquals} from "./state-value";
export type {AppStateOptions} from "./state-value";

/** Removes optional/default/lazy wrappers so scalar checks can inspect the underlying schema. */
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
        return schema.options.every((opt) => isScalar(opt as ZodTypeAny));
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
        z.ZodNull
    ];
    return scalarKinds.some((type) => unwrapped instanceof type);
}

/** Coerces one URL/storage token into the primitive shape expected by the schema. */
function coerceFromString(txt: string, schema: ZodTypeAny): any {
    const unwrapped = unwrapScalar(schema);

    if (unwrapped === Boolish || unwrapped instanceof z.ZodBoolean) {
        const v = txt.trim().toLowerCase();
        return v === "1" || v === "true";
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
        .split(",")
        .map((s) => {
            try {
                return decodeURIComponent(s);
            } catch {
                return s;
            }
        })
        .filter((s) => s.length > 0 || s === "");
}

/** Joins primitive values into the compact CSV form used in URLs. */
function joinCSV(values: unknown[]): string {
    return values.map((v) => String(compactBooleans(v))).join(",");
}

/** Detects array values that were stored as JSON rather than compact CSV. */
function looksLikeJsonArray(raw: string): boolean {
    const trimmed = raw.trim();
    return trimmed.startsWith("[") && trimmed.endsWith("]");
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
    return groups.map((g) => joinCSV(g)).join(":");
}

/** Splits the colon-delimited compact URL representation of arrays-of-arrays. */
function splitColonCSV(val: string): string[][] {
    if (!val) {
        return [];
    }
    return String(val)
        .split(":")
        .map((seg) => (seg === "" ? [] : splitCSV(seg)));
}

/**
 * Codec and read/notification adapter for one SignalStore value; it never caches a second value.
 *
 * URL encoding strategy is schema-aware:
 * - scalar arrays -> CSV (with optional run-length tokens),
 * - nested primitive arrays -> colon-separated CSV groups,
 * - form-encoded object arrays -> per-field CSV columns,
 * - everything else -> JSON.
 */
export class AppState<T> extends Observable<T> {
    /** Native read-only signal. The Observable API is retained for existing RxJS consumers. */
    readonly signal: Signal<T>;
    private readonly binding: StateBinding<T>;

    get value(): T {
        return this.getValue();
    }
    getValue(): T {
        return this.binding.read();
    }
    /** Origin of this value in the current coherent publication, including queued observer writes. */
    get writeOrigin() {
        return this.binding.writeOrigin?.();
    }
    /** Reads one portion, including prepared values inside a transaction. Values are immutable. */
    read<R>(select: (value: T) => R): R {
        return select(this.binding.read());
    }
    next(value: T): void {
        this.binding.write(value);
    }

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
    constructor(pool: Map<string, AppState<unknown>>, options: AppStateOptions<T>, binding: StateBinding<T>) {
        const source = binding;
        super((subscriber) => {
            let previous = source.signal();
            const subscription = source.commits.subscribe(() => {
                const value = source.signal();
                if (Object.is(previous, value)) return;
                previous = value;
                subscriber.next(value);
            });
            subscriber.next(previous);
            return subscription;
        });
        this.binding = source;
        this.signal = source.signal;
        this.name = options.name;
        this.defaultValue = deepCopy(options.defaultValue);

        this.schema = options.schema;
        this.preprocess = options.toStorage ?? ((value) => compactBooleans(value));
        this.postprocess = options.fromStorage;

        this.urlParamName = options.urlParamName;
        this.urlFormEncode = options.urlFormEncode ?? false;
        this.urlIncludeInVisualizationOnly = options.urlIncludeInVisualizationOnly;
        this.snapshotPersist = options.snapshotPersist ?? true;
        this.configDefault = options.configDefault ?? this.snapshotPersist;

        if (pool.has(options.name)) {
            throw new Error(`[AppState] Duplicate state name: ${options.name}`);
        }
        pool.set(options.name, this as unknown as AppState<unknown>);
    }

    /** Restores the state to its configured default value. */
    resetToDefault(): void {
        // Defaults are copied only at import/reset boundaries, never on ordinary reads.
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
        return !!el && unwrapScalar(el) instanceof z.ZodObject && this.urlFormEncode;
    }

    /** Returns whether this state slot should participate in URL serialization. */
    isUrlState(): boolean {
        return (
            (this.urlParamName !== undefined || this.urlFormEncode) &&
            !(environment.visualizationOnly && this.urlIncludeInVisualizationOnly === false)
        );
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

    /**
     * Serialize current state either for URL parameters (`forUrl=true`) or
     * for local storage payload (`forUrl=false`).
     */
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
                        const column = (payload as any[]).map((item) => (item ?? {})[field]);
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
    deserialize(raw: string | Params) {
        try {
            // Raw storage path (JSON string)
            if (typeof raw === "string") {
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
            if (!this.isUrlState()) return;

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
                        parsed = parts.map((s) => coerceFromString(s, elSchema));
                    }
                }
                // Array of arrays of primitives from colon-separated CSV
                else if (isArrayOfPrimitiveArrays(this.schema) && raw[base] !== undefined) {
                    const inner = (elSchema as z.ZodArray<any>).element as ZodTypeAny; // inner primitive schema
                    const groups = splitColonCSV(String(raw[base])); // string[][]
                    parsed = groups.map((group) =>
                        expandRunLengthTokens(group, inner).map((s) => coerceFromString(s, inner))
                    );
                }
                // Array of objects from per-field CSV
                else if (this.arrayIsFormObject()) {
                    const shape = (unwrapScalar(elSchema) as z.ZodObject<any>).shape as Record<string, ZodTypeAny>;
                    const fieldArrays: Record<string, string[]> = {};
                    let maxLen = 0;

                    for (const field of Object.keys(shape)) {
                        if (raw[field] === undefined) continue;
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

/** Resolves positional codec access to the authoritative record for one live view ID. */
export interface ViewValueBinding<T> {
    idAt(index: number): string | undefined;
    read(id: string): T;
    write(id: string, value: T): void;
    select(id: string): Signal<T>;
}

/** Projects ID-keyed owner values into the positional arrays used by existing storage and URL codecs. */
export class MapViewState<T> {
    public appState: AppState<Array<T>>;
    private readonly defaultValue: T;

    /** Wraps one array-valued state slot and exposes it as a per-view accessor set. */
    constructor(
        pool: Map<string, AppState<unknown>>,
        options: AppStateOptions<T>,
        binding: StateBinding<T[]>,
        private readonly views: ViewValueBinding<T>
    ) {
        this.defaultValue = deepCopy(options.defaultValue);
        this.appState = new AppState(
            pool,
            {
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
                    });
                },
                urlParamName: options.urlParamName,
                urlFormEncode: options.urlFormEncode,
                urlIncludeInVisualizationOnly: options.urlIncludeInVisualizationOnly,
                snapshotPersist: options.snapshotPersist,
                configDefault: options.configDefault
            },
            binding
        );
    }

    /** Writes through a current logical view; value assignment never creates view membership. */
    next(viewIndex: number, value: T) {
        const id = this.views.idAt(viewIndex);
        if (!id) throw new Error(`View index ${viewIndex} is unavailable`);
        this.views.write(id, value);
    }

    /** Subscribes to one view-specific slice of the shared array state. */
    subscribe(viewIndex: number, cb: (value: T) => void) {
        return this.pipe(viewIndex).subscribe(cb);
    }

    pipe<R = T>(viewIndex: number, ...ops: OperatorFunction<T, any>[]): Observable<R> {
        const id = this.views.idAt(viewIndex);
        const base$ = this.appState.pipe(
            map(() => id ? this.views.read(id) : this.defaultValue),
            distinctUntilChanged()
        );
        return ops.length ? (base$ as any).pipe(...ops) : (base$ as unknown as Observable<R>);
    }

    /** Native per-view reader for ordinary consumers; logical identity survives reordering. */
    signal(viewId: string): Signal<T> {
        return this.views.select(viewId);
    }

    /** Returns the current positional view's value, or the declaration default if it is absent. */
    getValue(viewIndex: number): T {
        const id = this.views.idAt(viewIndex);
        return id ? this.views.read(id) : this.defaultValue;
    }

    /** Returns the number of currently stored per-view entries. */
    length() {
        return this.appState.getValue().length;
    }
}

/** Compacts booleans to `1`/`0` for shorter URL output, recursively. */
function compactBooleans(value: unknown): unknown {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    if (Array.isArray(value)) {
        return value.map((item) => compactBooleans(item));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, compactBooleans(entry)])
        );
    }
    return value;
}

/**
 * Specialized codec for style options keyed by map/layer/style metadata.
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
export class StyleState extends AppState<Map<string, (string | number | boolean)[]>> {
    get layerNamesState(): AppState<string[]> {
        return this.pool.get("layerNames") as AppState<string[]>;
    }
    get numViewsState(): AppState<number> {
        return this.pool.get("numberOfViews") as AppState<number>;
    }

    /** Cross-slot dictionaries are resolved after all owners have registered at startup. */
    constructor(
        private readonly pool: Map<string, AppState<unknown>>,
        binding: StateBinding<Map<string, (string | number | boolean)[]>>
    ) {
        super(
            pool,
            {
                name: "styleOptions",
                schema: z.record(z.string(), z.string()),
                defaultValue: new Map<string, (string | number | boolean)[]>(),
                snapshotPersist: false
            },
            binding
        );
    }

    override isUrlState(): boolean {
        return true;
    }

    override toSnapshotValue(): unknown {
        const snapshot: Record<string, (string | number | boolean)[]> = {};
        for (const [key, values] of this.value.entries()) {
            snapshot[key] = [...values];
        }
        return snapshot;
    }

    override applySnapshotValue(value: unknown): void {
        const nextMap = this.validateSnapshotValue(value);
        if (this.styleMapEquals(this.value, nextMap)) {
            return;
        }
        this.next(nextMap);
    }

    override validateSnapshotValue(value: unknown): Map<string, (string | number | boolean)[]> {
        const parsed = z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))).parse(value);
        const nextMap = new Map<string, (string | number | boolean)[]>();
        for (const [key, values] of Object.entries(parsed)) {
            nextMap.set(key, [...values]);
        }
        return nextMap;
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
        //   'STY0': {
        //     'showOptionA': {'MapA/LayerX': [0, 1], 'MapB/LayerX': [0, 0]},
        //     'showOptionB': {'MapA/LayerX': [0, 0], 'MapB/LayerX': [1, 1]}
        //   }
        // }
        const grouped = new Map<string, Map<string, Map<string, (string | number | boolean)[]>>>();

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
                console.warn(
                    `[StyleState.serialize]: Omitting option ${fullKey}: Expected ${numViews} values, got: ${values.length}!`
                );
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
                            if (typeof val === "boolean") return val ? "1" : "0";
                            if (typeof val === "number") return String(val);
                            if (val === null || val === undefined) return "";
                            return String(val);
                        };
                        perLayerValues.push(enc(raw));
                    }
                    perViewStrings.push(perLayerValues.join(","));
                }
                optionBodies.push(perViewStrings.join(":"));
            }

            const paramKey = `${shortStyleId}~${[...layerSet].join("-")}~${[...byOption.keys()].join("~")}`;
            result[paramKey] = optionBodies.join("~");
        }

        return result;
    }

    override deserialize(raw: string | Params) {
        try {
            // A raw local storage string must be converted to the Record<string, string>
            if (typeof raw === "string") {
                raw = JSON.parse(raw);
                z.parse(this.schema, raw);
            }

            if (!Object.keys(raw).some((key) => this.isStyleOptionUrlParamKey(key))) return;
            const layerNames = this.layerNamesState.getValue();
            const numViews = this.numViewsState.getValue();
            const nextValues = deepCopy(this.getValue());

            for (const [key, value] of Object.entries(raw)) {
                if (!this.isStyleOptionUrlParamKey(key)) {
                    continue;
                }
                if (typeof value !== "string") {
                    console.warn(`[StyleState.deserialize]: Skipping style option ${key}: expected string payload.`);
                    continue;
                }
                const parts = key.split("~");
                const shortStyleId = parts[0];
                const layerPart = parts[1] ?? "";
                const layerIndices = layerPart
                    .split("-")
                    .map((s) => Number(s))
                    .filter((n) => Number.isFinite(n));
                const optionIds = parts.slice(2); // remaining parts are option IDs

                if (!optionIds.length || !layerIndices.length) {
                    continue;
                }

                // Split value by '~' per option, same order as in key
                const optionValueSegments = value.split("~");
                if (optionValueSegments.length < optionIds.length) {
                    // If fewer bodies than option ids, skip
                    continue;
                }

                for (let oi = 0; oi < optionIds.length; oi++) {
                    const optionId = this.normalizeStyleOptionId(optionIds[oi]);
                    const optionBody = optionValueSegments[oi] ?? "";
                    const perView = optionBody.split(":"); // per-view strings
                    const effectivePerView =
                        perView.length === 1 && numViews > 1
                            ? Array.from({length: numViews}, () => perView[0])
                            : perView;

                    for (let view = 0; view < numViews; view++) {
                        const layerCsv = effectivePerView[view] ?? "";
                        const perLayer = layerCsv.length ? this.expandStyleRunLengthTokens(layerCsv.split(",")) : [];
                        for (let li = 0; li < layerIndices.length; li++) {
                            const layerIndex = layerIndices[li];
                            if (layerIndex < 0 || layerIndex >= layerNames.length) {
                                continue;
                            }
                            const mapLayerId = layerNames[layerIndex];
                            const storeKey = this.styleOptionKeyFromMapLayer(mapLayerId, shortStyleId, optionId);
                            const valuesForStoreKey = nextValues.get(storeKey) || [];
                            const rawVal = perLayer[li] ?? "";

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
            this.next(nextValues);
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
        const parts = key.split("~");
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

    /** Compares two style-option maps structurally without relying on reference identity. */
    private styleMapEquals(
        a: Map<string, (string | number | boolean)[]>,
        b: Map<string, (string | number | boolean)[]>
    ): boolean {
        if (a.size !== b.size) {
            return false;
        }
        for (const [key, value] of a.entries()) {
            const other = b.get(key);
            if (!other || !deepEquals(value, other)) {
                return false;
            }
        }
        return true;
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
        const t = (optionType || "").toLowerCase();
        if (t === "bool" || t === "boolean") {
            if (typeof value === "boolean") return value;
            if (typeof value === "number") return value !== 0;
            if (typeof value === "string") {
                const v = value.trim().toLowerCase();
                return v === "1" || v === "true";
            }
            return false;
        }
        if (t === "number") {
            if (typeof value === "number") return value;
            const n = Number(value);
            return Number.isNaN(n) ? 0 : n;
        }
        if (t === "string") {
            if (value === null || value === undefined) return "";
            return String(value);
        }
        // Default to boolean semantics
        return typeof value === "boolean" ? value : false;
    }
}
