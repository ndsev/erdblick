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

    it("requests first-person entry only for the exact prepared feature target", () => {
        const {service} = createRightClickMenuService();
        const target = {
            position: [8.5, 49.1, 125] as [number, number, number],
            featureIds: [{featureId: "road-1", mapTileKey: "map/layer/1"}]
        };
        const requests: unknown[] = [];
        const subscription = service.firstPersonViewRequests.subscribe(request => requests.push(request));

        try {
            expect(service.menuItems.getValue().some(item => item.label === "Show First Person View")).toBe(false);

            service.setFirstPersonViewContext({viewIndex: 2, active: false, target});
            const enterItem = service.menuItems.getValue().find(item => item.label === "Show First Person View");
            enterItem?.command?.({} as never);

            expect(requests).toEqual([{viewIndex: 2, action: "enter", target}]);
        } finally {
            subscription.unsubscribe();
        }
    });

    it("offers first-person exit without requiring a picked position", () => {
        const {service} = createRightClickMenuService();
        const requests: unknown[] = [];
        const subscription = service.firstPersonViewRequests.subscribe(request => requests.push(request));

        try {
            service.setFirstPersonViewContext({viewIndex: 1, active: true});
            const exitItem = service.menuItems.getValue().find(item => item.label === "Exit First Person View");
            exitItem?.command?.({} as never);

            expect(requests).toEqual([{viewIndex: 1, action: "exit"}]);
        } finally {
            subscription.unsubscribe();
        }
    });
});
