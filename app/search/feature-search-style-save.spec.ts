import "@angular/compiler";
import {load} from "js-yaml";
import {describe, expect, it, vi} from "vitest";

import type {FeatureSearchStyleRule} from "../shared/feature-search-state";
import {AppModule} from "../app.module";
import {FeatureSearchComponent} from "./feature.search.component";
import type {SearchStyleSaveRequest} from "./search-style-save.dialog.component";

void AppModule;

const RULES: FeatureSearchStyleRule[] = [{
    geometry: ["line"],
    filter: [],
    color: {mode: "solid", color: "#ff0000"},
    width: 4
}];

function fixture(importedStyleId: string | undefined = "Folder/Saved") {
    const component = Object.create(FeatureSearchComponent.prototype) as any;
    component.searchStyleSavePending = false;
    component.searchStyleSaveVisible = true;
    component.pendingSearchStyleRules = structuredClone(RULES);
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
        component.selectedSearchMapLayers = vi.fn(() => [
            {mapId: "Map A", layerId: "Road"},
            {mapId: "Map B", layerId: "Road"},
            {mapId: "Map B", layerId: "Lane"}
        ]);

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
        expect(component.pendingSearchStyleRules).toEqual(RULES);
        expect(component.styleEditorRequestService.open).not.toHaveBeenCalled();
    });
});
