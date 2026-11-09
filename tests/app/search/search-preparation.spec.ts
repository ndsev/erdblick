/** Search submission is the boundary between editor drafts and executable plans. */
import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {AppModule} from "../../../app/app.module";
import {SearchService, type FeatureSearchSession} from "../../../app/search/search.service";
import {createFeatureSearchStateEntry} from "../../../app/search/search-definition.model";
import type {PreparedSearchBranch, SearchPreparation} from "../../../app/search/search-preparation.model";
import type {FeatureSearchScopeAnalysis} from "../../../app/search/feature-search-schema.service";
import {SearchComponent} from "../../../app/search/search.component";
import {SearchState} from "../../../app/search/search.state";
import {viewerActions} from "../../support/action-contract";
import type {FeatureSearchStatePatch} from "../../../app/search/search-definition.model";
import type {CompletionCandidate, FeatureSearchStyleFieldInventory} from "../../../app/search/search.model";

void AppModule;

const classic: PreparedSearchBranch = {
    id: "attribute:SPEED_LIMIT", label: "SPEED_LIMIT attribute", kind: "attribute", mapId: "Classic", layerId: "Routing",
    schemaId: "classic-v1", scope: "attribute", expression: "**.SPEED_LIMIT", query: '$name == "SPEED_LIMIT"', featureTypes: ["Link"], attributeScopes: []
};
const live: PreparedSearchBranch = {
    id: "enum:WARNING_SIGN:SPEED_LIMIT", label: "WARNING_SIGN contains SPEED_LIMIT", kind: "enum", mapId: "Live", layerId: "Road",
    schemaId: "live-v1", scope: "attribute", symbol: "SPEED_LIMIT",
    expression: '**.warningSign == "SPEED_LIMIT"', query: '**.warningSign == "SPEED_LIMIT"',
    matchedFieldNames: ["warningSign"], matchedEnumValues: ["SPEED_LIMIT"],
    featureTypes: ["Road"], attributeScopes: [{mapId: "Live", layerId: "Road", featureType: "Road", attrName: "WARNING_SIGN", attrLayerName: "Rules"}]
};

/** Keep the real preparation workflow while observing its activation boundary. */
function fixture(branches: PreparedSearchBranch[]) {
    const service = Object.create(SearchService.prototype) as SearchService;
    const definition = createFeatureSearchStateEntry({query: "SPEED_LIMIT"});
    const preparation: SearchPreparation = {
        signature: "v1", status: "preparing", interpretations: [], selectedIds: [], branches: [], initialStyles: []
    };
    const session = {
        id: definition.id, definition, preparation, schemaAnalysis: {status: "pending"},
        progressByRequestKey: new Map(), startTime: 0
    } as FeatureSearchSession;
    let signature = "v1";
    const activate = vi.fn();
    const reset = vi.fn((_session: FeatureSearchSession, next: typeof definition) => {session.definition = next;});
    const fields = vi.fn<() => Promise<FeatureSearchStyleFieldInventory>>();
    const state = {patchFeatureSearch: vi.fn(), addFeatureSearch: vi.fn(createFeatureSearchStateEntry)};
    Object.defineProperties(service, {
        searchRunCounter: {value: 0, writable: true},
        getInternalSession: {value: () => session}, searchScopeAnalysisSignature: {value: () => signature},
        resetSessionSearch: {value: reset}, syncSearchRequestsToMapService: {value: activate},
        state: {value: state}, progress: {value: {next: vi.fn()}},
        searchSchema: {value: {requestPreparedSearchStyleFields: fields}}
    });
    const analysis: FeatureSearchScopeAnalysis = {
        signature: "v1", interpretations: branches, concreteScope: "attribute", normalizedQuery: "SPEED_LIMIT",
        attributeScopes: [], attributeScopeCandidateCount: 0, rewriteSuppressed: false, rewriteSuppressionReason: "",
        inferredMapLayers: [], matchedFieldNames: [], matchedEnumValues: [], matchedFeatureTypes: []
    };
    return {service, session, preparation, analysis, activate, reset, fields, state, changeSchema: () => {signature = "v2";}};
}

const warningFields: FeatureSearchStyleFieldInventory = {
    contexts: live.attributeScopes, types: [{valueKind: "enum", enumValues: ["SPEED_LIMIT", "ANIMALS"], schemaType: undefined}],
    fields: [{path: "attributeValue.warningSign", metadata: 0, contexts: [0]}], branches: [], complete: true, incompleteReason: ""
};

describe("Confirmed search preparation", () => {
    it("requires a semantic choice even when both alternatives use attribute scope", async () => {
        const f = fixture([classic, live]);
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.preparation.status).toBe("needs-choice");
        expect(f.preparation.interpretations.map(meaning => meaning.id)).toEqual([classic.id, live.id]);
        expect(f.activate).not.toHaveBeenCalled();
        expect(f.fields).not.toHaveBeenCalled();
        expect(f.reset).not.toHaveBeenCalled();
    });

    it("waits for schema styling and activates membership and categories together", async () => {
        const f = fixture([live]);
        let finish!: (inventory: FeatureSearchStyleFieldInventory) => void;
        f.fields.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        const pending = f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.activate).not.toHaveBeenCalled();
        expect(f.preparation.status).toBe("preparing");
        expect(f.preparation.phase).toBe("style");
        finish(warningFields);
        await pending;
        expect(f.preparation.status).toBe("ready");
        expect(f.activate).toHaveBeenCalledOnce();
        expect(f.session.definition.searchStyleRules).toHaveLength(2);
        expect(f.session.definition.searchStyleRules[0].color).toMatchObject({mode: "categories", field: "attributeValue.warningSign"});
        expect(f.session.definition.searchStyleRules[0].opacity).toBe(0.6);
        expect(f.preparation.branches[0].query).toBe(live.query);
    });

    it("starts the execution timer before activating a prepared search", async () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(3_600_000);
        try {
            const f = fixture([live]);
            f.fields.mockResolvedValue(warningFields);
            f.activate.mockImplementation(() => f.session.startTime);
            await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
            expect(f.activate).toHaveBeenCalledOnce();
            expect(f.activate).toHaveReturnedWith(3_600_000);
            expect(f.session.timeElapsed).toBe("0ms");
            expect(f.session.runId).toBe("search_3600000_1");
        } finally {
            now.mockRestore();
        }
    });

    it("offers current choices when a saved interpretation disappears", async () => {
        const f = fixture([classic, live]);
        f.session.definition.interpretationIds = ["removed-meaning"];
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.preparation.status).toBe("needs-choice");
        expect(f.preparation.error).toContain("no longer declared");
        expect(f.preparation.interpretations.map(meaning => meaning.id)).toEqual([classic.id, live.id]);
        expect(f.activate).not.toHaveBeenCalled();
    });

    it("keeps the previous presentation while metadata is unavailable", async () => {
        const f = fixture([live]);
        f.fields.mockRejectedValue(new Error("Schema unavailable"));
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.preparation.status).toBe("invalid");
        expect(f.preparation.error).toContain("Schema unavailable");
        expect(f.activate).not.toHaveBeenCalled();
        expect(f.reset).not.toHaveBeenCalled();
    });

    it("rejects a late style response for a superseded schema", async () => {
        const f = fixture([live]);
        let finish!: (inventory: FeatureSearchStyleFieldInventory) => void;
        f.fields.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        const pending = f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        f.changeSchema();
        finish(warningFields);
        await pending;
        expect(f.activate).not.toHaveBeenCalled();
        expect(f.reset).not.toHaveBeenCalled();
    });

    it("refuses multiple meanings before requesting styles or dispatching", async () => {
        const f = fixture([classic, live]);
        f.session.definition.interpretationIds = [classic.id, live.id];
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.preparation.status).toBe("needs-choice");
        expect(f.preparation.error).toContain("exactly one");
        expect(f.fields).not.toHaveBeenCalled();
        expect(f.activate).not.toHaveBeenCalled();
    });

    it("retains all layer occurrences of the single selected meaning", async () => {
        const secondLayer = {...classic, mapId: "Another map", layerId: "Another layer"};
        const f = fixture([classic, secondLayer]);
        f.fields.mockResolvedValue({...warningFields, contexts: [], fields: []});
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.preparation.selectedIds).toEqual([classic.id]);
        expect(f.preparation.branches.map(branch => branch.mapId)).toEqual(["Classic", "Another map"]);
        expect(f.fields).toHaveBeenCalledExactlyOnceWith([classic, secondLayer], {recursive: true, values: "scalar"});
        expect(f.activate).toHaveBeenCalledOnce();
        expect(f.session.definition.query).toBe("SPEED_LIMIT");
        expect(f.session.schemaAnalysis.normalizedQuery).toBe('$name == "SPEED_LIMIT"');
    });

    it("keeps an unambiguous attribute shorthand while preparing its concrete predicate", async () => {
        const metric = {...classic, id: "attribute:SPEED_LIMIT_METRIC", expression: "**.SPEED_LIMIT_METRIC",
            query: '$name == "SPEED_LIMIT_METRIC"'};
        const f = fixture([metric]);
        f.session.definition.query = "SPEED_LIMIT_METRIC";
        f.fields.mockResolvedValue({...warningFields, contexts: [], fields: []});
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.preparation.status).toBe("ready");
        expect(f.session.definition.query).toBe("SPEED_LIMIT_METRIC");
        expect(f.session.schemaAnalysis.normalizedQuery).toBe('$name == "SPEED_LIMIT_METRIC"');
        expect(f.state.patchFeatureSearch).toHaveBeenCalledWith(f.session.id, expect.objectContaining({
            query: "SPEED_LIMIT_METRIC", interpretationIds: undefined
        }));
    });

    it.each([classic, live])("writes the explicit $kind expression when choosing an ambiguous meaning", chosen => {
        const f = fixture([classic, live]);
        const lane = {...live, layerId: "Lane"};
        f.preparation.interpretations = [
            {...classic, query: classic.expression, branches: [classic]},
            {...live, query: live.expression, branches: [live, lane, live]}
        ];
        Object.defineProperty(f.service, "requireSearchSession", {value: () => f.session});
        f.service.chooseSearchInterpretations(f.session.id, [chosen.id]);
        expect(f.state.patchFeatureSearch).toHaveBeenCalledWith(f.session.id, {
            query: chosen.expression, interpretationIds: undefined, selectedMapLayersManual: true,
            selectedMapLayers: chosen === classic
                ? [{mapId: "Classic", layerId: "Routing"}]
                : [{mapId: "Live", layerId: "Road"}, {mapId: "Live", layerId: "Lane"}]
        });
    });

    it("persists a sole meaning's actual source scope with its initial styles", async () => {
        const f = fixture([live]);
        f.session.definition.selectedMapLayers = [classic, live];
        f.fields.mockResolvedValue(warningFields);
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.session.definition.selectedMapLayers).toEqual([{mapId: "Live", layerId: "Road"}]);
        expect(f.state.patchFeatureSearch).toHaveBeenCalledWith(f.session.id, expect.objectContaining({
            query: live.expression, interpretationIds: undefined, selectedMapLayers: [{mapId: "Live", layerId: "Road"}]
        }));
    });

    it("reprepares the accepted expression for another artifact without narrowing the selection", async () => {
        const second = {...live, id: "expression", kind: "expression" as const,
            mapId: "New Live", schemaId: "unrelated-schema-hash"};
        const first = {...live, id: "expression", kind: "expression" as const};
        const f = fixture([first, second]);
        f.session.definition.query = live.expression;
        const layers = [first, second, {...classic, mapId: "No matching fields"}]
            .map(({mapId, layerId}) => ({mapId, layerId}));
        f.session.definition.selectedMapLayers = layers;
        f.fields.mockResolvedValue(warningFields);
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.preparation.status).toBe("ready");
        expect(f.preparation.interpretations).toHaveLength(1);
        expect(f.session.definition.query).toBe(live.expression);
        expect(f.session.definition.interpretationIds).toBeUndefined();
        expect(f.session.definition.selectedMapLayers).toEqual(layers);
        expect(f.session.schemaAnalysis.normalizedQuery).toBe(live.expression);
        expect(f.preparation.branches.map(branch => branch.schemaId)).toEqual(["live-v1", "unrelated-schema-hash"]);
        expect(f.activate).toHaveBeenCalledOnce();
    });

    it("shares one visualization across warning-sign owners and source layers", async () => {
        const branches = ["Road", "Lane"].map(layerId => ({
            ...live, layerId,
            attributeScopes: ["WARNING_SIGN", "MOVABLE_WARNING_SIGN"].map(attrName => ({
                mapId: "Live", layerId, featureType: layerId, attrLayerName: `${layerId}Rules`, attrName
            }))
        }));
        const f = fixture(branches);
        f.fields.mockResolvedValue({...warningFields,
            contexts: branches.flatMap(branch => branch.attributeScopes),
            fields: [{...warningFields.fields[0], contexts: [0, 1, 2, 3]}]
        });
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.preparation.status).toBe("ready");
        expect(f.session.definition.searchStyleRules).toHaveLength(2);
        expect(f.session.definition.searchStyleRules.every(rule => !rule.filter.length && !rule.applicability)).toBe(true);
        expect(f.session.definition.searchStyleRules[0].name).toBe("Auto: attributeValue.warningSign");
    });

    it("shares each payload field across Road and Lane using only the distinguishing attribute name", async () => {
        const branches = ["Road", "Lane"].map(layerId => ({
            ...live, layerId,
            attributeScopes: ["WARNING_SIGN", "MOVABLE_WARNING_SIGN"].map(attrName => ({
                mapId: "Live", layerId, featureType: layerId, attrLayerName: `${layerId}Rules`, attrName
            }))
        }));
        const f = fixture(branches);
        f.fields.mockResolvedValue({
            ...warningFields,
            contexts: branches.flatMap(branch => branch.attributeScopes),
            fields: ["warningSign", "movableWarningSign"].map((field, index) => ({
                path: `attributeValue.${field}`, metadata: 0, contexts: [index, index + 2]
            }))
        });
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        const rules = f.session.definition.searchStyleRules;
        expect(rules).toHaveLength(4);
        expect(rules.map(rule => rule.color.mode === "categories" && rule.color.field)).toEqual([
            "attributeValue.warningSign", "attributeValue.warningSign",
            "attributeValue.movableWarningSign", "attributeValue.movableWarningSign"
        ]);
        for (const [index, rule] of rules.entries()) {
            expect(rule.applicability).toBeUndefined();
            const name = index < 2 ? "WARNING_SIGN" : "MOVABLE_WARNING_SIGN";
            expect(rule.filter).toEqual([{field: "$name", op: "=", value: name}]);
        }
    });

    it.each([{ids: []}, {ids: [classic.id, live.id]}, {ids: [classic.id, classic.id]}])("rejects invalid choices $ids in the service and MCP contract", ({ids}) => {
        const f = fixture([classic, live]);
        f.preparation.interpretations = [classic, live].map(branch => ({...branch, query: branch.expression, branches: [branch]}));
        Object.defineProperty(f.service, "requireSearchSession", {value: () => f.session});
        expect(() => f.service.chooseSearchInterpretations(f.session.id, ids)).toThrow("exactly one");
        expect(viewerActions.viewer_choose_search_interpretations.inputSchema.safeParse({
            searchId: f.session.id, interpretationIds: ids
        }).success).toBe(false);
        expect(viewerActions.viewer_start_search.inputSchema.safeParse({
            query: "SPEED_LIMIT", mapLayers: [{mapId: "Classic", layerId: "Routing"}], viewIds: ["0"], interpretationIds: ids
        }).success).toBe(false);
        expect(viewerActions.viewer_set_search.inputSchema.safeParse({
            searchId: f.session.id, settings: {interpretationIds: ids}
        }).success).toBe(false);
    });
});

describe("Complete symbols are submitted without accepting a suggestion", () => {
    it("recognizes the original native symbol without interpreting the displayed predicate", () => {
        const service = Object.create(SearchService.prototype) as SearchService;
        const candidate: CompletionCandidate = {
            text: "**.SPEED_LIMIT_METRIC", query: "**.SPEED_LIMIT_METRIC", source: "SPEED_LIMIT_METRIC",
            kind: "field", hint: "SPEED_LIMIT_METRIC attribute", begin: 0, end: 18, isExactMatch: true
        };
        Object.defineProperty(service, "completionStateForOwner", {value: () => ({candidateList: [candidate]})});
        expect(service.hasExactCompletionCandidate("SPEED_LIMIT_METRIC")).toBe(true);
        expect(service.hasExactCompletionCandidate("SPEED_LIMIT")).toBe(false);
        candidate.isExactMatch = false;
        expect(service.hasExactCompletionCandidate("SPEED_LIMIT_METRIC")).toBe(false);
        expect(service.hasExactCompletionCandidate("**.SPEED_LIMIT_METRIC")).toBe(true);
    });
});

describe("Disabled search progress", () => {
    it.each([undefined, "preparing", "needs-choice", "waiting-for-schema", "invalid", "ready"] as const)(
        "shows a static disabled status even when preparation is %s", status => {
            const component = Object.create(SearchComponent.prototype) as SearchComponent;
            const f = fixture([]);
            f.session.definition.enabled = false;
            f.session.preparation = status ? {...f.preparation, status} : undefined;
            component["refreshProgressDisplay"](f.session);
            expect(component.progressLabel).toBe("Search disabled");
            expect(component.progressMeterItems).toEqual([]);
            expect(component.progressDisplayPercent).toBe(0);
        }
    );
});

/** Use the real persistence patch/normalization logic without starting workers. */
function storedSearch() {
    const state = Object.create(SearchState.prototype) as SearchState;
    const entry = createFeatureSearchStateEntry({query: "SPEED_LIMIT", interpretationIds: [live.id]});
    Object.defineProperty(state, "featureSearches", {value: [entry], writable: true});
    return {state, entry};
}

describe("Interpretations follow explicit scope edits", () => {
    it.each<FeatureSearchStatePatch>([
        {scope: "feature"},
        {selectedMapLayers: [{mapId: "Classic", layerId: "Routing"}]},
        {selectedFeatureTypes: ["Link"]},
        {query: "ANIMALS"}
    ])("clears the binding when its query context changes: %j", patch => {
        const {state, entry} = storedSearch();
        expect(state.patchFeatureSearch(entry.id, patch)?.interpretationIds).toBeUndefined();
    });

    it("continues without a choice when narrowing leaves one interpretation", async () => {
        const {state, entry} = storedSearch();
        const narrowed = state.patchFeatureSearch(entry.id, {selectedMapLayers: [{mapId: "Classic", layerId: "Routing"}]})!;
        const f = fixture([classic]);
        f.session.definition = narrowed;
        f.fields.mockResolvedValue({...warningFields, contexts: [], fields: []});
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.preparation.status).toBe("ready");
        expect(f.preparation.selectedIds).toEqual([classic.id]);
        expect(f.activate).toHaveBeenCalledOnce();
    });

    it("asks again when widening introduces another meaning", async () => {
        const {state, entry} = storedSearch();
        const widened = state.patchFeatureSearch(entry.id, {selectedMapLayers: [{mapId: "Classic", layerId: "Routing"},
            {mapId: "Live", layerId: "Road"}]})!;
        const f = fixture([classic, live]);
        f.session.definition = widened;
        await f.service["applySearchScopeAnalysis"](f.session.id, f.analysis);
        expect(f.preparation.status).toBe("needs-choice");
        expect(f.activate).not.toHaveBeenCalled();
    });

    it("keeps a qualified completion binding supplied with the new context", () => {
        const {state, entry} = storedSearch();
        expect(state.patchFeatureSearch(entry.id, {scope: "attribute", interpretationIds: [classic.id]})?.interpretationIds)
            .toEqual([classic.id]);
    });

    it("keeps the binding for coverage and presentation edits", () => {
        const {state, entry} = storedSearch();
        expect(state.patchFeatureSearch(entry.id, {autoUpdate: false, selectedViewIndices: [0], selectedTileLevels: [13]})?.interpretationIds)
            .toEqual([live.id]);
    });

    it("never replays saved combinations", () => {
        expect(createFeatureSearchStateEntry({query: "SPEED_LIMIT", interpretationIds: [classic.id, live.id]}).interpretationIds)
            .toBeUndefined();
    });
});


describe("Selected source scope stays explicit", () => {
    it.each([true, false])("uses completion origins only when no layers are active (active: %s)", active => {
        const f = fixture([]);
        const current = [{mapId: "Munich", layerId: "Road"}];
        const suggested = [{mapId: "Germany", layerId: "Road"}, {mapId: "Live", layerId: "Lane"}];
        Object.defineProperty(f.service, "activeFeatureSearchLayers", {value: () => active ? current : []});
        const run = vi.spyOn(f.service, "run").mockReturnValue(f.session);
        const query = '(**.movableWarningSign == "ANIMALS") or (**.warningSign == "ANIMALS")';
        f.service.runFromActionPayload(query, {suggestedMapLayers: suggested});
        expect(run).toHaveBeenCalledWith(query, {selectedMapLayers: active ? current : suggested});
    });

    it("keeps a deliberate source selection ahead of completion hints and visible maps", () => {
        const f = fixture([]);
        const selectedMapLayers = [{mapId: "Selected", layerId: "Road"}];
        Object.defineProperty(f.service, "activeFeatureSearchLayers", {value: () => [{mapId: "Visible", layerId: "Road"}]});
        const run = vi.spyOn(f.service, "run").mockReturnValue(f.session);
        f.service.runFromActionPayload("true", {selectedMapLayers, selectedMapLayersManual: true,
            suggestedMapLayers: [{mapId: "Suggested", layerId: "Road"}]});
        expect(run).toHaveBeenCalledWith("true", {selectedMapLayers, selectedMapLayersManual: true});
    });

    it("edits an existing query without replacing its source selection", () => {
        const f = fixture([]);
        Object.defineProperty(f.service, "pendingForcedGenerationIds", {value: new Set()});
        f.state.patchFeatureSearch.mockReturnValue(f.session.definition);
        f.service.rerunSearch(f.session.id, '**.warningSign == "ANIMALS"');
        expect(f.state.patchFeatureSearch).toHaveBeenCalledWith(f.session.id, {
            query: '**.warningSign == "ANIMALS"', paused: false, interpretationIds: undefined
        });
    });

    it("does not restrict an explicit start scope to maps already visible", () => {
        const f = fixture([]);
        const layers = [classic, live].map(({mapId, layerId}) => ({mapId, layerId}));
        Object.defineProperties(f.service, {
            activeFeatureSearchLayers: {value: () => [layers[0]]},
            nextDefaultSearchColor: {value: () => "#123456"},
            placeNewSearchSurface: {value: vi.fn()}
        });
        f.service.run("SPEED_LIMIT", {selectedMapLayers: layers, selectedViewIndices: [0]});
        expect(f.state.addFeatureSearch.mock.calls[0][0].selectedMapLayers).toEqual(layers);
    });

    it("updates the layer selector when the same session is scoped externally", () => {
        const component = Object.create(SearchComponent.prototype) as SearchComponent;
        const f = fixture([]);
        f.session.definition.selectedMapLayers = [{mapId: "Live", layerId: "Road"}];
        const select = vi.fn();
        Object.defineProperties(component, {
            refreshMapLayerTreeOptions: {value: vi.fn()},
            setSelectedMapLayerTreeLeafKeys: {value: select},
            mapLayerTreeExpandedKeys: {value: ["expanded-map"]}
        });
        component["syncMapLayerTreeSelection"](f.session);
        expect(select).toHaveBeenCalledWith(new Set([component["searchLayerKey"]("Live", "Road")]), new Set(["expanded-map"]));
    });
});
