/**
 * Panning streams results without checking unrelated panels. The dialog shell,
 * progress presenter and style editor keep their separate scheduling ownership.
 */
import "@angular/compiler";
import {afterEach, describe, expect, it, vi} from "vitest";
import {Subject} from "rxjs";
import {AppModule} from "../../../app/app.module";
import {SearchComponent} from "../../../app/search/search.component";
import {SearchDiagnosticsComponent} from "../../../app/search/search-diagnostics.component";
import {SearchVisualizationComponent} from "../../../app/search/search-visualization.component";
import {SearchService} from "../../../app/search/search.service";
import type {FeatureSearchSession} from "../../../app/search/search-session.model";
import {createFeatureSearchStateEntry} from "../../../app/search/search-definition.model";
import type {FeatureSearchStyleFieldInventory} from "../../../app/search/search.model";

void AppModule;

const components: Array<{ngOnDestroy(): void}> = [];
afterEach(() => {
    components.splice(0).forEach(component => component.ngOnDestroy());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

/** Keep projection logic real; replace only transport, catalogs and rendering. */
function fixture() {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const progress = new Subject<FeatureSearchSession>();
    const sessionsChanged = new Subject<FeatureSearchSession[]>();
    const styleGroups = new Subject<void>();
    const styles = new Map([["Saved", {
        id: "Saved", category: "search", source: "name: Saved\nrules: []\n"
    }]]);
    const fields = vi.fn<() => Promise<FeatureSearchStyleFieldInventory>>();
    const search = Object.create(SearchService.prototype) as SearchService;
    Object.assign(search, {
        searchRunCounter: 0,
        searchSchema: {searchScopeAnalysisSignature: () => "test-schema"}
    });
    const session = search["createSession"](createFeatureSearchStateEntry({query: "speed"}));
    session.preparation = {
        signature: "test-schema", status: "ready", interpretations: [],
        selectedIds: [], branches: [], initialStyles: []
    };
    session.schemaAnalysis.status = "ready";
    session.results.progressTotal = 4;
    session.results.resultTileIngressTotal = 4;
    const detectChanges = vi.fn();
    const markForCheck = vi.fn();
    const run = vi.fn((callback: () => unknown) => callback());
    const runOutsideAngular = vi.fn((callback: () => unknown) => callback());
    const changeDetector = {detectChanges, markForCheck};
    const zone = {run, runOutsideAngular};
    const controller = {
        progress, sessionsChanged, getSession: () => session, isSessionDocked: () => true,
        state: {featureSearchGrouping: [], featureSearchGroupingState: new Subject<number[]>()}
    };
    const component = new SearchComponent(controller as never, {} as never, {} as never,
        {} as never, {state: {isDockOpen: false}} as never, changeDetector as never, zone as never);
    const diagnostics = new SearchDiagnosticsComponent(controller as never, changeDetector as never, zone as never);
    const visualization = new SearchVisualizationComponent(controller as never,
        {maps$: new Subject()} as never, {requestPreparedSearchStyleFields: fields} as never,
        {styles, styleGroups} as never, {} as never, {} as never, {} as never, changeDetector as never);
    components.push(component, diagnostics, visualization);
    component.searchId = diagnostics.searchId = visualization.searchId = session.id;
    visualization.session = diagnostics.session = session;
    diagnostics.mode = "progress";
    component["syncFromSession"](session);
    return {
        component, diagnostics, visualization, session, progress, sessionsChanged, styles, styleGroups, fields,
        detectChanges, markForCheck, run, runOutsideAngular, frames,
        frame: () => {
            const pending = [...frames.values()];
            frames.clear();
            pending.forEach(callback => callback(performance.now()));
        }
    };
}

describe("Search panel change detection", () => {
    it("coalesces a progress burst and publishes the shell locally with the latest counters", () => {
        const f = fixture();
        for (let i = 0; i < 100; i++) {
            f.session.results.progressDone = i % 5;
            f.progress.next(f.session);
        }
        f.session.results.progressDone = 4;
        f.session.results.resultTileIngressDone = 4;
        f.session.results.complete = true;
        expect(f.frames.size).toBe(1);
        expect(f.detectChanges).not.toHaveBeenCalled();
        const revision = f.component.sessionRevision;
        f.frame();
        expect(f.component.sessionRevision).toBe(revision + 1);
        expect(f.component.canStopSearch).toBe(false);
        expect(f.detectChanges).toHaveBeenCalledOnce();
        expect(f.runOutsideAngular).toHaveBeenCalled();
        expect(f.run).not.toHaveBeenCalled();
        expect(f.markForCheck).not.toHaveBeenCalled();
    });

    it("coalesces progress presentation and renders completion without checking the application", async () => {
        const f = fixture();
        for (let i = 0; i < 100; i++) f.diagnostics.ngOnChanges();
        f.session.results.progressDone = 4;
        f.session.results.resultTileIngressDone = 4;
        f.session.results.complete = true;
        await Promise.resolve();
        expect(f.diagnostics.progressLabel).toBe("Complete, 4/4 tiles");
        expect(f.diagnostics.progressDisplayPercent).toBe(100);
        expect(f.detectChanges).toHaveBeenCalledOnce();
        expect(f.run).not.toHaveBeenCalled();
        expect(f.markForCheck).not.toHaveBeenCalled();
    });

    it("keeps progress forward when streamed results and source totals grow", async () => {
        const f = fixture();
        f.session.results.progressDone = 2;
        f.session.results.resultTileIngressDone = 2;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressDisplayPercent).toBe(50);

        // New coverage and later source reports must not take displayed progress
        // away. Only fully received/decoded tiles contribute to the percentage.
        f.session.results.resultTileIngressTotal = 8;
        f.session.results.progressTotal = 8;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressDisplayPercent).toBe(50);
        f.session.results.progressDone = 6;
        f.session.results.resultTileIngressDone = 6;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressDisplayPercent).toBe(75);
        expect(f.diagnostics.progressMeterItems).toHaveLength(1);

        f.session.results.progressDone = 4;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressLabel).toBe("Searching, 75%");
        expect(f.diagnostics.progressTooltip).toContain("Received and decoded: 6 / 8 tiles");
    });

    it("waits for receiving and tree work, even before the tree's first report", async () => {
        const f = fixture();
        f.session.results.progressDone = 4;
        f.session.results.backendComplete = true;
        f.session.results.resultTileIngressDone = 1;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressLabel).toBe("Searching, 25%");
        expect(f.diagnostics.progressDisplayPercent).toBe(25);
        expect(f.diagnostics.finishingResults).toBe(false);

        f.session.results.searchResults.push({
            label: "Road.1", mapId: "Map", layerId: "Road", featureId: "Road.1",
            resultIndex: 0, resultKey: "one", mapTileKey: "tile", sourceTileKey: "tile",
            sourceMapId: "Map", sourceLayerId: "Road", sourceTileId: 1, hoverFeatureId: "Road.1"
        });
        f.session.results.resultTileIngressDone = 4;
        f.session.results.complete = true;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressLabel).toBe("Organizing results…");
        expect(f.diagnostics.progressDisplayPercent).toBe(99);
        expect(f.diagnostics.finishingResults).toBe(true);

        f.diagnostics.treeIngress = {done: 1, total: 1};
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressLabel).toBe("Complete, 4/4 tiles");
        expect(f.diagnostics.progressDisplayPercent).toBe(100);
        expect(f.diagnostics.finishingResults).toBe(false);
    });

    it("starts a fresh meter for a rerun and for new coverage after completion", async () => {
        const f = fixture();
        f.session.results.progressDone = 3;
        f.session.results.resultTileIngressDone = 3;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressDisplayPercent).toBe(75);

        f.session.runId = "rerun";
        f.session.results.progressDone = 1;
        f.session.results.resultTileIngressDone = 1;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressDisplayPercent).toBe(25);

        f.session.results.complete = true;
        f.session.results.progressDone = 4;
        f.session.results.resultTileIngressDone = 4;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressDisplayPercent).toBe(100);

        f.session.results.complete = false;
        f.session.results.progressDone = 1;
        f.session.results.resultTileIngressDone = 1;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressDisplayPercent).toBe(25);
    });

    it("keeps partial progress when pausing instead of treating paused completion as 100%", async () => {
        const f = fixture();
        f.session.results.resultTileIngressDone = 1;
        f.session.results.complete = true;
        f.session.paused = true;
        f.diagnostics.ngOnChanges();
        await Promise.resolve();
        expect(f.diagnostics.progressLabel).toBe("Paused, 25%");
        expect(f.diagnostics.progressDisplayPercent).toBe(25);
        expect(f.diagnostics.finishingResults).toBe(false);
    });

    it("ignores progress for another search", () => {
        const f = fixture();
        f.progress.next({...f.session, id: "other-search"});
        expect(f.frames.size).toBe(0);
        expect(f.detectChanges).not.toHaveBeenCalled();
    });

    it("reuses saved-style projections during panning and refreshes them for scope/catalog edits", () => {
        vi.useFakeTimers();
        const f = fixture();
        f.visualization.ngOnChanges();
        vi.runAllTimers();
        const options = f.visualization.searchStyleOptions;
        for (let i = 0; i < 10; i++) {
            f.visualization.ngOnChanges();
            vi.runAllTimers();
        }
        expect(f.visualization.searchStyleOptions).toBe(options);
        f.session.schemaAnalysis.concreteScope = "attribute";
        f.visualization.ngOnChanges();
        vi.runAllTimers();
        expect(f.visualization.searchStyleOptions).not.toBe(options);
        const attributeOptions = f.visualization.searchStyleOptions;
        f.styles.set("New", {id: "New", category: "search", source: "name: New\nrules: []\n"});
        f.styleGroups.next();
        vi.runAllTimers();
        expect(f.visualization.searchStyleOptions).not.toBe(attributeOptions);
        expect(f.visualization.searchStyleOptions.map(option => option.value)).toEqual(["New", "Saved"]);
    });

    it("uses an explicitly changed scope while schema analysis is still pending", () => {
        vi.useFakeTimers();
        const f = fixture();
        f.visualization.ngOnChanges();
        vi.runAllTimers();
        const options = f.visualization.searchStyleOptions;
        f.session.schemaAnalysis.status = "pending";
        f.session.definition.scope = "attribute";
        f.visualization.ngOnChanges();
        vi.runAllTimers();
        expect(f.visualization.searchStyleOptions).not.toBe(options);
        expect(f.visualization["searchStyleOptionsScope"]).toBe("attribute");
    });

    it.each([false, true])("notifies OnPush when schema fields finish (failure: %s)", async failure => {
        const f = fixture();
        const inventory: FeatureSearchStyleFieldInventory = {
            fields: [], types: [], contexts: [], branches: [], complete: true, incompleteReason: ""
        };
        if (failure) f.fields.mockRejectedValue(new Error("offline"));
        else f.fields.mockResolvedValue(inventory);
        f.visualization.styleAttributeOptionsLoading = true;
        f.visualization["refreshStyleAttributeOptions"](f.session);
        await Promise.resolve();
        await Promise.resolve();
        expect(f.visualization.styleAttributeOptionsLoading).toBe(false);
        expect(f.markForCheck).toHaveBeenCalledOnce();
        expect(f.visualization.styleAttributeOptionsError).toContain(failure ? "offline" : "");
    });

    it("cancels queued frames and ignores late progress/schema replies after closing", async () => {
        const f = fixture();
        let finish!: (inventory: FeatureSearchStyleFieldInventory) => void;
        f.fields.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        f.visualization["refreshStyleAttributeOptions"](f.session);
        f.progress.next(f.session);
        f.component.ngOnDestroy();
        f.visualization.ngOnDestroy();
        finish({fields: [], types: [], contexts: [], branches: [], complete: true, incompleteReason: ""});
        await Promise.resolve();
        expect(f.frames.size).toBe(0);
        expect(f.detectChanges).not.toHaveBeenCalled();
        expect(f.markForCheck).not.toHaveBeenCalled();
        f.progress.next(f.session);
        expect(f.frames.size).toBe(0);
    });
});
