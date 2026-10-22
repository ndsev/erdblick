import { ConnectionModel } from "./connection/connection.model";
import { RenderingModel } from "./rendering/rendering.model";
import { MapStylesModel } from "./map-styles/map-styles.model";
import { ConfigModel } from "./config/config.model";
import { DiagnosticsModel } from "./diagnostics/diagnostics.model";
import { LocationSearchModel } from "./location-search/location-search.model";
import { OmnibarModel } from "./omnibar/omnibar.model";
import "@angular/compiler";
import { provideHttpClient } from "@angular/common/http";
import { EnvironmentInjector } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { MessageService } from "primeng/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import manifest from "./actions/generated/web-mcp-actions.json";
import { stateOwners, testPersistence } from "../test/state-owners";
import { ActionRegistry } from "./actions/action-registry.service";
import { AppActionContributor } from "./actions/app-action-contributor";
import { registerApplication } from "./application-registration";
import { CoordinatesService } from "./coordinates/coordinates.service";
import { CoordinatesModel } from "./coordinates/coordinates.model";
import { InspectionPanelService } from "./inspection/inspection-panel.service";
import { InspectionModel } from "./inspection/inspection.model";
import { AppLayoutService } from "./layout/app-layout.service";
import { LayoutModel } from "./layout/layout.model";
import { MapInfoService } from "./mapdata/map-info.service";
import { MapDataModel } from "./mapdata/mapdata.model";
import { MapViewService } from "./mapview/map-view.service";
import { MapViewModel } from "./mapview/mapview.model";
import { FeatureSearchModel } from "./feature-search/feature-search.model";
import { FeatureSearchService } from "./feature-search/feature.search.service";
import { InfoMessageService } from "./shared/info.service";
import { AppStateService } from "./state/app-state.service";

afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
});

describe("application registration boundaries", () => {
    it("allows adjacent consumers to observe models without constructing domain controllers", () => {
        const forbidden = () => { throw new Error("A model constructed a controller"); };
        TestBed.configureTestingModule({ providers: [
            provideRouter([]), MessageService,
            ...[CoordinatesService, InspectionPanelService, AppLayoutService, MapInfoService,
                MapViewService, FeatureSearchService, InfoMessageService]
                .map(provide => ({ provide, useFactory: forbidden }))
        ] });

        const coordinates = TestBed.inject(CoordinatesModel);
        const layout = TestBed.inject(LayoutModel);
        const views = TestBed.inject(MapViewModel);
        const inspections = TestBed.inject(InspectionModel);
        const layers = TestBed.inject(MapDataModel);
        const searches = TestBed.inject(FeatureSearchModel);
        // Every additional domain model must also be independently injectable.
        for (const model of [ConnectionModel, RenderingModel, MapStylesModel, ConfigModel,
            DiagnosticsModel, LocationSearchModel, OmnibarModel]) {
            expect(TestBed.inject<unknown>(model)).toBeDefined();
        }
        const seen: boolean[] = [];
        const subscription = layout.dockOpenState.subscribe(value => seen.push(value));
        layout.dockOpenState.next(true);

        expect(seen).toEqual([false, true]);
        expect(coordinates.markerState.name).toBe("marker");
        expect(inspections.selectionState.name).toBe("selected");
        expect(layers.layerNamesState.name).toBe("layerNames");
        expect(searches.featureSearchState.name).toBe("featureSearchState");
        expect(views.viewIds).toHaveLength(1);
        subscription.unsubscribe();
    });

    it("collects the actual Angular registrations before any runtime initializer or network IO", () => {
        const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected catalog IO"));
        const searchStartup = vi.spyOn(FeatureSearchService.prototype, "initialize");
        TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([]), MessageService] });
        const registry = registerApplication(TestBed.inject(EnvironmentInjector));
        const catalog = registry.catalog();
        const persistence = TestBed.inject(AppStateService);

        const { catalogId: _catalogId, ...expected } = structuredClone(manifest);
        expected.actions.sort((left, right) => left.name.localeCompare(right.name, "en"));
        expected.channels.sort((left, right) => left.name.localeCompare(right.name, "en"));
        expect(catalog).toEqual(expected);
        expect(catalog.actions).toHaveLength(32);
        expect(catalog.channels).toHaveLength(21);
        expect(catalog.actions.every(action => action.permission ===
            (action.mutation ? "viewer-control" : "viewer-read"))).toBe(true);
        expect(catalog.actions.some(action => action.name.startsWith("omnibar_"))).toBe(false);
        expect([...persistence.registeredStates.keys()].sort()).toEqual(
            [...stateOwners(testPersistence()).persistence.registeredStates.keys()].sort()
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(searchStartup).not.toHaveBeenCalled();
    });

    it("derives control tools from registrations without invoking readers, handlers or candidates", () => {
        const registry = new ActionRegistry(testPersistence());
        const read = vi.fn(() => false);
        const write = vi.fn();
        const execute = vi.fn(() => ({ done: true as const }));
        const candidates = vi.fn(() => []);
        const controller: AppActionContributor = {
            registerControls(actions) {
                actions.registerControl({
                    name: "example.visible", description: "Example visibility", readable: true, writable: true,
                    selectorSchema: z.strictObject({}), valueSchema: z.boolean(),
                    persistence: "local-storage", synchronization: "none"
                }, { read, write });
            },
            registerActions(actions) {
                actions.registerAction({
                    name: "example_open", description: "Open example", mutation: true,
                    inputSchema: z.strictObject({}), outputSchema: z.strictObject({ done: z.literal(true) })
                }, execute, candidates);
            }
        };
        registry.registerContributors([controller]);
        const catalog = registry.catalog();
        expect(catalog.channels.map(control => control.name)).toEqual(["example.visible"]);
        for (const callback of [read, write, execute, candidates]) expect(callback).not.toHaveBeenCalled();
        expect(() => registry.execute("viewer_set_control", {
            target: { control: "example.visible" }, value: "wrong type"
        })).toThrow();
        expect(write).not.toHaveBeenCalled();
        registry.execute("viewer_set_control", { target: { control: "example.visible" }, value: true });
        expect(write).toHaveBeenCalledWith({}, true);
        expect(() => registry.registerContributors([controller])).toThrow("registration is closed");
    });
});
