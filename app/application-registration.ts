import { Injector } from "@angular/core";
import { ActionRegistry } from "./actions/action-registry.service";
import { AppActionContributor } from "./actions/app-action-contributor";
import { UiAutomationService } from "./actions/ui-automation.service";
import { AppConfigService } from "./config/app-config.service";
import { CoordinatesService } from "./coordinates/coordinates.service";
import { DiagnosticsFacadeService } from "./diagnostics/diagnostics.facade.service";
import { InspectionPanelService } from "./inspection/inspection-panel.service";
import { InspectionSelectionService } from "./inspection/inspection-selection.service";
import { ConnectionPreferencesService } from "./connection/connection-preferences.service";
import { MapInfoService } from "./mapdata/map-info.service";
import { MapViewService } from "./mapview/map-view.service";
import { RenderPreferencesService } from "./rendering/render-preferences.service";
import { ExternalViewerService } from "./navigation/external-viewer.service";
import { JumpTargetService } from "./navigation/jump.service";
import { LocationNavigationService } from "./navigation/location-navigation.service";
import { OmnibarModel } from "./omnibar/omnibar.model";
import { FeatureSearchService } from "./feature-search/feature.search.service";
import { AppStateService } from "./state/app-state.service";
import { AppUrlStateService } from "./state/app-url-state.service";
import { StyleService } from "./map-styles/style.service";

/**
 * The application's one composition point for state and action contributors.
 * Constructing controllers also constructs their models; hydration and runtime
 * initialization happen later in app.module.ts. The catalog build uses this
 * exact function without starting the map, loading config or opening sockets.
 */
export function registerApplication(injector: Injector): ActionRegistry {
    // The palette owns persistence but contributes no domain actions itself.
    injector.get(OmnibarModel);
    const controllers: AppActionContributor[] = [
        injector.get(UiAutomationService),
        injector.get(AppConfigService),
        injector.get(CoordinatesService),
        injector.get(DiagnosticsFacadeService),
        injector.get(InspectionSelectionService),
        injector.get(InspectionPanelService),
        injector.get(ConnectionPreferencesService),
        injector.get(MapInfoService),
        injector.get(MapViewService),
        injector.get(RenderPreferencesService),
        injector.get(ExternalViewerService),
        injector.get(JumpTargetService),
        injector.get(LocationNavigationService),
        injector.get(FeatureSearchService),
        injector.get(AppUrlStateService),
        injector.get(StyleService),
    ];
    const registry = injector.get(ActionRegistry);
    injector.get(AppStateService).sealRegistration();
    registry.registerContributors(controllers);
    return registry;
}
