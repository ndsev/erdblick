import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";

import {AppModule} from "../app.module";
import {FeatureSearchComponent} from "./feature.search.component";

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
