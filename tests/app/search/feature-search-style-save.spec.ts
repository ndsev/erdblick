import {SearchService} from "../../../app/search/search.service";
import {createFeatureSearchStateEntry} from "../../../app/search/search-definition.model";
import "@angular/compiler";
import {load} from "js-yaml";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";

import type {FeatureSearchStyleRule} from "../../../app/search/search-definition.model";
import {AppModule} from "../../../app/app.module";
import {SearchComponent} from "../../../app/search/search.component";
import type {SearchStyleSaveRequest} from "../../../app/search/search-style-save-dialog.component";

void AppModule;

const RULES: FeatureSearchStyleRule[] = [{
    geometry: ["line"],
    filter: [],
    color: {mode: "solid", color: "#ff0000"},
    width: 4
}];

function fixture(importedStyleId: string | undefined = "Folder/Saved") {
    const component = Object.create(SearchComponent.prototype) as any;
    component.searchStyleSavePending = false;
    component.searchStyleSaveVisible = true;
    component.pendingSearchStyle = {
        ...createFeatureSearchStateEntry({query: "true", searchStyleRules: structuredClone(RULES)}),
        concreteScope: "feature", backendQuery: "", resultFields: []
    };
    component.styleService = {
        styleIdentityConflict: vi.fn(() => undefined),
        importStyleYamlSource: vi.fn(() => importedStyleId)
    };
    component.styleEditorRequestService = {open: vi.fn()};
    component.infoMessageService = {
        showError: vi.fn(),
        showSuccess: vi.fn()
    };
    return component;
}

function request(action: SearchStyleSaveRequest["action"], enabled: boolean): SearchStyleSaveRequest {
    return {
        action,
        options: {name: "Folder/Saved", defaultEnabled: enabled, layerIds: []}
    };
}

describe("Feature Search style save lifecycle", () => {
    it("freezes resolved query, scope, selected types and visual rules for the dialog", () => {
        const service: SearchService = Object.create(SearchService.prototype);
        const definition = {
            ...createFeatureSearchStateEntry({query: "**.speedLimitKmh", selectedFeatureTypes: ["Road"]}),
            concreteScope: "attribute" as const, backendQuery: "speedLimitKmh", resultFields: ["$name"]
        };
        Reflect.set(service, "getInternalSession", () => ({id: definition.id}));
        Reflect.set(service, "resolvedDefinitionForSession", () => definition);
        const drafts = structuredClone(RULES);
        const snapshot = service.getStyleExportSnapshot(definition.id, drafts);
        definition.backendQuery = "otherField";
        definition.selectedFeatureTypes.push("Lane");
        drafts[0].width = 19;
        expect(snapshot.backendQuery).toBe("speedLimitKmh");
        expect(snapshot.concreteScope).toBe("attribute");
        expect(snapshot.selectedFeatureTypes).toEqual(["Road"]);
        expect(snapshot.searchStyleRules[0].width).toBe(4);
    });

    it("initializes layer affinity from the search's selected layers", () => {
        const component = fixture();
        component.searchStyleSaveVisible = false;
        component.serializeStyleRuleDrafts = vi.fn(() => RULES);
        component.mapService = {maps: {
            allFeatureLayers: vi.fn(() => [
                {id: "Road"},
                {id: "Lane"},
                {id: "RoadSurface"}
            ])
        }};
        component.session = {id: "search-1"};
        component.pendingSearchStyle.selectedMapLayers = [
            {mapId: "Map A", layerId: "Road"},
            {mapId: "Map B", layerId: "Road"},
            {mapId: "Map B", layerId: "Lane"}
        ];
        component.searchService = {getStyleExportSnapshot: vi.fn(() => component.pendingSearchStyle)};

        component.saveSearchStyle();

        expect(component.searchStyleSaveLayerIds)
            .toEqual(["Lane", "Road", "RoadSurface"]);
        expect(component.searchStyleSaveInitialLayerIds)
            .toEqual(["Lane", "Road"]);
        expect(component.searchStyleSaveVisible).toBe(true);
    });

    it("saves enabled YAML without opening the editor for plain Save", async () => {
        const component = fixture();

        component.confirmSearchStyleSave(request("save", true));
        await Promise.resolve();

        const [source, visibility] = component.styleService.importStyleYamlSource.mock.calls[0];
        const parsed = load(source) as any;
        expect(parsed.default).toBe(true);
        expect(parsed.options).toEqual([{
            label: "Show Folder/Saved",
            id: "showSearchStyle",
            type: "bool",
            default: true
        }]);
        expect(parsed.rules[0].filter).toBe("showSearchStyle == true");
        expect(visibility).toBe(true);
        expect(component.searchStyleSaveVisible).toBe(false);
        expect(component.styleEditorRequestService.open).not.toHaveBeenCalled();
    });

    it("opens only the successfully imported disabled style for Save and Open", async () => {
        const component = fixture("Folder/Saved");

        component.confirmSearchStyleSave(request("save-and-open", false));
        await Promise.resolve();

        const [source, visibility] = component.styleService.importStyleYamlSource.mock.calls[0];
        expect((load(source) as any).default).toBe(false);
        expect(visibility).toBe(false);
        expect(component.styleEditorRequestService.open).toHaveBeenCalledOnce();
        expect(component.styleEditorRequestService.open).toHaveBeenCalledWith("Folder/Saved");
    });

    it("keeps the dialog and pending rules when persistence fails", async () => {
        const component = fixture("");

        component.confirmSearchStyleSave(request("save-and-open", true));
        await Promise.resolve();

        expect(component.searchStyleSaveVisible).toBe(true);
        expect(component.pendingSearchStyle.searchStyleRules).toEqual(RULES);
        expect(component.styleEditorRequestService.open).not.toHaveBeenCalled();
    });

    it("refuses an unresolved scope before opening the save dialog", () => {
        const component = fixture();
        component.searchStyleSaveVisible = false;
        component.session = {id: "search-1"};
        component.serializeStyleRuleDrafts = vi.fn(() => RULES);
        component.searchService = {getStyleExportSnapshot: vi.fn(() => {
            throw new Error("Search scope is still being resolved.");
        })};
        component.saveSearchStyle();
        expect(component.searchStyleSaveVisible).toBe(false);
        expect(component.infoMessageService.showError).toHaveBeenCalledWith("Search scope is still being resolved.");
        expect(component.styleService.importStyleYamlSource).not.toHaveBeenCalled();
    });
});
