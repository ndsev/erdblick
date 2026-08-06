import {describe, expect, it, vi} from "vitest";

import type {DiagnosticsFacadeService} from "../diagnostics/diagnostics.facade.service";
import type {FeatureSearchService} from "../search/feature.search.service";
import type {AppStateService} from "../shared/appstate.service";
import type {InfoMessageService} from "../shared/info.service";
import type {ExternalViewerService} from "../search/external-viewer.service";
import type {InspectionSelectionService} from "../inspection/inspection-selection.service";
import {coreLib} from "../integrations/wasm";
import {RightClickMenuService} from "./rightclickmenu.service";

/** Creates the right-click service with the dependencies not used by ownership tests stubbed out. */
function createRightClickMenuService() {
    const externalViewerService = {
        providers: [
            {id: "one", name: "Viewer One", urlTemplate: "https://one.test/{lat}/{lon}"},
            {id: "two", name: "Viewer Two", urlTemplate: "https://two.test/{lat}/{lon}"}
        ],
        open: vi.fn()
    };
    const inspectionSelection = {
        inspectFeatureIds: vi.fn()
    };
    const service = new RightClickMenuService(
        {} as AppStateService,
        {} as FeatureSearchService,
        {showInfo: vi.fn()} as unknown as InfoMessageService,
        {openPerformanceDialog: vi.fn()} as unknown as DiagnosticsFacadeService,
        externalViewerService as unknown as ExternalViewerService,
        inspectionSelection as unknown as InspectionSelectionService);
    return {service, externalViewerService, inspectionSelection};
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

    it("shows flat feature-id rows grouped by map, layer, and feature identity", () => {
        const {service, inspectionSelection} = createRightClickMenuService();
        const firstTile = coreLib.getTileIdFromPosition(11, 48, 13);
        const secondTile = coreLib.getTileIdFromPosition(12, 48, 13);
        const topmost = {
            mapTileKey: coreLib.getTileFeatureLayerKey("NDS.Live/Islands/map-a", "layer-a", firstTile),
            featureId: "same"
        };
        const repeatedTile = {
            mapTileKey: coreLib.getTileFeatureLayerKey("NDS.Live/Islands/map-a", "layer-a", secondTile),
            featureId: "same"
        };
        const otherMap = {
            mapTileKey: coreLib.getTileFeatureLayerKey("map-b", "layer-a", firstTile),
            featureId: "same"
        };
        const otherFeature = {
            mapTileKey: coreLib.getTileFeatureLayerKey("NDS.Live/Islands/map-a", "layer-a", firstTile),
            featureId: "other"
        };

        service.setPickedFeatures([topmost, repeatedTile, otherMap, otherFeature]);

        const items = service.menuItems.getValue();
        expect(items.slice(0, 4).map(item => item.label)).toEqual([
            "Select all", "same", "same", "other"
        ]);
        expect(items.slice(1, 4).map(item => item["mapIdLabel"])).toEqual(["map-a", "map-b", "map-a"]);
        expect(items.slice(1, 4).map(item => item.icon)).toEqual([undefined, undefined, undefined]);
        expect(new Set(items.slice(1, 4).map(item => item.id)).size).toBe(3);
        expect(items[4].separator).toBe(true);
        items[0].command?.({} as never);
        items[1].command?.({} as never);

        expect(inspectionSelection.inspectFeatureIds).toHaveBeenNthCalledWith(
            1,
            [topmost, otherMap, otherFeature]
        );
        expect(inspectionSelection.inspectFeatureIds).toHaveBeenNthCalledWith(2, [topmost]);

        service.setPickedFeatures([]);
        expect(service.menuItems.getValue()[0].label).toBe("Inspect Source Data for Tile");
    });
});
