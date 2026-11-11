/**
 * Search completion follows currently requested output partitions and their
 * decoded rows. Historical backend emissions must not turn viewport movement,
 * retransmission or style replacement into a permanently unfinished search.
 */
import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {AppModule} from "../../../app/app.module";
import {FilterTileState} from "../../../app/mapdata/filter-tile-state.model";
import {SearchService} from "../../../app/search/search.service";
import {SearchResults} from "../../../app/search/search-results.model";
import {SearchResultDensityIndex} from "../../../app/search/search-result-density.visualization";

void AppModule;

type Contribution = Parameters<SearchService["valueSummariesForContribution"]>[0];
type Presentation = Parameters<SearchService["handleSearchStyledLayerEvent"]>[0];

/** Build one received, empty result partition without involving native decoding. */
function receivedPartition(id: number): {state: FilterTileState; contribution: Contribution} {
    const key = `Features:map:Road:${id}`;
    const state = new FilterTileState("map", "Road", {kind: "tile", id}, key, 1);
    state.status = "ready";
    state.backendPending = false;
    state.deliveredGeneration = 1;
    state.subsetBlob = new Uint8Array([id]);
    return {
        state,
        contribution: {
            refresh: 0, sourceTileKey: key, sourceMapId: "map", sourceLayerId: "Road",
            sourceTileId: id, requestOrder: id, resultCount: 0, resultChannelOrdinal: 0,
            resultFields: [], results: [], diagnostics: null, layerBlob: state.subsetBlob,
            valueSummary: null, points: []
        }
    };
}

/** Supply only the owners used by completion, keeping transport counters independent. */
function progressFixture(count = 2) {
    const service = Object.create(SearchService.prototype) as SearchService;
    const partitions = Array.from({length: count}, (_, index) => receivedPartition(index));
    const results = new SearchResults(new SearchResultDensityIndex());
    Object.assign(results, {complete: false, backendComplete: true,
        progressTotal: count, progressDone: count,
        progressByRequestKey: new Map(),
        searchResultTilesBySourceKey: new Map(partitions.map(({state, contribution}) =>
            [state.mapTileKey, contribution]))
    });
    const session = {id: "search", paused: false, results} as Parameters<SearchService["updateSessionCompletion"]>[0];
    const presentation = {
        sessionId: session.id,
        styledLayer: {
            generation: 1,
            tileStates: new Map(partitions.map(({state}) => [state.partitionKey, state]))
        }
    } as Presentation;
    const pendingRebuilds = new Set<string>();
    Object.defineProperties(service, {
        searchPresentations: {value: new Map([["current", presentation]])},
        pendingResultDataRebuildSessionIds: {value: pendingRebuilds}
    });
    const update = () => {
        service["updateSearchResultIngressProgress"](session);
        service["updateSessionCompletion"](session);
    };
    return {service, session, presentation, partitions, pendingRebuilds, update};
}

describe("Search result ingress completion", () => {
    it("finishes sixteen current outputs despite twenty historical emissions", () => {
        const {service, session, update} = progressFixture(16);
        session.results.progressByRequestKey.set("current\n1", {
            tilesQueued: 16, tilesSearched: 16, chunksEmitted: 20,
            chunksReported: true, matches: 6, terminal: true
        });
        session.results.progressByRequestKey.set("old\n1", {
            tilesQueued: 4, tilesSearched: 4, chunksEmitted: 4,
            chunksReported: true, matches: 0, terminal: true
        });
        update();
        expect([session.results.resultTileIngressDone, session.results.resultTileIngressTotal]).toEqual([16, 16]);
        expect(session.results.complete).toBe(true);
        expect(session.results.canSummarizeSessionValues()).toBe(true);

        session.results.clearFilterSearchProgress("old");
        expect([...session.results.progressByRequestKey.keys()]).toEqual(["current\n1"]);
        expect(session.results.resultTileIngressTotal).toBe(16);
    });

    it("does not let terminal backend status hide a missing output", () => {
        const {session, partitions, update} = progressFixture();
        const missing = partitions[1];
        session.results.searchResultTilesBySourceKey.delete(missing.state.mapTileKey);
        update();
        expect([session.results.resultTileIngressDone, session.results.resultTileIngressTotal]).toEqual([1, 2]);
        expect(session.results.complete).toBe(false);

        session.results.searchResultTilesBySourceKey.set(missing.state.mapTileKey, missing.contribution);
        update();
        expect(session.results.complete).toBe(true);
    });

    it("waits for a replacement's current bytes and every result row", () => {
        const {session, partitions, update} = progressFixture(1);
        const {state, contribution} = partitions[0];
        state.markPending(1);
        update();
        expect(session.results.resultTileIngressDone).toBe(0);

        state.backendPending = false;
        state.subsetBlob = new Uint8Array([99]);
        update();
        expect(session.results.complete).toBe(false); // Retained rows still belong to the old bytes.

        contribution.layerBlob = state.subsetBlob;
        contribution.resultCount = 2;
        contribution.results.push(Object.create(null));
        update();
        expect(session.results.complete).toBe(false);
        contribution.results.push(Object.create(null));
        update();
        expect(session.results.complete).toBe(true);
    });

    it("drops off-screen outputs from the completion target even while old rows are retained", () => {
        const {session, presentation, partitions, update} = progressFixture();
        presentation.styledLayer.tileStates.delete(partitions[1].state.partitionKey);
        update();
        expect(session.results.searchResultTilesBySourceKey.size).toBe(2);
        expect([session.results.resultTileIngressDone, session.results.resultTileIngressTotal]).toEqual([1, 1]);
        expect(session.results.complete).toBe(true);
    });

    it("publishes completion only after a scheduled result-list rebuild", () => {
        const {service, session, pendingRebuilds, update} = progressFixture(1);
        pendingRebuilds.add(session.id);
        session.results.rebuildPending = true;
        update();
        expect(session.results.complete).toBe(false);
        const rebuild = vi.spyOn(session.results, "rebuildSessionResultData");
        const diagnostics = vi.fn();
        Object.defineProperties(service, {
            getInternalSession: {value: () => session},
            updateDiagnosticsForCompletedSearch: {value: diagnostics},
            progress: {value: {next: vi.fn()}}
        });
        service["flushPendingSessionResultDataRebuilds"]();
        expect(rebuild).toHaveBeenCalledOnce();
        expect(session.results.complete).toBe(true);
        expect(diagnostics).toHaveBeenCalledWith(session);
    });
});
