import { AppConfigService } from "../../app/config/appconfig.service";
import { MapDataState } from "../../app/mapdata/mapdata.state";
import { MapViewState } from "../../app/mapview/mapview.state";
import { MapStyleState } from "../../app/mapstyle/mapstyle.state";
import { DiagnosticsState } from "../../app/diagnostics/diagnostics.state";
import { GeolocationState } from "../../app/geolocation/geolocation.state";
import { OmnibarState } from "../../app/omnibar/omnibar.state";
import "@angular/compiler";
import { provideHttpClient } from "@angular/common/http";
import { EnvironmentInjector } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { MessageService } from "primeng/api";
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from "vitest";
import { z } from "zod";
import manifest from "../../app/action/generated/web-mcp-actions.json";
import { stateOwners, testPersistence } from "../support/state-owners";
import { AppActionRegistry } from "../../app/action/action-registry.service";
import { AppActionContributor } from "../../app/action/action-contributor.model";
import { registerApplication } from "../../app/application-registration";
import { CoordinatesService } from "../../app/coordinates/coordinates.service";
import { CoordinatesState } from "../../app/coordinates/coordinates.state";
import { InspectionPanelService } from "../../app/inspection/inspection-panel.service";
import { InspectionState } from "../../app/inspection/inspection.state";
import { LayoutService } from "../../app/layout/layout.service";
import { LayoutState } from "../../app/layout/layout.state";
import { MapDataService } from "../../app/mapdata/mapdata.service";
import { MapViewService } from "../../app/mapview/mapview.service";
import { SearchState } from "../../app/search/search.state";
import { SearchService } from "../../app/search/search.service";
import { InfoMessageService } from "../../app/diagnostics/info.service";
import { AppStateService } from "../../app/appstate/appstate.service";

afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
});

describe("application registration boundaries", () => {
    it("allows adjacent consumers to observe state containers without constructing domain controllers", () => {
        const forbidden = () => { throw new Error("A state container constructed a controller"); };
        TestBed.configureTestingModule({ providers: [
            provideRouter([]), MessageService,
            ...[CoordinatesService, InspectionPanelService, LayoutService, MapDataService,
                MapViewService, SearchService, InfoMessageService]
                .map(provide => ({ provide, useFactory: forbidden }))
        ] });

        const coordinates = TestBed.inject(CoordinatesState);
        const layout = TestBed.inject(LayoutState);
        const views = TestBed.inject(MapViewState);
        const inspections = TestBed.inject(InspectionState);
        const layers = TestBed.inject(MapDataState);
        const searches = TestBed.inject(SearchState);
        // Every additional domain state container must also be independently injectable.
        for (const stateContainer of [MapDataState, MapViewState, MapStyleState,
            DiagnosticsState, GeolocationState, OmnibarState]) {
            expect(TestBed.inject<unknown>(stateContainer)).toBeDefined();
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

    it("loads configuration without constructing state or action owners", () => {
        TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([]), MessageService] });
        const config = TestBed.inject(AppConfigService);
        expect(config.snapshot.backgroundLayers[0].id).toBe("osm");
        expect(TestBed.inject(AppStateService).registeredStates.size).toBe(0);
    });

    it("collects the actual Angular registrations before any runtime initializer or network IO", () => {
        const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected catalog IO"));
        const searchStartup = vi.spyOn(SearchService.prototype, "initialize");
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
        const registry = new AppActionRegistry(testPersistence());
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
