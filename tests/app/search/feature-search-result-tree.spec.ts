import { InspectionState } from "../../../app/inspection/inspection.state";
import { LayoutState } from "../../../app/layout/layout.state";
import "@angular/compiler";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";

import {AppModule} from "../../../app/app.module";
import {SearchComponent} from "../../../app/search/search.component";
import {testPersistence} from "../../support/state-owners";
import {LayoutService} from "../../../app/layout/layout.service";
import {InspectionPanelService} from "../../../app/inspection/inspection-panel.service";

void AppModule;

function resultTreeFixture() {
    const component = Object.create(SearchComponent.prototype) as any;
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

function inspectionSelectionFixture() {
    const persistence = testPersistence();
    const layout = new LayoutService(persistence, new LayoutState(persistence));
    const inspectionState = new InspectionPanelService(persistence, layout, {} as never, new InspectionState(persistence));
    const focusOnFeature = vi.fn().mockResolvedValue(undefined);
    const showError = vi.fn();
    const component = Object.create(SearchComponent.prototype) as SearchComponent;
    Object.assign(component, {
        stateService: persistence,
        inspectionState,
        isDocked: () => true,
        inspectionSelection: {focusOnFeature},
        infoMessageService: {showError}
    });
    return {component, persistence, layout, inspectionState, focusOnFeature, showError};
}

describe("Feature Search result inspection", () => {
    it("publishes a Ctrl-selected result as one fully locked floating panel", () => {
        const {component, persistence, layout, inspectionState, focusOnFeature} = inspectionSelectionFixture();
        const observed: unknown[] = [];
        const subscription = persistence.observe(() => ({
            panels: inspectionState.state.selection.map(panel => ({
                featureId: panel.features[0].featureId, locked: panel.locked, undocked: panel.undocked
            })),
            dockOpen: layout.state.isDockOpen
        })).subscribe(value => observed.push(value));

        component.selectResult({
            value: {mapTileKey: "Features:map:layer:42", featureId: "Road.1"},
            originalEvent: {ctrlKey: true}
        });

        expect(observed).toEqual([
            {panels: [], dockOpen: false},
            {panels: [{featureId: "Road.1", locked: true, undocked: true}], dockOpen: false}
        ]);
        expect(focusOnFeature).toHaveBeenCalledWith(undefined, {
            mapTileKey: "Features:map:layer:42", featureId: "Road.1"
        });
        subscription.unsubscribe();
    });

    it("reports a rejected result-focus request without an unhandled promise", async () => {
        const {component, inspectionState, focusOnFeature, showError} = inspectionSelectionFixture();
        focusOnFeature.mockRejectedValueOnce(new Error("Feature load failed"));

        component.selectResult({mapTileKey: "Features:map:layer:42", featureId: "Road.1"});
        await Promise.resolve();

        expect(showError).toHaveBeenCalledExactlyOnceWith("Feature load failed");
        expect(inspectionState.state.selection[0].features[0].featureId).toBe("Road.1");
    });
});
