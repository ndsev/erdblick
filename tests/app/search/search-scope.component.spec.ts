/** Catalog and view changes must remain visible when a search is idle or disabled. */
import "@angular/compiler";
import {NgComponentOutlet} from "@angular/common";
import {ChangeDetectionStrategy, Component} from "@angular/core";
import {TestBed} from "@angular/core/testing";
import {FormsModule} from "@angular/forms";
import {NoopAnimationsModule} from "@angular/platform-browser/animations";
import {CheckboxModule} from "primeng/checkbox";
import {IftaLabelModule} from "primeng/iftalabel";
import {MultiSelectModule} from "primeng/multiselect";
import {SelectModule} from "primeng/select";
import {TreeSelectModule} from "primeng/treeselect";
import {Subject} from "rxjs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {MapDataService} from "../../../app/mapdata/mapdata.service";
import {MapViewState} from "../../../app/mapview/mapview.state";
import {createFeatureSearchStateEntry} from "../../../app/search/search-definition.model";
import {SearchResults} from "../../../app/search/search-results.model";
import {SearchScopeComponent} from "../../../app/search/search-scope.component";
import type {FeatureSearchSession} from "../../../app/search/search-session.model";
import {SearchService} from "../../../app/search/search.service";

/** An unchanged OnPush input models the search shell without progress or interaction. */
@Component({
    selector: "idle-search-host",
    imports: [NgComponentOutlet],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `<ng-container *ngComponentOutlet="scopeComponent; inputs: scopeInputs"></ng-container>`
})
class IdleSearchHostComponent {
    session: FeatureSearchSession = {
        id: "idle", layoutId: "idle", runId: "idle", refresh: 0, paused: false,
        startTime: 0, endTime: 0, timeElapsed: "0ms", pointColor: "#ff0000",
        definition: createFeatureSearchStateEntry({id: "idle", query: "true", enabled: false,
            selectedMapLayers: [{mapId: "Map", layerId: "Road"}, {mapId: "Map", layerId: "Lane"}],
            selectedViewIndices: [0, 1]}),
        results: new SearchResults({isEmpty: true, clear: vi.fn(), addContribution: vi.fn(),
            removeContribution: () => false, materialize: () => []}),
        schemaAnalysis: {signature: "", status: "pending", concreteScope: "feature", normalizedQuery: "true",
            attributeScopes: [], attributeScopeCandidateCount: 0, rewriteSuppressed: false,
            rewriteSuppressionReason: "", matchedFieldNames: [], matchedEnumValues: [], matchedFeatureTypes: []}
    };
    readonly scopeComponent = SearchScopeComponent;
    readonly scopeInputs = {searchId: this.session.id, session: this.session,
        definition: this.session.definition, analysis: this.session.schemaAnalysis};
}

/** Only catalogs are doubled; the selector's actual template and PrimeNG controls render normally. */
async function fixture() {
    const maps$ = new Subject<void>();
    const numViewsState = new Subject<number>();
    const views = {numViews: 1, numViewsState};
    const catalog = (ids: string[]) => {
        const layers = ids.map(id => ({mapId: "Map", id}));
        const map = {id: "Map", key: "Map", expanded: true, children: layers,
            layers: new Map(layers.map(layer => [layer.id, layer])), allFeatureLayers: () => layers};
        return {maps: new Map([[map.id, map]]), nodes: [map], allFeatureLayers: () => layers};
    };
    const mapData = {maps$, maps: catalog(["Road"]), featureTypesForLayer: () => ["Road"],
        canPruneStateForCurrentCatalog: () => false};
    TestBed.configureTestingModule({
        declarations: [SearchScopeComponent],
        imports: [IdleSearchHostComponent, FormsModule, NoopAnimationsModule, CheckboxModule, IftaLabelModule,
            MultiSelectModule, SelectModule, TreeSelectModule],
        providers: [
            {provide: SearchService, useValue: {}},
            {provide: MapDataService, useValue: mapData},
            {provide: MapViewState, useValue: views}
        ]
    });
    const rendered = TestBed.createComponent(IdleSearchHostComponent);
    rendered.autoDetectChanges();
    await rendered.whenStable();
    return {rendered, views, mapData, catalog, root: rendered.nativeElement as HTMLElement};
}

afterEach(() => TestBed.resetTestingModule());

describe("Idle search scope selectors", () => {
    it("shows a newly available selected layer without search progress or input changes", async () => {
        const f = await fixture();
        const label = () => f.root.querySelector(".feature-search-layer-select")?.textContent ?? "";
        expect(label()).toContain("Map/Road");
        expect(label()).not.toContain("Map/Lane");
        f.mapData.maps = f.catalog(["Road", "Lane"]);
        f.mapData.maps$.next();
        // Let Angular respond to the notification; forcing fixture.detectChanges()
        // would check the OnPush host itself and conceal a missing notification.
        await f.rendered.whenStable();
        expect(label()).toContain("Map/Road");
        expect(label()).toContain("Map/Lane");
    });

    it("shows and hides the second-view selector while the disabled search stays idle", async () => {
        const f = await fixture();
        const selector = () => f.root.querySelector(".feature-search-view-select");
        expect(selector()).toBeNull();
        f.views.numViews = 2;
        f.views.numViewsState.next(2);
        await f.rendered.whenStable();
        expect(selector()).not.toBeNull();
        expect(selector()?.textContent).toContain("View");
        f.views.numViews = 1;
        f.views.numViewsState.next(1);
        await f.rendered.whenStable();
        expect(selector()).toBeNull();
    });
});
