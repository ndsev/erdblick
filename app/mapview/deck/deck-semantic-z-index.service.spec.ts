import {afterEach, describe, expect, it, vi} from "vitest";
import {Layer, _LayersPass as LayersPass, _PickLayersPass as PickLayersPass} from "@deck.gl/core";
import {
    Framebuffer,
    Texture,
    type Device,
    type FramebufferProps,
    type TextureProps,
    type TextureView
} from "@luma.gl/core";
import {Model} from "@luma.gl/engine";
import {WebGLDevice} from "@luma.gl/webgl";
import {Stats} from "@probe.gl/stats";

import {
    DeckSemanticZIndexService,
    SEMANTIC_COMPOSITE_DEPTH_BIAS,
    isSemanticZIndexPassLayer,
    isSemanticZIndexPickingLayer
} from "./deck-semantic-z-index.service";
import {
    ErdblickVectorRenderMode,
    VECTOR_POLYGON_OFFSET_DEPTH_UNITS
} from "./erdblick-vector.layer";

/** Exercise luma's real attachment ownership without allocating WebGL handles. */
class TestFramebuffer extends Framebuffer {
    readonly handle = null;
    colorAttachments: TextureView[] = [];
    depthStencilAttachment: TextureView | null = null;

    /** Let luma create and own automatic attachments just as on the GPU. */
    constructor(readonly device: Device, props: FramebufferProps) {
        super(device, props);
        this.autoCreateAttachmentTextures();
    }

    /** The ownership tests do not need native framebuffer bindings. */
    protected override updateAttachments(): void {}
}

/** Set up the real effect and layers with tracked textures and a no-op raster pass. */
function createRenderHarness() {
    const size: [number, number] = [16, 8];
    const textures: Texture[] = [];
    const framebuffers: TestFramebuffer[] = [];
    const layers = new Map<string, Layer>();
    const stats = new Stats({id: "semantic-test"});
    const createTexture = vi.fn((props: TextureProps): Texture => {
        const texture: Texture = Object.assign(Object.create(Texture.prototype), {
            props,
            width: props.width,
            height: props.height,
            destroy: vi.fn(),
            clone: (nextSize: {width: number; height: number}) =>
                createTexture({...props, ...nextSize})
        });
        // Destroying a view deliberately does NOT destroy the backing texture.
        texture.view = {texture, destroy: vi.fn()} as never;
        textures.push(texture);
        return texture;
    });
    const device = {
        type: "webgl",
        userData: {},
        statsManager: {getStats: () => stats},
        canvasContext: {getDrawingBufferSize: () => size},
        createTexture,
        createFramebuffer: vi.fn((props: FramebufferProps) => {
            const framebuffer = new TestFramebuffer(device as never, props);
            framebuffers.push(framebuffer);
            return framebuffer;
        })
    };
    const service = new DeckSemanticZIndexService({
        upsert: (id: string, layer: Layer) => layers.set(id, layer),
        remove: (id: string) => layers.delete(id)
    } as never);
    service.setup({device} as never);
    service.bindScene({} as never, false);
    const render = vi.spyOn(LayersPass.prototype, "render").mockImplementation(() => {});
    const preRender = () => service.preRender({
        isPicking: false,
        viewports: [],
        layers: [],
        pass: "screen"
    } as never);
    return {service, size, textures, framebuffers, layers, device, render, preRender};
}

describe("DeckSemanticZIndexService", () => {
    afterEach(() => vi.restoreAllMocks());

    it("retains the established fixed-depth clearance above support surfaces", () => {
        expect(SEMANTIC_COMPOSITE_DEPTH_BIAS * 0x00ff_ffff)
            .toBe(VECTOR_POLYGON_OFFSET_DEPTH_UNITS);
    });

    it("registers a pick-only compositor backed by the semantic overlay source", () => {
        const registry = {
            upsert: vi.fn(),
            remove: vi.fn()
        };
        const service = new DeckSemanticZIndexService(registry as never);
        const sharedDisabledPickIndices = new Set<number>();
        const scene = {
            navigationAltitude: vi.fn(() => 123)
        };

        service.bindScene(
            scene as never,
            false,
            sharedDisabledPickIndices
        );

        const registrations = registry.upsert.mock.calls as Array<
            [string, any, number]
        >;
        const overlayLayer = registrations.find(([, layer]) =>
            layer.props.renderMode === ErdblickVectorRenderMode.SemanticOverlay
        )?.[1];
        const pickingRegistration = registrations.find(([id]) =>
            isSemanticZIndexPickingLayer(id)
        );
        const pickingLayer = pickingRegistration?.[1];

        expect(service.useInPicking).toBe(true);
        expect(overlayLayer).toBeDefined();
        expect(pickingLayer).toBeDefined();
        expect(pickingLayer.props).toMatchObject({
            pickable: true,
            drillPickEligible: true,
            navigationAnchorEligible: true,
            markerAnchorEligible: true
        });
        expect(pickingLayer.props.navigationAltitudeResolver(7)).toBe(123);
        expect(scene.navigationAltitude).toHaveBeenCalledWith(7);

        const info = pickingLayer.getPickingInfo({
            info: {index: 19},
            mode: "query"
        });
        expect(info.object).toEqual({globalPickIndex: 19});
        expect(info.sourceLayer).toBe(overlayLayer);

        pickingLayer.disablePickingIndex(19);
        expect(sharedDisabledPickIndices).toEqual(new Set([19]));
        pickingLayer.restorePickingColors();
        expect(sharedDisabledPickIndices.size).toBe(0);
    });

    it("keeps hidden pass layers distinct from the public picking compositor", () => {
        expect(isSemanticZIndexPassLayer(
            "builtin/semantic-z-index-pass/support"
        )).toBe(true);
        expect(isSemanticZIndexPassLayer(
            "builtin/semantic-z-index-picking"
        )).toBe(false);
        expect(isSemanticZIndexPickingLayer(
            "builtin/semantic-z-index-picking"
        )).toBe(true);
        expect(isSemanticZIndexPickingLayer(
            "builtin/semantic-z-index-composite"
        )).toBe(false);
    });

    it("preserves pass-specific state through Deck's WebGL draw setup", () => {
        const {service, layers} = createRenderHarness();
        const device: WebGLDevice = Object.assign(Object.create(WebGLDevice.prototype), {
            setParametersWebGL: vi.fn(),
            withParametersWebGL: (_parameters: unknown, draw: () => void) => draw()
        });

        for (const [id, layer] of layers) {
            const composite = id === "builtin/semantic-z-index-composite";
            const model: Model = Object.assign(Object.create(Model.prototype), {
                device,
                parameters: {},
                _setPipelineNeedsUpdate: vi.fn()
            });
            Object.assign(layer, {context: {device}, internalState: {attributeManager: null}});
            vi.spyOn(layer, "getModels").mockReturnValue([model]);
            const draw = vi.spyOn(layer, "draw").mockImplementation(() => {
                expect(model.parameters).toMatchObject({
                    depthCompare: "less-equal",
                    depthWriteEnabled: !composite,
                    blend: composite,
                    cullMode: "none"
                });
                if (composite) {
                    expect(model.parameters).toMatchObject({
                        blendColorOperation: "add",
                        blendColorSrcFactor: "src-alpha",
                        blendColorDstFactor: "one-minus-src-alpha",
                        blendAlphaOperation: "add",
                        blendAlphaSrcFactor: "one",
                        blendAlphaDstFactor: "one-minus-src-alpha"
                    });
                }
            });

            // Exercise the real Deck -> Model.setParameters path, not just props.
            layer._drawLayer({
                renderPass: {} as never,
                shaderModuleProps: null,
                uniforms: {},
                parameters: layer.props.parameters
            });
            expect(draw).toHaveBeenCalledOnce();
        }
        service.cleanup();
    });

    it("reuses equal-sized targets and releases backing textures on resize and cleanup", () => {
        const {service, size, textures, framebuffers, device, render, preRender} = createRenderHarness();
        expect(service.compositeInput()).toBeNull();
        preRender();
        expect(device.createFramebuffer).toHaveBeenCalledTimes(2);
        expect(textures).toHaveLength(4);
        expect(framebuffers.every(target => target.width === 16 && target.height === 8)).toBe(true);
        const firstInput = service.compositeInput();

        preRender();
        expect(service.compositeInput()).toEqual(firstInput);
        expect(device.createFramebuffer).toHaveBeenCalledTimes(2);

        for (const [width, height] of [[32, 8], [32, 16], [16, 8]]) {
            const previousTextures = [...textures];
            const previousTargets = [...framebuffers];
            size[0] = width;
            size[1] = height;
            preRender();
            for (const texture of previousTextures) {
                expect(texture.destroy).toHaveBeenCalledOnce();
            }
            expect(previousTargets.every(target => target.destroyed)).toBe(true);
            const [support, overlay] = framebuffers.slice(-2);
            expect(service.compositeInput()).toEqual({
                overlayColor: overlay.colorAttachments[0].texture,
                supportDepth: support.depthStencilAttachment?.texture
            });
            expect(render.mock.calls.at(-2)?.[0].target).toBe(support);
            expect(render.mock.calls.at(-1)?.[0].target).toBe(overlay);
            expect(textures.filter(texture => vi.mocked(texture.destroy).mock.calls.length === 0))
                .toHaveLength(4);
        }

        service.cleanup();
        service.cleanup();
        expect(service.compositeInput()).toBeNull();
        expect(framebuffers.every(target => target.destroyed)).toBe(true);
        for (const texture of textures) {
            expect(texture.destroy).toHaveBeenCalledOnce();
        }
    });

    it("allows Deck picking to encode its layer id without alpha-blending object ids", () => {
        const {service, layers, device} = createRenderHarness();
        const layer = layers.get("builtin/semantic-z-index-picking")!;
        const pass = new PickLayersPass(device as never);
        pass["_resetColorEncoder"](false);
        const parameters = pass["getLayerParameters"](layer, 0, {} as never);
        expect(parameters).toMatchObject({
            depthCompare: "less-equal",
            depthWriteEnabled: true,
            blend: true,
            blendColorSrcFactor: "one",
            blendColorDstFactor: "zero",
            blendAlphaSrcFactor: "constant",
            blendAlphaDstFactor: "zero",
            blendColor: [0, 0, 0, 1 / 255]
        });
        pass["_resetColorEncoder"](true);
        expect(pass["getLayerParameters"](layer, 0, {} as never).blend).toBe(false);
        service.cleanup();
    });

    it("releases the explicit color texture if framebuffer creation fails", () => {
        const {service, device, textures, preRender} = createRenderHarness();
        device.createFramebuffer.mockImplementationOnce(() => {
            throw new Error("Framebuffer allocation failed");
        });
        expect(preRender).toThrow("Framebuffer allocation failed");
        expect(textures).toHaveLength(1);
        expect(textures[0].destroy).toHaveBeenCalledOnce();
        expect(service.compositeInput()).toBeNull();
        service.cleanup();
    });

    it("writes feature identities only when the effect feeds a Deck picking pass", () => {
        const service = new DeckSemanticZIndexService({} as never);
        const render = vi.fn();
        const supportGroup = {};
        const supportDepth = {};
        const overlayColor = {};
        const setSemanticSupportTexture = vi.fn();
        const internal = service as any;
        internal.context = {
            device: {
                canvasContext: {
                    getDrawingBufferSize: () => [16, 8]
                }
            }
        };
        internal.pass = {render};
        internal.supportFramebuffer = {
            width: 16,
            height: 8,
            colorAttachments: [{texture: supportGroup}],
            depthStencilAttachment: {texture: supportDepth}
        };
        internal.overlayFramebuffer = {
            width: 16,
            height: 8,
            colorAttachments: [{texture: overlayColor}],
            depthStencilAttachment: {texture: {}}
        };
        internal.supportLayer = {};
        internal.overlayLayer = {setSemanticSupportTexture};

        service.preRender({
            isPicking: true,
            viewports: [],
            layers: [],
            pass: "picking:query"
        } as never);

        expect(setSemanticSupportTexture).toHaveBeenCalledWith(supportGroup);
        expect(render).toHaveBeenCalledTimes(2);
        expect(render.mock.calls[0][0]).toMatchObject({
            pass: "semantic-z-index-support",
            shaderModuleProps: {
                picking: {isActive: false, isAttribute: false}
            }
        });
        expect(render.mock.calls[1][0]).toMatchObject({
            pass: "semantic-z-index-picking",
            shaderModuleProps: {
                picking: {isActive: true, isAttribute: false}
            }
        });

        render.mockClear();
        service.preRender({
            isPicking: false,
            viewports: [],
            layers: [],
            pass: "screen"
        } as never);
        expect(render.mock.calls[1][0]).toMatchObject({
            pass: "semantic-z-index-overlay",
            shaderModuleProps: {
                picking: {isActive: false, isAttribute: false}
            }
        });
    });
});
