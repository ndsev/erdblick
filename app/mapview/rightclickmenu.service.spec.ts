import {describe, expect, it, vi} from "vitest";

import type {DiagnosticsFacadeService} from "../diagnostics/diagnostics.facade.service";
import type {FeatureSearchService} from "../search/feature.search.service";
import type {AppStateService} from "../shared/appstate.service";
import type {InfoMessageService} from "../shared/info.service";
import {RightClickMenuService} from "./rightclickmenu.service";

/** Creates the right-click service with the dependencies not used by ownership tests stubbed out. */
function createRightClickMenuService(): RightClickMenuService {
    return new RightClickMenuService(
        {} as AppStateService,
        {} as FeatureSearchService,
        {showInfo: vi.fn()} as unknown as InfoMessageService,
        {openPerformanceDialog: vi.fn()} as unknown as DiagnosticsFacadeService);
}

describe("RightClickMenuService", () => {
    it("broadcasts map context-menu close requests", () => {
        const service = createRightClickMenuService();
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
});
