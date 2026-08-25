import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {ViewLayerController} from "./view-layer.controller";
import {TileSubsetLayerVisualization} from
    "./deck/tile-subset-layer.visualization";
import {coreLib} from "../integrations/wasm";

describe("ViewLayerController", () => {
    it("reconciles hover masks without rebuilding regular presentation demand", async () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        controller.disposed = false;
        controller.reconcileQueued = false;
        controller.fullReconcileRequired = false;
        controller.interactionReconcileRequired = false;
        controller.lastViewportPresentationSignature = "viewport";
        controller.lastInteractionViewportSignature = "previous";
        controller.ngZone = {
            runOutsideAngular: (callback: () => void) => callback()
        };
        controller.styleService = {
            styles: new Map([
                ["visible", {visible: true}],
                ["hidden", {visible: false}]
            ])
        };
        controller.viewportPresentationSignature = vi.fn(() => "viewport");
        controller.interactionViewportSignature = vi.fn(() => "hover");
        controller.reconcile = vi.fn();
        controller.reconcileHighlightLayers = vi.fn();

        controller.scheduleInteractionReconcile();
        await Promise.resolve();

        expect(controller.reconcile).not.toHaveBeenCalled();
        expect(controller.reconcileHighlightLayers).toHaveBeenCalledWith([
            {visible: true}
        ]);
        expect(controller.lastInteractionViewportSignature).toBe("hover");
    });

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

    it("retires regular presentation when the current LOD has no active rules", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const style = {
            id: "style",
            visible: true,
            featureLayerStyle: {hasLayerAffinity: vi.fn(() => true)}
        };
        const mapgetLayer = {
            key: "Map/Road",
            mapId: "Map",
            layerId: "Road"
        };
        const existingLayer = {
            identity: {presentationKind: "regular"},
            dispose: vi.fn()
        };
        const existing = {
            layer: existingLayer,
            subscription: {unsubscribe: vi.fn()},
            visualizations: new Map(),
            visualizationKeyByTileId: new Map(),
            pendingTiles: new Map(),
            disposeLayer: true,
            replacementSlot: "Map/Road/regular/style",
            replacementTileIds: new Set()
        };
        controller.mapInfo = {
            mapgetLayers: () => [mapgetLayer],
            maps: {
                getMapLayerVisibility: () => true
            },
            planStyleFilter: vi.fn(() => ({
                valid: true,
                channels: [],
                issues: []
            }))
        };
        controller.viewState = {
            getEffectiveMapLayerLevel: () => 13,
            visibleTileIdsForLevel: () => [7],
            styleLod: () => 2
        };
        controller.styleService = {styles: new Map([[style.id, style]])};
        controller.hoverDetails = {reconcileView: vi.fn()};
        controller.styledLayers = new Map([["previous-owner", existing]]);
        controller.retiringRegularLayers = new Map();
        controller.pendingVisualizationRenders = new Set();
        controller.localInteractionVisualizationsWithOverlays = new Set();
        controller.featureSearch = {searchStyledLayersForView: () => []};
        controller.interactionReconcileRequired = false;
        controller.lastInteractionViewportSignature = "unchanged";
        controller.interactionViewportSignature = () => "unchanged";
        controller.occupancyChanged = {next: vi.fn()};
        controller.diagnostics = {notifyChanged: vi.fn()};

        controller.reconcile();

        expect(controller.styledLayers.size).toBe(0);
        expect(existing.subscription.unsubscribe).toHaveBeenCalledOnce();
        expect(existingLayer.dispose).toHaveBeenCalledOnce();
        expect(controller.retiringRegularLayers.size).toBe(0);
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
        controller.localInteractionVisualizationsWithOverlays = new Set();
        controller.scheduleInteractionPresenceReconcile = vi.fn();

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
        controller.scheduleInteractionPresenceReconcile = vi.fn();
        const retireContribution = vi.spyOn(
            TileSubsetLayerVisualization,
            "retireContribution"
        ).mockImplementation(() => undefined);
        const owned = {
            layer: {identity: {presentationKind: "regular"}},
            pendingTiles: new Map([[7, {
                state: {},
                lod: 1,
                preservedContributionIdentity: "retained-contribution"
            }]])
        };

        controller.discardPendingTile(owned, 7);

        expect(owned.pendingTiles.size).toBe(0);
        expect(retireContribution).toHaveBeenCalledWith(
            controller.sceneHandle,
            "retained-contribution"
        );
        expect(controller.scheduleInteractionPresenceReconcile)
            .toHaveBeenCalledWith(owned.layer, 7);
    });

    it("keeps inherited contribution ownership across pending state updates", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        controller.presentationLod = vi.fn(() => 2);
        controller.lineSimplificationToleranceMeters = vi.fn(() => 4);
        controller.schedulePendingTiles = vi.fn();
        const previousState = {tileId: 7};
        const nextState = {tileId: 7};
        const owned = {
            layer: {},
            pendingTiles: new Map([[7, {
                state: previousState,
                lod: 1,
                preservedContributionIdentity: "retained-contribution"
            }]])
        };

        controller.enqueueTile(owned, nextState);

        expect(owned.pendingTiles.get(7)).toEqual({
            state: nextState,
            lod: 2,
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

    it("interleaves new tile renders across styled layers", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const first = {id: "first"};
        const second = {id: "second"};
        const third = {id: "third"};
        let availableChecks = 0;
        const remaining = new Map([
            [first, 2],
            [second, 2],
            [third, 2]
        ]);
        controller.sceneHandle = {scene: {}};
        controller.nextStyledLayerDispatchIndex = 0;
        controller.pendingVisualizationRenders = new Set();
        controller.styledLayers = new Map([
            ["first", first],
            ["second", second],
            ["third", third]
        ]);
        controller.renderService = {
            availableWorkerSlots: vi.fn(() => availableChecks++ < 6 ? 1 : 0)
        };
        controller.dispatchOnePendingTile = vi.fn(owned => {
            const count = remaining.get(owned) ?? 0;
            if (!count) {
                return false;
            }
            remaining.set(owned, count - 1);
            return true;
        });

        controller.drainPendingTiles();

        expect(controller.dispatchOnePendingTile.mock.calls.map(
            ([owned]: [typeof first]) => owned.id
        )).toEqual([
            "first", "second", "third",
            "first", "second", "third"
        ]);
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
            owner: {identity: {presentationKind: "regular"}},
            state: {tileId: 7},
            render: vi.fn().mockResolvedValue(true)
        };
        controller.sceneHandle = {scene: {}};
        controller.styledLayers = new Map();
        controller.applyLocalInteractionOverlays = vi.fn();
        controller.scheduleInteractionPresenceReconcile = vi.fn();
        controller.diagnostics = {notifyChanged: vi.fn()};
        controller.releaseRegularFallbackWhenReady = vi.fn();

        controller.startVisualizationRender(visualization);
        await vi.waitFor(() =>
            expect(controller.applyLocalInteractionOverlays)
                .toHaveBeenCalledOnce()
        );

        expect(controller.applyLocalInteractionOverlays)
            .toHaveBeenCalledWith(visualization);
        expect(controller.scheduleInteractionPresenceReconcile)
            .toHaveBeenCalledWith(visualization.owner, 7);
        expect(controller.diagnostics.notifyChanged).toHaveBeenCalledOnce();
    });

    it("reconciles authored fallback demand after local geometry is removed", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const visualization = {destroy: vi.fn()};
        const owned = {
            layer: {identity: {presentationKind: "regular"}},
            pendingTiles: new Map(),
            visualizations: new Map([["tile-7", visualization]]),
            visualizationKeyByTileId: new Map([[7, "tile-7"]])
        };
        controller.sceneHandle = {scene: {}};
        controller.pendingVisualizationRenders = new Set([visualization]);
        controller.localInteractionVisualizationsWithOverlays =
            new Set([visualization]);
        controller.scheduleInteractionPresenceReconcile = vi.fn();

        controller.removeTileVisualization(owned, 7);

        expect(visualization.destroy)
            .toHaveBeenCalledWith(controller.sceneHandle);
        expect(controller.scheduleInteractionPresenceReconcile)
            .toHaveBeenCalledWith(owned.layer, 7);
    });

    it("reconciles presence only for interaction targets in the changed tile", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const layer = {
            identity: {presentationKind: "regular"},
            mapgetLayer: {mapId: "Map", layerId: "Road"}
        };
        controller.inspection = {
            selectionIdsTopic: {getValue: () => [{features: [{
                mapTileKey: "tile-7",
                featureId: "Road.1:relation#2"
            }]}]},
            hoverIdsTopic: {getValue: () => []}
        };
        controller.parseFeatureTileId = vi.fn(target => ({
            mapId: "Map",
            layerId: "Road",
            tileId: target.mapTileKey === "tile-7" ? 7 : 8
        }));
        controller.scheduleInteractionReconcile = vi.fn();

        controller.scheduleInteractionPresenceReconcile(layer, 8);
        expect(controller.scheduleInteractionReconcile).not.toHaveBeenCalled();

        controller.scheduleInteractionPresenceReconcile(layer, 7);
        expect(controller.scheduleInteractionReconcile).toHaveBeenCalledOnce();
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
        controller.localInteractionVisualizationsWithOverlays = new Set();

        controller.applyLocalInteractionOverlays(visualization);

        expect(visualization.setInteractionOverlays).toHaveBeenCalledWith([{
            id: "selection",
            targets: [matching],
            effect: {},
            order: 1
        }]);
    });

    it("resolves local interaction work directly from target tile ids", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const matching = {};
        const unrelated = {};
        controller.parseFeatureTileId = vi.fn(target => ({
            mapId: "Map",
            layerId: "Road",
            tileId: target.featureId === "Road.7" ? 7 : 8
        }));
        controller.styledLayers = new Map([["regular", {
            layer: {
                identity: {presentationKind: "regular"},
                mapgetLayer: {key: "Map/Road"}
            },
            visualizations: new Map([
                ["tile-7", matching],
                ["tile-8", unrelated]
            ]),
            visualizationKeyByTileId: new Map([
                [7, "tile-7"],
                [8, "tile-8"]
            ])
        }]]);
        controller.retiringRegularLayers = new Map();
        const overlays = new Map([["Map/Road", new Map([["hover", {
            id: "hover",
            targets: [{mapTileKey: "tile", featureId: "Road.7"}],
            effect: {},
            order: 1
        }]])]]);

        expect(controller.localInteractionVisualizations(overlays))
            .toEqual(new Set([matching]));
    });

    it("detects an exact relation already present in regular presentation", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const target = {
            mapTileKey: "tile",
            featureId: "Road.7:relation#2"
        };
        const visualization = {
            hasLocalInteractionTarget: vi.fn(() => true)
        };
        controller.parseFeatureTileId = vi.fn(() => ({
            mapId: "Map",
            layerId: "Road",
            tileId: 7
        }));
        controller.styledLayers = new Map([["regular", {
            layer: {
                identity: {presentationKind: "regular"},
                mapgetLayer: {key: "Map/Road"}
            },
            visualizations: new Map([["tile-7", visualization]]),
            visualizationKeyByTileId: new Map([[7, "tile-7"]])
        }]]);
        controller.retiringRegularLayers = new Map();

        expect(controller.hasLocalInteractionTarget({
            key: "Map/Road",
            mapId: "Map",
            layerId: "Road"
        }, target)).toBe(true);
        expect(visualization.hasLocalInteractionTarget)
            .toHaveBeenCalledWith(target);
    });

    it("keeps exact fallback eligible across visibility and level changes", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const mapgetLayer = {
            key: "Islands/Island-6-Local/Lane",
            mapId: "Islands/Island-6-Local",
            layerId: "Lane"
        };
        controller.viewIndex = 0;
        controller.parseFeatureTileId = vi.fn(() => ({
            mapId: mapgetLayer.mapId,
            layerId: mapgetLayer.layerId,
            tileId: 545379780
        }));
        controller.mapInfo = {
            mapgetLayer: vi.fn(() => mapgetLayer),
            maps: {
                getMapLayerVisibility: vi.fn(() => false)
            }
        };
        controller.viewState = {
            getEffectiveMapLayerLevel: vi.fn(() => 12)
        };

        expect(controller.resolveInteractionTargetLayer({
            mapTileKey: "Features:Islands/Island-6-Local:Lane:545379780:0",
            featureId: "Lane.545379780.75"
        })).toEqual({mapgetLayer, tileId: 545379780});
        expect(controller.mapInfo.maps.getMapLayerVisibility)
            .not.toHaveBeenCalled();
        expect(controller.viewState.getEffectiveMapLayerLevel)
            .not.toHaveBeenCalled();
    });

    it("reuses immutable interaction planning across hover targets", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        controller.interactionLayerAffinityCache = new WeakMap();
        controller.interactionFilterPlanCache = new WeakMap();
        controller.interactionEffectCache = new WeakMap();
        const nativeStyle = {
            hasLayerAffinity: vi.fn(() => true),
            supportsHighlightMode: vi.fn(() => true),
            supportsInteractionEffect: vi.fn(() => true),
            interactionEffect: vi.fn(() => ({
                tint: [255, 0, 0, 255],
                tintMix: 1,
                opacity: 1,
                edgeWidth: 2,
                haloRadius: 0,
                haloOpacity: 0,
                stripeSpacing: 0,
                stripeWidth: 0,
                stripeOpacity: 0,
                stripeAngle: 45,
                stripeOffset: 0,
                stripeSoftness: 1
            }))
        };
        const style = {featureLayerStyle: nativeStyle};
        const mapgetLayer = {
            key: "Map/Road",
            mapId: "Map",
            layerId: "Road"
        };
        const plan = {valid: true, channels: [{}]};
        controller.mapInfo = {planStyleFilter: vi.fn(() => plan)};
        const mode = coreLib.HighlightMode.HOVER_HIGHLIGHT;

        expect(controller.hasInteractionLayerAffinity(style, "Road")).toBe(true);
        expect(controller.hasInteractionLayerAffinity(style, "Road")).toBe(true);
        expect(controller.interactionFilterPlan(style, mapgetLayer, mode)).toBe(plan);
        expect(controller.interactionFilterPlan(style, mapgetLayer, mode)).toBe(plan);
        const firstEffect = controller.interactionEffect(
            style,
            mode,
            {},
            "options"
        );
        const secondEffect = controller.interactionEffect(
            style,
            mode,
            {},
            "options"
        );

        expect(firstEffect).toBe(secondEffect);
        expect(nativeStyle.hasLayerAffinity).toHaveBeenCalledOnce();
        expect(nativeStyle.supportsHighlightMode).toHaveBeenCalledOnce();
        expect(controller.mapInfo.planStyleFilter).toHaveBeenCalledOnce();
        expect(nativeStyle.supportsInteractionEffect).toHaveBeenCalledOnce();
        expect(nativeStyle.interactionEffect).toHaveBeenCalledOnce();
    });

    it("invalidates interaction planning after datasource metadata changes", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        const style = {
            featureLayerStyle: {
                supportsHighlightMode: vi.fn(() => true)
            }
        };
        const mapgetLayer = {
            key: "Map/Road",
            mapId: "Map",
            layerId: "Road"
        };
        controller.interactionLayerAffinityCache = new WeakMap();
        controller.interactionFilterPlanCache = new WeakMap();
        controller.interactionEffectCache = new WeakMap();
        controller.mapInfo = {
            planStyleFilter: vi.fn(() => ({valid: true, channels: [{}]}))
        };

        controller.interactionFilterPlan(
            style,
            mapgetLayer,
            coreLib.HighlightMode.HOVER_HIGHLIGHT
        );
        controller.resetInteractionStyleCaches();
        controller.interactionFilterPlan(
            style,
            mapgetLayer,
            coreLib.HighlightMode.HOVER_HIGHLIGHT
        );

        expect(controller.mapInfo.planStyleFilter).toHaveBeenCalledTimes(2);
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
