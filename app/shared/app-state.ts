import {BehaviorSubject} from "rxjs";

export type AppStateValidator = (value: any) => boolean;
export type AppStateSerializer<T> = (value: T) => string;
export type AppStateDeserializer<T> = (raw: string, currentValue: T) => T | undefined;

export interface AppStateOptions<T> {
    name: string;
    defaultValue: T;
    validate?: AppStateValidator;
    serialize?: AppStateSerializer<T>;
    deserialize?: AppStateDeserializer<T>;
    urlParamName?: string;
    urlFormEncode?: boolean;
    urlFormParamNames?: ReadonlyArray<string>;
    urlIncludeInVisualizationOnly?: boolean;
}

export class AppState<T> extends BehaviorSubject<T> {
    readonly name: string;
    readonly defaultValue: T;

    readonly urlParamName?: string;
    readonly urlFormEncode: boolean;
    readonly urlFormParamNames: ReadonlyArray<string>;
    readonly urlIncludeInVisualizationOnly?: boolean;

    private readonly serializer: AppStateSerializer<T>;
    private readonly deserializer: AppStateDeserializer<T>;
    private readonly validator?: AppStateValidator;

    constructor(pool: Map<string, AppState<unknown>>, options: AppStateOptions<T>) {
        super(options.defaultValue);
        this.name = options.name;
        this.defaultValue = options.defaultValue;

        this.urlParamName = options.urlParamName;
        this.urlFormEncode = options.urlFormEncode ?? false;
        this.urlFormParamNames = options.urlFormParamNames ?? [];
        this.urlIncludeInVisualizationOnly = options.urlIncludeInVisualizationOnly;

        this.validator = options.validate;
        this.serializer = options.serialize ?? (value => simpleStringify(value));
        this.deserializer = options.deserialize ?? ((raw: string) => defaultJsonDeserialize<T>(raw, options.name));

        if (pool.has(options.name)) {
            console.warn(`[AppState] Duplicate state name detected: ${options.name}. Overwriting previous instance.`);
        }
        pool.set(options.name, this as unknown as AppState<unknown>);
    }

    resetToDefault(): void {
        this.next(this.defaultValue);
    }

    validate(value: T): boolean {
        if (!this.validator) {
            return true;
        }
        try {
            return this.validator(value);
        } catch (error) {
            console.warn(`[AppState:${this.name}] Validator threw an error`, error);
            return false;
        }
    }

    serialize(value: T = this.getValue()): string | undefined {
        try {
            return this.serializer(value);
        } catch (error) {
            console.warn(`[AppState:${this.name}] Failed to serialize value`, error);
            if (value !== this.defaultValue) {
                try {
                    return this.serializer(this.defaultValue);
                } catch (_fallbackError) {
                    return undefined;
                }
            }
            return undefined;
        }
    }

    deserialize(raw: string): T | undefined {
        try {
            return this.deserializer(raw, this.getValue());
        } catch (error) {
            console.warn(`[AppState:${this.name}] Failed to deserialize value`, error);
            return undefined;
        }
    }
}

export function simpleStringify(value: unknown): string {
    return JSON.stringify(value, (_key, val) => {
        return typeof val === 'boolean' ? (val ? 1 : 0) : val;
    });
}

function defaultJsonDeserialize<T>(raw: string, stateName: string): T | undefined {
    try {
        return JSON.parse(raw) as T;
    } catch (error) {
        console.warn(`[AppState:${stateName}] Failed to parse value`, error);
        return undefined;
    }
}
