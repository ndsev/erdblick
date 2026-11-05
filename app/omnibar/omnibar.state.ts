/**
 * Shared command-palette state, independent of feature search and navigation.
 * History uses the deployed searchHistory key; moving its ownership does not
 * discard saved commands. The component resolves old numeric action identities
 * against the live action registry after application initialization.
 */
import { Injectable } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { z } from "zod";
import { AppStateService } from "../appstate/appstate.service";
import {
    historyEntryDedupeKey,
    isLegacyOmnibarHistoryEntry,
    LegacyOmnibarHistoryEntrySchema,
    normalizeOmnibarHistoryEntry,
    OmnibarHistoryEntry,
    OmnibarHistoryStateEntry,
    VersionedOmnibarHistoryEntrySchema
} from "./omnibar-history.model";

@Injectable({ providedIn: "root" })
export class OmnibarState {
    constructor(private readonly persistence: AppStateService) {}

    /** Opening the palette is temporary UI state, so it is never shared in a URL. */
    readonly openState = new BehaviorSubject(false);

    get isOpen(): boolean {
        return this.openState.value;
    }
    set isOpen(value: boolean) {
        this.openState.next(value);
    }

    /**
     * History stays local and is excluded from exported snapshots. The decoder
     * accepts both a legacy single entry and a list, retaining valid neighbours
     * when an obsolete entry cannot be interpreted.
     */
    readonly historyState = this.persistence.registerState<OmnibarHistoryStateEntry[]>({
        name: "searchHistory",
        defaultValue: [],
        snapshotPersist: false,
        // Action payloads are JSON, including booleans. AppState's ordinary
        // compact-boolean codec would change the arguments of a saved command.
        toStorage: entries => entries,
        schema: z.preprocess(
            (value) => this.normalizeHistory(value),
            z.array(z.union([VersionedOmnibarHistoryEntrySchema, LegacyOmnibarHistoryEntrySchema]))
        )
    });

    /** Publish a bounded, deduplicated history after resolving live action names. */
    replaceHistory(entries: OmnibarHistoryEntry[]): void {
        this.historyState.next(this.normalizeHistory(entries));
    }

    /** Place a recently executed command first, keeping its current target payload. */
    remember(entry: OmnibarHistoryEntry): void {
        this.replaceHistory([
            entry,
            ...this.historyState.value.filter(
                (saved): saved is OmnibarHistoryEntry => !isLegacyOmnibarHistoryEntry(saved)
            )
        ]);
    }

    /**
     * Decode saved records without resolving action identities or constructing
     * controllers. Numeric legacy identities remain available for UI migration.
     */
    private normalizeHistory(raw: unknown): OmnibarHistoryStateEntry[] {
        const isSingleTuple = Array.isArray(raw) && raw.length === 2 &&
            (typeof raw[0] === "string" || typeof raw[0] === "number") && typeof raw[1] === "string";
        const entries = Array.isArray(raw) && !isSingleTuple ? raw : [raw];
        const result: OmnibarHistoryStateEntry[] = [];
        const seen = new Set<string>();
        for (const candidate of entries) {
            const entry = normalizeOmnibarHistoryEntry(candidate);
            if (!entry) continue;
            const key = isLegacyOmnibarHistoryEntry(entry)
                ? JSON.stringify(entry)
                : historyEntryDedupeKey(entry);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(entry);
            if (result.length === 100) break;
        }
        return result;
    }
}
