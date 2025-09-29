import {BehaviorSubject} from "rxjs";
import {z, ZodType, ZodTypeAny} from "zod";

export type AppStateSerializer<T> = (value: T) => unknown;
export type AppStateDeserializer<T, SchemaValue = T> = (value: SchemaValue, currentValue: T) => T;

export interface AppStateOptions<T, SchemaValue = T> {
    name: string;
    defaultValue: T;
    schema: ZodType<SchemaValue>;
    serialize?: AppStateSerializer<T>;
    deserialize?: AppStateDeserializer<T, SchemaValue>;
    urlParamName?: string;
    urlFormEncode?: boolean;
    urlIncludeInVisualizationOnly?: boolean;
}

export class AppState<T, SchemaValue = T> extends BehaviorSubject<T> {
    readonly name: string;
    readonly defaultValue: T;

    readonly urlParamName?: string;
    readonly urlFormEncode: boolean;
    readonly urlIncludeInVisualizationOnly?: boolean;

    private readonly serializer: AppStateSerializer<T>;
    private readonly deserializer?: AppStateDeserializer<T, SchemaValue>;
    private readonly schema: ZodType<SchemaValue>;
    private cachedFormKeys: readonly string[] | null = null;

    constructor(pool: Map<string, AppState<unknown>>, options: AppStateOptions<T, SchemaValue>) {
        super(options.defaultValue);
        this.name = options.name;
        this.defaultValue = options.defaultValue;

        this.schema = options.schema;
        this.serializer = options.serialize ?? (value => compactBooleans(value));
        this.deserializer = options.deserialize;

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

    getSerializablePayload(value: T = this.getValue()): unknown | undefined {
        try {
            return this.serializer(value);
        } catch (error) {
            console.warn(`[AppState:${this.name}] Failed to prepare serialization payload`, error);
            return undefined;
        }
    }

    serialize(value: T = this.getValue()): string | undefined {
        const payload = this.getSerializablePayload(value);
        if (payload === undefined) {
            return undefined;
        }
        try {
            return JSON.stringify(payload);
        } catch (error) {
            console.warn(`[AppState:${this.name}] Failed to serialize value`, error);
            return undefined;
        }
    }

    parsePayload(payload: unknown): T | undefined {
        try {
            const parsed = this.schema.parse(payload) as unknown as SchemaValue;
            const value = this.deserializer ? this.deserializer(parsed, this.getValue()) : parsed;
            return value as unknown as T;
        } catch (error) {
            console.warn(`[AppState:${this.name}] Failed to parse payload`, error);
            return undefined;
        }
    }

    deserialize(raw: string): T | undefined {
        try {
            const parsed = JSON.parse(raw);
            return this.parsePayload(parsed);
        } catch (error) {
            console.warn(`[AppState:${this.name}] Failed to deserialize value`, error);
            return undefined;
        }
    }

    getFormFieldNames(): readonly string[] {
        if (!this.urlFormEncode) {
            return [];
        }
        if (this.cachedFormKeys) {
            return this.cachedFormKeys;
        }
        const keys = extractSchemaFieldNames(this.schema);
        this.cachedFormKeys = keys;
        return keys;
    }
}

function extractSchemaFieldNames(schema: ZodTypeAny): readonly string[] {
    if (schema instanceof z.ZodObject) {
        return Object.keys(schema.shape);
    }
    return [];
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
