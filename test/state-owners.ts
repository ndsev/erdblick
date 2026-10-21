import { Subject } from "rxjs";
import { AppStateService } from "../app/shared/appstate.service";
import { AppLayoutService } from '../app/shared/app-layout.service';
import { AppConfigService } from '../app/shared/app-config.service';
import { AppUrlStateService } from '../app/shared/app-url-state.service';
import { MapViewStateService } from '../app/mapview/map-view-state.service';
import { MapLayerStateService } from '../app/mapdata/map-layer-state.service';
import { InspectionStateService } from '../app/inspection/inspection-state.service';
import { RenderPreferencesService } from '../app/mapview/render-preferences.service';
import { ConnectionPreferencesService } from '../app/mapdata/connection-preferences.service';
import { CoordinatesService } from '../app/coords/coordinates.service';
import { CoordinatesPolicyService } from '../app/coords/coordinates-policy.service';
import { StyleService } from '../app/styledata/style.service';
import { FeatureSearchService } from '../app/search/feature.search.service';
import { LocationSearchService } from '../app/search/location.search.service';
import { DiagnosticsFacadeService } from '../app/diagnostics/diagnostics.facade.service';
import { StyleValidationReportService } from '../app/styledata/style-validation-report.service';
import { InfoMessageService } from '../app/shared/info.service';

/**
 * Actual owners, with inert network/rendering dependencies. Persistence tests can
 * exercise all deployed keys without starting search transport or diagnostics timers.
 * Tests address each owner explicitly; there is no production compatibility facade.
 */
export class StateOwners {
    readonly configService = new AppConfigService({} as never, this.persistence);
    readonly layout = new AppLayoutService(this.persistence);
    readonly viewSettings = new MapViewStateService(this.persistence);
    readonly inspectionState = new InspectionStateService(this.persistence, this.layout, this.messages);
    readonly renderPreferences = new RenderPreferencesService(this.persistence);
    readonly connectionPreferences = new ConnectionPreferencesService(this.persistence);
    readonly coordinates = new CoordinatesService(this.persistence, this.configService);
    readonly coordinatePolicy = new CoordinatesPolicyService(this.configService, this.persistence, this.messages);
    readonly styleService = new StyleService({} as never, this.persistence, this.messages, this.configService);
    readonly layerState = new MapLayerStateService(this.persistence, this.viewSettings);
    readonly searchService = new FeatureSearchService({} as never, {} as never, {} as never, {} as never,
        this.persistence, this.layout, this.inspectionState, this.viewSettings);
    readonly locationSearch = new LocationSearchService({} as never, this.configService, this.persistence);
    readonly diagnostics = new DiagnosticsFacadeService({
        getTileStreamTransportCompressionStats: () => ({}), getBackendRequestProgress: () => ({}),
        getPendingFrameQueueSize: () => 0, getConnectionDiagnostics: () => ({}),
        getDownstreamBytesPerSecond: () => 0, currentViewportRenderSeconds: () => 0,
        isTileStreamConnected: () => false
    } as never, { visualizationQueueLength: () => 0, currentFrameTimeMs: () => 0 } as never,
        { currentSummary: () => ({}) } as never, this.persistence,
        new StyleValidationReportService(), {} as never, this.layout, this.configService, {} as never, this.searchService, this.viewSettings);
    readonly url = new AppUrlStateService(this.persistence, this.layerState, this.inspectionState, this.viewSettings, this.styleService, this.searchService);

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
