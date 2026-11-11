import { MapPresetService } from "../../app/mapstyle/map-preset.service";
import { MapDataService } from "../../app/mapdata/mapdata.service";
import { MapDataState } from '../../app/mapdata/mapdata.state';
import { MapViewService } from "../../app/mapview/mapview.service";
import { MapViewState } from '../../app/mapview/mapview.state';
import { OmnibarState } from "../../app/omnibar/omnibar.state";
import { DiagnosticsState } from "../../app/diagnostics/diagnostics.state";
import { GeolocationState } from "../../app/geolocation/geolocation.state";
import { SearchState } from "../../app/search/search.state";
import { MapStyleState } from "../../app/mapstyle/mapstyle.state";
import { CoordinatesState } from "../../app/coordinates/coordinates.state";
import { InspectionState } from "../../app/inspection/inspection.state";
import { LayoutState } from "../../app/layout/layout.state";
import { Subject } from "rxjs";
import { AppStateService } from "../../app/appstate/appstate.service";
import { LayoutService } from '../../app/layout/layout.service';
import { AppConfigService } from '../../app/config/appconfig.service';
import { AppUrlStateService } from '../../app/appstate/appstate-url.service';
import { InspectionPanelService } from '../../app/inspection/inspection-panel.service';
import { CoordinatesService } from '../../app/coordinates/coordinates.service';
import { CoordinatesPolicyService } from '../../app/coordinates/coordinates-policy.service';
import { MapStyleService } from '../../app/mapstyle/mapstyle.service';
import { SearchService } from '../../app/search/search.service';
import { GeolocationService } from '../../app/geolocation/geolocation.service';
import { DiagnosticsFacadeService } from '../../app/diagnostics/diagnostics-facade.service';
import { StyleValidationReportService } from '../../app/mapstyle/style-validation-report.service';
import { InfoMessageService } from '../../app/diagnostics/info.service';

/**
 * Actual owners, with inert network/rendering dependencies. Persistence tests can
 * exercise all deployed keys without starting search transport or diagnostics timers.
 * Tests address each owner explicitly; there is no production compatibility facade.
 */
export class StateOwners {
    readonly omnibar = new OmnibarState(this.persistence);
    readonly configService = new AppConfigService({} as never);
    readonly layout = new LayoutService(this.persistence, new LayoutState(this.persistence));
    readonly viewSettings = new MapViewState(this.persistence);
    readonly inspectionState = new InspectionPanelService(this.persistence, this.layout, this.messages, new InspectionState(this.persistence));
    readonly coordinates = new CoordinatesService(this.persistence, this.configService, new CoordinatesState(this.persistence));
    readonly coordinatePolicy = new CoordinatesPolicyService(this.configService, this.persistence, this.messages, this.coordinates.state);
    readonly styleService = new MapStyleService({} as never, this.persistence, this.messages, this.configService, undefined, new MapStyleState(this.persistence));
    readonly layerState = new MapDataState(this.persistence, this.viewSettings);
    readonly presets = new MapPresetService(this.configService, {} as never, this.styleService);
    readonly data = new MapDataService({} as never, this.persistence, this.styleService, this.presets,
        this.messages, this.layerState, this.viewSettings, this.inspectionState);
    readonly views = new MapViewService(this.persistence, this.data, this.viewSettings, this.configService);
    readonly searchService = new SearchService({} as never, {} as never, {} as never, {} as never,
        this.persistence, this.layout, this.inspectionState.state, this.viewSettings, new SearchState(this.persistence, this.viewSettings));
    readonly locationSearch = new GeolocationService({} as never, this.configService, this.persistence, new GeolocationState(this.persistence));
    readonly diagnostics = new DiagnosticsFacadeService({
        getTileStreamTransportCompressionStats: () => ({}), getBackendRequestProgress: () => ({}),
        getPendingFrameQueueSize: () => 0, getConnectionDiagnostics: () => ({}),
        getDownstreamBytesPerSecond: () => 0, currentViewportRenderSeconds: () => 0,
        isTileStreamConnected: () => false
    } as never, { visualizationQueueLength: () => 0, currentFrameTimeMs: () => 0 } as never,
        { currentSummary: () => ({}) } as never, this.persistence,
        new StyleValidationReportService(), {} as never, this.layout, {} as never, this.searchService, this.viewSettings, new DiagnosticsState(this.persistence));
    readonly url = new AppUrlStateService(this.persistence, this.layerState, this.inspectionState.state, this.viewSettings, this.styleService, this.searchService.state);

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
