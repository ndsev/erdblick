import { Injector } from "@angular/core";
import { AppActionRegistry } from "./action/action-registry.service";
import { AppActionContributor } from "./action/action-contributor.model";
import { UiAutomationService } from "./action/ui-automation.service";
import { CoordinatesService } from "./coordinates/coordinates.service";
import { DiagnosticsFacadeService } from "./diagnostics/diagnostics-facade.service";
import { InspectionPanelService } from "./inspection/inspection-panel.service";
import { InspectionSelectionService } from "./inspection/inspection-selection.service";
import { MapDataService } from "./mapdata/mapdata.service";
import { MapViewService } from "./mapview/mapview.service";
import { ExternalViewerService } from "./navigation/external-viewer.service";
import { JumpTargetService } from "./navigation/jump.service";
import { LocationNavigationService } from "./navigation/location-navigation.service";
import { OmnibarState } from "./omnibar/omnibar.state";
import { SearchService } from "./search/search.service";
import { AppStateService } from "./appstate/appstate.service";
import { AppUrlStateService } from "./appstate/appstate-url.service";
import { MapStyleService } from "./mapstyle/mapstyle.service";

/**
 * Eagerly constructs the contributors once, then closes both registrations.
 *
 * Angular's providedIn: "root" makes services available, but constructs them only
 * when requested. Waiting for a panel to inject its controller would omit that
 * controller's state during hydration and its actions from the initial catalog.
 * This explicit composition root makes that dependency visible in one place.
 *
 * Browser startup and the Node catalog application call this same function.
 * Constructors declare state and bind handlers; they must not load config/WASM,
 * open sockets or start workers. The asynchronous initializer in app.module.ts
 * performs that work later, after all state keys and actions are registered.
 *
 * An Angular multi-provider token could collect these services too, but still
 * requires an explicit provider list and an eager initializer. It would not remove
 * the startup ordering requirement. Keep this small list instead of introducing
 * another discovery mechanism or another production catalog.
 */
export function registerApplication(injector: Injector): AppActionRegistry {
    // The palette owns persistence but contributes no domain actions itself.
    injector.get(OmnibarState);
    const controllers: AppActionContributor[] = [
        injector.get(UiAutomationService),
        injector.get(CoordinatesService),
        injector.get(DiagnosticsFacadeService),
        injector.get(InspectionSelectionService),
        injector.get(InspectionPanelService),
        injector.get(MapDataService),
        injector.get(MapViewService),
        injector.get(ExternalViewerService),
        injector.get(JumpTargetService),
        injector.get(LocationNavigationService),
        injector.get(SearchService),
        injector.get(AppUrlStateService),
        injector.get(MapStyleService),
    ];
    const registry = injector.get(AppActionRegistry);
    injector.get(AppStateService).sealRegistration();
    registry.registerContributors(controllers);
    return registry;
}
