import {z} from "zod";

/** Legacy URL/search-history entry used before search targets had stable ids. */
export type LegacySearchHistoryEntry = [number, string];

/** Persisted search entry keyed by the stable search target id. */
export interface SearchHistoryEntry {
    version: 2;
    actionId: string;
    input: string;
    actionName?: string;
    savedAt?: number;
}

/** Search-state value accepted from current URLs/storage or legacy history payloads. */
export type SearchHistoryStateEntry = SearchHistoryEntry | LegacySearchHistoryEntry;

/** Active search state; an empty tuple clears the omnibox state. */
export type SearchStateValue = SearchHistoryStateEntry | [];

const LEGACY_SEARCH_HISTORY_ENTRY_SCHEMA = z.tuple([
    z.coerce.number().int(),
    z.string()
]);

const COMPACT_SEARCH_HISTORY_ENTRY_SCHEMA = z.tuple([
    z.string(),
    z.string()
]);

const SEARCH_HISTORY_ENTRY_SCHEMA = z.object({
    version: z.literal(2),
    actionId: z.string(),
    input: z.string(),
    actionName: z.string().optional(),
    savedAt: z.coerce.number().optional()
});

/** Schema for one active search-history entry, including compact URL tuples. */
export const SearchHistoryStateEntrySchema = z.union([
    SEARCH_HISTORY_ENTRY_SCHEMA,
    LEGACY_SEARCH_HISTORY_ENTRY_SCHEMA,
    COMPACT_SEARCH_HISTORY_ENTRY_SCHEMA
]);

/** Schema for the active search state persisted by `AppStateService`. */
export const SearchStateSchema = z.union([
    z.tuple([]),
    SearchHistoryStateEntrySchema
]);

/** Returns true when a search entry still uses the legacy target-index format. */
export function isLegacySearchHistoryEntry(entry: unknown): entry is LegacySearchHistoryEntry {
    return Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "number" && typeof entry[1] === "string";
}

/** Normalizes current and legacy search-history payloads into their runtime representation. */
export function normalizeSearchHistoryEntry(rawEntry: unknown): SearchHistoryStateEntry | null {
    const parsed = SearchHistoryStateEntrySchema.safeParse(rawEntry);
    if (!parsed.success) {
        return null;
    }

    const entry = parsed.data;
    if (Array.isArray(entry)) {
        const input = entry[1].trim();
        if (!input) {
            return null;
        }
        if (typeof entry[0] === "number") {
            return [entry[0], input];
        }
        const actionId = entry[0].trim();
        return actionId ? {version: 2, actionId, input} : null;
    }

    const actionId = entry.actionId.trim();
    const input = entry.input.trim();
    if (!actionId || !input) {
        return null;
    }
    const actionName = entry.actionName?.trim();
    return {
        version: 2,
        actionId,
        input,
        ...(actionName ? {actionName} : {}),
        ...(entry.savedAt !== undefined ? {savedAt: entry.savedAt} : {})
    };
}

/** Normalizes only stable-id search entries; legacy index entries require target-list migration first. */
export function normalizeResolvedSearchHistoryEntry(rawEntry: unknown): SearchHistoryEntry | null {
    const entry = normalizeSearchHistoryEntry(rawEntry);
    return entry && !isLegacySearchHistoryEntry(entry) ? entry : null;
}

/** Normalizes the active search state, returning an empty tuple when no valid entry exists. */
export function normalizeSearchStateValue(rawValue: unknown): SearchStateValue {
    if (Array.isArray(rawValue) && rawValue.length === 0) {
        return [];
    }
    return normalizeSearchHistoryEntry(rawValue) ?? [];
}

/** Serializes active search state into the compact URL tuple used by existing links. */
export function serializeSearchStateValue(value: SearchStateValue): [] | [number, string] | [string, string] {
    if (Array.isArray(value)) {
        return value;
    }
    return [value.actionId, value.input];
}

/** Stable key for exact entry identity including optional display metadata. */
export function historyEntryKey(entry: SearchHistoryEntry): string {
    return JSON.stringify([
        entry.actionId,
        entry.input,
        entry.actionName ?? "",
        entry.savedAt ?? null
    ]);
}

/** Stable key for deduplicating entries that execute the same action on the same input. */
export function historyEntryDedupeKey(entry: SearchHistoryEntry): string {
    return JSON.stringify([entry.actionId, entry.input]);
}

/** Compares two resolved entries by the executable search action and input. */
export function sameSearchHistoryEntry(
    left: SearchHistoryEntry | null,
    right: SearchHistoryEntry | null
): boolean {
    if (!left || !right) {
        return left === right;
    }
    return historyEntryDedupeKey(left) === historyEntryDedupeKey(right);
}

/** Attaches the current target display name without changing the executable search identity. */
export function withSearchHistoryActionName(entry: SearchHistoryEntry, actionName: string): SearchHistoryEntry {
    return {
        ...entry,
        actionName
    };
}
