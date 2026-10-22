/**
 * Saved command identities and their replay payloads. History accepts deployed
 * tuple formats as well as versioned records; resolving an identity to a live
 * action remains the omnibar component's responsibility.
 */
import { z } from "zod";

export interface OmnibarHistoryEntry {
    version: 2;
    actionId: string;
    input: string;
    actionName?: string;
    payload?: unknown;
    savedAt?: number;
}

export type LegacyOmnibarHistoryEntry = [number, string];
export type OmnibarHistoryStateEntry = OmnibarHistoryEntry | LegacyOmnibarHistoryEntry;

export const VersionedOmnibarHistoryEntrySchema = z.object({
    version: z.literal(2),
    actionId: z.string(),
    input: z.string(),
    actionName: z.string().optional(),
    payload: z.unknown().optional(),
    savedAt: z.coerce.number().optional()
});

export const LegacyOmnibarHistoryEntrySchema = z.tuple([z.number().int().nonnegative(), z.string()]);

/** Returns whether a stored command uses the legacy numeric action identity. */
export function isLegacyOmnibarHistoryEntry(
    entry: OmnibarHistoryStateEntry | null | undefined
): entry is LegacyOmnibarHistoryEntry {
    return Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "number";
}

/** Normalizes a raw omnibar history entry. */
export function normalizeOmnibarHistoryEntry(raw: unknown): OmnibarHistoryStateEntry | null {
    if (Array.isArray(raw) && raw.length === 2 && typeof raw[1] === "string") {
        const input = raw[1].trim();
        if (!input) {
            return null;
        }
        if (typeof raw[0] === "number" && Number.isInteger(raw[0]) && raw[0] >= 0) {
            return [raw[0], input];
        }
        if (typeof raw[0] === "string") {
            const actionId = raw[0].trim();
            return actionId ? { version: 2, actionId, input } : null;
        }
        return null;
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
    }

    const value = raw as Partial<OmnibarHistoryEntry>;
    if (value.version !== 2 || typeof value.actionId !== "string" || typeof value.input !== "string") {
        return null;
    }

    const actionId = value.actionId.trim();
    const input = value.input.trim();
    if (!actionId || !input) {
        return null;
    }

    const actionName =
        typeof value.actionName === "string" && value.actionName.trim() ? value.actionName.trim() : undefined;
    const savedAt =
        typeof value.savedAt === "number" && Number.isFinite(value.savedAt) ? value.savedAt : undefined;
    const payload = normalizeOmnibarHistoryPayload(value.payload);

    return {
        version: 2,
        actionId,
        input,
        ...(actionName ? { actionName } : {}),
        ...(payload !== undefined ? { payload } : {}),
        ...(savedAt !== undefined ? { savedAt } : {})
    };
}

/** Returns a small JSON-serializable payload value, or undefined when it is unsafe to persist. */
export function normalizeOmnibarHistoryPayload(payload: unknown): unknown {
    if (payload === undefined) {
        return undefined;
    }
    try {
        const serialized = JSON.stringify(payload);
        if (serialized === undefined || serialized.length > 8192) {
            return undefined;
        }
        return JSON.parse(serialized);
    } catch {
        return undefined;
    }
}

/** Normalizes a raw resolved omnibar history entry. */
export function normalizeResolvedOmnibarHistoryEntry(raw: unknown): OmnibarHistoryEntry | null {
    const normalized = normalizeOmnibarHistoryEntry(raw);
    if (!normalized || isLegacyOmnibarHistoryEntry(normalized)) {
        return null;
    }
    return normalized;
}

/** Builds the dedupe key for an omnibar history entry. */
export function historyEntryDedupeKey(entry: OmnibarHistoryEntry): string {
    return `${entry.actionId}\u0000${entry.input}`;
}

/** Builds the stable key for an omnibar history entry. */
export function historyEntryKey(entry: OmnibarHistoryEntry): string {
    return `${historyEntryDedupeKey(entry)}\u0000${entry.savedAt ?? ""}`;
}

/** Attaches an action name to an omnibar history entry. */
export function withOmnibarHistoryActionName(
    entry: OmnibarHistoryEntry,
    actionName: string | undefined
): OmnibarHistoryEntry {
    const trimmedName = actionName?.trim();
    return {
        ...entry,
        ...(trimmedName ? { actionName: trimmedName } : {})
    };
}
