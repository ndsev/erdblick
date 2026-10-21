/** Limits used while validating imported viewer snapshots. */
export interface SnapshotImportLimits {
    maxFileSizeBytes: number;
    maxTopLevelEntries: number;
    maxNestingDepth: number;
    maxCollectionEntries: number;
    maxStringLength: number;
}

/** Result of snapshot normalization before schema validation is applied. */
export interface SnapshotNormalizationResult {
    normalized?: Record<string, unknown>;
    errors: string[];
}

export interface ConfigDefaultStateMetaEntry {
    owner: "config" | "user";
    valueHash: string;
}

export interface ConfigDefaultStateMeta {
    version: 1;
    sourceHash: string;
    entries: Record<string, ConfigDefaultStateMetaEntry>;
}

/** Produces a detached clone suitable for app-state snapshots and comparisons. */
export function cloneStateValue<T>(value: T): T {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (value instanceof Date) {
        return new Date(value.getTime()) as unknown as T;
    }
    if (Array.isArray(value)) {
        return value.map(entry => cloneStateValue(entry)) as unknown as T;
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        result[key] = cloneStateValue(entry);
    }
    return result as T;
}

/** Serializes state values with deterministic key ordering. */
export function stableSerializeStateValue(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (value === undefined) {
        return "undefined";
    }
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(entry => stableSerializeStateValue(entry)).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const objectValue = value as Record<string, unknown>;
        const keys = Object.keys(objectValue).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerializeStateValue(objectValue[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/** Computes a stable hash for a state value. */
export function hashStateValue(value: unknown): string {
    const serialized = stableSerializeStateValue(value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < serialized.length; i++) {
        hash ^= serialized.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
