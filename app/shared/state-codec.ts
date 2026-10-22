import type {Params} from "@angular/router";
import {z, ZodTypeAny} from "zod";
import {environment} from "../environments/environment";
import {
    AppStateFromStorageFun,
    AppStateOptions,
    AppStateSerializedValue,
    AppStateToStorageFun,
    Boolish,
    deepCopy,
} from "./state-value";

/**
 * Optional fields and fields with defaults retain the same compact URL encoding
 * as their underlying type. Inspect that type through Zod's public wrapper API.
 */
function unwrapScalar(schema: z.ZodTypeAny): z.ZodTypeAny {
    while (
        schema instanceof z.ZodOptional ||
        schema instanceof z.ZodNullable ||
        schema instanceof z.ZodDefault ||
        schema instanceof z.ZodLazy
    ) {
        schema = schema.unwrap() as z.ZodTypeAny;
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
    if (unwrapped instanceof z.ZodNumber) {
        return Number(txt);
    }
    if (unwrapped instanceof z.ZodString) {
        return txt;
    }
    // Let the declared schema finish parsing unions, refinements and other types.
    return txt;
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

/** Detects nested primitive arrays, such as one list of flags per map view. */
function isArrayOfPrimitiveArrays(schema: z.ZodTypeAny): schema is z.ZodArray<z.ZodArray<ZodTypeAny>> {
    if (!(schema instanceof z.ZodArray)) {
        return false;
    }
    const el = (schema as z.ZodArray<any>).element;
    if (!(el instanceof z.ZodArray)) {
        return false;
    }
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
 * The original AppState storage algorithms, without a reactive value or write API.
 * A feature owns its native SignalStore value. This object only converts a supplied
 * value to/from the released local-storage, snapshot and URL representations.
 * Preparing an import can therefore validate every field before a single store patch.
 */
export class StateCodec<T> {
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

    /** A codec retains declarations only; callers supply every value explicitly. */
    constructor(options: AppStateOptions<T>) {
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
    }

    /** Returns a detached value suitable for snapshot export. */
    toSnapshotValue(value: T): unknown {
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

    /**
     * Snapshot imports reject invalid values before any store publication.
     * Unlike URL and local-storage recovery, this method lets validation errors
     * reach the caller so it can reject the complete snapshot.
     */
    validateSnapshotValue(value: unknown, currentValue: T): T {
        const verified = this.schema.parse(value);
        return (this.postprocess ? this.postprocess(verified as any, currentValue) : verified) as T;
    }

    /** Returns whether the state schema encodes an array. */
    private isArray(): this is StateCodec<unknown[]> {
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
     * Converts the caller's value to shared-link parameters or local-storage JSON.
     * Existing links use CSV for primitive arrays and one parameter per object
     * field for camera arrays; storage always keeps the declared field name.
     */
    serialize(value: T, forUrl: boolean): Record<string, AppStateSerializedValue> | undefined {
        if (forUrl && !this.isUrlState()) {
            return undefined;
        }

        try {
            const result: Record<string, AppStateSerializedValue> = {};
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

                // Camera objects become one CSV parameter per field, such as lon or lat.
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
     * Reads local-storage JSON or shared-link parameters using the released formats.
     * Missing or invalid input keeps the caller's current value, which lets a link
     * override only the fields it contains. Parsing never publishes to the store.
     */
    deserialize(raw: string | Params, currentValue: T): T {
        try {
            // Raw storage path (JSON string)
            if (typeof raw === "string") {
                if (raw) {
                    const parsed = JSON.parse(raw);
                    const verified = this.schema.parse(parsed);
                    const value = this.postprocess
                        ? this.postprocess(verified as any, currentValue)
                        : verified;
                    return value as T;
                }
                return currentValue;
            }

            // No need to update from URL params if this is not a URL state.
            if (!this.isUrlState()) {
                return currentValue;
            }

            let parsed: unknown = undefined;
            const base = this.urlParamName ?? this.name;
            if (this.isEmptyArrayUrlValue(raw[base])) {
                return currentValue;
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
                        if (raw[field] === undefined) {
                            continue;
                        }
                        const arr = expandRunLengthTokens(splitCSV(String(raw[field])), shape[field]);
                        fieldArrays[field] = arr;
                        if (arr.length > maxLen) {
                            maxLen = Math.max(maxLen, arr.length);
                        }
                    }

                    if (maxLen > 0) {
                        const items: any[] = new Array(maxLen).fill(null).map(() => ({}));
                        for (const field of Object.keys(shape)) {
                            const col = fieldArrays[field] ?? [];
                            const singleton = col.length === 1 ? col[0] : undefined;
                            for (let i = 0; i < maxLen; i++) {
                                const rawVal = col[i] ?? singleton;
                                if (rawVal === undefined) {
                                    continue;
                                }
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
                    if (raw[field] !== undefined) {
                        collected[field] = raw[field];
                    }
                }
                parsed = Object.keys(collected).length ? collected : undefined;
            }
            // Accept `"0"` and `""` etc. (only skip if truly undefined)
            else if (raw[this.urlParamName!] !== undefined) {
                if (this.isEmptyArrayUrlValue(raw[this.urlParamName!])) {
                    return currentValue;
                }
                parsed = isScalar(this.schema) ? raw[this.urlParamName!] : JSON.parse(raw[this.urlParamName!]);
            }

            if (parsed !== undefined) {
                const verified = this.schema.parse(parsed);
                const value = this.postprocess
                    ? this.postprocess(verified as any, currentValue)
                    : verified;
                return value as T;
            }
        } catch (error) {
            console.error(`[AppState:${this.name}:${this.urlParamName}] Failed to deserialize value from `, raw, error);
        }
        return currentValue;
    }

    /** Returns URL parameter names for a single object encoded as form fields. */
    getFormFieldNames(): readonly string[] {
        if (!this.urlFormEncode || !(unwrapScalar(this.schema) instanceof z.ZodObject)) {
            return [];
        }
        return Object.keys((unwrapScalar(this.schema) as z.ZodObject<any>).shape);
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

/** The current URL's layer and view order supplies the indices in compact style parameters. */
export interface StyleCodecContext {
    layerNames: readonly string[];
    viewCount: number;
}

/**
 * Preserves the compact style-option format used by existing shared links.
 * Options are stored under map/layer/style/option keys in memory, while the URL
 * groups them by style and refers to layers by their position in the link.
 * The caller supplies that order explicitly; this codec never reads map resources.
 */
export class StyleOptionsCodec extends StateCodec<Map<string, (string | number | boolean)[]>> {
    constructor() {
        super({
            name: "styleOptions",
            schema: z.record(z.string(), z.string()),
            defaultValue: new Map(),
            snapshotPersist: false,
        });
    }

    override isUrlState(): boolean {
        return true;
    }

    override toSnapshotValue(value: Map<string, (string | number | boolean)[]>): unknown {
        const snapshot: Record<string, (string | number | boolean)[]> = {};
        for (const [key, values] of value.entries()) {
            snapshot[key] = [...values];
        }
        return snapshot;
    }

    override validateSnapshotValue(value: unknown): Map<string, (string | number | boolean)[]> {
        const parsed = z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))).parse(value);
        const nextMap = new Map<string, (string | number | boolean)[]>();
        for (const [key, values] of Object.entries(parsed)) {
            nextMap.set(key, [...values]);
        }
        return nextMap;
    }

    override serialize(
        value: Map<string, (string | number | boolean)[]>,
        _: boolean,
        context?: StyleCodecContext,
    ): Record<string, string> | undefined {
        const result: Record<string, string> = {};
        if (value.size === 0) {
            return result;
        }

        const layerNames = context?.layerNames ?? [];
        const numViews = context?.viewCount ?? 1;

        // Group by style -> option -> mapLayerId
        // E.g. {
        //   'STY0': {
        //     'showOptionA': {'MapA/LayerX': [0, 1], 'MapB/LayerX': [0, 0]},
        //     'showOptionB': {'MapA/LayerX': [0, 0], 'MapB/LayerX': [1, 1]}
        //   }
        // }
        const grouped = new Map<string, Map<string, Map<string, (string | number | boolean)[]>>>();

        for (const [fullKey, values] of value.entries()) {
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
                        const encode = (val: unknown): string => {
                            if (typeof val === "boolean") {
                                return val ? "1" : "0";
                            }
                            if (typeof val === "number") {
                                return String(val);
                            }
                            if (val === null || val === undefined) {
                                return "";
                            }
                            return String(val);
                        };
                        perLayerValues.push(encode(raw));
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

    override deserialize(
        raw: string | Params,
        currentValue: Map<string, (string | number | boolean)[]>,
        context?: StyleCodecContext,
    ): Map<string, (string | number | boolean)[]> {
        try {
            // A raw local storage string must be converted to the Record<string, string>
            if (typeof raw === "string") {
                raw = JSON.parse(raw);
                z.parse(this.schema, raw);
            }

            if (!Object.keys(raw).some((key) => this.isStyleOptionUrlParamKey(key))) {
                return currentValue;
            }
            const layerNames = context?.layerNames ?? [];
            const numViews = context?.viewCount ?? 1;
            const nextValues = deepCopy(currentValue);

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
            return nextValues;
        } catch (error) {
            console.error(`[StyleState.deserialize]: Failed to deserialize style options from `, raw, error);
        }
        return currentValue;
    }

    /** Returns whether the key belongs to the compact style-option URL namespace. */
    public isStyleOptionUrlParamKey(key: string): boolean {
        // Example: STY0~0-2~showOptionA~showOptionB
        // Constraints: at least 3 segments separated by '~' (styleId, layers, one option)
        if (!key) {
            return false;
        }
        const parts = key.split("~");
        if (parts.length < 3) {
            return false;
        }
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
        const t = (optionType || "").toLowerCase();
        if (t === "bool" || t === "boolean") {
            if (typeof value === "boolean") {
                return value;
            }
            if (typeof value === "number") {
                return value !== 0;
            }
            if (typeof value === "string") {
                const v = value.trim().toLowerCase();
                return v === "1" || v === "true";
            }
            return false;
        }
        if (t === "number") {
            if (typeof value === "number") {
                return value;
            }
            const n = Number(value);
            return Number.isNaN(n) ? 0 : n;
        }
        if (t === "string") {
            if (value === null || value === undefined) {
                return "";
            }
            return String(value);
        }
        // Default to boolean semantics
        return typeof value === "boolean" ? value : false;
    }
}
