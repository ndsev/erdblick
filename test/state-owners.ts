import { OmnibarModel } from "../app/omnibar/omnibar.model";
import { DiagnosticsModel } from "../app/diagnostics/diagnostics.model";
import { LocationSearchModel } from "../app/location-search/location-search.model";
import { FeatureSearchModel } from "../app/feature-search/feature-search.model";
import { MapStylesModel } from "../app/map-styles/map-styles.model";
import { CoordinatesModel } from "../app/coordinates/coordinates.model";
import { ConnectionModel } from "../app/connection/connection.model";
import { RenderingModel } from "../app/rendering/rendering.model";
import { InspectionModel } from "../app/inspection/inspection.model";
import { LayoutModel } from "../app/layout/layout.model";
import { ConfigModel } from "../app/config/config.model";
import { Subject } from "rxjs";
import { AppStateService } from "../app/state/app-state.service";
import { AppLayoutService } from '../app/layout/app-layout.service';
import { AppConfigService } from '../app/config/app-config.service';
import { AppUrlStateService } from '../app/state/app-url-state.service';
import { MapViewModel } from '../app/mapview/mapview.model';
import { MapDataModel } from '../app/mapdata/mapdata.model';
import { InspectionPanelService } from '../app/inspection/inspection-panel.service';
import { RenderPreferencesService } from '../app/rendering/render-preferences.service';
import { ConnectionPreferencesService } from '../app/connection/connection-preferences.service';
import { CoordinatesService } from '../app/coordinates/coordinates.service';
import { CoordinatesPolicyService } from '../app/coordinates/coordinates-policy.service';
import { StyleService } from '../app/map-styles/style.service';
import { FeatureSearchService } from '../app/feature-search/feature.search.service';
import { LocationSearchService } from '../app/location-search/location.search.service';
import { DiagnosticsFacadeService } from '../app/diagnostics/diagnostics.facade.service';
import { StyleValidationReportService } from '../app/map-styles/style-validation-report.service';
import { InfoMessageService } from '../app/shared/info.service';

/**
 * Actual owners, with inert network/rendering dependencies. Persistence tests can
 * exercise all deployed keys without starting search transport or diagnostics timers.
 * Tests address each owner explicitly; there is no production compatibility facade.
 */
export class StateOwners {
    readonly omnibar = new OmnibarModel(this.persistence);
    readonly configService = new AppConfigService({} as never, this.persistence, new ConfigModel(this.persistence));
    readonly layout = new AppLayoutService(this.persistence, new LayoutModel(this.persistence));
    readonly viewSettings = new MapViewModel(this.persistence);
    readonly inspectionState = new InspectionPanelService(this.persistence, this.layout, this.messages, new InspectionModel(this.persistence));
    readonly renderPreferences = new RenderPreferencesService(this.persistence, new RenderingModel(this.persistence));
    readonly connectionPreferences = new ConnectionPreferencesService(this.persistence, new ConnectionModel(this.persistence));
    readonly coordinates = new CoordinatesService(this.persistence, this.configService, new CoordinatesModel(this.persistence));
    readonly coordinatePolicy = new CoordinatesPolicyService(this.configService, this.persistence, this.messages, this.coordinates.model);
    readonly styleService = new StyleService({} as never, this.persistence, this.messages, this.configService, undefined, new MapStylesModel(this.persistence));
    readonly layerState = new MapDataModel(this.persistence, this.viewSettings);
    readonly searchService = new FeatureSearchService({} as never, {} as never, {} as never, {} as never,
        this.persistence, this.layout, this.inspectionState.model, this.viewSettings, new FeatureSearchModel(this.persistence, this.viewSettings));
    readonly locationSearch = new LocationSearchService({} as never, this.configService, this.persistence, new LocationSearchModel(this.persistence));
    readonly diagnostics = new DiagnosticsFacadeService({
        getTileStreamTransportCompressionStats: () => ({}), getBackendRequestProgress: () => ({}),
        getPendingFrameQueueSize: () => 0, getConnectionDiagnostics: () => ({}),
        getDownstreamBytesPerSecond: () => 0, currentViewportRenderSeconds: () => 0,
        isTileStreamConnected: () => false
    } as never, { visualizationQueueLength: () => 0, currentFrameTimeMs: () => 0 } as never,
        { currentSummary: () => ({}) } as never, this.persistence,
        new StyleValidationReportService(), {} as never, this.layout, this.configService.model, {} as never, this.searchService, this.viewSettings, new DiagnosticsModel(this.persistence));
    readonly url = new AppUrlStateService(this.persistence, this.layerState, this.inspectionState.model, this.viewSettings, this.styleService, this.searchService.model);

    constructor(readonly persistence: AppStateService,
        readonly messages: InfoMessageService = { showError() { }, showWarning() { } } as unknown as InfoMessageService) {
        persistence.sealRegistration();
    }
}

const fixtures = new WeakMap<AppStateService, StateOwners>();

export function stateOwners(persistence: AppStateService): StateOwners {
    let fixture = fixtures.get(persistence);
    if (!fixture) {
        fixture = new StateOwners(persistence);
        fixtures.set(persistence, fixture);
    }
    return fixture;
}

/** An isolated persistence registry for tests of owners that do not hydrate the application. */
export function testPersistence(): AppStateService {
    return new AppStateService({ events: new Subject() } as never, {} as never);
}
