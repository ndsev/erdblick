import {z} from "zod";

export interface SearchHistoryEntry {
    version: 2;
    actionId: string;
    input: string;
    actionName?: string;
    savedAt?: number;
}

export type LegacySearchHistoryEntry = [number, string];
export type SearchHistoryStateEntry = SearchHistoryEntry | LegacySearchHistoryEntry;
export type SearchStateValue = SearchHistoryStateEntry | [];
export type SerializedSearchStateValue = [string, string] | LegacySearchHistoryEntry | [];

export const VersionedSearchHistoryEntrySchema = z.object({
    version: z.literal(2),
    actionId: z.string(),
    input: z.string(),
    actionName: z.string().optional(),
    savedAt: z.coerce.number().optional()
});

export const CompactSearchHistoryEntrySchema = z.tuple([z.string(), z.string()]);
export const LegacySearchHistoryEntrySchema = z.tuple([z.coerce.number(), z.string()]);

export const SearchHistoryStateEntrySchema = z.union([
    VersionedSearchHistoryEntrySchema,
    CompactSearchHistoryEntrySchema,
    LegacySearchHistoryEntrySchema
]);

export const SearchStateSchema = z.union([
    z.tuple([]),
    SearchHistoryStateEntrySchema
]);

export function isLegacySearchHistoryEntry(entry: SearchHistoryStateEntry | null | undefined): entry is LegacySearchHistoryEntry {
    return Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "number";
}

export function normalizeSearchHistoryEntry(raw: unknown): SearchHistoryStateEntry | null {
    if (Array.isArray(raw) && raw.length === 2 && typeof raw[1] === "string") {
        const input = raw[1].trim();
        if (!input) {
            return null;
        }
        if (typeof raw[0] === "number" && Number.isFinite(raw[0])) {
            return [raw[0], input];
        }
        if (typeof raw[0] === "string") {
            const actionId = raw[0].trim();
            return actionId ? {version: 2, actionId, input} : null;
        }
        return null;
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
    }

    const value = raw as Partial<SearchHistoryEntry>;
    if (value.version !== 2 || typeof value.actionId !== "string" || typeof value.input !== "string") {
        return null;
    }

    const actionId = value.actionId.trim();
    const input = value.input.trim();
    if (!actionId || !input) {
        return null;
    }

    const actionName = typeof value.actionName === "string" && value.actionName.trim()
        ? value.actionName.trim()
        : undefined;
    const savedAt = typeof value.savedAt === "number" && Number.isFinite(value.savedAt)
        ? value.savedAt
        : undefined;

    return {
        version: 2,
        actionId,
        input,
        ...(actionName ? {actionName} : {}),
        ...(savedAt !== undefined ? {savedAt} : {})
    };
}

export function normalizeResolvedSearchHistoryEntry(raw: unknown): SearchHistoryEntry | null {
    const normalized = normalizeSearchHistoryEntry(raw);
    if (!normalized || isLegacySearchHistoryEntry(normalized)) {
        return null;
    }
    return normalized;
}

export function normalizeSearchStateValue(raw: unknown): SearchStateValue {
    if (Array.isArray(raw) && raw.length === 0) {
        return [];
    }
    return normalizeSearchHistoryEntry(raw) ?? [];
}

export function serializeSearchStateValue(value: SearchStateValue): SerializedSearchStateValue {
    if (Array.isArray(value) && value.length === 0) {
        return [];
    }
    const normalized = normalizeSearchHistoryEntry(value);
    if (!normalized) {
        return [];
    }
    if (isLegacySearchHistoryEntry(normalized)) {
        return normalized;
    }
    return [normalized.actionId, normalized.input];
}

export function historyEntryDedupeKey(entry: SearchHistoryEntry): string {
    return `${entry.actionId}\u0000${entry.input}`;
}

export function historyEntryKey(entry: SearchHistoryEntry): string {
    return `${historyEntryDedupeKey(entry)}\u0000${entry.savedAt ?? ""}`;
}

export function sameSearchHistoryEntry(lhs: SearchHistoryEntry | null, rhs: SearchHistoryEntry | null): boolean {
    return !!lhs && !!rhs && lhs.actionId === rhs.actionId && lhs.input === rhs.input;
}

export function withSearchHistoryActionName(entry: SearchHistoryEntry, actionName: string | undefined): SearchHistoryEntry {
    const trimmedName = actionName?.trim();
    return {
        ...entry,
        ...(trimmedName ? {actionName: trimmedName} : {})
    };
}
