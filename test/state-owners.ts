import { DiagnosticsStore } from "../app/diagnostics/diagnostics.store";
import { LocationSearchStore } from "../app/search/location-search.store";
import { FeatureSearchStore } from "../app/search/feature-search.store";
import { StyleStore } from "../app/styledata/style.store";
import { CoordinatesPolicyStore } from "../app/coords/coordinates-policy.store";
import { CoordinatesStore } from "../app/coords/coordinates.store";
import { ConnectionPreferencesStore } from "../app/mapdata/connection-preferences.store";
import { RenderPreferencesStore } from "../app/mapview/render-preferences.store";
import { InspectionStore } from "../app/inspection/inspection.store";
import { AppLayoutStore } from "../app/layout/app-layout.store";
import { AppConfigStore } from "../app/config/app-config.store";
import { Subject } from "rxjs";
import { AppStateService } from "../app/state/app-state.service";
import { AppLayoutService } from '../app/layout/app-layout.service';
import { AppConfigService } from '../app/config/app-config.service';
import { AppUrlStateService } from '../app/state/app-url-state.service';
import { MapViewStore } from '../app/mapview/map-view.store';
import { MapLayerStore } from '../app/mapdata/map-layer.store';
import { InspectionPanelService } from '../app/inspection/inspection-panel.service';
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
    readonly configService = new AppConfigService({} as never, this.persistence, new AppConfigStore(this.persistence));
    readonly layout = new AppLayoutService(this.persistence, new AppLayoutStore(this.persistence));
    readonly viewSettings = new MapViewStore(this.persistence);
    readonly inspectionState = new InspectionPanelService(this.persistence, this.layout, this.messages, new InspectionStore(this.persistence));
    readonly renderPreferences = new RenderPreferencesService(this.persistence, new RenderPreferencesStore(this.persistence));
    readonly connectionPreferences = new ConnectionPreferencesService(this.persistence, new ConnectionPreferencesStore(this.persistence));
    readonly coordinates = new CoordinatesService(this.persistence, this.configService, new CoordinatesStore(this.persistence));
    readonly coordinatePolicy = new CoordinatesPolicyService(this.configService, this.persistence, this.messages, new CoordinatesPolicyStore(this.persistence));
    readonly styleService = new StyleService({} as never, this.persistence, this.messages, this.configService, undefined, new StyleStore(this.persistence));
    readonly layerState = new MapLayerStore(this.persistence, this.viewSettings);
    readonly searchService = new FeatureSearchService({} as never, {} as never, {} as never, {} as never,
        this.persistence, this.layout, this.inspectionState.store, this.viewSettings, new FeatureSearchStore(this.persistence, this.viewSettings));
    readonly locationSearch = new LocationSearchService({} as never, this.configService, this.persistence, new LocationSearchStore(this.persistence));
    readonly diagnostics = new DiagnosticsFacadeService({
        getTileStreamTransportCompressionStats: () => ({}), getBackendRequestProgress: () => ({}),
        getPendingFrameQueueSize: () => 0, getConnectionDiagnostics: () => ({}),
        getDownstreamBytesPerSecond: () => 0, currentViewportRenderSeconds: () => 0,
        isTileStreamConnected: () => false
    } as never, { visualizationQueueLength: () => 0, currentFrameTimeMs: () => 0 } as never,
        { currentSummary: () => ({}) } as never, this.persistence,
        new StyleValidationReportService(), {} as never, this.layout, this.configService.store, {} as never, this.searchService, this.viewSettings, new DiagnosticsStore(this.persistence));
    readonly url = new AppUrlStateService(this.persistence, this.layerState, this.inspectionState.store, this.viewSettings, this.styleService, this.searchService.store);

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
