import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {ViewLayerController} from "./view-layer.controller";
import {TileSubsetLayerVisualization} from
    "./deck/tile-subset-layer.visualization";

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
        controller.occupancyChanged = {next: vi.fn()};
        controller.diagnostics = {notifyChanged: vi.fn()};
        controller.pendingVisualizationRenders = new Set();

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
                pendingTiles: new Map(),
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
        expect(controller.occupancyChanged.next).toHaveBeenCalledOnce();
        expect(controller.diagnostics.notifyChanged).toHaveBeenCalledOnce();
    });
    it("retires an inherited contribution when its pending successor is dropped", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        controller.sceneHandle = {scene: {}};
        const retireContribution = vi.spyOn(
            TileSubsetLayerVisualization,
            "retireContribution"
        ).mockImplementation(() => undefined);
        const owned = {
            pendingTiles: new Map([[7, {
                state: {},
                fidelity: 1,
                preservedContributionIdentity: "retained-contribution"
            }]])
        };

        controller.discardPendingTile(owned, 7);

        expect(owned.pendingTiles.size).toBe(0);
        expect(retireContribution).toHaveBeenCalledWith(
            controller.sceneHandle,
            "retained-contribution"
        );
    });

    it("keeps inherited contribution ownership across pending state updates", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        controller.presentationFidelity = vi.fn(() => 2);
        controller.lineSimplificationToleranceMeters = vi.fn(() => 4);
        controller.schedulePendingTiles = vi.fn();
        const previousState = {tileId: 7};
        const nextState = {tileId: 7};
        const owned = {
            layer: {},
            pendingTiles: new Map([[7, {
                state: previousState,
                fidelity: 1,
                preservedContributionIdentity: "retained-contribution"
            }]])
        };

        controller.enqueueTile(owned, nextState);

        expect(owned.pendingTiles.get(7)).toEqual({
            state: nextState,
            fidelity: 2,
            lineSimplificationToleranceMeters: 4,
            preservedContributionIdentity: "retained-contribution"
        });
    });

    it("dispatches queued rerenders only while global worker credit is free", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const first = {};
        const second = {};
        controller.sceneHandle = {scene: {}};
        controller.pendingVisualizationRenders = new Set([first, second]);
        controller.styledLayers = new Map();
        controller.renderService = {
            availableWorkerSlots: vi.fn()
                .mockReturnValueOnce(1)
                .mockReturnValueOnce(0)
        };
        controller.startVisualizationRender = vi.fn();

        controller.drainPendingTiles();

        expect(controller.startVisualizationRender).toHaveBeenCalledOnce();
        expect(controller.startVisualizationRender).toHaveBeenCalledWith(first);
        expect(controller.pendingVisualizationRenders).toEqual(new Set([second]));
    });

    it("reattaches scene owners by queueing rather than rendering immediately", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const regular = {reattach: vi.fn()};
        const retiring = {reattach: vi.fn()};
        controller.ngZone = {runOutsideAngular: (callback: () => void) => callback()};
        controller.styledLayers = new Map([["regular", {
            visualizations: new Map([["tile", regular]])
        }]]);
        controller.retiringRegularLayers = new Map([["slot", {owned: {
            visualizations: new Map([["tile", retiring]])
        }}]]);
        controller.queueVisualizationRender = vi.fn();
        controller.schedulePendingTiles = vi.fn();
        const scene = {scene: {}};

        controller.attachScene(scene);

        expect(regular.reattach).toHaveBeenCalledWith(scene);
        expect(retiring.reattach).toHaveBeenCalledWith(scene);
        expect(controller.queueVisualizationRender.mock.calls)
            .toEqual([[regular], [retiring]]);
    });

    it("replays retained interaction masks after a contribution renders", async () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const visualization = {
            owner: {},
            render: vi.fn().mockResolvedValue(true)
        };
        controller.sceneHandle = {scene: {}};
        controller.styledLayers = new Map();
        controller.applyLocalInteractionOverlays = vi.fn();
        controller.diagnostics = {notifyChanged: vi.fn()};
        controller.releaseRegularFallbackWhenReady = vi.fn();

        controller.startVisualizationRender(visualization);
        await vi.waitFor(() =>
            expect(controller.applyLocalInteractionOverlays)
                .toHaveBeenCalledOnce()
        );

        expect(controller.applyLocalInteractionOverlays)
            .toHaveBeenCalledWith(visualization);
        expect(controller.diagnostics.notifyChanged).toHaveBeenCalledOnce();
    });

    it("filters retained interaction targets against one local contribution", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const matching = {mapTileKey: "tile", featureId: "Road.1"};
        const missing = {mapTileKey: "tile", featureId: "Road.2"};
        const visualization = {
            owner: {
                identity: {presentationKind: "regular"},
                mapgetLayer: {key: "Map/Road"}
            },
            hasLocalInteractionTarget: vi.fn(target => target === matching),
            setInteractionOverlays: vi.fn()
        };
        controller.localInteractionOverlaysByLayer = new Map([["Map/Road", [{
            id: "selection",
            targets: [matching, missing],
            effect: {},
            order: 1
        }]]]);

        controller.applyLocalInteractionOverlays(visualization);

        expect(visualization.setInteractionOverlays).toHaveBeenCalledWith([{
            id: "selection",
            targets: [matching],
            effect: {},
            order: 1
        }]);
    });

    it("skips membership scans for identical regular coverage inputs", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const layer = {setCoverage: vi.fn()};
        const tileIds = [1, 2, 3];
        const priorityTileIds = [2, 1, 3];
        controller.regularCoverageByLayer = new WeakMap();

        controller.setRegularCoverage(layer, tileIds, priorityTileIds);
        controller.setRegularCoverage(layer, tileIds, priorityTileIds);

        expect(layer.setCoverage).toHaveBeenCalledOnce();
    });
});
