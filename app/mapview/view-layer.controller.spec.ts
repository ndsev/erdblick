import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {ViewLayerController} from "./view-layer.controller";

describe("ViewLayerController", () => {
    it("does not scan replacement coverage when no fallback exists", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        controller.retiringRegularLayers = new Map();
        controller.regularReplacementIsReady = vi.fn(() => false);

        controller.releaseRegularFallbackWhenReady({
            replacementSlot: "regular-slot"
        });

        expect(controller.regularReplacementIsReady).not.toHaveBeenCalled();
    });

    it("refreshes only non-search presentations for the selected map", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        controller.disposed = false;
        controller.sceneHandle = null;
        controller.changed = {next: vi.fn()};
        controller.occupancyChanged = {next: vi.fn()};
        controller.diagnostics = {notifyChanged: vi.fn()};

        const owned = (
            mapId: string,
            presentationKind: string,
            disposeLayer = true
        ) => {
            const visualization = {destroy: vi.fn()};
            const layer = {
                identity: {mapId, presentationKind},
                tileStates: new Map([[7, {}]]),
                refresh: vi.fn(),
                dispose: vi.fn()
            };
            return {
                layer,
                subscription: {unsubscribe: vi.fn()},
                visualizations: new Map([["visual", visualization]]),
                visualizationKeyByTileId: new Map([[7, "visual"]]),
                pendingBlockTiles: new Map([[7, {}]]),
                disposeLayer,
                replacementSlot: null,
                replacementTileIds: new Set(),
                visualization
            };
        };

        const regular = owned("MapA", "regular");
        const selection = owned("MapA", "selection");
        const search = owned("MapA", "search", false);
        const otherMap = owned("MapB", "regular");
        const fallback = owned("MapA", "regular");
        controller.styledLayers = new Map([
            ["regular", regular],
            ["selection", selection],
            ["search", search],
            ["other", otherMap]
        ]);
        controller.retiringRegularLayers = new Map([
            ["fallback-slot", {key: "fallback", owned: fallback}]
        ]);

        controller.refreshMap("MapA");

        expect(regular.visualization.destroy).toHaveBeenCalledOnce();
        expect(regular.layer.refresh).toHaveBeenCalledOnce();
        expect(selection.layer.refresh).toHaveBeenCalledOnce();
        expect(search.layer.refresh).not.toHaveBeenCalled();
        expect(search.visualization.destroy).not.toHaveBeenCalled();
        expect(otherMap.layer.refresh).not.toHaveBeenCalled();
        expect(fallback.subscription.unsubscribe).toHaveBeenCalledOnce();
        expect(fallback.layer.dispose).toHaveBeenCalledOnce();
        expect(controller.retiringRegularLayers.size).toBe(0);
        expect(controller.changed.next).toHaveBeenCalledOnce();
        expect(controller.occupancyChanged.next).toHaveBeenCalledOnce();
        expect(controller.diagnostics.notifyChanged).toHaveBeenCalledOnce();
    });
});
