import {HttpClient} from "@angular/common/http";
import {Injector, NgZone} from "@angular/core";
import type {Router} from "@angular/router";
import {Subject} from "rxjs";
import {AppActionService} from "../actions/app-action.service";
import {CoordinatesPolicyService} from "../coords/coordinates-policy.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {DiagnosticsFacadeService} from "../diagnostics/diagnostics.facade.service";
import {InspectionStateService} from "../inspection/inspection-state.service";
import {FeatureSearchSchemaService} from "../mapdata/feature-search-schema.service";
import {MapInfoService} from "../mapdata/map-info.service";
import {MapLayerStateService} from "../mapdata/map-layer-state.service";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {TileSubsetLayerRenderService} from "../mapview/deck/tile-subset-layer-render.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapViewService} from "../mapview/map-view.service";
import {ViewLayerDiagnosticsService} from "../mapview/view-layer-diagnostics.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {LocationSearchService} from "../search/location.search.service";
import {StyleEditorRequestService} from "../styledata/style-editor-request.service";
import {StyleValidationReportService} from "../styledata/style-validation-report.service";
import {StyleService} from "../styledata/style.service";
import {AppConfigService} from "./app-config.service";
import {AppLayoutService} from "./app-layout.service";
import {AppUrlStateService} from "./app-url-state.service";
import {AppStateService} from "./appstate.service";
import {InfoMessageService} from "./info.service";

/** Real persisted owners, with network/rendering collaborators stubbed for codec tests. */
export function createStateOwners(router: Router, info: InfoMessageService) {
    const state = new AppStateService(router, info);
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
            AppActionService,
            AppUrlStateService,
            {provide: AppStateService, useValue: state},
            {provide: InfoMessageService, useValue: info},
            {provide: HttpClient, useValue: {}},
            {provide: NgZone, useValue: zone},
            {provide: MapInfoService, useValue: mapInfo},
            {provide: MapViewService, useValue: views},
            {provide: FeatureSearchSchemaService, useValue: {}},
            StyleValidationReportService,
            ViewLayerDiagnosticsService,
            TileSubsetLayerRenderService,
            MapViewStateService,
            MapLayerStateService,
            InspectionStateService,
            AppLayoutService,
            StyleService,
            FeatureSearchService,
            MapTileStreamService,
            CoordinatesService,
            CoordinatesPolicyService,
            LocationSearchService,
            StyleEditorRequestService,
            AppConfigService,
            DiagnosticsFacadeService
        ]
    });
    // View membership must exist before per-view values are registered.
    injector.get(MapViewStateService);
    const owners = {
        views: injector.get(MapViewStateService),
        layers: injector.get(MapLayerStateService),
        inspections: injector.get(InspectionStateService),
        layout: injector.get(AppLayoutService),
        styles: injector.get(StyleService),
        searches: injector.get(FeatureSearchService),
        connection: injector.get(MapTileStreamService),
        coordinates: injector.get(CoordinatesService),
        coordinatePolicy: injector.get(CoordinatesPolicyService),
        location: injector.get(LocationSearchService),
        styleEditor: injector.get(StyleEditorRequestService),
        config: injector.get(AppConfigService),
        diagnostics: injector.get(DiagnosticsFacadeService)
    };
    // These fixtures exercise persisted search definitions. Backend session execution
    // has separate owner tests and must not start network work during codec assertions.
    Object.defineProperty(owners.searches, "reconcilePersistedFeatureSearchState", {value: () => {}});
    Object.defineProperty(owners.searches, "resetStaleDockState", {value: () => {}});
    return {injector, actions: injector.get(AppActionService), persistence: state, url: injector.get(AppUrlStateService), ...owners, destroy: () => injector.destroy()};
}

export type StateOwners = ReturnType<typeof createStateOwners>;
