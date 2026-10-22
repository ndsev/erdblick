import {observeStore} from "../shared/persisted-state";
import {AppStore} from "../shared/app.store";
import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";

import {AppModule} from "../app.module";
import {FeatureSearchComponent} from "./feature.search.component";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {SEARCH_DOCK_TAB_ID} from "../shared/app-layout.model";
import {AppStateService} from "../shared/appstate.service";

void AppModule;

function resultTreeFixture() {
    const component = Object.create(FeatureSearchComponent.prototype) as any;
    const nestedGroup = {
        key: "nested",
        expanded: false,
        children: [{key: "leaf", leaf: true}]
    };
    const rootGroup = {
        key: "root",
        expanded: false,
        children: [nestedGroup]
    };
    component.resultsTree = [rootGroup];
    component.resultTreeInputLength = 2;
    component.resultTreeGroupingSignature = "1,2";
    component.resultTreeAutoExpandedSignature = "";
    component.scheduleTreeScrollHeightSync = vi.fn();
    return {component, rootGroup, nestedGroup};
}

describe("Feature Search result-tree completion", () => {
    it("publishes a Ctrl-click result as one pinned floating panel and reports a failed camera load", async () => {
        const injector = ownerTestInjector([AppStore, AppStore]);
        const inspections = injector.get(AppStore);
        const layout = injector.get(AppStore);
        layout.setDockOpen(true);
        layout.setDockActiveTab(SEARCH_DOCK_TAB_ID);
        const component = Object.create(FeatureSearchComponent.prototype) as any;
        component.store = inspections;
        component.stateService = injector.get(AppStateService);
        component.isDocked = () => true;
        component.inspectionSelection = {focusOnFeature: vi.fn().mockRejectedValue(new Error("Feature load failed"))};
        component.infoMessageService = {showError: vi.fn()};
        const observed: unknown[] = [];
        const priorPanels = inspections.inspection.selection();
        const subscription = observeStore(inspections, state => state.inspection.selection).subscribe(panels => observed.push({
            panels: panels.map(panel => ({features: panel.features, locked: panel.locked, undocked: panel.undocked})),
            dockOpen: layout.layout.dockOpen(),
            dockTab: layout.layout.dockActiveTab()
        }));
        const selected = {mapTileKey: "Features:Map:Layer:42", featureId: "Road.1"};

        component.selectResult({node: {data: selected}, originalEvent: {ctrlKey: true}});
        await Promise.resolve();

        expect(observed).toEqual([
            {panels: [], dockOpen: true, dockTab: SEARCH_DOCK_TAB_ID},
            {panels: [{features: [selected], locked: true, undocked: true}],
                dockOpen: true, dockTab: SEARCH_DOCK_TAB_ID}
        ]);
        expect(priorPanels).toEqual([]);
        expect(component.infoMessageService.showError).toHaveBeenCalledWith("Feature load failed");
        subscription.unsubscribe();
    });

    it("expands every result group only after completed results have entered the tree", () => {
        const {component, rootGroup, nestedGroup} = resultTreeFixture();
        const session = {
            runId: "search-run",
            complete: false,
            searchResults: [{}, {}]
        };

        component.expandCompletedResultTreeIfReady(session);
        expect(rootGroup.expanded).toBe(false);
        expect(nestedGroup.expanded).toBe(false);

        session.complete = true;
        component.resultTreeInputLength = 1;
        component.expandCompletedResultTreeIfReady(session);
        expect(rootGroup.expanded).toBe(false);

        component.resultTreeInputLength = 2;
        component.expandCompletedResultTreeIfReady(session);
        expect(rootGroup.expanded).toBe(true);
        expect(nestedGroup.expanded).toBe(true);
        expect(component.scheduleTreeScrollHeightSync).toHaveBeenCalledOnce();
    });

    it("does not reopen groups the user collapses after automatic expansion", () => {
        const {component, rootGroup} = resultTreeFixture();
        const session = {
            runId: "search-run",
            complete: true,
            searchResults: [{}, {}]
        };

        component.expandCompletedResultTreeIfReady(session);
        rootGroup.expanded = false;
        component.expandCompletedResultTreeIfReady(session);

        expect(rootGroup.expanded).toBe(false);
        expect(component.scheduleTreeScrollHeightSync).toHaveBeenCalledOnce();
    });
});
