import {computed} from "@angular/core";
import {getState, signalStoreFeature, type, withComputed, withMethods, withProps} from "@ngrx/signals";
import type {NamedEntityState} from "@ngrx/signals/entities";
import {z} from "zod";
import type {ViewIdentity} from "../mapview/view-id";
import {
    createFeatureSearchStateEntry,
    FeatureSearchStateEntry,
    FeatureSearchStatePatch,
    FeatureSearchStateSchema,
    normalizeFeatureSearchState,
    serializeFeatureSearchState
} from "../shared/feature-search-state";
import {
    AppDialogLayout,
    FEATURE_SEARCH_DIALOG_LAYOUT_ID,
    SEARCH_DOCK_TAB_ID
} from "../shared/app-layout.model";
import type {AppLayoutValues} from "../shared/app-layout.store-feature";
import type {InspectionValues} from "../inspection/inspection.store-feature";
import {patchAppState, PersistenceDescriptor, transient, withPersistedState} from "../shared/persisted-state";
import {StateCodec} from "../shared/state-codec";
import {DEFAULT_FEATURE_SEARCH_GROUPING, normalizeFeatureSearchGrouping} from "./feature-search-grouping";

/** The store owns logical IDs; deployed local-storage entries still use view positions. */
export type StoredFeatureSearch = Omit<FeatureSearchStateEntry, "selectedViewIndices" | "selectedViewIds"> & {
    selectedViewIds: string[];
};
export interface FeatureSearchValues {
    featureSearchGrouping: number[];
    featureSearch: StoredFeatureSearch[];
}
type SearchRoot = NamedEntityState<ViewIdentity, "view"> & {searches: FeatureSearchValues};
type SearchLayoutRoot = SearchRoot & {layout: AppLayoutValues; inspection: InspectionValues};

function searchLayoutId(id: string): string {
    return `${FEATURE_SEARCH_DIALOG_LAYOUT_ID}:${id}`;
}

/** A removed saved search must leave no floating dialog, dock tile or pending first-open marker. */
export function normalizeSearchLayouts<State extends SearchLayoutRoot>(state: State): State {
    const active = new Set(state.searches.featureSearch.map((entry) => searchLayoutId(entry.id)));
    const stale = (id: string) =>
        (id === FEATURE_SEARCH_DIALOG_LAYOUT_ID || id.startsWith(`${FEATURE_SEARCH_DIALOG_LAYOUT_ID}:`)) &&
        !active.has(id);
    const removedDockedSurface = Object.entries(state.layout.dialogLayouts).some(
        ([id, layout]) => stale(id) && layout.docked
    );
    const dialogLayouts = Object.fromEntries(
        Object.entries(state.layout.dialogLayouts).filter(([id]) => !stale(id))
    );
    const dockOccupied =
        Object.values(dialogLayouts).some((layout) => layout.docked) ||
        state.inspection.selection.some((panel) => !panel.undocked);
    return {
        ...state,
        layout: {
            ...state.layout,
            dialogLayouts,
            pendingOpenDialogs: state.layout.pendingOpenDialogs.filter((id) => !stale(id)),
            // Hydration and unrelated edits can legitimately contain an empty,
            // manually opened dock. Collapse only when this cleanup removed its
            // final docked search, rather than treating emptiness as invalid state.
            dockOpen:
                state.layout.dockAutoCollapse && removedDockedSurface && !dockOccupied
                    ? false
                    : state.layout.dockOpen
        }
    };
}

/** Calculate search placement before publishing either its definition or its dock tile. */
function placeSearchSurface(
    layout: AppLayoutValues,
    id: string,
    docked: boolean,
    floating?: AppDialogLayout
): AppLayoutValues {
    const layoutId = searchLayoutId(id);
    const current = floating ??
        layout.dialogLayouts[layoutId] ?? {
            position: {left: 0, top: 0},
            size: {width: 480, height: 640},
            open: false
        };
    const dialogLayouts = {
        ...layout.dialogLayouts,
        [layoutId]: {...current, docked, dockTab: SEARCH_DOCK_TAB_ID}
    };
    if (docked) {
        const others = Object.entries(dialogLayouts)
            .filter(
                ([otherId, value]) =>
                    otherId !== layoutId && value.docked && value.dockTab === SEARCH_DOCK_TAB_ID
            )
            .sort((left, right) => (left[1].dockOrder ?? 0) - (right[1].dockOrder ?? 0));
        [layoutId, ...others.map(([otherId]) => otherId)].forEach((otherId, dockOrder) => {
            dialogLayouts[otherId] = {...dialogLayouts[otherId], dockOrder};
        });
    }
    return {
        ...layout,
        dialogLayouts,
        pendingOpenDialogs: layout.pendingOpenDialogs.filter((pending) => pending !== layoutId),
        dockOpen: docked || layout.dockOpen,
        dockActiveTab: docked ? SEARCH_DOCK_TAB_ID : layout.dockActiveTab
    };
}

/** Project at the persistence/runtime boundary; never store a second positional selection. */
export function projectSearches(
    entries: readonly StoredFeatureSearch[],
    ids: readonly (string | number)[]
): FeatureSearchStateEntry[] {
    return entries.map((entry) => ({
        ...entry,
        selectedViewIndices: entry.selectedViewIds.map((id) => ids.indexOf(id)).filter((index) => index >= 0)
    }));
}

/** Accept either a current ID selection or a legacy positional payload, then retain only live views. */
export function storeSearches(
    entries: readonly FeatureSearchStateEntry[],
    ids: readonly (string | number)[]
): StoredFeatureSearch[] {
    return entries.map(({selectedViewIndices, selectedViewIds, ...entry}) => ({
        ...entry,
        selectedViewIds:
            selectedViewIds?.filter((id) => ids.includes(id)) ??
            selectedViewIndices
                .map((index) => ids[index])
                .filter((id) => id !== undefined)
                .map(String)
    }));
}

/**
 * Search definitions are durable, while loaded result sessions remain runtime
 * resources. The released format stores view positions, so it projects IDs only
 * while reading/writing the codec instead of keeping two mutable selections.
 */
class SearchPersistence extends PersistenceDescriptor<FeatureSearchStateEntry[]> {
    constructor() {
        super(
            "searches",
            "featureSearch",
            new StateCodec<FeatureSearchStateEntry[]>({
                name: "featureSearchState",
                defaultValue: [],
                schema: FeatureSearchStateSchema,
                toStorage: (value) =>
                    serializeFeatureSearchState(value).map(({selectedViewIds, ...entry}) => entry),
                fromStorage: (value) => normalizeFeatureSearchState(value),
                snapshotPersist: false
            })
        );
    }
    override read(state: object): FeatureSearchStateEntry[] {
        const root = state as SearchRoot;
        return projectSearches(root.searches.featureSearch, root.viewIds);
    }
    override replace<S extends object>(state: S, value: FeatureSearchStateEntry[]): S {
        const root = state as unknown as SearchRoot;
        return {...state, searches: {...root.searches, featureSearch: storeSearches(value, root.viewIds)}};
    }
}

/** Search values and serialization; network requests and loaded sessions remain FeatureSearchService resources. */
export function withFeatureSearch() {
    return signalStoreFeature(
        {
            state: type<
                NamedEntityState<ViewIdentity, "view"> & {
                    layout: AppLayoutValues;
                    inspection: InspectionValues;
                }
            >()
        },
        withPersistedState<"searches", FeatureSearchValues>("searches", {
            featureSearchGrouping: {
                name: "featureSearchGrouping",
                defaultValue: [...DEFAULT_FEATURE_SEARCH_GROUPING],
                schema: z.array(z.coerce.number()),
                toStorage: normalizeFeatureSearchGrouping,
                fromStorage: (value) => normalizeFeatureSearchGrouping(value),
                snapshotPersist: false
            },
            featureSearch: transient([])
        }),
        withProps(() => ({searchPersistence: new SearchPersistence()})),
        withComputed((store) => ({
            featureSearchEntries: computed(() =>
                projectSearches(store.searches.featureSearch(), store.viewIds())
            )
        })),
        withMethods((store) => {
            // Removing a definition also removes its dock/floating geometry. The
            // session observer sees the complete edit and only releases resources.
            function setFeatureSearchEntries(entries: FeatureSearchStateEntry[]): void {
                const state = getState(store);
                const searches = {
                    ...state.searches,
                    featureSearch: storeSearches(normalizeFeatureSearchState(entries), state.viewIds)
                };
                patchAppState(store, normalizeSearchLayouts({...state, searches}));
            }
            return {
                setFeatureSearchEntries,
                setFeatureSearchGrouping(value: number[]): void {
                    patchAppState(store, {
                        searches: {
                            ...store.searches(),
                            featureSearchGrouping: normalizeFeatureSearchGrouping(value)
                        }
                    });
                },
                /** Create or clone a definition with its final dock position in one native publication. */
                addFeatureSearch(
                    value: {query: string} & Partial<FeatureSearchStateEntry>,
                    presentation?: {docked: boolean; floating?: AppDialogLayout}
                ): FeatureSearchStateEntry {
                    const entry = createFeatureSearchStateEntry(value);
                    const state = getState(store);
                    const searches = {
                        ...state.searches,
                        featureSearch: [
                            ...state.searches.featureSearch,
                            ...storeSearches([entry], state.viewIds)
                        ]
                    };
                    const docked =
                        presentation?.docked ??
                        Object.values(state.layout.dialogLayouts).some(
                            (layout) => layout.docked && layout.dockTab === SEARCH_DOCK_TAB_ID
                        );
                    const layout =
                        docked || presentation?.floating
                            ? placeSearchSurface(state.layout, entry.id, docked, presentation?.floating)
                            : state.layout;
                    patchAppState(store, {searches, layout});
                    return entry;
                },
                patchFeatureSearch(
                    id: string,
                    patch: FeatureSearchStatePatch
                ): FeatureSearchStateEntry | undefined {
                    let updated: FeatureSearchStateEntry | undefined;
                    const entries = store.featureSearchEntries().map((entry) => {
                        if (entry.id !== id) {
                            return entry;
                        }
                        updated = createFeatureSearchStateEntry({
                            ...entry,
                            ...patch,
                            ...(patch.selectedViewIndices ? {selectedViewIds: undefined} : {}),
                            id,
                            query: patch.query ?? entry.query
                        });
                        return updated;
                    });
                    if (updated) {
                        setFeatureSearchEntries(entries);
                    }
                    return updated;
                },
                removeFeatureSearch(id: string): void {
                    setFeatureSearchEntries(store.featureSearchEntries().filter((entry) => entry.id !== id));
                },
                /** Docking selects the Search tab and places this tile first in the same edit. */
                setSearchSurfaceDocked(id: string, docked: boolean, floating?: AppDialogLayout): void {
                    if (!store.searches.featureSearch().some((entry) => entry.id === id)) {
                        return;
                    }
                    patchAppState(store, {layout: placeSearchSurface(store.layout(), id, docked, floating)});
                },
                /** Remove transient/imported result surfaces without deleting saved search definitions. */
                closeSearchSurfaces(ids: readonly string[]): void {
                    const removed = new Set(ids.map(searchLayoutId));
                    const layout = store.layout();
                    const dialogLayouts = Object.fromEntries(
                        Object.entries(layout.dialogLayouts).filter(([id]) => !removed.has(id))
                    );
                    const removedDockedSurface = Object.entries(layout.dialogLayouts).some(
                        ([id, value]) => removed.has(id) && value.docked
                    );
                    const occupied =
                        Object.values(dialogLayouts).some((value) => value.docked) ||
                        store.inspection.selection().some((panel) => !panel.undocked);
                    patchAppState(store, {
                        layout: {
                            ...layout,
                            dialogLayouts,
                            pendingOpenDialogs: layout.pendingOpenDialogs.filter((id) => !removed.has(id)),
                            dockOpen:
                                layout.dockAutoCollapse && removedDockedSurface && !occupied
                                    ? false
                                    : layout.dockOpen
                        }
                    });
                }
            };
        })
    );
}
