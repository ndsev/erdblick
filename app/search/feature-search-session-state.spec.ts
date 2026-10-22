import {watchState} from "@ngrx/signals";
import {Subject} from "rxjs";
import {afterEach, describe, expect, it} from "vitest";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {SEARCH_DOCK_TAB_ID} from "../shared/app-layout.model";
import {createStateOwners, StateOwners} from "../shared/state-test-owners";
import {FeatureSearchService} from "./feature.search.service";

const fixtures: StateOwners[] = [];
function fixture() {
    const owners = createStateOwners({events: new Subject(), navigate: async () => true,
        routerState: {snapshot: {root: {queryParams: {}}}}, getCurrentNavigation: () => undefined} as never,
    {showError() {}, showSuccess() {}, showWarning() {}} as never,
    [{provide: MapTileStreamService, useValue: {}}]);
    fixtures.push(owners);
    owners.persistence.initializePersistence();
    // Construct the real session engine. Only backend transport/schema resources
    // are fixtures; its native observation and session reconciliation remain active.
    const searches = owners.searches;
    const first = owners.store.addFeatureSearch({query: "Road", selectedViewIndices: [0]});
    const second = owners.store.addFeatureSearch({query: "Lane", selectedViewIndices: [0]});
    return {store: owners.store, injector: owners.injector, searches, first, second};
}

afterEach(() => {
    fixtures.splice(0).forEach(owners => owners.destroy());
    localStorage.clear();
});

describe("real search session layout operations", () => {
    it("docks and reorders an ordinary search with one complete native publication", () => {
        const {store, injector, searches, first, second} = fixture();
        searches.setSessionDocked(first.id, true);
        const observed: unknown[] = [];
        watchState(store, state => observed.push({open: state.layout.dockOpen,
            tab: state.layout.dockActiveTab,
            order: Object.entries(state.layout.dialogLayouts).filter(([, layout]) => layout.docked)
                .sort((left, right) => (left[1].dockOrder ?? 0) - (right[1].dockOrder ?? 0)).map(([id]) => id)
        }), {injector});
        observed.length = 0;
        searches.setSessionDocked(second.id, true);
        expect(observed).toEqual([{open: true, tab: SEARCH_DOCK_TAB_ID, order: [
            FeatureSearchService.layoutIdForSearch(second.id), FeatureSearchService.layoutIdForSearch(first.id)
        ]}]);
        expect(searches.getDockedSessions().map(session => session.id)).toEqual([second.id, first.id]);
    });

    it("creates a docked clone's definition, order and runtime shell from the same revision", () => {
        const {store, injector, searches, first} = fixture();
        searches.setSessionDocked(first.id, true);
        const observed: unknown[] = [];
        watchState(store, state => observed.push({ids: state.searches.featureSearch.map(entry => entry.id),
            layouts: state.layout.dialogLayouts, open: state.layout.dockOpen, tab: state.layout.dockActiveTab
        }), {injector});
        observed.length = 0;
        const clone = searches.cloneSearch(first.id)!;
        expect(clone).toBeDefined();
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({ids: expect.arrayContaining([first.id, clone.id]), open: true,
            tab: SEARCH_DOCK_TAB_ID, layouts: {[clone.layoutId]: {docked: true, dockOrder: 0}}});
        expect(searches.getDockedSessions().map(session => session.id)).toEqual([clone.id, first.id]);
        expect(clone.searchResults).toEqual([]);
    });

    it("keeps a manually opened empty dock when editing or closing a floating search", () => {
        const {store, searches, first} = fixture();
        store.setDockOpen(true);
        store.setDockWidth(480);
        store.patchFeatureSearch(first.id, {bookmarked: true});
        expect(store.layout.dockOpen()).toBe(true);
        store.closeSearchSurfaces([]);
        searches.closeSearch(first.id);
        expect(store.layout.dockOpen()).toBe(true);
        expect(store.layout.dockWidth()).toBe(480);
    });

    it("closes the final docked search without an observer performing a second layout repair", () => {
        const {store, injector, searches, first} = fixture();
        searches.setSessionDocked(first.id, true);
        const observed: unknown[] = [];
        watchState(store, state => observed.push({ids: state.searches.featureSearch.map(entry => entry.id),
            layout: state.layout.dialogLayouts[FeatureSearchService.layoutIdForSearch(first.id)],
            open: state.layout.dockOpen}), {injector});
        observed.length = 0;
        searches.closeSearch(first.id);
        expect(observed).toEqual([{ids: expect.not.arrayContaining([first.id]), layout: undefined, open: false}]);
        expect(searches.getSession(first.id)).toBeUndefined();
    });
});
