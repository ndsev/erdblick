import {describe, expect, it, vi} from "vitest";

import {
    createErdblickVectorLayers,
    ErdblickVectorLayer
} from "./erdblick-vector.layer";
import {
    DUAL_COMPACT_PATH_FRAGMENT_SHADER,
    DUAL_SIMPLE_PATH_FRAGMENT_SHADER,
    gpuSceneShaderModule,
    gpuSceneMaskFragmentShader
} from "./erdblick-vector.shaders";
import {GpuMaterialFlag, GpuPrimitiveKind} from "./gpu-render-packet";

/** Builds the low-cardinality model entry shape retained by the custom layer. */
function material(
    kind: GpuPrimitiveKind,
    key: bigint,
    draws: string[],
    styleOrder = 0,
    renderOrder = 0
) {
    return {
        model: {
            shaderInputs: {setProps: vi.fn()},
            draw: vi.fn(() => {
                draws.push(`${kind}:${styleOrder}:${renderOrder}`);
                return true;
            })
        },
        source: {
            kind,
            flags: GpuMaterialFlag.DepthTest,
            styleOrder,
            renderOrder,
            store: {
                materialKey: key,
                highWaterRecord: 1
            }
        },
        bufferRevision: 0,
        shaderPropsRevision: -1
    };
}

describe("ErdblickVectorLayer model order", () => {
    it("keeps scene lookup samplers high precision through helper calls", () => {
        const source = gpuSceneShaderModule.vs as string;

        expect(source).toContain(
            "uniform highp sampler2D gpuSceneOriginTexture;"
        );
        expect(source).toContain(
            "uniform highp sampler2D gpuSceneContributionTexture;"
        );
        expect(source).toContain(
            "uniform highp sampler2D gpuSceneZIndexTexture;"
        );
        expect(source).toContain(
            "vec4 gpuScene_lookup(highp sampler2D lookupTexture, uint texelIndex)"
        );
    });

    it("scales LNGLAT meter offsets without relying on shared geometry state", () => {
        const source = gpuSceneShaderModule.vs as string;

        expect(source).toContain(
            "project.projectionMode == PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET"
        );
        expect(source).toContain(
            "originScale /= project_size_at_latitude(project.coordinateOrigin.y);"
        );
        expect(source).toContain(
            "project.commonUnitsPerMeter * originScale"
        );
        expect(source).not.toContain(
            "project_size(gpuScene_localPosition(localPosition))"
        );
    });

    it("does not require Deck picking uniforms in dual-stroke mask passes", () => {
        for (const shader of [
            DUAL_COMPACT_PATH_FRAGMENT_SHADER,
            DUAL_SIMPLE_PATH_FRAGMENT_SHADER
        ]) {
            const maskShader = gpuSceneMaskFragmentShader(shader);
            expect(maskShader).toMatch(
                /#ifdef ERDBLICK_MASK_RENDER\s+bool innerOnly = true;\s+/
            );
            expect(maskShader).toMatch(
                /#else\s+bool innerOnly = picking\.isActive > 0\.5;\s+/
            );
        }
    });

    it("keeps vector hits eligible for camera and marker anchoring", () => {
        const layers = createErdblickVectorLayers(
            "vector",
            {} as never,
            false
        );

        expect(layers).toHaveLength(2);
        for (const layer of layers) {
            expect(layer.props.navigationAnchorEligible).toBe(true);
            expect(layer.props.markerAnchorEligible).toBe(true);
            expect(layer.props.drillPickEligible).toBe(true);
        }
    });

    it("draws semantic primitive passes independently of packet arrival order", () => {
        const draws: string[] = [];
        const scene = {
            revision: 0,
            originTexture: {},
            contributionTexture: {},
            zIndexTexture: {},
            lookupTextureWidth: 1024
        };
        const layer = new ErdblickVectorLayer({
            id: "vector",
            data: [],
            scene,
            flattenZ: false
        } as never);
        const internal = layer as any;
        internal.initialized = true;
        internal.sceneRevision = 0;
        for (const [kind, key] of [
            [GpuPrimitiveKind.Icon, 5n],
            [GpuPrimitiveKind.Point, 3n],
            [GpuPrimitiveKind.SurfaceTriangle, 4n],
            [GpuPrimitiveKind.Arrow, 2n],
            [GpuPrimitiveKind.PathSegment, 1n]
        ] as const) {
            internal.materialModels.set(key, material(kind, key, draws));
        }

        layer.draw({renderPass: {}});

        expect(draws).toEqual([
            GpuPrimitiveKind.SurfaceTriangle,
            GpuPrimitiveKind.PathSegment,
            GpuPrimitiveKind.Point,
            GpuPrimitiveKind.Arrow,
            GpuPrimitiveKind.Icon
        ].map(kind => `${kind}:0:0`));
    });

    it("keeps semantic passes ahead of authored stylesheet order", () => {
        const draws: string[] = [];
        const scene = {
            revision: 0,
            originTexture: {},
            contributionTexture: {},
            zIndexTexture: {},
            lookupTextureWidth: 1024
        };
        const layer = new ErdblickVectorLayer({
            id: "vector",
            data: [],
            scene,
            flattenZ: false
        } as never);
        const internal = layer as any;
        internal.initialized = true;
        internal.sceneRevision = 0;
        internal.materialModels.set(
            1n,
            material(GpuPrimitiveKind.PathSegment, 1n, draws, 9)
        );
        internal.materialModels.set(
            2n,
            material(GpuPrimitiveKind.SurfaceTriangle, 2n, draws, 60)
        );

        layer.draw({renderPass: {}});

        expect(draws).toEqual([
            `${GpuPrimitiveKind.SurfaceTriangle}:60:0`,
            `${GpuPrimitiveKind.PathSegment}:9:0`
        ]);
        const surfaceBias = internal.materialModels.get(2n).model
            .shaderInputs.setProps.mock.calls[0][0].gpuScene.primitiveDepthBias;
        const pathBias = internal.materialModels.get(1n).model
            .shaderInputs.setProps.mock.calls[0][0].gpuScene.primitiveDepthBias;
        expect(pathBias).toBeGreaterThan(surfaceBias);
    });

    it("does not rebind unchanged scene shader inputs on every draw", () => {
        const scene = {
            revision: 0,
            originTexture: {},
            contributionTexture: {},
            zIndexTexture: {},
            lookupTextureWidth: 1024
        };
        const layer = new ErdblickVectorLayer({
            id: "vector",
            data: [],
            scene,
            flattenZ: false
        } as never);
        const model = material(GpuPrimitiveKind.PathSegment, 1n, []);
        const internal = layer as any;
        internal.initialized = true;
        internal.sceneRevision = 0;
        internal.materialModels.set(1n, model);

        layer.draw({renderPass: {}});
        layer.draw({renderPass: {}});

        expect(model.model.shaderInputs.setProps).toHaveBeenCalledTimes(1);
    });

    it("preserves concrete rule order before opaque material hashes", () => {
        const draws: string[] = [];
        const scene = {
            revision: 0,
            originTexture: {},
            contributionTexture: {},
            zIndexTexture: {},
            lookupTextureWidth: 1024
        };
        const layer = new ErdblickVectorLayer({
            id: "vector",
            data: [],
            scene,
            flattenZ: false
        } as never);
        const internal = layer as any;
        internal.initialized = true;
        internal.sceneRevision = 0;
        internal.materialModels.set(
            99n,
            material(GpuPrimitiveKind.PathSegment, 99n, draws, 1, 8)
        );
        internal.materialModels.set(
            1n,
            material(GpuPrimitiveKind.PathSegment, 1n, draws, 1, 2)
        );

        layer.draw({renderPass: {}});

        expect(draws).toEqual([
            `${GpuPrimitiveKind.PathSegment}:1:2`,
            `${GpuPrimitiveKind.PathSegment}:1:8`
        ]);
    });

    it("rebinds grown buffers and recreates models for replaced stores", () => {
        const firstBuffer = {id: "first"};
        const grownBuffer = {id: "grown"};
        const replacementBuffer = {id: "replacement"};
        const firstStore = {
            materialKey: 7n,
            presentedBuffer: firstBuffer,
            presentedBufferRevision: 1,
            presentedHighWaterRecord: 3
        };
        const replacementStore = {
            materialKey: 7n,
            presentedBuffer: replacementBuffer,
            presentedBufferRevision: 1,
            presentedHighWaterRecord: 2
        };
        const source = (store: typeof firstStore) => ({
            kind: GpuPrimitiveKind.Point,
            flags: GpuMaterialFlag.DepthTest,
            styleOrder: 0,
            renderOrder: 0,
            glowColor: [0, 0, 0, 0],
            glowRadius: 0,
            atlasPage: 0,
            store
        });
        const scene = {
            presentationRevision: 1,
            materialStores: vi.fn(() => [source(firstStore)])
        };
        const layer = new ErdblickVectorLayer({
            id: "vector",
            data: [],
            scene,
            flattenZ: false
        } as never);
        const models = [0, 1].map(() => ({
            setAttributes: vi.fn(),
            setInstanceCount: vi.fn(),
            destroy: vi.fn()
        }));
        const internal = layer as any;
        internal.initialized = true;
        internal.createModel = vi
            .fn()
            .mockReturnValueOnce(models[0])
            .mockReturnValueOnce(models[1]);

        internal.syncModels();
        expect(models[0].setAttributes)
            .toHaveBeenLastCalledWith({instances: firstBuffer});

        firstStore.presentedBuffer = grownBuffer;
        firstStore.presentedBufferRevision = 2;
        scene.presentationRevision += 1;
        internal.syncModels();
        expect(models[0].setAttributes)
            .toHaveBeenLastCalledWith({instances: grownBuffer});
        expect(models[0].destroy).not.toHaveBeenCalled();

        scene.materialStores.mockReturnValue([
            source(replacementStore as typeof firstStore)
        ]);
        scene.presentationRevision += 1;
        internal.syncModels();
        expect(models[0].destroy).toHaveBeenCalledOnce();
        expect(models[1].setAttributes)
            .toHaveBeenLastCalledWith({instances: replacementBuffer});
    });

    it("suppresses one drill-picked identity across every material model", () => {
        const scene = {
            revision: 0,
            originTexture: {},
            contributionTexture: {},
            zIndexTexture: {},
            lookupTextureWidth: 1024
        };
        const [surfaceLayer, vectorLayer] = createErdblickVectorLayers(
            "vector",
            scene as never,
            false
        );
        const surfaceModel = material(
            GpuPrimitiveKind.SurfaceTriangle,
            1n,
            []
        );
        const pathModel = material(GpuPrimitiveKind.PathSegment, 2n, []);
        for (const [layer, model] of [
            [surfaceLayer, surfaceModel],
            [vectorLayer, pathModel]
        ] as const) {
            const internal = layer as any;
            internal.initialized = true;
            internal.sceneRevision = 0;
            internal.materialModels.set(model.source.store.materialKey, model);
        }

        surfaceLayer.disablePickingIndex(23);
        vectorLayer.draw({renderPass: {}});
        surfaceLayer.draw({renderPass: {}});

        expect(pathModel.model.shaderInputs.setProps).toHaveBeenCalledWith({
            gpuScene: expect.objectContaining({disabledPickIndices: [23]})
        });
        expect(surfaceModel.model.shaderInputs.setProps).toHaveBeenCalledWith({
            gpuScene: expect.objectContaining({disabledPickIndices: [23]})
        });

        vectorLayer.restorePickingColors();
        surfaceLayer.draw({renderPass: {}});
        expect(surfaceModel.model.shaderInputs.setProps).toHaveBeenLastCalledWith({
            gpuScene: expect.objectContaining({disabledPickIndices: []})
        });
    });

    it("ignores invalid drill indices and bounds shader suppression state", () => {
        const scene = {
            revision: 0,
            originTexture: {},
            contributionTexture: {},
            zIndexTexture: {},
            lookupTextureWidth: 1024
        };
        const layer = new ErdblickVectorLayer({
            id: "vector",
            data: [],
            scene,
            flattenZ: false
        } as never);
        const model = material(GpuPrimitiveKind.Point, 1n, []);
        const internal = layer as any;
        internal.initialized = true;
        internal.sceneRevision = 0;
        internal.materialModels.set(1n, model);

        layer.disablePickingIndex(-1);
        layer.disablePickingIndex(1.5);
        for (let index = 0; index < 80; ++index) {
            layer.disablePickingIndex(index);
        }
        layer.draw({renderPass: {}});

        const props = model.model.shaderInputs.setProps.mock.calls.at(-1)![0]
            .gpuScene;
        expect(props.disabledPickIndices).toHaveLength(64);
        expect(props.disabledPickIndices).toEqual(
            Array.from({length: 64}, (_, index) => index)
        );
    });
});
