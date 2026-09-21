import {
    Layer,
    picking,
    type Effect,
    type EffectContext,
    type LayerProps,
    type PickingInfo,
    type PreRenderOptions,
    _LayersPass as LayersPass
} from "@deck.gl/core";
import {Texture, type Framebuffer, type RenderPipelineParameters} from "@luma.gl/core";
import {ClipSpace} from "@luma.gl/engine";

import {DeckLayerRegistry} from "./deck-layer-registry";
import {
    ErdblickVectorLayer,
    ErdblickVectorRenderMode,
    NO_POLYGON_OFFSET,
    VECTOR_POLYGON_OFFSET_DEPTH_UNITS
} from "./erdblick-vector.layer";
import type {GpuScene} from "./gpu-scene";

const PASS_LAYER_PREFIX = "builtin/semantic-z-index-pass/";
const COMPOSITE_LAYER_ID = "builtin/semantic-z-index-composite";
const PICKING_LAYER_ID = "builtin/semantic-z-index-picking";
const SUPPORT_LAYER_ID = `${PASS_LAYER_PREFIX}support`;
const OVERLAY_LAYER_ID = `${PASS_LAYER_PREFIX}overlay`;
const MAX_DISABLED_PICK_INDICES = 64;
// Deck replaces model parameters with layer parameters before each WebGL draw.
// Resolve one unblended winner, retaining straight alpha for the final composite.
const SEMANTIC_PASS_PARAMETERS: RenderPipelineParameters = {
    depthCompare: "less-equal",
    depthWriteEnabled: true,
    cullMode: "none",
    blend: false
};
/**
 * Normalized fixed-depth bias shared by the visible and picking composites.
 *
 * Ordinary vector paths receive this clearance through polygon offset. WebGL
 * ignores polygon offset when a fullscreen fragment writes `gl_FragDepth`, so
 * the semantic compositor must apply the fixed-depth component explicitly.
 */
export const SEMANTIC_COMPOSITE_DEPTH_BIAS =
    VECTOR_POLYGON_OFFSET_DEPTH_UNITS / 0x00ff_ffff;

interface SemanticCompositeLayerState {
    model: ClipSpace | null;
}

type SemanticCompositeLayerProps = LayerProps & {
    service: DeckSemanticZIndexService;
};

type SemanticPickingLayerProps = LayerProps & {
    service: DeckSemanticZIndexService;
    sourceLayer: ErdblickVectorLayer;
    sharedDisabledPickIndices: Set<number>;
    drillPickEligible?: boolean;
    navigationAnchorEligible?: boolean;
    navigationAltitudeResolver?: (globalPickIndex: number) => number | undefined;
    markerAnchorEligible?: boolean;
};

const COMPOSITE_FRAGMENT_SHADER = `\
#version 300 es
precision highp float;

uniform sampler2D semanticOverlayColorTexture;
uniform highp sampler2D semanticSupportDepthTexture;

in vec2 coordinate;
out vec4 fragColor;

void main(void) {
  vec4 overlay = texture(semanticOverlayColorTexture, coordinate);
  if (overlay.a <= 0.0) {
    discard;
  }
  float supportDepth = texture(semanticSupportDepthTexture, coordinate).r;
  gl_FragDepth = max(0.0, supportDepth - ${SEMANTIC_COMPOSITE_DEPTH_BIAS});
  fragColor = overlay;
}
`;

const PICKING_FRAGMENT_SHADER = `\
#version 300 es
precision highp float;

uniform sampler2D semanticResolvedPickTexture;
uniform highp sampler2D semanticSupportDepthTexture;

layout(location = 0) out vec4 fragColor;

void main(void) {
  ivec2 semanticCoordinate = ivec2(gl_FragCoord.xy);
  vec4 resolvedPick = texelFetch(
    semanticResolvedPickTexture,
    semanticCoordinate,
    0);
  if (resolvedPick.a <= 0.0) {
    discard;
  }
  float supportDepth = texelFetch(
    semanticSupportDepthTexture,
    semanticCoordinate,
    0).r;
  gl_FragDepth = max(0.0, supportDepth - ${SEMANTIC_COMPOSITE_DEPTH_BIAS});
  fragColor = picking.isAttribute > 0.5
    ? vec4(supportDepth * 2.0 - 1.0, 0.0, 0.0, 1.0)
    : resolvedPick;
}
`;

/** Composite semantic overlays at their support depth plus coplanar clearance. */
class SemanticCompositeLayer extends Layer<SemanticCompositeLayerProps> {
    static override layerName = "SemanticCompositeLayer";

    /** Build one raw fullscreen model; semantic textures are bound immediately before draw. */
    override initializeState(): void {
        this.getAttributeManager()?.remove(["instancePickingColors"]);
        const model = new ClipSpace(this.context.device, {
            id: String(this.props.id),
            fs: COMPOSITE_FRAGMENT_SHADER,
            parameters: this.props.parameters
        });
        this.setState({model} satisfies SemanticCompositeLayerState);
    }

    /** The raw compositor owns all shader inputs and ignores Deck module updates. */
    override setShaderModuleProps(..._props: unknown[]): void {}

    /** Destroy the fullscreen pipeline while the service retains its render targets. */
    override finalizeState(): void {
        (this.state as unknown as SemanticCompositeLayerState).model?.destroy();
    }

    /** Expose the compositor model to Deck's ordinary layer pass. */
    override getModels(): ClipSpace[] {
        const model = (this.state as unknown as SemanticCompositeLayerState).model;
        return model ? [model] : [];
    }

    /** Draw the resolved overlay only after both hidden semantic passes completed. */
    override draw({renderPass}: {renderPass: unknown}): void {
        const model = (this.state as unknown as SemanticCompositeLayerState).model;
        const input = this.props.service.compositeInput();
        if (!model || !input) {
            return;
        }
        model.setBindings({
            semanticOverlayColorTexture: input.overlayColor,
            semanticSupportDepthTexture: input.supportDepth
        });
        if (!model.draw(renderPass as never)) {
            this.setNeedsRedraw();
        }
    }
}

/** Reinsert the resolved semantic winner into Deck's ordinary picking buffer. */
class SemanticPickingLayer extends Layer<SemanticPickingLayerProps> {
    static override layerName = "SemanticPickingLayer";

    private readonly disabledPickIndices: Set<number>;

    /** Retain the suppression set shared with every vector representation. */
    constructor(props: SemanticPickingLayerProps) {
        super(props);
        this.disabledPickIndices = props.sharedDisabledPickIndices;
    }

    /** Build one raw fullscreen model that forwards pre-resolved pick identities. */
    override initializeState(): void {
        this.getAttributeManager()?.remove(["instancePickingColors"]);
        const model = new ClipSpace(this.context.device, {
            id: String(this.props.id),
            fs: PICKING_FRAGMENT_SHADER,
            modules: [picking as never],
            parameters: this.props.parameters
        });
        this.setState({model} satisfies SemanticCompositeLayerState);
    }

    /** Forward only Deck's picking mode; the raw model does not use layer/project modules. */
    override setShaderModuleProps(...props: unknown[]): void {
        const model = (this.state as unknown as SemanticCompositeLayerState).model;
        const pickingProps = (props[0] as {picking?: unknown} | undefined)
            ?.picking;
        if (model && pickingProps) {
            model.shaderInputs.setProps({picking: pickingProps} as never);
        }
    }

    /** Destroy the fullscreen pipeline while the service retains its render targets. */
    override finalizeState(): void {
        (this.state as unknown as SemanticCompositeLayerState).model?.destroy();
    }

    /** Expose the picking compositor model to Deck's picking layer pass. */
    override getModels(): ClipSpace[] {
        const model = (this.state as unknown as SemanticCompositeLayerState).model;
        return model ? [model] : [];
    }

    /** Draw the winning identity with the same coplanar clearance as its visible overlay. */
    override draw({renderPass}: {renderPass: unknown}): void {
        const model = (this.state as unknown as SemanticCompositeLayerState).model;
        const input = this.props.service.compositeInput();
        if (!model || !input) {
            return;
        }
        model.setBindings({
            semanticResolvedPickTexture: input.overlayColor,
            semanticSupportDepthTexture: input.supportDepth
        });
        if (!model.draw(renderPass as never)) {
            this.setNeedsRedraw();
        }
    }

    /** Resolve the encoded scene-global identity without a geometry-sized CPU array. */
    override getPickingInfo({
        info
    }: {
        info: PickingInfo;
        mode: string;
    }): PickingInfo {
        return {
            ...info,
            object: info.index >= 0
                ? {globalPickIndex: info.index}
                : undefined,
            sourceLayer: this.props.sourceLayer
        };
    }

    /** Exclude one winner before Deck asks for the next drill-pick result. */
    override disablePickingIndex(objectIndex: number): void {
        if (Number.isInteger(objectIndex) && objectIndex >= 0 &&
            this.disabledPickIndices.size < MAX_DISABLED_PICK_INDICES) {
            this.disabledPickIndices.add(objectIndex);
            this.setNeedsRedraw();
        }
    }

    /** Restore the shared identity set after Deck completes one pick operation. */
    override restorePickingColors(): void {
        if (this.disabledPickIndices.size) {
            this.disabledPickIndices.clear();
            this.setNeedsRedraw();
        }
    }
}

/** Return whether a layer exists only to feed the hidden semantic render passes. */
export function isSemanticZIndexPassLayer(layerId: string): boolean {
    return layerId.startsWith(PASS_LAYER_PREFIX);
}

/** Return whether a layer composites resolved semantic ids only during picking. */
export function isSemanticZIndexPickingLayer(layerId: string): boolean {
    return layerId === PICKING_LAYER_ID;
}

/**
 * Resolve style-local z-index only among overlays attached to the physically
 * visible support group, then composite that winner through the main depth buffer.
 */
export class DeckSemanticZIndexService implements Effect {
    readonly id = "deck-semantic-z-index-service";
    readonly props = null;
    readonly useInPicking = true;
    readonly order = -20;

    private context: EffectContext | null = null;
    private pass: LayersPass | null = null;
    private supportFramebuffer: Framebuffer | null = null;
    private overlayFramebuffer: Framebuffer | null = null;
    private supportLayer: ErdblickVectorLayer | null = null;
    private overlayLayer: ErdblickVectorLayer | null = null;

    /** Keep generated hidden and composite layers in the same stable view registry. */
    constructor(private readonly layerRegistry: DeckLayerRegistry) {}

    /** Allocate the shared hidden pass after Deck exposes its graphics device. */
    setup(context: EffectContext): void {
        this.context = context;
        this.pass = new LayersPass(context.device, {
            id: "deck-semantic-z-index-pass"
        });
    }

    /** Attach one retained scene and create its stable support, overlay, and composite shells. */
    bindScene(
        scene: GpuScene,
        flattenZ: boolean,
        sharedDisabledPickIndices = new Set<number>()
    ): void {
        this.unbindScene();
        this.supportLayer = new ErdblickVectorLayer({
            id: SUPPORT_LAYER_ID,
            data: [],
            scene,
            flattenZ,
            renderMode: ErdblickVectorRenderMode.SemanticSupport,
            parameters: SEMANTIC_PASS_PARAMETERS,
            getPolygonOffset: NO_POLYGON_OFFSET,
            pickable: false
        });
        this.overlayLayer = new ErdblickVectorLayer({
            id: OVERLAY_LAYER_ID,
            data: [],
            scene,
            flattenZ,
            renderMode: ErdblickVectorRenderMode.SemanticOverlay,
            parameters: SEMANTIC_PASS_PARAMETERS,
            sharedDisabledPickIndices,
            getPolygonOffset: NO_POLYGON_OFFSET,
            pickable: false
        });
        this.layerRegistry.upsert(SUPPORT_LAYER_ID, this.supportLayer, -200_000);
        this.layerRegistry.upsert(OVERLAY_LAYER_ID, this.overlayLayer, -199_999);
        this.layerRegistry.upsert(COMPOSITE_LAYER_ID, new SemanticCompositeLayer({
            id: COMPOSITE_LAYER_ID,
            service: this,
            parameters: {
                depthCompare: "less-equal",
                depthWriteEnabled: false,
                cullMode: "none",
                blend: true,
                blendColorOperation: "add",
                blendColorSrcFactor: "src-alpha",
                blendColorDstFactor: "one-minus-src-alpha",
                blendAlphaOperation: "add",
                blendAlphaSrcFactor: "one",
                blendAlphaDstFactor: "one-minus-src-alpha"
            },
            getPolygonOffset: NO_POLYGON_OFFSET,
            pickable: false
        }), 425);
        this.layerRegistry.upsert(PICKING_LAYER_ID, new SemanticPickingLayer({
            id: PICKING_LAYER_ID,
            service: this,
            sourceLayer: this.overlayLayer,
            sharedDisabledPickIndices,
            parameters: SEMANTIC_PASS_PARAMETERS,
            getPolygonOffset: NO_POLYGON_OFFSET,
            pickable: true,
            drillPickEligible: true,
            navigationAnchorEligible: true,
            navigationAltitudeResolver: (globalPickIndex) =>
                scene.navigationAltitude(globalPickIndex),
            markerAnchorEligible: true
        }), 425);
    }

    /** Notify hidden models when packet admission replaces scene buffers or lookup textures. */
    sceneChanged(): void {
        this.supportLayer?.sceneChanged();
        this.overlayLayer?.sceneChanged();
    }

    /** Remove scene-specific shells without destroying the Effect's device-level pass. */
    unbindScene(): void {
        this.layerRegistry.remove(SUPPORT_LAYER_ID);
        this.layerRegistry.remove(OVERLAY_LAYER_ID);
        this.layerRegistry.remove(COMPOSITE_LAYER_ID);
        this.layerRegistry.remove(PICKING_LAYER_ID);
        this.supportLayer = null;
        this.overlayLayer = null;
    }

    /** Render physical support ownership first and local overlay winners second. */
    preRender(options: PreRenderOptions): void {
        if (!this.context || !this.pass ||
            !this.supportLayer || !this.overlayLayer) {
            return;
        }
        const size = this.context.device.canvasContext?.getDrawingBufferSize();
        if (!size || size[0] <= 0 || size[1] <= 0) {
            return;
        }
        this.ensureFramebuffers(size);
        const supportGroup = this.supportFramebuffer
            ?.colorAttachments[0]?.texture;
        if (!this.supportFramebuffer || !this.overlayFramebuffer ||
            !supportGroup) {
            return;
        }
        this.overlayLayer.setSemanticSupportTexture(supportGroup);
        const common = {
            viewports: options.viewports,
            onViewportActive: options.onViewportActive,
            effects: [],
            layerFilter: null,
            clearCanvas: true,
            clearStack: true,
            clearColor: [0, 0, 0, 0] as [number, number, number, number],
            isPicking: false
        };
        this.pass.render({
            ...common,
            target: this.supportFramebuffer,
            layers: [this.supportLayer],
            pass: "semantic-z-index-support",
            shaderModuleProps: {
                lighting: {enabled: false},
                picking: {isActive: false, isAttribute: false}
            }
        });
        this.pass.render({
            ...common,
            target: this.overlayFramebuffer,
            layers: [this.overlayLayer],
            pass: options.isPicking
                ? "semantic-z-index-picking"
                : "semantic-z-index-overlay",
            shaderModuleProps: {
                lighting: {enabled: false},
                picking: {
                    isActive: Boolean(options.isPicking),
                    isAttribute: false
                }
            }
        });
    }

    /** Expose completed textures to the ordinary fullscreen composite layer. */
    compositeInput(): {overlayColor: Texture; supportDepth: Texture} | null {
        const overlayColor = this.overlayFramebuffer
            ?.colorAttachments[0]?.texture;
        const supportDepth = this.supportFramebuffer
            ?.depthStencilAttachment?.texture;
        return overlayColor && supportDepth
            ? {overlayColor, supportDepth}
            : null;
    }

    /** Release all scene shells, framebuffers, and the reusable hidden pass. */
    cleanup(): void {
        this.unbindScene();
        this.destroyFramebuffers();
        this.pass?.cleanup();
        this.pass = null;
        this.context = null;
    }

    /** Replace resized targets as complete ownership units; reuse unchanged sizes. */
    private ensureFramebuffers(size: [number, number]): void {
        if (!this.context) {
            return;
        }
        if (this.supportFramebuffer?.width === size[0] &&
            this.supportFramebuffer.height === size[1] &&
            this.overlayFramebuffer?.width === size[0] &&
            this.overlayFramebuffer.height === size[1]) {
            return;
        }
        // luma's deprecated resize() attaches replacement views, not their
        // backing color textures. Recreate to keep texture ownership explicit.
        this.destroyFramebuffers();
        this.supportFramebuffer = createFramebuffer(this.context, "support", size);
        this.overlayFramebuffer = createFramebuffer(this.context, "overlay", size);
    }

    /** Release both targets and all textures they own, including automatic depth. */
    private destroyFramebuffers(): void {
        this.supportFramebuffer?.destroy();
        this.overlayFramebuffer?.destroy();
        this.supportFramebuffer = null;
        this.overlayFramebuffer = null;
    }
}

/** Create one nearest-filtered color target with an attached hardware depth buffer. */
function createFramebuffer(
    context: EffectContext,
    id: string,
    [width, height]: [number, number]
): Framebuffer {
    const colorAttachment = context.device.createTexture({
        id: `semantic-z-index-${id}`,
        format: "rgba8unorm",
        usage: Texture.RENDER_ATTACHMENT | Texture.SAMPLE,
        width,
        height,
        sampler: {
            minFilter: "nearest",
            magFilter: "nearest",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge"
        }
    });
    try {
        const framebuffer = context.device.createFramebuffer({
            id: `semantic-z-index-${id}`,
            width,
            height,
            colorAttachments: [colorAttachment],
            depthStencilAttachment: "depth24plus"
        });
        // Explicit attachments are borrowed by default. Own the texture, not
        // its view; destroying a TextureView does not release GPU storage.
        framebuffer.attachResource(colorAttachment);
        return framebuffer;
    } catch (error) {
        colorAttachment.destroy();
        throw error;
    }
}
