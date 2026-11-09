import "@angular/compiler";
import { BehaviorSubject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeatureSearchStateEntry } from "../../../app/search/search-definition.model";
import { SearchResultsComponent } from "../../../app/search/search-results.component";
import { SearchResults } from "../../../app/search/search-results.model";
import type { FeatureSearchSession } from "../../../app/search/search-session.model";

/** Uses the component's real lifecycle and chunk scheduler with a controlled frame queue. */
function fixture(count: number) {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        callbacks.set(++nextFrame, callback);
        return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    const results = new SearchResults({isEmpty: true, clear: vi.fn(), addContribution: vi.fn(),
        removeContribution: () => false, materialize: () => []});
    results.searchResults = Array.from({length: count}, (_, index) => ({
        label: `Road.${index}`, featureId: `Road.${index}`, resultIndex: index, resultKey: String(index),
        mapId: "map", layerId: "layer", mapTileKey: "Features:map:layer:1", sourceTileKey: "source",
        sourceMapId: "map", sourceLayerId: "layer", sourceTileId: 1, hoverFeatureId: `Road.${index}`
    }));
    const session: FeatureSearchSession = {
        id: "s", layoutId: "s", runId: "run", refresh: 0, paused: false,
        startTime: 0, endTime: 0, timeElapsed: "", pointColor: "#ff0000", results,
        definition: createFeatureSearchStateEntry({id: "s", query: "true"}),
        schemaAnalysis: {signature: "", status: "ready", concreteScope: "feature", normalizedQuery: "true",
            attributeScopes: [], attributeScopeCandidateCount: 0, rewriteSuppressed: false,
            rewriteSuppressionReason: "", matchedFieldNames: [], matchedEnumValues: [], matchedFeatureTypes: []}
    };
    const component = new SearchResultsComponent({state: {featureSearchGrouping: [],
        featureSearchGroupingState: new BehaviorSubject<number[]>([])}} as never,
        {} as never, {} as never, {} as never, {} as never, {markForCheck: vi.fn(), detectChanges: vi.fn()} as never,
        {run: (work: () => unknown) => work(), runOutsideAngular: (work: () => unknown) => work()} as never,
        {} as never, {} as never, {} as never);
    component.searchId = session.id;
    component.session = session;
    component.ngOnChanges();
    return {component, session, results, callbacks, frame: () => {
        const current = [...callbacks.values()];
        callbacks.clear();
        current.forEach(callback => callback(0));
    }};
}

afterEach(() => vi.unstubAllGlobals());

describe("Search result-tree lifetime", () => {
    it("keeps appends bounded and cancels all pending frames when the tree is removed", () => {
        const h = fixture(2501);
        expect(h.component.resultsTree).toHaveLength(0);
        h.frame();
        expect(h.component.resultsTree.length).toBeGreaterThan(0);
        expect(h.component.resultsTree.length).toBeLessThanOrEqual(1000);
        expect(h.callbacks.size).toBeGreaterThan(0);
        h.component.ngOnDestroy();
        expect(h.callbacks.size).toBe(0);
        expect(h.component.resultsTree).toEqual([]);
    });

    it("replaces equal-length contributions without retaining old leaves and rebuilds grouping", () => {
        const h = fixture(2);
        h.frame();
        expect(h.component.resultsTree.map(node => node.label)).toEqual(["Road.0", "Road.1"]);
        h.results.searchResults = h.results.searchResults.map(row => ({...row, label: `new ${row.label}`}));
        h.component.ngOnChanges();
        h.frame();
        expect(h.component.resultsTree.map(node => node.label)).toEqual(["new Road.0", "new Road.1"]);
        h.component.onGroupingOptionsChange([{name: "Map", value: 1}]);
        h.frame();
        expect(h.component.resultsTree).toHaveLength(1);
        expect(h.component.resultsTree[0].children?.map(node => node.label)).toEqual(["new Road.0", "new Road.1"]);
        h.component.ngOnDestroy();
    });
});
