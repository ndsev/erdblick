import {AppActionService} from "../actions/app-action.service";
import {Injector, NgZone, ProviderToken} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import type {Router} from "@angular/router";
import {BehaviorSubject, Subject} from "rxjs";
import {AppStateService} from "./appstate.service";
import {InfoMessageService} from "./info.service";
import {MapInfoService} from "../mapdata/map-info.service";
import {MapViewService} from "../mapview/map-view.service";
import {FeatureSearchSchemaService} from "../mapdata/feature-search-schema.service";
import {StyleValidationReportService} from "../styledata/style-validation-report.service";
import {DiagnosticsFacadeService} from "../diagnostics/diagnostics.facade.service";
import {ViewLayerDiagnosticsService} from "../mapview/view-layer-diagnostics.service";
import {TileSubsetLayerRenderService} from "../mapview/deck/tile-subset-layer-render.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapLayerStateService} from "../mapdata/map-layer-state.service";
import {InspectionStateService} from "../inspection/inspection-state.service";
import {AppLayoutService} from "./app-layout.service";
import {StyleService} from "../styledata/style.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {CoordinatesPolicyService} from "../coords/coordinates-policy.service";
import {LocationSearchService} from "../search/location.search.service";
import {StyleEditorRequestService} from "../styledata/style-editor-request.service";
import {AppConfigService} from "./app-config.service";

export type StateTestSystem = {owner<T>(token: ProviderToken<T>): T} & Pick<MapViewStateService, "retainViews" | "viewIds" | "viewIdsState" | "identities" | "captureView" | "isCurrent" | "reorderViews" | "idAt" | "indexOf"> &
    Pick<AppStateService, keyof AppStateService> &
    Pick<MapViewStateService, Extract<"numViewsState" | "markerState" | "markedPositionState" | "focusedViewState" | "viewSyncState" | "cameraViewDataState" | "mode2dState" | "deckAntialiasingEnabledState" | "semanticCompositingEnabledState" | "contactShadingEnabledState" | "lod3TileThresholdState" | "tileSubsetRenderWorkerCountState" | "pointCloudDownsamplingEnabledState" | "pointCloudDetailPixelsState" | "pointCloudWorkingMemoryMiBState" | "pointCloudGpuMemoryMiBState" | "pointCloudPolicy" | "setPointCloudPolicy" | "mapZoomStepState" | "featureZoomClearanceMetersState" | "tilesLoadLimitState" | "syncOptions" | "syncViews" | "numViews" | "deckAntialiasingEnabled" | "semanticCompositingEnabled" | "contactShadingEnabled" | "lod3TileThreshold" | "tileSubsetRenderWorkerCount" | "mapZoomStep" | "featureZoomClearanceMeters" | "marker" | "markedPosition" | "focusedView" | "tilesLoadLimit" | "viewSync" | "getCameraOrientation" | "getCameraPosition" | "_setView" | "setView" | "setProjectionMode" | "setMarkerState" | "setMarkerPosition" | "updateSelectedSyncOptions", keyof MapViewStateService>> &
    Pick<MapLayerStateService, Extract<"hasAuthoritativeUrlLayerList" | "layerSyncOptionsState" | "backgroundState" | "layerNamesState" | "layerVisibilityState" | "viewTileBordersState" | "viewTileGridModeState" | "viewTileGridLevelState" | "viewTileGridAutoLevelState" | "viewTileGridColorState" | "viewTileGridOpacityState" | "layerZoomLevelState" | "layerAutoZoomLevelState" | "stylesState" | "layerPresetSelectionState" | "mapPresetSelectionState" | "mapsOpenState" | "layerNames" | "styles" | "getLayerSyncOption" | "setLayerSyncOption" | "getBackgroundState" | "resolveBackgroundState" | "setBackgroundState" | "getBackgroundOpacity" | "mapLayerConfig" | "setMapLayerConfig" | "styleOptionValues" | "setStyleOptionValues" | "setStyleOptionValuesBatch" | "getLayerPresetSelection" | "setLayerPresetSelection" | "getMapPresetSelection" | "setMapPresetSelection" | "prune" | "migrateLegacyOsmState" | "parseLegacyOsmStorage" | "parseLegacyOsmUrl" | "parseLegacyOsmToken", keyof MapLayerStateService>> &
    Pick<InspectionStateService, Extract<"inspectionTreeExpansionStates" | "defaultInspectionPanelSize" | "selectionState" | "inspectionsLimitState" | "drillPickRadiusState" | "inspectionTreeExpandByDefaultState" | "sourceDataInspectionDefaultColumnsState" | "inspectionTreeHiddenColumnsState" | "inspectionValueVaryColorsState" | "inspectionValueVaryOutlinesState" | "inspectionValueVaryStripingState" | "hoverLabelsEnabledState" | "hoverLabelFieldsState" | "inspectionComparisonState" | "selection" | "focusedInspectionPanelId" | "inspectionsLimit" | "drillPickRadius" | "inspectionComparison" | "inspectionTreeExpandByDefault" | "sourceDataInspectionDefaultColumns" | "inspectionValueVaryColors" | "inspectionValueVaryOutlines" | "inspectionValueVaryStriping" | "hoverLabelsEnabled" | "hoverLabelFields" | "setSelection" | "toggleInspectionFeatureHighlight" | "setInspectionPanelSize" | "setInspectionPanelLockedState" | "setInspectionPanelUndockedState" | "setFocusedInspectionPanel" | "isInspectionPanelFocused" | "setInspectionTreeExpansionState" | "getInspectionTreeExpansionState" | "setInspectionTreeHiddenColumns" | "getInspectionTreeHiddenColumns" | "cloneInspectionTreeExpansionSnapshot" | "cloneInspectionTreeExpansionState" | "getInspectionDialogLayout" | "ensureInspectionDialogLayout" | "setInspectionDialogPosition" | "pruneInspectionDialogLayout" | "pruneInspectionTreeExpansionStates" | "pruneInspectionTreeHiddenColumns" | "openInspectionComparison" | "closeInspectionComparison" | "reorderInspectionPanels" | "setInspectionPanelColor" | "unsetUnlockedSelections" | "unsetPanel" | "findPanelIdContainingFeatureSelection" | "sanitizeFocusedInspectionPanel" | "panelOrderEquals" | "inspectionLayoutId" | "sanitizeInspectionComparisonForSelection" | "sanitizeInspectionComparisonModel" | "buildCompareOptions" | "isFeaturePanel" | "formatFeatureLabel" | "createComparisonEntryFromPanel" | "createComparisonModel", keyof InspectionStateService>> &
    Pick<AppLayoutService, Extract<"baseFontSize" | "dockOpenState" | "dockWidthState" | "viewPanelSizesState" | "dockActiveTabState" | "dockAutoCollapse" | "dialogLayoutsState" | "pendingOpenDialogs" | "isDockOpen" | "dockActiveTab" | "isDockAutoCollapsible" | "getDialogLayout" | "getDialogLayoutOpen" | "isDialogOpen" | "setDialogOpen" | "openDialog" | "closeDialog" | "isSurfaceDocked" | "setSurfaceDocked" | "toggleSurfaceDocked" | "setPanelLayout" | "hasDockedSurface" | "reorderDockedSurfaces" | "setDialogPosition" | "nextSurfaceDockOrder" | "ensureDialogLayout" | "upsertDialogLayout" | "setDialogLayoutOpen" | "removeDialogLayout", keyof AppLayoutService>> &
    Pick<StyleService, Extract<"styleVisibilityState" | "styleVisibility" | "getStyleVisibility" | "setStyleVisibility" | "removeStyleVisibility", keyof StyleService>> &
    Pick<FeatureSearchService, Extract<"featureSearchGroupingState" | "featureSearchState" | "featureSearchGrouping" | "featureSearches" | "addFeatureSearch" | "patchFeatureSearch" | "removeFeatureSearch", keyof FeatureSearchService>> &
    Pick<MapTileStreamService, Extract<"tilePullCompressionEnabledState" | "invalidConnectionPolicy" | "connectionRetryEnabledState" | "connectionRetryInitialDelayMsState" | "connectionRetryBackoffMultiplierState" | "connectionRetryMaxDelayMsState" | "connectionRetryPolicy" | "setConnectionRetryPolicy" | "tilePullCompressionEnabled", keyof MapTileStreamService>> &
    Pick<CoordinatesService, Extract<"enabledCoordsTileIdsState" | "enabledCoordsTileIds", keyof CoordinatesService>> &
    Pick<CoordinatesPolicyService, Extract<"coordinatesEnabledState" | "coordinatesLegalTermsAcceptedState", keyof CoordinatesPolicyService>> &
    Pick<LocationSearchService, Extract<"locationSearchResultLimitState" | "locationSearchResultLimit", keyof LocationSearchService>> &
    Pick<StyleEditorRequestService, Extract<"styleEditorTargetState" | "styleEditorTargetId", keyof StyleEditorRequestService>> &
    Pick<AppConfigService, Extract<"distributionVersions" | "erdblickVersion", keyof AppConfigService>> &
    Pick<DiagnosticsFacadeService, "diagnosticsLogFilterState" | "diagnosticsLogFilter" | "diagnosticsExportOptionsState" | "diagnosticsExportOptions">;

/**
 * Executes the historical cross-domain persistence fixtures against real owner instances.
 * The proxy exists only in tests so their old assertions remain readable during comparison;
 * production consumers import owners directly. New workflow tests use injector.get(owner).
 */
export function createStateTestSystem(router: Router, info: InfoMessageService): StateTestSystem {
    const state = new AppStateService(router, info);
    const mapInfo = {dataSourceInfoChanged: new Subject<void>(), layerStateChanged: new Subject<string>(),
        maps: {maps: new Map()}, mapgetLayers: new Map(), reapplySyncOptionsForAllViews() {},
        getSourceRecoveryState: () => ({retrying: false, failed: false, message: ""})};
    const views = {viewStateChanged: new Subject<string>(), navigationStarted: new Subject<void>(), viewLayoutRevision: 0};
    const zone = {runOutsideAngular: <T>(fn: () => T) => fn(), run: <T>(fn: () => T) => fn()};
    const injector = Injector.create({providers: [AppActionService,
        {provide: AppStateService, useValue: state}, {provide: InfoMessageService, useValue: info},
        {provide: HttpClient, useValue: {}}, {provide: NgZone, useValue: zone},
        {provide: MapInfoService, useValue: mapInfo}, {provide: MapViewService, useValue: views},
        {provide: FeatureSearchSchemaService, useValue: {}},
        StyleValidationReportService, ViewLayerDiagnosticsService, TileSubsetLayerRenderService,
        MapViewStateService, MapLayerStateService, InspectionStateService, AppLayoutService, StyleService, FeatureSearchService, MapTileStreamService, CoordinatesService, CoordinatesPolicyService, LocationSearchService, StyleEditorRequestService, AppConfigService, DiagnosticsFacadeService
    ]});
    // View membership must exist before per-view values are registered.
    injector.get(MapViewStateService);
    const owners = {MapViewStateService: injector.get(MapViewStateService),
        MapLayerStateService: injector.get(MapLayerStateService),
        InspectionStateService: injector.get(InspectionStateService),
        AppLayoutService: injector.get(AppLayoutService),
        StyleService: injector.get(StyleService),
        FeatureSearchService: injector.get(FeatureSearchService),
        MapTileStreamService: injector.get(MapTileStreamService),
        CoordinatesService: injector.get(CoordinatesService),
        CoordinatesPolicyService: injector.get(CoordinatesPolicyService),
        LocationSearchService: injector.get(LocationSearchService),
        StyleEditorRequestService: injector.get(StyleEditorRequestService),
        AppConfigService: injector.get(AppConfigService),
        DiagnosticsFacadeService: injector.get(DiagnosticsFacadeService)};
    // These fixtures exercise persisted search definitions. Backend session execution
    // has separate owner tests and must not start network work during codec assertions.
    Object.defineProperty(owners.FeatureSearchService, "reconcilePersistedFeatureSearchState", {value: () => {}});
    Object.defineProperty(owners.FeatureSearchService, "resetStaleDockState", {value: () => {}});
    const memberOwners: Record<string, keyof typeof owners> = {
    "retainViews": "MapViewStateService",
    "viewIds": "MapViewStateService",
    "viewIdsState": "MapViewStateService",
    "identities": "MapViewStateService",
    "captureView": "MapViewStateService",
    "isCurrent": "MapViewStateService",
    "reorderViews": "MapViewStateService",
    "idAt": "MapViewStateService",
    "indexOf": "MapViewStateService",
    "numViewsState": "MapViewStateService",
    "markerState": "MapViewStateService",
    "markedPositionState": "MapViewStateService",
    "focusedViewState": "MapViewStateService",
    "viewSyncState": "MapViewStateService",
    "cameraViewDataState": "MapViewStateService",
    "mode2dState": "MapViewStateService",
    "deckAntialiasingEnabledState": "MapViewStateService",
    "semanticCompositingEnabledState": "MapViewStateService",
    "contactShadingEnabledState": "MapViewStateService",
    "lod3TileThresholdState": "MapViewStateService",
    "tileSubsetRenderWorkerCountState": "MapViewStateService",
    "pointCloudDownsamplingEnabledState": "MapViewStateService",
    "pointCloudDetailPixelsState": "MapViewStateService",
    "pointCloudWorkingMemoryMiBState": "MapViewStateService",
    "pointCloudGpuMemoryMiBState": "MapViewStateService",
    "pointCloudPolicy": "MapViewStateService",
    "setPointCloudPolicy": "MapViewStateService",
    "mapZoomStepState": "MapViewStateService",
    "featureZoomClearanceMetersState": "MapViewStateService",
    "tilesLoadLimitState": "MapViewStateService",
    "syncOptions": "MapViewStateService",
    "syncViews": "MapViewStateService",
    "numViews": "MapViewStateService",
    "deckAntialiasingEnabled": "MapViewStateService",
    "semanticCompositingEnabled": "MapViewStateService",
    "contactShadingEnabled": "MapViewStateService",
    "lod3TileThreshold": "MapViewStateService",
    "tileSubsetRenderWorkerCount": "MapViewStateService",
    "mapZoomStep": "MapViewStateService",
    "featureZoomClearanceMeters": "MapViewStateService",
    "marker": "MapViewStateService",
    "markedPosition": "MapViewStateService",
    "focusedView": "MapViewStateService",
    "tilesLoadLimit": "MapViewStateService",
    "viewSync": "MapViewStateService",
    "getCameraOrientation": "MapViewStateService",
    "getCameraPosition": "MapViewStateService",
    "_setView": "MapViewStateService",
    "setView": "MapViewStateService",
    "setProjectionMode": "MapViewStateService",
    "setMarkerState": "MapViewStateService",
    "setMarkerPosition": "MapViewStateService",
    "updateSelectedSyncOptions": "MapViewStateService",
    "hasAuthoritativeUrlLayerList": "MapLayerStateService",
    "layerSyncOptionsState": "MapLayerStateService",
    "backgroundState": "MapLayerStateService",
    "layerNamesState": "MapLayerStateService",
    "layerVisibilityState": "MapLayerStateService",
    "viewTileBordersState": "MapLayerStateService",
    "viewTileGridModeState": "MapLayerStateService",
    "viewTileGridLevelState": "MapLayerStateService",
    "viewTileGridAutoLevelState": "MapLayerStateService",
    "viewTileGridColorState": "MapLayerStateService",
    "viewTileGridOpacityState": "MapLayerStateService",
    "layerZoomLevelState": "MapLayerStateService",
    "layerAutoZoomLevelState": "MapLayerStateService",
    "stylesState": "MapLayerStateService",
    "layerPresetSelectionState": "MapLayerStateService",
    "mapPresetSelectionState": "MapLayerStateService",
    "mapsOpenState": "MapLayerStateService",
    "layerNames": "MapLayerStateService",
    "styles": "MapLayerStateService",
    "getLayerSyncOption": "MapLayerStateService",
    "setLayerSyncOption": "MapLayerStateService",
    "getBackgroundState": "MapLayerStateService",
    "resolveBackgroundState": "MapLayerStateService",
    "setBackgroundState": "MapLayerStateService",
    "getBackgroundOpacity": "MapLayerStateService",
    "mapLayerConfig": "MapLayerStateService",
    "setMapLayerConfig": "MapLayerStateService",
    "styleOptionValues": "MapLayerStateService",
    "setStyleOptionValues": "MapLayerStateService",
    "setStyleOptionValuesBatch": "MapLayerStateService",
    "getLayerPresetSelection": "MapLayerStateService",
    "setLayerPresetSelection": "MapLayerStateService",
    "getMapPresetSelection": "MapLayerStateService",
    "setMapPresetSelection": "MapLayerStateService",
    "prune": "MapLayerStateService",
    "migrateLegacyOsmState": "MapLayerStateService",
    "parseLegacyOsmStorage": "MapLayerStateService",
    "parseLegacyOsmUrl": "MapLayerStateService",
    "parseLegacyOsmToken": "MapLayerStateService",
    "inspectionTreeExpansionStates": "InspectionStateService",
    "defaultInspectionPanelSize": "InspectionStateService",
    "selectionState": "InspectionStateService",
    "inspectionsLimitState": "InspectionStateService",
    "drillPickRadiusState": "InspectionStateService",
    "inspectionTreeExpandByDefaultState": "InspectionStateService",
    "sourceDataInspectionDefaultColumnsState": "InspectionStateService",
    "inspectionTreeHiddenColumnsState": "InspectionStateService",
    "inspectionValueVaryColorsState": "InspectionStateService",
    "inspectionValueVaryOutlinesState": "InspectionStateService",
    "inspectionValueVaryStripingState": "InspectionStateService",
    "hoverLabelsEnabledState": "InspectionStateService",
    "hoverLabelFieldsState": "InspectionStateService",
    "inspectionComparisonState": "InspectionStateService",
    "selection": "InspectionStateService",
    "focusedInspectionPanelId": "InspectionStateService",
    "inspectionsLimit": "InspectionStateService",
    "drillPickRadius": "InspectionStateService",
    "inspectionComparison": "InspectionStateService",
    "inspectionTreeExpandByDefault": "InspectionStateService",
    "sourceDataInspectionDefaultColumns": "InspectionStateService",
    "inspectionValueVaryColors": "InspectionStateService",
    "inspectionValueVaryOutlines": "InspectionStateService",
    "inspectionValueVaryStriping": "InspectionStateService",
    "hoverLabelsEnabled": "InspectionStateService",
    "hoverLabelFields": "InspectionStateService",
    "setSelection": "InspectionStateService",
    "toggleInspectionFeatureHighlight": "InspectionStateService",
    "setInspectionPanelSize": "InspectionStateService",
    "setInspectionPanelLockedState": "InspectionStateService",
    "setInspectionPanelUndockedState": "InspectionStateService",
    "setFocusedInspectionPanel": "InspectionStateService",
    "isInspectionPanelFocused": "InspectionStateService",
    "setInspectionTreeExpansionState": "InspectionStateService",
    "getInspectionTreeExpansionState": "InspectionStateService",
    "setInspectionTreeHiddenColumns": "InspectionStateService",
    "getInspectionTreeHiddenColumns": "InspectionStateService",
    "cloneInspectionTreeExpansionSnapshot": "InspectionStateService",
    "cloneInspectionTreeExpansionState": "InspectionStateService",
    "getInspectionDialogLayout": "InspectionStateService",
    "ensureInspectionDialogLayout": "InspectionStateService",
    "setInspectionDialogPosition": "InspectionStateService",
    "pruneInspectionDialogLayout": "InspectionStateService",
    "pruneInspectionTreeExpansionStates": "InspectionStateService",
    "pruneInspectionTreeHiddenColumns": "InspectionStateService",
    "openInspectionComparison": "InspectionStateService",
    "closeInspectionComparison": "InspectionStateService",
    "reorderInspectionPanels": "InspectionStateService",
    "setInspectionPanelColor": "InspectionStateService",
    "unsetUnlockedSelections": "InspectionStateService",
    "unsetPanel": "InspectionStateService",
    "findPanelIdContainingFeatureSelection": "InspectionStateService",
    "sanitizeFocusedInspectionPanel": "InspectionStateService",
    "panelOrderEquals": "InspectionStateService",
    "inspectionLayoutId": "InspectionStateService",
    "sanitizeInspectionComparisonForSelection": "InspectionStateService",
    "sanitizeInspectionComparisonModel": "InspectionStateService",
    "buildCompareOptions": "InspectionStateService",
    "isFeaturePanel": "InspectionStateService",
    "formatFeatureLabel": "InspectionStateService",
    "createComparisonEntryFromPanel": "InspectionStateService",
    "createComparisonModel": "InspectionStateService",
    "baseFontSize": "AppLayoutService",
    "dockOpenState": "AppLayoutService",
    "dockWidthState": "AppLayoutService",
    "viewPanelSizesState": "AppLayoutService",
    "dockActiveTabState": "AppLayoutService",
    "dockAutoCollapse": "AppLayoutService",
    "dialogLayoutsState": "AppLayoutService",
    "pendingOpenDialogs": "AppLayoutService",
    "isDockOpen": "AppLayoutService",
    "dockActiveTab": "AppLayoutService",
    "isDockAutoCollapsible": "AppLayoutService",
    "getDialogLayout": "AppLayoutService",
    "getDialogLayoutOpen": "AppLayoutService",
    "isDialogOpen": "AppLayoutService",
    "setDialogOpen": "AppLayoutService",
    "openDialog": "AppLayoutService",
    "closeDialog": "AppLayoutService",
    "isSurfaceDocked": "AppLayoutService",
    "setSurfaceDocked": "AppLayoutService",
    "toggleSurfaceDocked": "AppLayoutService",
    "setPanelLayout": "AppLayoutService",
    "hasDockedSurface": "AppLayoutService",
    "reorderDockedSurfaces": "AppLayoutService",
    "setDialogPosition": "AppLayoutService",
    "nextSurfaceDockOrder": "AppLayoutService",
    "ensureDialogLayout": "AppLayoutService",
    "upsertDialogLayout": "AppLayoutService",
    "setDialogLayoutOpen": "AppLayoutService",
    "removeDialogLayout": "AppLayoutService",
    "styleVisibilityState": "StyleService",
    "styleVisibility": "StyleService",
    "getStyleVisibility": "StyleService",
    "setStyleVisibility": "StyleService",
    "removeStyleVisibility": "StyleService",
    "featureSearchGroupingState": "FeatureSearchService",
    "featureSearchState": "FeatureSearchService",
    "featureSearchGrouping": "FeatureSearchService",
    "featureSearches": "FeatureSearchService",
    "addFeatureSearch": "FeatureSearchService",
    "patchFeatureSearch": "FeatureSearchService",
    "removeFeatureSearch": "FeatureSearchService",
    "tilePullCompressionEnabledState": "MapTileStreamService",
    "invalidConnectionPolicy": "MapTileStreamService",
    "connectionRetryEnabledState": "MapTileStreamService",
    "connectionRetryInitialDelayMsState": "MapTileStreamService",
    "connectionRetryBackoffMultiplierState": "MapTileStreamService",
    "connectionRetryMaxDelayMsState": "MapTileStreamService",
    "connectionRetryPolicy": "MapTileStreamService",
    "setConnectionRetryPolicy": "MapTileStreamService",
    "tilePullCompressionEnabled": "MapTileStreamService",
    "enabledCoordsTileIdsState": "CoordinatesService",
    "enabledCoordsTileIds": "CoordinatesService",
    "coordinatesEnabledState": "CoordinatesPolicyService",
    "coordinatesLegalTermsAcceptedState": "CoordinatesPolicyService",
    "locationSearchResultLimitState": "LocationSearchService",
    "locationSearchResultLimit": "LocationSearchService",
    "styleEditorTargetState": "StyleEditorRequestService",
    "styleEditorTargetId": "StyleEditorRequestService",
    "distributionVersions": "AppConfigService",
    "erdblickVersion": "AppConfigService",
    "diagnosticsLogFilterState": "DiagnosticsFacadeService",
    "diagnosticsLogFilter": "DiagnosticsFacadeService",
    "diagnosticsExportOptionsState": "DiagnosticsFacadeService",
    "diagnosticsExportOptions": "DiagnosticsFacadeService"
};
    return new Proxy(state, {
        get(target, name) {
            if (name === "owner") return <T>(token: ProviderToken<T>) => injector.get(token);
            if (name === "ngOnDestroy") return () => injector.destroy();
            const owner = typeof name === "string" ? owners[memberOwners[name]] : undefined;
            const value = Reflect.get(owner ?? target, name);
            return typeof value === "function" ? value.bind(owner ?? target) : value;
        },
        set(target, name, value) {
            const owner = typeof name === "string" ? owners[memberOwners[name]] : undefined;
            return Reflect.set(owner ?? target, name, value);
        }
    }) as unknown as StateTestSystem;
}
