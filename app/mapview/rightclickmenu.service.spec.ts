import {describe, expect, it, vi} from "vitest";

import type {DiagnosticsFacadeService} from "../diagnostics/diagnostics.facade.service";
import type {FeatureSearchService} from "../search/feature.search.service";
import type {AppStateService} from "../shared/appstate.service";
import type {InfoMessageService} from "../shared/info.service";
import type {ExternalViewerService} from "../search/external-viewer.service";
import {RightClickMenuService} from "./rightclickmenu.service";

/** Creates the right-click service with the dependencies not used by ownership tests stubbed out. */
function createRightClickMenuService() {
    const externalViewerService = {
        providers: [
            {id: "one", name: "Viewer One", buildUrl: vi.fn()},
            {id: "two", name: "Viewer Two", buildUrl: vi.fn()}
        ],
        open: vi.fn()
    };
    const service = new RightClickMenuService(
        {} as AppStateService,
        {} as FeatureSearchService,
        {showInfo: vi.fn()} as unknown as InfoMessageService,
        {openPerformanceDialog: vi.fn()} as unknown as DiagnosticsFacadeService,
        externalViewerService as unknown as ExternalViewerService);
    return {service, externalViewerService};
}

describe("RightClickMenuService", () => {
    it("broadcasts map context-menu close requests", () => {
        const {service} = createRightClickMenuService();
        let closeRequests = 0;
        const subscription = service.closeContextMenus.subscribe(() => {
            closeRequests++;
        });

        try {
            service.closeAllContextMenus();
            service.closeAllContextMenus();

            expect(closeRequests).toBe(2);
        } finally {
            subscription.unsubscribe();
        }
    });

    it("offers every provider only when an exact right-click location is available", () => {
        const {service, externalViewerService} = createRightClickMenuService();

        expect(service.menuItems.getValue().some(item => item.label === "Open in…")).toBe(false);

        service.setExternalViewerLocation({lon: 8.5, lat: 49.1});
        const openInItem = service.menuItems.getValue().find(item => item.label === "Open in…");

        expect(openInItem?.items?.map(item => item.label)).toEqual(["Viewer One", "Viewer Two"]);
        openInItem?.items?.[1].command?.({} as never);
        expect(externalViewerService.open).toHaveBeenCalledWith(
            externalViewerService.providers[1],
            {lon: 8.5, lat: 49.1}
        );

        service.setExternalViewerLocation(null);
        expect(service.menuItems.getValue().some(item => item.label === "Open in…")).toBe(false);
    });
});
