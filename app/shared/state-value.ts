import {z, ZodTypeAny} from "zod";

/** Converts an app-state value into the representation stored in URL or local storage. */
export type AppStateToStorageFun<T> = (value: T) => unknown;
/** Restores an app-state value from persisted storage using the current value as context. */
export type AppStateFromStorageFun<T> = (value: ZodTypeAny, currentValue: T) => T;
export type AppStateSerializedValue = string | null;

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

/** Performs a structural equality check tailored to persisted state values. */
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

    if (a instanceof Map && b instanceof Map) {
        return a.size === b.size && [...a].every(([key, value]) => b.has(key) && deepEquals(value, b.get(key)));
    }
    if (a instanceof Set && b instanceof Set) {
        return a.size === b.size && [...a].every(value => b.has(value));
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

