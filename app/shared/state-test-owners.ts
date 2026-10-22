import {HttpClient} from "@angular/common/http";
import {Injector, NgZone, Provider} from "@angular/core";
import {Router} from "@angular/router";
import {Subject} from "rxjs";
import {CoordinatesPolicyService} from "../coords/coordinates-policy.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {DiagnosticsFacadeService} from "../diagnostics/diagnostics.facade.service";
import {FeatureSearchSchemaService} from "../mapdata/feature-search-schema.service";
import {MapInfoService} from "../mapdata/map-info.service";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {TileSubsetLayerRenderService} from "../mapview/deck/tile-subset-layer-render.service";
import {MapViewService} from "../mapview/map-view.service";
import {ViewLayerDiagnosticsService} from "../mapview/view-layer-diagnostics.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {LocationSearchService} from "../search/location.search.service";
import {StyleEditorRequestService} from "../styledata/style-editor-request.service";
import {StyleValidationReportService} from "../styledata/style-validation-report.service";
import {StyleService} from "../styledata/style.service";
import {AppStore} from "./app.store";
import {AppConfigService} from "./app-config.service";
import {AppUrlStateService} from "./app-url-state.service";
import {AppStateService} from "./appstate.service";
import {InfoMessageService} from "./info.service";

/** Real persisted owners, with network/rendering collaborators stubbed for codec tests. */
export function createStateOwners(router: Router, info: InfoMessageService, providers: Provider[] = []) {
    const mapInfo = {
        dataSourceInfoChanged: new Subject<void>(),
        layerStateChanged: new Subject<string>(),
        maps: {maps: new Map()},
        mapgetLayers: new Map(),
        reapplySyncOptionsForAllViews() {},
        getSourceRecoveryState: () => ({retrying: false, failed: false, message: ""})
    };
    const views = {
        viewStateChanged: new Subject<string>(),
        navigationStarted: new Subject<void>(),
        viewLayoutRevision: 0
    };
    const zone = {runOutsideAngular: <T>(fn: () => T) => fn(), run: <T>(fn: () => T) => fn()};
    const injector = Injector.create({
        providers: [
            AppStore,
            AppStateService,
            AppUrlStateService,
            {provide: Router, useValue: router},
            {provide: InfoMessageService, useValue: info},
            {provide: HttpClient, useValue: {}},
            {provide: NgZone, useValue: zone},
            {provide: MapInfoService, useValue: mapInfo},
            {provide: MapViewService, useValue: views},
            {provide: FeatureSearchSchemaService, useValue: {
                searchScopeAnalysisSignature: (query: string, scope: string, layers: unknown) => JSON.stringify([query, scope, layers]),
                requestSearchScopeAnalysis: async (query: string, scope: string, layers: unknown) => ({
                    signature: JSON.stringify([query, scope, layers]), concreteScope: "feature", normalizedQuery: query,
                    attributeScopes: [], attributeScopeCandidateCount: 0, rewriteSuppressed: false,
                    rewriteSuppressionReason: "", inferredMapLayers: [], matchedFieldNames: [], matchedEnumValues: [],
                    matchedFeatureTypes: []
                })
            }},
            StyleValidationReportService,
            ViewLayerDiagnosticsService,
            TileSubsetLayerRenderService,
            StyleService,
            FeatureSearchService,
            MapTileStreamService,
            CoordinatesService,
            CoordinatesPolicyService,
            LocationSearchService,
            StyleEditorRequestService,
            AppConfigService,
            DiagnosticsFacadeService,
            ...providers
        ]
    });
    const store = injector.get(AppStore);
    store.initializeViews();
    const state = injector.get(AppStateService);
    // Persistence discovers descriptors on the store; no runtime engine is needed
    // merely to decode a saved state. Tests opt into actual resources by reading a
    // handle, with all overrides still supplied by this same injector.
    return {
        injector, store, actions: store.actionCatalog, persistence: state,
        url: injector.get(AppUrlStateService),
        get styles() { return injector.get(StyleService); },
        get searches() { return injector.get(FeatureSearchService); },
        get connection() { return injector.get(MapTileStreamService); },
        get coordinates() { return injector.get(CoordinatesService); },
        get coordinatePolicy() { return injector.get(CoordinatesPolicyService); },
        get location() { return injector.get(LocationSearchService); },
        get styleEditor() { return injector.get(StyleEditorRequestService); },
        get config() { return injector.get(AppConfigService); },
        get diagnostics() { return injector.get(DiagnosticsFacadeService); },
        destroy: () => injector.destroy()
    };
}

export type StateOwners = ReturnType<typeof createStateOwners>;
