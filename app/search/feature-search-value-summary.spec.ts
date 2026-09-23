import "@angular/compiler";
import {SimpleChange} from "@angular/core";
import {beforeAll, describe, expect, it, vi} from "vitest";

import {AppModule} from "../app.module";
import {initializeLibrary} from "../integrations/wasm";
import {featureSearchResultFields} from "../mapdata/feature-search-runtime-state.model";
import {createFeatureSearchStateEntry} from "../shared/feature-search-state";
import {FeatureSearchService, type FeatureSearchSession} from "./feature.search.service";
import {buildFeatureSearchFilterChannels} from "./feature-search-style";
import {SearchStyleColorComponent} from "./search-style-color.component";
import {defaultSearchStyleColorDraft} from "./search-style-color.util";
import type {SearchValueSummary} from "./search.model";

void AppModule;

describe("Search observed category values", () => {
    beforeAll(() => initializeLibrary());

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
        const service = Object.create(FeatureSearchService.prototype) as FeatureSearchService;
        const rawSummary = {resultFields: [], traces: []};
        const subset = {valueSummaries: vi.fn(() => rawSummary), delete: vi.fn()};
        Object.defineProperty(service, "mapInfo", {value: {
            tileLayerParser: {readTileSubsetLayer: vi.fn(() => subset)}
        }});
        const contribution: Parameters<FeatureSearchService["valueSummariesForContribution"]>[0] = {
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

    it("populates numeric category stops from data without a schema enum", () => {
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
            count: 3, missing: 0, nulls: 0,
            kinds: {integer: 3, number: 0, boolean: 0, string: 0, object: 0, list: 0, blob: 0, unknown: 0},
            numeric: {count: 3, min: 1, max: 2, sum: 4, average: 4 / 3},
            histogram: [{value: "1", count: 2}, {value: "2", count: 1}],
            otherCount: 0, distinctLimitReached: false
        };
        const changed = vi.spyOn(component.draftChange, "emit");
        component.dataSummary = summary;
        component.dataSummaryStatus = "ready";
        component.ngOnChanges({dataSummary: new SimpleChange(undefined, summary, false)});
        expect(changed).toHaveBeenCalledWith(expect.objectContaining({
            categoryValueKind: "number",
            categoryStops: [
                expect.objectContaining({valueText: "1"}),
                expect.objectContaining({valueText: "2"})
            ]
        }));
    });

    it("does not wait for retired filters' chunks after replacing a style", () => {
        const service = Object.create(FeatureSearchService.prototype) as FeatureSearchService;
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
