import {BehaviorSubject} from "rxjs";
import {z, ZodTypeAny} from "zod";
import {Params} from "@angular/router";
import {environment} from "../environments/environment";

export type AppStatePreProcessor<T> = (value: T) => unknown;
export type AppStatePostProcessor<T> = (value: ZodTypeAny, currentValue: T) => T;

export interface AppStateOptions<T> {
    name: string;
    defaultValue: T;
    schema: ZodTypeAny;
    preprocess?: AppStatePreProcessor<T>;
    postprocess?: AppStatePostProcessor<T>;
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

function isScalar(schema: z.ZodTypeAny): boolean {
    if (schema === Boolish) {
        return true;
    }
    if (schema instanceof z.ZodUnion) {
        return schema.options.every(opt => isScalar(opt as ZodTypeAny));
    }
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
    return scalarKinds.some(type => schema instanceof type);
}

export class AppState<T> extends BehaviorSubject<T> {
    readonly name: string;
    readonly defaultValue: T;

    readonly urlParamName?: string;
    readonly urlFormEncode: boolean;
    readonly urlIncludeInVisualizationOnly?: boolean;

    private readonly preprocess?: AppStatePreProcessor<T>;
    private readonly postprocess?: AppStatePostProcessor<T>;
    private readonly schema: ZodTypeAny;

    constructor(pool: Map<string, AppState<unknown>>, options: AppStateOptions<T>) {
        super(options.defaultValue);
        this.name = options.name;
        this.defaultValue = options.defaultValue;

        this.schema = options.schema;
        this.preprocess = options.preprocess ?? (value => compactBooleans(value));
        this.postprocess = options.postprocess;

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

    serialize(forUrl: boolean): Record<string, string> | undefined {
        if (forUrl && !this.isUrlState()) {
            return undefined;
        }
        try {
            const result: Record<string, string> = {};
            const payload = this.preprocess ? this.preprocess(this.getValue()) : this.getValue();
            if (forUrl) {
                if (this.urlFormEncode) {
                    for (const formField of this.getFormFieldNames()) {
                        result[formField] = String((payload as Record<string, any>)[formField]);
                    }
                } else {
                    if (isScalar(this.schema)) {
                        result[this.urlParamName!] = String(payload);
                        return result;
                    }
                    result[this.urlParamName!] = JSON.stringify(payload);
                }
            } else {
                result[this.name] = JSON.stringify(payload);
            }
            return result;
        } catch (error) {
            console.warn(`[AppState:${this.name}] Failed to serialize value`, error);
            return undefined;
        }
    }

    isUrlState(): boolean {
        return (this.urlParamName !== undefined || this.urlFormEncode) &&
            !(environment.visualizationOnly && this.urlIncludeInVisualizationOnly === false);
    }

    deserialize(raw: string | Params) {
        try {
            let parsed = undefined;
            if (typeof raw === 'string') {
                if (raw) {
                    parsed = JSON.parse(raw);
                }
            } else if (this.isUrlState()) {
                if (this.urlFormEncode) {
                    const collected: Record<string, string> = {};
                    for (const field of this.getFormFieldNames()) {
                        if (raw[field] === undefined) {
                            continue;
                        }
                        collected[field] = raw[field];
                    }
                    parsed = collected;
                }
                else if (raw[this.urlParamName!]) {
                    if (isScalar(this.schema)) {
                        parsed = raw[this.urlParamName!];
                    }
                    parsed = JSON.parse(raw[this.urlParamName!]);
                }
            }
            if (parsed) {
                const verified = this.schema.parse(parsed);
                const value = this.postprocess ? this.postprocess(verified as any, this.getValue()) : verified;
                this.next(value as T);
            }
        } catch (error) {
            console.error(`[AppState:${this.name}:${this.urlParamName}] Failed to deserialize value from `, raw, error);
        }
    }

    getFormFieldNames(): readonly string[] {
        if (!this.urlFormEncode || !(this.schema instanceof z.ZodObject)) {
            return [];
        }
        return Object.keys(this.schema.shape);
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
