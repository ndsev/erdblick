import {BehaviorSubject} from "rxjs";
import {Params} from "@angular/router";

export type AppStateValidator<T> = (value: T) => boolean;
export type AppStateStringConverter<T> = (value: string) => T;
export type AppStateSerializer<T> = (value: T) => string;
export type AppStateDeserializer<T> = (raw: string) => T | undefined;

export interface AppStateUrlCodec<T> {
    paramName?: string;
    encoder?: (value: T) => Record<string, string>;
    decoder?: (params: Params) => T | undefined;
    formEncoding?: boolean;
    paramNames?: Array<string>;
    includeInVisualizationOnly?: boolean;
}

export interface AppStateStorageCodec<T> {
    key?: string;
    serialize?: AppStateSerializer<T>;
    deserialize?: AppStateDeserializer<T>;
}

export interface AppStateOptions<T> {
    name: string;
    defaultValue: T;
    converter?: AppStateStringConverter<T>;
    validator?: AppStateValidator<T>;
    url?: AppStateUrlCodec<T>;
    storage?: AppStateStorageCodec<T>;
    persist?: boolean;
}

export class AppState<T> extends BehaviorSubject<T> {
    readonly name: string;
    readonly defaultValue: T;
    readonly url?: AppStateUrlCodec<T>;
    readonly storage?: Required<AppStateStorageCodec<T>>;

    private readonly converter?: AppStateStringConverter<T>;
    private readonly validator?: AppStateValidator<T>;

    constructor(pool: Map<string, AppState<unknown>>, options: AppStateOptions<T>) {
        super(options.defaultValue);
        this.name = options.name;
        this.defaultValue = options.defaultValue;
        this.converter = options.converter;
        this.validator = options.validator;
        this.url = options.url;
        if (options.persist === false) {
            this.storage = undefined;
        } else {
            this.storage = {
                key: options.storage?.key ?? `appState/${options.name}`,
                serialize: options.storage?.serialize ?? JSON.stringify,
                deserialize: options.storage?.deserialize ?? ((raw: string) => {
                    try {
                        return JSON.parse(raw) as T;
                    } catch (error) {
                        console.warn(`[AppState:${options.name}] Failed to parse storage value`, error);
                        return undefined;
                    }
                })
            };
        }

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

    convert(raw: string): T | undefined {
        if (!this.converter) {
            return raw as unknown as T;
        }
        try {
            return this.converter(raw);
        } catch (error) {
            console.warn(`[AppState:${this.name}] Converter failed for value`, raw, error);
            return undefined;
        }
    }

    trySet(value: T): boolean {
        if (!this.validate(value)) {
            return false;
        }
        this.next(value);
        return true;
    }

    serialize(value: T = this.getValue()): string | undefined {
        if (!this.storage) {
            return undefined;
        }
        try {
            return this.storage.serialize(value);
        } catch (error) {
            console.warn(`[AppState:${this.name}] Failed to serialize value`, error);
            return this.storage.serialize(this.defaultValue);
        }
    }

    deserialize(raw: string): T | undefined {
        if (!this.storage) {
            return undefined;
        }
        try {
            return this.storage.deserialize(raw);
        } catch (error) {
            console.warn(`[AppState:${this.name}] Failed to deserialize value`, error);
            return undefined;
        }
    }
}

export function createSimpleUrlCodec<T>(paramName: string, serializer?: AppStateSerializer<T>, converter?: AppStateStringConverter<T>): AppStateUrlCodec<T> {
    return {
        paramName,
        paramNames: [paramName],
        encoder: (value: T) => ({[paramName]: serializer ? serializer(value) : simpleStringify(value)}),
        decoder: (params: Params) => {
            if (!params.hasOwnProperty(paramName)) {
                return undefined;
            }
            const raw = params[paramName];
            if (typeof raw !== 'string') {
                return undefined;
            }
            if (converter) {
                try {
                    return converter(raw);
                } catch (error) {
                    console.warn(`[AppState:${paramName}] Failed to decode URL param`, error);
                    return undefined;
                }
            }
            return raw as unknown as T;
        }
    };
}

export function simpleStringify(value: unknown): string {
    return JSON.stringify(value, (_key, val) => {
        return typeof val === 'boolean' ? (val ? 1 : 0) : val;
    });
}
