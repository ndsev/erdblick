import {DEFAULT_POINT_CLOUD_POLICY} from "../../../../app/mapview/point-cloud-policy.model";
import "@angular/compiler";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";

import {SceneMode} from "../../../../app/integrations/geo.adapter";
import type {GpuSceneContributionInput} from "../../../../app/mapview/deck/gpu-scene.visualization";
import {coreLib} from "../../../../app/integrations/wasm.adapter";
import {
    deckSubsetInteractionProps,
    remapGltfPickContributions
} from "../../../../app/mapview/deck/deck-subset-picking.util";
import {TileSubsetLayerVisualization} from
    "../../../../app/mapview/deck/tile-subset-layer.visualization";

/** Real render/disposal methods with device and worker boundaries controlled by the test. */
function renderFixture() {
    const finishRender = vi.fn();
    const scene = {prepareRender: vi.fn(() => ({
        origin: {slot: 0, key: 0n}, contributions: [{key: 0n}],
    })), snapshot: () => ({stores: []}), finishRender, removeContributions: vi.fn(),
        accepts: () => true, applyPacket: vi.fn()};
    const sceneHandle = {scene: {gpuScene: scene, gpuMaskController: {removeOwner: vi.fn()}}};
    const renderService = {
        pointCloudPolicy: {...DEFAULT_POINT_CLOUD_POLICY},
        cancel: vi.fn(), unregisterPointCloud: vi.fn(),
        render: vi.fn(async (_request: unknown, _accept: (packet: unknown) => void): Promise<unknown> => {
            throw new Error("Device allocation failed");
        })
    };
    const visualization = Object.assign(Object.create(TileSubsetLayerVisualization.prototype), {
        visualizationId: "cloud", disposed: false, sceneRevision: 0, sceneHandle,
        renderedSignature: "", requestedSignature: "", failedSignature: "",
        contributionIdentities: new Set(["cloud"]), renderService,
        gltfPresentation: {destroy: vi.fn()}, pickSubset: {delete: vi.fn()},
        pendingIconUris: new Set(), failedIconUris: new Set(),
        state: {status: "ready", subsetBlob: new Uint8Array(1), valueVersion: 1,
            mapId: "Map", mapTileKey: "cloud", partition: {kind: "object"}, dependencies: []},
        owner: {
            releaseTileState: vi.fn(),
            mapInfo: {
                getRenderDataSourceInfoBlob: () => new Uint8Array(1),
                getFieldDictBlob: () => new Uint8Array(1),
                // The controlled worker never consumes schema bytes.
                mapMetadataGeneration: () => 1,
                getSchemaArtifacts: () => []
            },
            style: {id: "cloud"}, highlightMode: {value: 0}
        },
        setPointCloudScale: vi.fn(), contributionIdentity: () => "cloud"
    });
    return {visualization, renderService, scene, sceneHandle, finishRender};
}

describe("TileSubsetLayerVisualization", () => {
    it("reports a device failure once per immutable render and releases its reservation", async () => {
        const {visualization, renderService, scene, sceneHandle, finishRender} = renderFixture();
        await expect(visualization.render(sceneHandle)).rejects.toThrow("Device allocation failed");
        for (let i = 0; i < 10; ++i) expect(await visualization.render(sceneHandle)).toBe(false);
        expect(renderService.render).toHaveBeenCalledOnce();
        expect(finishRender).toHaveBeenCalledOnce();
        expect(scene.removeContributions).not.toHaveBeenCalled();
        expect(visualization.requestedSignature).toBe("");

        visualization.state.valueVersion += 1;
        await expect(visualization.render(sceneHandle)).rejects.toThrow("Device allocation failed");
        expect(renderService.render).toHaveBeenCalledTimes(2);
        expect(finishRender).toHaveBeenCalledTimes(2);
    });

    it("rejects a late worker packet after datasource retirement and releases lazy picking state", async () => {
        const {visualization, renderService, scene, sceneHandle, finishRender} = renderFixture();
        let release!: () => void;
        let acceptPacket!: (packet: unknown) => void;
        renderService.render.mockImplementation((_request: any, accept: any) => {
            acceptPacket = accept;
            return new Promise<void>(resolve => {release = resolve;}).then(() => {
                // The worker may finish after cancellation. Admission must
                // still reject its bytes before touching the live GPU scene.
                acceptPacket({});
                return undefined;
            });
        });
        const deletedPickModel = visualization.pickSubset.delete;
        const pending = visualization.render(sceneHandle);
        expect(renderService.render).toHaveBeenCalledOnce();
        visualization.destroy(sceneHandle);
        expect(renderService.cancel).toHaveBeenCalledWith("cloud");
        expect(deletedPickModel).toHaveBeenCalledOnce();
        release();
        expect(await pending).toBe(false);
        expect(scene.applyPacket).not.toHaveBeenCalled();
        expect(finishRender).toHaveBeenCalledOnce();
    });

    it.each([
        {sources: ["cloud"], scope: "feature", channelEntries: 2200, reusable: true},
        {sources: ["cloud"], scope: "feature", channelEntries: 2199, reusable: false},
        {sources: ["cloud"], scope: "relation", channelEntries: 2200, reusable: false},
        {sources: ["cloud", "other"], scope: "feature", channelEntries: 2200, reusable: false},
        {sources: ["other"], scope: "feature", channelEntries: 2200, reusable: false}
    ])("reuses a pointer row only for a single local feature channel: %o", async test => {
        const {visualization, scene, sceneHandle, renderService} = renderFixture();
        const reference = {channelOrdinal: 1, entryOrdinal: 5, endpointRole: 0};
        const peer = {...reference, channelOrdinal: 2};
        const find = vi.fn(() => [reference, peer]);
        const schema = vi.fn(() => ({scope: test.scope, entryCount: test.channelEntries}));
        visualization.state.dependencies = test.sources.map(sourceTileKey => ({sourceTileKey}));
        const subset = {
            resolvePick: (_channel: number, entry: number) => ({featureId: `Road.${entry}`}),
            numEntries: () => 2200, channelSchema: schema, findPickReferences: find
        };
        visualization.withGpuPickSubset = (_: unknown, read: (value: typeof subset) => unknown) => read(subset);
        const contributions: GpuSceneContributionInput[] = [];
        const prepare = scene.prepareRender.getMockImplementation()!;
        scene.prepareRender.mockImplementation((...args: unknown[]) => {
            contributions.push(...args[2] as GpuSceneContributionInput[]);
            return prepare();
        });
        scene.applyPacket.mockReturnValue({});
        visualization.applyResult = vi.fn(async () => []);
        visualization.installRenderStats = vi.fn();
        visualization.recordRuntimeStyleIssues = vi.fn();
        renderService.render.mockImplementationOnce(async (_request, accept) => { accept({}); return {}; });
        expect(await visualization.render(sceneHandle)).toBe(true);
        const picks = contributions[0];
        // Restored selections without a pointer still do a complete native lookup.
        expect(picks.findPickReferences!("Road.5")).toEqual([reference, peer]);
        for (const entryOrdinal of [5, 6]) {
            const row = {...reference, entryOrdinal};
            const id = `Road.${entryOrdinal}`;
            expect(picks.resolvePick!(row)).toBe(id);
            expect(picks.findPickReferences!(id)).toEqual(test.reusable ? [row] : [reference, peer]);
        }
        expect(find).toHaveBeenCalledTimes(test.reusable ? 1 : 3);
        expect(schema.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it.each([false, true])("picks the visible packet until retirement (preserve contribution: %s)", async preserve => {
        const {visualization, renderService, scene, sceneHandle} = renderFixture();
        const contributions: GpuSceneContributionInput[] = [];
        const prepare = scene.prepareRender.getMockImplementation()!;
        scene.prepareRender.mockImplementation((...args: unknown[]) => {
            const entries = args[2] as readonly GpuSceneContributionInput[];
            contributions.push(entries[0]);
            return prepare();
        });
        scene.applyPacket.mockReturnValue({});
        visualization.applyResult = vi.fn(async () => []);
        visualization.installRenderStats = vi.fn();
        visualization.recordRuntimeStyleIssues = vi.fn();
        const catalog = vi.fn(() => 1);
        visualization.owner.mapInfo.mapMetadataGeneration = catalog;
        const reference = {channelOrdinal: 0, entryOrdinal: 0, endpointRole: 0};
        const releaseSubset = vi.fn();
        const findPickReferences = vi.fn(() => []);
        const readTileSubsetLayer = vi.fn((buffer: {getPointer(): number}) => {
            // A single byte identifies each simulated native subset. Both use
            // row zero, but that row names a different original source vertex.
            const pointIndex = coreLib.HEAPU8[Number(buffer.getPointer())];
            const sourceRevision = `r${pointIndex}`;
            return {
                delete: releaseSubset,
                findPickReferences,
                resolvePick: () => ({
                    scope: "shapepoint",
                    featureId: "Road.7",
                    geometryOrdinal: 1,
                    pointIndex,
                    sourceId: "survey",
                    sourceRevision
                }),
                findShapePointPickReferences: (
                    id: string, geometry: number, vertex: number, source: string, revision: string
                ) => {
                    const matches = id === "Road.7" && geometry === 1 && vertex === pointIndex &&
                        source === "survey" && revision === sourceRevision;
                    return matches ? [reference] : [];
                }
            };
        });
        visualization.owner.mapInfo.tileLayerParser = {readTileSubsetLayer};
        renderService.render.mockImplementationOnce(async (_request, accept) => {
            accept({});
            return {};
        });
        visualization.state.subsetBlob = Uint8Array.of(1);
        expect(await visualization.render(sceneHandle)).toBe(true);

        // Deliver the next subset before the user has ever picked the first one.
        let finishPacket!: () => void;
        renderService.render.mockImplementationOnce((_request, accept) => new Promise(resolve => {
            finishPacket = () => {
                accept({});
                resolve({});
            };
        }));
        visualization.state.subsetBlob = Uint8Array.of(2);
        visualization.state.valueVersion++;
        const next = visualization.render(sceneHandle);
        const firstTarget = "Road.7:shapepoint#1.1@survey@r1";
        const secondTarget = "Road.7:shapepoint#1.2@survey@r2";
        expect(contributions[0].resolvePick!(reference)).toBe(firstTarget);
        expect(contributions[0].findPickReferences!(firstTarget)).toEqual([reference]);
        expect(contributions[0].findPickReferences!(secondTarget)).toEqual([]);
        expect(contributions[0].findPickReferences!("Road.7")).toEqual([]);
        expect(findPickReferences).toHaveBeenCalledWith("Road.7", "feature", -1n, -1n);
        expect(readTileSubsetLayer).toHaveBeenCalledTimes(1);

        finishPacket();
        expect(await next).toBe(true);
        expect(contributions[1].resolvePick!(reference)).toBe(secondTarget);
        expect(contributions[1].findPickReferences!(firstTarget)).toEqual([]);
        expect(readTileSubsetLayer).toHaveBeenCalledTimes(2);
        // A replacement datasource can reuse the dictionary namespace. Old
        // packet bytes must never be decoded against that new catalog.
        catalog.mockReturnValue(2);
        expect(contributions[1].resolvePick!(reference)).toBeUndefined();
        expect(contributions[1].findPickReferences!(secondTarget)).toEqual([]);
        expect(readTileSubsetLayer).toHaveBeenCalledTimes(2);
        visualization.destroy(sceneHandle, preserve);
        catalog.mockReturnValue(1);
        // A requeued style temporarily keeps the previous packet visible.
        // Its former owner releases every transient model used by those picks.
        expect(contributions[1].resolvePick!(reference)).toBe(preserve ? secondTarget : undefined);
        expect(contributions[1].findPickReferences!(secondTarget)).toEqual(preserve ? [reference] : []);
        expect(readTileSubsetLayer).toHaveBeenCalledTimes(preserve ? 4 : 2);
        expect(releaseSubset).toHaveBeenCalledTimes(readTileSubsetLayer.mock.calls.length);
    });

    it("resolves cloud picks from entry identities without parsing another subset", () => {
        const reference = {channelOrdinal: 2, entryOrdinal: 3, endpointRole: 0};
        const firstPicks = [{...reference, featureId: "PointCloudObject.1"}];
        const secondPicks = [{...reference, featureId: "PointCloudObject.2"}];
        const visualization = Object.assign(Object.create(TileSubsetLayerVisualization.prototype), {
            withGpuPickSubset: vi.fn(() => { throw new Error("Unexpected main-thread parse"); })
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
        const vertex = {...reference, scope: "shapepoint", featureId: "Road.7",
            geometryOrdinal: 0, pointIndex: 1, sourceId: "survey", sourceRevision: "r1"};
        const target = "Road.7:shapepoint#0.1@survey@r1";
        expect(visualization.resolveGpuPick(reference, [vertex])).toBe(target);
        expect(visualization.findGpuPickReferences(target, [vertex])).toEqual([vertex]);
        expect(visualization.findGpuPickReferences("Road.7:shapepoint#0.1@survey@r2", [vertex])).toEqual([]);
        expect(visualization.withGpuPickSubset).not.toHaveBeenCalled();
    });

    it("retains foreign endpoint parts and prefers an available local relation row", () => {
        const visualization = Object.create(TileSubsetLayerVisualization.prototype);
        const reference = {mapId: "Target", typeId: "Road", id: {id: 9223372036854775807n}};
        expect(visualization.featureIdsForPickResult({featureReference: reference})).toEqual({featureReference: reference});
        expect(visualization.featureIdsForPickResult({featureReference: reference,
            relationSourceFeatureId: "Source.1", relationIndex: 2})).toBe("Source.1:relation#2");
        expect(visualization.featureIdsForPickResult({memberFeatureIds: ["Source.1"],
            memberFeatureReferences: [reference]})).toEqual(["Source.1", {featureReference: reference}]);
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
