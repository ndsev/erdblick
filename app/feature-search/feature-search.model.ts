/**
 * Saved search definitions and grouping preferences, independent of the search
 * engine and its workers. View membership callbacks keep selected view IDs
 * valid during URL hydration and view removal, before searches are executed.
 * FeatureSearchService owns execution, results and public search actions.
 */
import { Injectable } from "@angular/core";
import { z } from "zod";
import { MapViewModel } from "../mapview/mapview.model";
import { AppStateService } from "../state/app-state.service";
import {
    createFeatureSearchStateEntry,
    DEFAULT_FEATURE_SEARCH_GROUPING,
    FeatureSearchStateEntry,
    FeatureSearchStatePatch,
    FeatureSearchStateSchema,
    normalizeFeatureSearchGrouping,
    normalizeFeatureSearchState,
    serializeFeatureSearchState
} from "./feature-search-state";

/**
 * Search definitions use logical view IDs in memory. The existing URL, storage
 * and UI formats still use indices, translated by storeSearch/presentSearch.
 */
type StoredFeatureSearch = Omit<FeatureSearchStateEntry, "selectedViewIndices"> & {
    selectedViewIds: string[];
};

@Injectable({ providedIn: "root" })
export class FeatureSearchModel {
    constructor(
        private readonly persistence: AppStateService,
        private readonly viewSettings: MapViewModel
    ) {
        viewSettings.registerMembershipOwner({
            seed: (previous, count, sourceIndex) => {
                const sourceId = viewSettings.viewIdAt(sourceIndex);
                const added = viewSettings.viewIds.slice(previous, count);
                this.featureSearchState.next(
                    this.featureSearchState.value.map((entry) =>
                        entry.selectedViewIds.includes(sourceId)
                            ? { ...entry, selectedViewIds: [...entry.selectedViewIds, ...added] }
                            : entry
                    )
                );
            },
            import: (_previous, ids) =>
                this.featureSearchState.next(
                    this.featureSearchState.value.map((entry) => ({
                        ...entry,
                        selectedViewIds: entry.selectedViewIds.filter((id) => ids.includes(id))
                    }))
                ),
            retain: (indices) => {
                const ids = indices.map((index) => viewSettings.viewIdAt(index));
                this.featureSearchState.next(
                    this.featureSearchState.value.map((entry) => ({
                        ...entry,
                        selectedViewIds: entry.selectedViewIds.filter((id) => ids.includes(id))
                    }))
                );
            }
        });
    }

    readonly featureSearchGroupingState = this.persistence.registerState<number[]>({
        name: "featureSearchGrouping",
        defaultValue: [...DEFAULT_FEATURE_SEARCH_GROUPING],
        schema: z.array(z.coerce.number()),
        toStorage: (value: number[]) => normalizeFeatureSearchGrouping(value),
        fromStorage: (payload: any): number[] => normalizeFeatureSearchGrouping(payload),
        snapshotPersist: false
    });

    readonly featureSearchState = this.persistence.registerState<StoredFeatureSearch[]>({
        name: "featureSearchState",
        defaultValue: [],
        schema: FeatureSearchStateSchema,
        toStorage: (entries) =>
            serializeFeatureSearchState(entries.map((entry) => this.presentSearch(entry))),
        fromStorage: (payload) =>
            normalizeFeatureSearchState(payload).map((entry) => this.storeSearch(entry)),
        snapshotPersist: false
    });

    get featureSearchGrouping() {
        return this.featureSearchGroupingState.getValue();
    }

    set featureSearchGrouping(val: number[]) {
        this.featureSearchGroupingState.next(normalizeFeatureSearchGrouping(val));
    }

    get featureSearches(): FeatureSearchStateEntry[] {
        return this.featureSearchState.value.map((entry) => this.presentSearch(entry));
    }

    set featureSearches(values: FeatureSearchStateEntry[]) {
        this.featureSearchState.next(
            normalizeFeatureSearchState(values).map((entry) => this.storeSearch(entry))
        );
    }

    /** UI indices are converted once; persisted runtime ownership follows logical views. */
    private storeSearch(entry: FeatureSearchStateEntry): StoredFeatureSearch {
        const { selectedViewIndices, ...fields } = entry;
        return {
            ...fields,
            selectedViewIds: selectedViewIndices.flatMap((index) => {
                const id = this.viewSettings.viewIds[index];
                return id === undefined ? [] : [id];
            })
        };
    }

    /** Present current indices only when producing the existing UI/storage shape. */
    private presentSearch(entry: StoredFeatureSearch): FeatureSearchStateEntry {
        const { selectedViewIds, ...fields } = entry;
        return {
            ...fields,
            selectedViewIndices: selectedViewIds
                .map((id) => this.viewSettings.viewIds.indexOf(id))
                .filter((index) => index >= 0)
        };
    }

    /** Adds a persisted feature-search definition. Runtime results remain service-owned. */
    addFeatureSearch(value: { query: string } & Partial<FeatureSearchStateEntry>): FeatureSearchStateEntry {
        const entry = createFeatureSearchStateEntry(value);
        this.featureSearches = [...this.featureSearches, entry];
        return entry;
    }

    /** Patches one persisted feature-search definition. */
    patchFeatureSearch(id: string, patch: FeatureSearchStatePatch): FeatureSearchStateEntry | undefined {
        let updated: FeatureSearchStateEntry | undefined;
        const next = this.featureSearches.map((entry) => {
            if (entry.id !== id) {
                return entry;
            }
            updated = createFeatureSearchStateEntry({
                ...entry,
                ...patch,
                id: entry.id,
                query: patch.query ?? entry.query
            });
            return updated;
        });
        if (updated) {
            this.featureSearches = next;
        }
        return updated;
    }

    /** Removes one persisted feature-search definition. */
    removeFeatureSearch(id: string): void {
        const next = this.featureSearches.filter((entry) => entry.id !== id);
        if (next.length !== this.featureSearches.length) {
            this.featureSearches = next;
        }
    }
}
