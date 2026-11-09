/**
 * Panning streams results without asking Angular to check unrelated panels.
 * Exercise the real search view model with a controlled animation-frame queue:
 * progress must remain current, while saved styles and idle panels do no work.
 */
import "@angular/compiler";
import {afterEach, describe, expect, it, vi} from "vitest";
import {Subject} from "rxjs";
import {AppModule} from "../../../app/app.module";
import {SearchComponent} from "../../../app/search/search.component";
import {SearchService, type FeatureSearchSession} from "../../../app/search/search.service";
import {createFeatureSearchStateEntry} from "../../../app/search/search-definition.model";
import type {FeatureSearchStyleFieldInventory} from "../../../app/search/search.model";

void AppModule;

const components: SearchComponent[] = [];

afterEach(() => {
    components.splice(0).forEach(component => component.ngOnDestroy());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** Keep all projection logic real; replace only transport, catalogs and rendering. */
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
    session.progressTotal = 4;
    session.resultTileIngressTotal = 4;
    const detectChanges = vi.fn();
    const markForCheck = vi.fn();
    const run = vi.fn((callback: () => unknown) => callback());
    const runOutsideAngular = vi.fn((callback: () => unknown) => callback());
    const component = new SearchComponent(
        {
            progress, sessionsChanged, getSession: () => session, isSessionDocked: () => true,
            state: {featureSearchGrouping: [], featureSearchGroupingState: new Subject<number[]>()}
        } as never,
        {} as never,
        {
            maps$: new Subject(),
            maps: {maps: new Map(), nodes: [], allFeatureLayers: () => []},
            canPruneStateForCurrentCatalog: () => false
        } as never,
        {requestPreparedSearchStyleFields: fields} as never,
        {styles, styleGroups} as never,
        {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
        {detectChanges, markForCheck} as never,
        {run, runOutsideAngular} as never,
        {state: {isDockOpen: false}} as never,
        {numViews: 1, numViewsState: new Subject<number>()} as never,
        {} as never
    );
    components.push(component);
    component.searchId = session.id;
    component["syncFromSession"](session);
    return {
        component, session, progress, sessionsChanged, styles, styleGroups, fields,
        detectChanges, markForCheck, run, runOutsideAngular, frames,
        frame: () => {
            const pending = [...frames.values()];
            frames.clear();
            pending.forEach(callback => callback(performance.now()));
        }
    };
}

describe("Search panel change detection", () => {
    it("coalesces a progress burst and renders completion locally with the latest counters", async () => {
        const f = fixture();
        await Promise.resolve();
        f.frame(); // Initial result-tree sizing, unrelated to incoming progress.
        f.detectChanges.mockClear();
        f.runOutsideAngular.mockClear();

        for (let i = 0; i < 100; i++) {
            f.session.progressDone = i % 5;
            f.progress.next(f.session);
        }
        f.session.progressDone = 4;
        f.session.resultTileIngressDone = 4;
        f.session.complete = true;
        expect(f.frames.size).toBe(1);
        expect(f.detectChanges).not.toHaveBeenCalled();

        f.frame();
        await Promise.resolve();
        expect(f.component.progressLabel).toBe("Complete, 4/4 tiles");
        expect(f.component.progressDisplayPercent).toBe(100);
        expect(f.detectChanges).toHaveBeenCalledOnce();
        expect(f.runOutsideAngular).toHaveBeenCalled();
        expect(f.run).not.toHaveBeenCalled();
        expect(f.markForCheck).not.toHaveBeenCalled();
    });

    it("ignores progress for another search", async () => {
        const f = fixture();
        await Promise.resolve();
        f.frame();
        f.detectChanges.mockClear();
        f.progress.next({...f.session, id: "other-search"});
        expect(f.frames.size).toBe(0);
        expect(f.detectChanges).not.toHaveBeenCalled();
    });

    it("reuses saved-style projections during panning and refreshes them for scope/catalog edits", async () => {
        const f = fixture();
        const options = f.component.searchStyleOptions;
        await Promise.resolve();
        f.frame();
        for (let i = 0; i < 10; i++) {
            f.progress.next(f.session);
            f.frame();
            await Promise.resolve();
        }
        expect(f.component.searchStyleOptions).toBe(options);

        f.session.schemaAnalysis.concreteScope = "attribute";
        f.progress.next(f.session);
        f.frame();
        await Promise.resolve();
        expect(f.component.searchStyleOptions).not.toBe(options);

        const attributeOptions = f.component.searchStyleOptions;
        f.styles.set("New", {id: "New", category: "search", source: "name: New\nrules: []\n"});
        f.styleGroups.next();
        expect(f.component.searchStyleOptions).not.toBe(attributeOptions);
        expect(f.component.searchStyleOptions.map(option => option.value)).toEqual(["New", "Saved"]);
        expect(f.markForCheck).toHaveBeenCalledOnce();
    });

    it("uses an explicitly changed scope while schema analysis is still pending", async () => {
        const f = fixture();
        const options = f.component.searchStyleOptions;
        f.session.schemaAnalysis.status = "pending";
        f.session.definition.scope = "attribute";
        f.component["syncFromSession"](f.session);
        await Promise.resolve();
        expect(f.component.searchStyleOptions).not.toBe(options);
        expect(f.component["searchStyleOptionsScope"]).toBe("attribute");
    });

    it.each([false, true])("notifies OnPush when schema fields finish (failure: %s)", async failure => {
        const f = fixture();
        const inventory: FeatureSearchStyleFieldInventory = {
            fields: [], types: [], contexts: [], branches: [], complete: true, incompleteReason: ""
        };
        if (failure) f.fields.mockRejectedValue(new Error("offline"));
        else f.fields.mockResolvedValue(inventory);
        f.component.styleAttributeOptionsLoading = true;
        f.component["refreshStyleAttributeOptions"](f.session);
        await Promise.resolve();
        await Promise.resolve();
        expect(f.component.styleAttributeOptionsLoading).toBe(false);
        expect(f.markForCheck).toHaveBeenCalledOnce();
        expect(f.component.styleAttributeOptionsError).toContain(failure ? "offline" : "");
    });

    it("cancels queued frames and ignores late progress/schema replies after closing", async () => {
        const f = fixture();
        let finish!: (inventory: FeatureSearchStyleFieldInventory) => void;
        f.fields.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        f.component["refreshStyleAttributeOptions"](f.session);
        f.progress.next(f.session);
        f.component.ngOnDestroy();
        finish({fields: [], types: [], contexts: [], branches: [], complete: true, incompleteReason: ""});
        await Promise.resolve();
        expect(f.frames.size).toBe(0);
        expect(f.detectChanges).not.toHaveBeenCalled();
        expect(f.markForCheck).not.toHaveBeenCalled();
        f.progress.next(f.session);
        expect(f.frames.size).toBe(0);
    });
});
