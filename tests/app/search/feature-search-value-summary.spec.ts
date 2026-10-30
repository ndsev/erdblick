import "@angular/compiler";
import {SimpleChange} from "@angular/core";
import {
    beforeAll,
    describe,
    expect,
    it,
    vi
} from "vitest";

import {AppModule} from "../../../app/app.module";
import {initializeLibrary} from "../../../app/integrations/wasm.adapter";
import {featureSearchResultFields} from "../../../app/search/feature-search-runtime-state.model";
import {createFeatureSearchStateEntry} from "../../../app/search/search-definition.model";
import {SearchService, type FeatureSearchSession} from "../../../app/search/search.service";
import {buildFeatureSearchFilterChannels} from "../../../app/search/feature-search-style.adapter";
import {SearchStyleColorComponent} from "../../../app/search/search-style-color.component";
import {defaultSearchStyleColorDraft} from "../../../app/search/search-style-color.util";
import type {
    SearchResultFieldValueSummary,
    SearchTraceValueSummary,
    SearchValueSummary
} from "../../../app/search/search.model";
import type {SchemaScalarDomain} from "../../../app/mapdata/schema-domain.model";

void AppModule;

describe("Search observed category values", () => {
    beforeAll(() => initializeLibrary());

    it("merges only identical native domains for both projected values and traces", () => {
        const service = Object.create(SearchService.prototype) as SearchService;
        const resultFields = new Map<string, SearchResultFieldValueSummary>();
        const traces = new Map<string, SearchTraceValueSummary>();
        const domains: Array<SchemaScalarDomain | undefined> = [
            {schemaId: "graph-a", domainId: 1, typeName: "Speed", namedValues: []},
            {schemaId: "graph-a", domainId: 2, typeName: "LaneCount", namedValues: []},
            {schemaId: "graph-b", domainId: 1, typeName: "Width", namedValues: []},
            undefined
        ];
        // The expression text is deliberately identical. Only the actual
        // value's graph/domain identity determines whether ranges may merge.
        for (let tile = 0; tile < 2; ++tile) {
            domains.forEach((domain, index) => {
                const value = index + 1;
                const summary = service["emptyValueSummary"](domain);
                summary.count = 1;
                summary.kinds.integer = 1;
                summary.numeric = {count: 1, min: value, max: value, sum: value, average: value};
                summary.histogram = [{value: String(value), count: 1}];
                service["mergeTileValueSummaries"](resultFields, traces, {
                    resultFields: [{source: "resultField", index: 0, expression: "value", summary}],
                    traces: [{source: "trace", name: "value", calls: 1, totalus: 10, summary}]
                });
            });
        }
        expect(resultFields.size).toBe(4);
        expect(traces.size).toBe(4);
        for (const summaries of [resultFields, traces]) {
            [...summaries.values()].forEach(({summary}, index) => {
                expect(summary.domain).toEqual(domains[index]);
                expect(summary.count).toBe(2);
                expect(summary.numeric).toEqual({
                    count: 2, min: index + 1, max: index + 1,
                    sum: 2 * (index + 1), average: index + 1
                });
            });
        }
    });

    it.each([
        {results: [], expected: ""},
        {results: [null], expected: ""},
        {results: [undefined], expected: ""},
        {results: ["WARNING_SIGN"], expected: "WARNING_SIGN"},
        {results: ["WARNING_SIGN", "SPEED_LIMIT"], expected: ""},
        {results: [[1, 2]], expected: "[1,2]"},
        {results: [{name: "WARNING_SIGN"}], expected: '{"name":"WARNING_SIGN"}'}
    ])("formats a result label from exactly one value: $results", ({results, expected}) => {
        const service = Object.create(SearchService.prototype) as SearchService;
        expect(service["searchResultFieldValue"]({
            mapTileKey: "tile", featureId: "Road.1", resultIndex: 0, values: [results]
        }, ["$name"], "$name")).toBe(expected);
    });

    it("requests numeric values even before a category scale has stops", () => {
        const definition = createFeatureSearchStateEntry({
            query: "attributes.layer.Guidance.NUM_LANES.numLanes.normalLanes",
            searchStyleRules: [{
                geometry: ["line", "surface"], filter: [],
                color: {mode: "categories", field: "numLanes.normalLanes", stops: []}
            }]
        });
        const fields = featureSearchResultFields(definition, "attribute");
        const plan = buildFeatureSearchFilterChannels([{
            channelId: "style-rule:0", scope: "attribute", rewrite: false,
            featureTypes: [], featureFields: [], entryFields: [],
            geometryTypes: 6, geometryName: "*"
        }], "attribute", "numLanes.normalLanes", [], fields, definition.id, "Classic/Routing");

        expect(fields).toEqual(["$name", "numLanes.normalLanes"]);
        expect(plan.resultChannelOrdinal).toBe(1);
        expect(plan.channels[0].entryFields).toEqual([]);
        expect(plan.channels[plan.resultChannelOrdinal].entryFields).toEqual(fields);
    });

    it.each([0, 1, 3])("summarizes the result channel %i, not the first rendering rule", resultChannelOrdinal => {
        const service = Object.create(SearchService.prototype) as SearchService;
        const rawSummary = {resultFields: [], traces: []};
        const subset = {valueSummaries: vi.fn(() => rawSummary), delete: vi.fn()};
        Object.defineProperty(service, "mapInfo", {value: {
            tileLayerParser: {readTileSubsetLayer: vi.fn(() => subset)}
        }});
        const contribution: Parameters<SearchService["valueSummariesForContribution"]>[0] = {
            refresh: 0, sourceTileKey: "tile", sourceMapId: "Classic",
            sourceLayerId: "Routing", sourceTileId: 545377861, requestOrder: 0,
            resultCount: 1, resultChannelOrdinal, resultFields: ["numLanes.normalLanes"],
            results: [], diagnostics: null, layerBlob: new Uint8Array(), valueSummary: null, points: []
        };

        const summary = service["valueSummariesForContribution"](contribution);
        expect(subset.valueSummaries).toHaveBeenCalledWith(resultChannelOrdinal, 64, 2048);
        expect(subset.delete).toHaveBeenCalledOnce();
        expect(service["valueSummariesForContribution"](contribution)).toBe(summary);
        expect(subset.valueSummaries).toHaveBeenCalledOnce();
    });

    it.each(["ordinary", "specials", "unsafe"] as const)(
        "populates exact ordinary numeric categories from observed data (%s)", values => {
            const component = new SearchStyleColorComponent();
            component.draft = {...defaultSearchStyleColorDraft("numLanes.normalLanes"), mode: "categories"};
            component.fieldOptions = [{
                label: "Normal lanes", value: "numLanes.normalLanes", valueKind: "integer"
            }];
            component.ngOnChanges({draft: new SimpleChange(undefined, component.draft, true)});
            const requested = vi.spyOn(component.updateFromDataRequested, "emit");
            component["updateStopsFromData"]();
            expect(requested).toHaveBeenCalledOnce();

            const summary: SearchValueSummary = {
                count: 3, missing: 0, nulls: 0, specials: 0,
                kinds: {integer: 3, number: 0, boolean: 0, string: 0, object: 0, list: 0, blob: 0, bitmask: 0, unknown: 0},
                numeric: {count: 3, min: 1, max: 2, sum: 4, average: 4 / 3},
                histogram: [{value: "1", count: 2}, {value: "2", count: 1}],
                otherCount: 0, distinctLimitReached: false
            };
            if (values === "specials") {
                summary.domain = {schemaId: "sample", domainId: 1, typeName: "Count", namedValues: [{
                    name: "UNKNOWN", value: 1, valueType: "integer", role: "special", meaning: "unknown",
                    deprecated: false, removed: false
                }]};
                component.fieldOptions[0].domain = summary.domain;
                summary.specials = 2;
                summary.numeric = {count: 1, min: 2, max: 2, sum: 2, average: 2};
            }
            if (values === "unsafe") {
                summary.histogram = [{value: "9223372036854775807", count: 3}];
                summary.numeric = undefined;
            }
            const changed = vi.spyOn(component.draftChange, "emit");
            component.dataSummary = summary;
            component.dataSummaryStatus = "ready";
            component.ngOnChanges({dataSummary: new SimpleChange(undefined, summary, false)});
            if (values === "unsafe") {
                expect(changed).not.toHaveBeenCalled();
                expect(component["colorWarning"]).toContain("exact numeric range");
                return;
            }
            expect(changed).toHaveBeenCalledWith(expect.objectContaining({
                categoryValueKind: "number",
                categoryStops: [
                    ...(values === "specials" ? [] : [expect.objectContaining({valueText: "1"})]),
                    expect.objectContaining({valueText: "2"})
                ]
            }));
            if (values === "specials") {
                expect(changed.mock.calls[0][0]?.specialStops).toEqual([
                    expect.objectContaining({value: 1})
                ]);
                // Updating the ordinary histogram must not undo the user's
                // custom special color or their choice to use its fallback.
                const special = changed.mock.calls[0][0]!.specialStops![0];
                component["setSpecialStopColor"](special, "#123456");
                component["updateStopsFromData"]();
                expect(changed.mock.lastCall?.[0]?.specialStops).toEqual([
                    expect.objectContaining({value: 1, color: "#123456"})
                ]);
                component["deleteSpecialStop"](special);
                component["updateStopsFromData"]();
                expect(changed.mock.lastCall?.[0]?.specialStops).toEqual([]);
            }
        });

    it("does not wait for retired filters' chunks after replacing a style", () => {
        const service = Object.create(SearchService.prototype) as SearchService;
        const session = Object.create(null) as FeatureSearchSession;
        session.progressByRequestKey = new Map([
            ["old\n1", {tilesQueued: 2, tilesSearched: 2, chunksEmitted: 2, chunksReported: true, matches: 0, terminal: true}],
            ["old\n2", {tilesQueued: 2, tilesSearched: 2, chunksEmitted: 2, chunksReported: true, matches: 0, terminal: true}],
            ["old-replacement\n1", {tilesQueued: 4, tilesSearched: 4, chunksEmitted: 4, chunksReported: true, matches: 1114, terminal: true}]
        ]);
        session.searchResultTilesBySourceKey = new Map();
        for (let tile = 0; tile < 4; ++tile) {
            session.searchResultTilesBySourceKey.set(String(tile), Object.create(null));
        }
        service["updateSearchResultIngressProgress"](session);
        expect(session.resultTileIngressDone).toBe(4);
        expect(session.resultTileIngressTotal).toBe(8);

        service["clearFilterSearchProgress"](session, "old");
        expect([...session.progressByRequestKey.keys()]).toEqual(["old-replacement\n1"]);
        expect(session.resultTileIngressDone).toBe(4);
        expect(session.resultTileIngressTotal).toBe(4);
        session.backendComplete = true;
        session.complete = false;
        session.paused = false;
        session.progressTotal = 4;
        session.progressDone = 4;
        expect(service["updateSessionCompletion"](session)).toBe(true);
        expect(service["canSummarizeSessionValues"](session)).toBe(true);
    });
});
