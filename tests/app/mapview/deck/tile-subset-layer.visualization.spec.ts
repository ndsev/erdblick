import {DEFAULT_POINT_CLOUD_POLICY} from "../../../../app/mapview/point-cloud-policy.model";
import {GpuAllocationError, gpuMemoryBudget} from "../../../../app/mapview/deck/gpu-memory-budget.model";
import "@angular/compiler";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";

import {SceneMode} from "../../../../app/integrations/geo.adapter";
import {coreLib} from "../../../../app/integrations/wasm.adapter";
import {
    deckSubsetInteractionProps,
    remapGltfPickContributions
} from "../../../../app/mapview/deck/deck-subset-picking.util";
import {TileSubsetLayerVisualization} from
    "../../../../app/mapview/deck/tile-subset-layer.visualization";

describe("TileSubsetLayerVisualization", () => {
    it.each(["physical", "reusable"])("retries after %s capacity returns without retaining an unreachable byte threshold", async (capacity) => {
        const finishRender = vi.fn();
        const scene = {prepareRender: vi.fn(() => ({
            origin: {slot: 0, key: 0n}, contributions: [{key: 0n}],
        })), snapshot: () => ({stores: []}), finishRender, removeContributions: vi.fn()};
        const sceneHandle = {scene: {gpuScene: scene}};
        const renderService = {
            pointCloudPolicy: {...DEFAULT_POINT_CLOUD_POLICY},
            render: vi.fn(async () => {
                // Returning this job's own temporary allocation must not wake it again.
                const releaseStaging = gpuMemoryBudget.allocate(128);
                releaseStaging();
                gpuMemoryBudget.beginRetirement()();
                throw new GpuAllocationError(5000);
            }),
            reportAllocationFailure: vi.fn()
        };
        const visualization = Object.assign(Object.create(TileSubsetLayerVisualization.prototype), {
            visualizationId: "cloud", disposed: false, sceneRevision: 0, sceneHandle,
            renderedSignature: "", requestedSignature: "", failedSignature: "",
            failedGpuCapacity: null, contributionIdentities: new Set(["cloud"]), renderService,
            state: {status: "ready", subsetBlob: new Uint8Array(1), valueVersion: 1,
                mapId: "Map", mapTileKey: "cloud", partition: {kind: "object"}},
            owner: {mapInfo: {getRenderDataSourceInfoBlob: () => new Uint8Array(1),
                getFieldDictBlob: () => new Uint8Array(1),
                // The mocked renderer rejects allocation before consuming any schema bytes.
                mapMetadataGeneration: () => 1, getSchemaArtifacts: () => []},
                style: {id: "cloud"}, highlightMode: {value: 0}},
            setPointCloudScale: vi.fn(), contributionIdentity: () => "cloud"
        });
        gpuMemoryBudget.setLimit(1024);
        const releaseOtherOwner = gpuMemoryBudget.allocate(256);
        try {
            expect(await visualization.render(sceneHandle)).toBe(false);
            for (let i = 0; i < 10; ++i) expect(await visualization.render(sceneHandle)).toBe(false);
            expect(renderService.render).toHaveBeenCalledOnce();
            expect(visualization.waitingForGpuMemory).toBe(true);
            expect(visualization.canRetryGpuAllocation()).toBe(false);
            expect(finishRender).toHaveBeenCalledOnce();
            if (capacity === "physical") releaseOtherOwner();
            else gpuMemoryBudget.beginRetirement()(true);
            expect(visualization.canRetryGpuAllocation()).toBe(true);
            expect(await visualization.render(sceneHandle)).toBe(false);
            expect(renderService.render).toHaveBeenCalledTimes(2);
            for (let i = 0; i < 10; ++i) await visualization.render(sceneHandle);
            expect(renderService.render).toHaveBeenCalledTimes(2);
            renderService.pointCloudPolicy.gpuMemoryMiB += 1;
            expect(await visualization.render(sceneHandle)).toBe(false);
            expect(renderService.render).toHaveBeenCalledTimes(3);
            visualization.disposed = true;
            expect(visualization.waitingForGpuMemory).toBe(false);
            expect(visualization.canRetryGpuAllocation()).toBe(false);
        } finally {
            releaseOtherOwner();
            gpuMemoryBudget.setLimit(DEFAULT_POINT_CLOUD_POLICY.gpuMemoryMiB * 1048576);
        }
    });

    it("retires ordinary geometry too when the shared allowance is reduced", () => {
        const scene = {removeContributions: vi.fn()};
        const cancel = vi.fn();
        const visualization = Object.assign(Object.create(TileSubsetLayerVisualization.prototype), {
            visualizationId: "roads", renderedSignature: "installed", requestedSignature: "running",
            sceneRevision: 0, contributionIdentities: new Set(["roads"]),
            sceneHandle: {scene: {gpuScene: scene}}, renderService: {cancel},
            owner: {filterPlan: {channels: [{}]}},
            state: {status: "ready", renderedValueVersion: 1, valueVersion: 1}
        });
        visualization.setPointCloudScale(null, true);
        expect(cancel).toHaveBeenCalledExactlyOnceWith("roads");
        expect(scene.removeContributions).toHaveBeenCalledExactlyOnceWith(["roads"]);
        expect(visualization.isCurrentPresentationInstalled()).toBe(false);
        expect(visualization.requestedSignature).toBe("");
    });

    it("resolves cloud picks from entry identities without parsing another subset", () => {
        const reference = {channelOrdinal: 2, entryOrdinal: 3, endpointRole: 0};
        const firstPicks = [{...reference, featureId: "PointCloudObject.1"}];
        const secondPicks = [{...reference, featureId: "PointCloudObject.2"}];
        const visualization = Object.assign(Object.create(TileSubsetLayerVisualization.prototype), {
            gpuPickSubset: vi.fn(() => { throw new Error("Unexpected main-thread parse"); })
        });
        expect(visualization.resolveGpuPick(reference, firstPicks)).toBe("PointCloudObject.1");
        expect(visualization.resolveGpuPick(reference, secondPicks)).toBe("PointCloudObject.2");
        expect(visualization.resolveGpuPick(reference, firstPicks)).toBe("PointCloudObject.1");
        expect(visualization.findGpuPickReferences("PointCloudObject.1", firstPicks)).toEqual([
            {...reference, featureId: "PointCloudObject.1"}
        ]);
        expect(visualization.findGpuPickReferences("PointCloudObject.1", secondPicks)).toEqual([]);
        expect(visualization.resolveGpuPick({...reference, entryOrdinal: 4}, firstPicks)).toBeUndefined();
        expect(visualization.resolveGpuPick(reference, [])).toBeUndefined();
        expect(visualization.gpuPickSubset).not.toHaveBeenCalled();
    });

    it("restores either endpoint of a merged relation in a mixed cloud style", () => {
        const visualization = Object.create(TileSubsetLayerVisualization.prototype);
        const picks = [0, 1, 2].map(endpointRole => ({
            channelOrdinal: 1, entryOrdinal: 2, endpointRole,
            featureId: endpointRole === 2 ? "Road.2" : "Road.1",
            relationSourceFeatureId: "Road.1", relationIndex: 3,
            relationId: "source:Road.1#3<->source:Road.2#7"
        }));
        expect(visualization.findGpuPickReferences("Road.1:relation#3", picks)).toEqual(picks);
        expect(visualization.findGpuPickReferences("Road.2:relation#7", picks)).toEqual(picks);
        expect(visualization.findGpuPickReferences("Road.2:relation#3", picks)).toEqual([]);
        expect(visualization.findGpuPickReferences("Road.1", picks)).toEqual([]);
        expect(visualization.findGpuPickReferences("Road.1", [{
            channelOrdinal: 2, entryOrdinal: 0, endpointRole: 0,
            featureId: "Road.1", attributeIndex: 1
        }])).toEqual([]);
    });

    it("invalidates changed line detail without destroying the installed GLTF presentation", () => {
        const gltfPresentation = {destroy: vi.fn()};
        const visualization = Object.assign(Object.create(TileSubsetLayerVisualization.prototype), {
            lineSimplificationToleranceMeters: 1,
            renderedSignature: "installed",
            requestedSignature: "in-flight",
            state: {status: "ready", renderedValueVersion: 1, valueVersion: 1},
            gltfPresentation
        });

        visualization.setLineSimplificationTolerance(1);
        expect(visualization.isCurrentPresentationInstalled()).toBe(true);
        expect(visualization.requestedSignature).toBe("in-flight");

        visualization.setLineSimplificationTolerance(2);
        expect(visualization.isCurrentPresentationInstalled()).toBe(false);
        expect(visualization.requestedSignature).toBe("");
        expect(visualization.lineSimplificationToleranceMeters).toBe(2);
        expect(gltfPresentation.destroy).not.toHaveBeenCalled();
    });

    it("makes only ordinary map layers eligible for drill picking", () => {
        expect(deckSubsetInteractionProps(
            "regular",
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            SceneMode.SCENE3D
        )).toEqual({
            pickable: "3d",
            drillPickEligible: true
        });
        expect(deckSubsetInteractionProps(
            "search",
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            SceneMode.SCENE3D
        )).toEqual({
            pickable: "3d",
            drillPickEligible: false
        });
        expect(deckSubsetInteractionProps(
            "selection",
            coreLib.HighlightMode.SELECTION_HIGHLIGHT.value,
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            SceneMode.SCENE3D
        )).toEqual({
            pickable: false,
            drillPickEligible: false
        });
    });

    it("keeps shared GLTF proxy addresses bound to their owning subset", () => {
        const firstResolver = vi.fn(() => [{
            mapTileKey: "map/tile-a",
            featureId: "a"
        }]);
        const secondResolver = vi.fn(() => [{
            mapTileKey: "map/tile-b",
            featureId: "b"
        }]);
        const remapped = remapGltfPickContributions([
            {
                sourceId: "first",
                data: [{
                    nodeIndex: 1,
                    featureAddress: 7,
                    positions: new Float32Array(9)
                }],
                pickResolver: firstResolver
            },
            {
                sourceId: "second",
                data: [{
                    nodeIndex: 2,
                    featureAddress: 7,
                    positions: new Float32Array(9)
                }],
                pickResolver: secondResolver
            }
        ]);

        expect(remapped.contributions.map(
            contribution => contribution.data[0].featureAddress
        )).toEqual([0, 1]);
        expect(remapped.pickResolver(0)[0].featureId).toBe("a");
        expect(remapped.pickResolver(1)[0].featureId).toBe("b");
        expect(firstResolver).toHaveBeenCalledWith(7);
        expect(secondResolver).toHaveBeenCalledWith(7);
    });

    it("retains the semantic mask while an atomic successor owns the contribution", () => {
        const maskController = {removeOwner: vi.fn()};
        const gpuScene = {removeContributions: vi.fn()};
        const sceneHandle = {
            scene: {gpuMaskController: maskController, gpuScene}
        } as any;
        const visualization = Object.assign(
            Object.create(TileSubsetLayerVisualization.prototype),
            {
                disposed: false,
                state: {mapTileKey: "Features:Map:Road:7:0"},
                owner: {
                    ownerId: "regular-owner",
                    releaseTileState: vi.fn()
                },
                viewIndex: 2,
                visualizationId: "render-specific-owner",
                renderService: {cancel: vi.fn(), unregisterPointCloud: vi.fn()},
                gltfPresentation: {destroy: vi.fn()},
                interactionGltf: null,
                contributionIdentities: new Set<string>(),
                interactionOverlays: [],
                gltfPickResults: [],
                pickSubset: null,
                pickSubsetValueVersion: -1,
                pendingIconUris: new Set<string>(),
                failedIconUris: new Set<string>(),
                sceneHandle
            }
        ) as TileSubsetLayerVisualization;

        const identity = visualization.destroy(sceneHandle, true);

        expect(identity).toBe(
            "regular-owner\u0000view-2\u0000Features:Map:Road:7:0"
        );
        expect(maskController.removeOwner).not.toHaveBeenCalled();
        expect(gpuScene.removeContributions).not.toHaveBeenCalled();

        TileSubsetLayerVisualization.retireContribution(sceneHandle, identity!);
        expect(maskController.removeOwner).toHaveBeenCalledWith(
            `interaction-mask\u0000${identity}`
        );
        expect(gpuScene.removeContributions).toHaveBeenCalledWith([identity]);
    });
});
