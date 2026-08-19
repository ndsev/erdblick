import {
    Layer,
    type Effect,
    type EffectContext,
    type LayerProps,
    type PreRenderOptions,
    _LayersPass as LayersPass
} from "@deck.gl/core";
import type {Framebuffer, RenderPipelineParameters, Texture} from "@luma.gl/core";
import {ClipSpace} from "@luma.gl/engine";
import type {ShaderModule} from "@luma.gl/shadertools";
import type {DeckInteractionEffect, DeckRgba} from "./deck-interaction-effect";
import {DeckLayerRegistry} from "./deck-layer-registry";

const MASK_LAYER_PREFIX = "builtin/interaction-mask/";
const HALO_LAYER_PREFIX = "builtin/interaction-halo/";
const SCREEN_LAYER_PREFIX = "builtin/interaction-outline/";
const MAX_BLUR_RADIUS_PX = 12;
const GAUSSIAN_SAMPLE_EXTENT = 3.2307692308;

type NormalizedColor = [number, number, number, number];

interface OutlineShaderProps {
    textureSize: [number, number];
    tintColor: NormalizedColor;
    haloColor: NormalizedColor;
    stripeColor: NormalizedColor;
    stripeAxis: [number, number];
    stripeOrigin: [number, number];
    tintMix: number;
    opacity: number;
    edgeThreshold: number;
    haloOpacity: number;
    stripeSpacing: number;
    stripeWidth: number;
    stripeOpacity: number;
    stripeOffset: number;
    stripeSoftness: number;
    hasTint: number;
    hasHalo: number;
    hasInteriorHalo: number;
    hasStripe: number;
}

/** Pixel-space material consumed by the fullscreen interaction-outline shader. */
export interface DeckInteractionOutlineUniforms extends
    OutlineShaderProps, Record<string, unknown> {}

interface OutlineGroup {
    effect: DeckInteractionEffect;
    order: number;
    maskLayerKeys: Map<string, string>;
    identityIds: Map<string, number>;
    nextIdentityId: number;
    stripeAnchor: [number, number, number] | null;
    stripeOrigin: [number, number];
    identityFramebuffer: Framebuffer | null;
    blurTemporaryFramebuffer: Framebuffer | null;
    blurFramebuffer: Framebuffer | null;
}

interface OutlineLayerState {
    model: ClipSpace | null;
}

type OutlineLayerProps = LayerProps & {
    groupId: string;
    service: DeckInteractionOutlineService;
    haloOnly: boolean;
};

interface OutlinePhaseShaderProps {
    haloOnly: number;
}

const outlineShaderModule = {
    name: "interactionOutline",
    fs: `\
uniform interactionOutlineUniforms {
  vec2 textureSize;
  vec4 tintColor;
  vec4 haloColor;
  vec4 stripeColor;
  vec2 stripeAxis;
  vec2 stripeOrigin;
  float tintMix;
  float opacity;
  float edgeThreshold;
  float haloOpacity;
  float stripeSpacing;
  float stripeWidth;
  float stripeOpacity;
  float stripeOffset;
  float stripeSoftness;
  float hasTint;
  float hasHalo;
  float hasInteriorHalo;
  float hasStripe;
} interactionOutline;
`,
    uniformTypes: {
        textureSize: "vec2<f32>",
        tintColor: "vec4<f32>",
        haloColor: "vec4<f32>",
        stripeColor: "vec4<f32>",
        stripeAxis: "vec2<f32>",
        stripeOrigin: "vec2<f32>",
        tintMix: "f32",
        opacity: "f32",
        edgeThreshold: "f32",
        haloOpacity: "f32",
        stripeSpacing: "f32",
        stripeWidth: "f32",
        stripeOpacity: "f32",
        stripeOffset: "f32",
        stripeSoftness: "f32",
        hasTint: "f32",
        hasHalo: "f32",
        hasInteriorHalo: "f32",
        hasStripe: "f32"
    }
} as const satisfies ShaderModule<OutlineShaderProps>;

const outlinePhaseShaderModule = {
    name: "interactionOutlinePhase",
    fs: `\
uniform interactionOutlinePhaseUniforms {
  float haloOnly;
} interactionOutlinePhase;
`,
    uniformTypes: {
        haloOnly: "f32"
    }
} as const satisfies ShaderModule<OutlinePhaseShaderProps>;

const SOURCE_OVER_PARAMETERS: RenderPipelineParameters = {
    depthWriteEnabled: false,
    depthCompare: "always",
    cullMode: "none",
    blend: true,
    blendColorOperation: "add",
    blendColorSrcFactor: "one",
    blendColorDstFactor: "one-minus-src-alpha",
    blendAlphaOperation: "add",
    blendAlphaSrcFactor: "one",
    blendAlphaDstFactor: "one-minus-src-alpha"
};

const DESTINATION_OVER_PARAMETERS: RenderPipelineParameters = {
    depthWriteEnabled: false,
    depthCompare: "always",
    cullMode: "none",
    blend: true,
    blendColorOperation: "add",
    blendColorSrcFactor: "one-minus-dst-alpha",
    blendColorDstFactor: "one",
    blendAlphaOperation: "add",
    blendAlphaSrcFactor: "one-minus-dst-alpha",
    blendAlphaDstFactor: "one"
};

/** Select the premultiplied Porter-Duff operator for one compositor phase. */
export function deckInteractionOutlineBlendParameters(
    haloOnly: boolean
): RenderPipelineParameters {
    return haloOnly ? DESTINATION_OVER_PARAMETERS : SOURCE_OVER_PARAMETERS;
}

interface BlurShaderProps {
    haloSampleStep: [number, number];
    edgeSampleStep: [number, number];
    extractIdentity: number;
    haloFromCoverage: number;
}

const blurShaderModule = {
    name: "interactionBlur",
    fs: `\
uniform interactionBlurUniforms {
  vec2 haloSampleStep;
  vec2 edgeSampleStep;
  float extractIdentity;
  float haloFromCoverage;
} interactionBlur;
`,
    uniformTypes: {
        haloSampleStep: "vec2<f32>",
        edgeSampleStep: "vec2<f32>",
        extractIdentity: "f32",
        haloFromCoverage: "f32"
    }
} as const satisfies ShaderModule<BlurShaderProps>;

const BLUR_FRAGMENT_SHADER = `\
#version 300 es
precision highp float;

uniform sampler2D interactionBlurSource;

in vec2 coordinate;
out vec4 fragColor;

ivec4 blur_object_id(vec2 uv) {
  return ivec4(floor(texture(interactionBlurSource, uv) * 255.0 + 0.5));
}

float semantic_boundary(vec2 uv) {
  vec2 texel = 1.0 / vec2(textureSize(interactionBlurSource, 0));
  ivec4 centerId = blur_object_id(uv);
  float boundary = 0.0;
  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      if (x == 0 && y == 0) {
        continue;
      }
      ivec4 neighborId = blur_object_id(clamp(
        uv + vec2(float(x), float(y)) * texel,
        texel * 0.5,
        vec2(1.0) - texel * 0.5));
      if (any(notEqual(neighborId, centerId))) {
        boundary = max(boundary,
          (x == 0 || y == 0) ? 1.0 : 0.70710678);
      }
    }
  }
  return boundary;
}

void main(void) {
  if (interactionBlur.extractIdentity > 0.5) {
    vec4 identity = texture(interactionBlurSource, coordinate);
    float boundary = semantic_boundary(coordinate);
    float haloSeed = mix(
      boundary,
      identity.a,
      interactionBlur.haloFromCoverage);
    fragColor = vec4(
      identity.a,
      haloSeed,
      boundary,
      1.0);
    return;
  }
  // Red coverage and blue semantic edges use the edge-width blur scale.
  // Green carries the same semantic boundary through the independently sized
  // halo field. Enabling a halo must never widen or soften the yellow edge.
  vec3 center = texture(interactionBlurSource, coordinate).rgb;
  vec2 edgeValue = center.rb * 0.2270270270;
  float haloValue = center.g * 0.2270270270;

  vec3 edgePositiveNear = texture(
    interactionBlurSource,
    coordinate + interactionBlur.edgeSampleStep * 1.3846153846).rgb;
  vec3 edgeNegativeNear = texture(
    interactionBlurSource,
    coordinate - interactionBlur.edgeSampleStep * 1.3846153846).rgb;
  vec3 edgePositiveFar = texture(
    interactionBlurSource,
    coordinate + interactionBlur.edgeSampleStep * 3.2307692308).rgb;
  vec3 edgeNegativeFar = texture(
    interactionBlurSource,
    coordinate - interactionBlur.edgeSampleStep * 3.2307692308).rgb;
  edgeValue += (edgePositiveNear.rb + edgeNegativeNear.rb) * 0.3162162162;
  edgeValue += (edgePositiveFar.rb + edgeNegativeFar.rb) * 0.0702702703;

  haloValue += (
    texture(
      interactionBlurSource,
      coordinate + interactionBlur.haloSampleStep * 1.3846153846).g +
    texture(
      interactionBlurSource,
      coordinate - interactionBlur.haloSampleStep * 1.3846153846).g
    ) * 0.3162162162;
  haloValue += (
    texture(
      interactionBlurSource,
      coordinate + interactionBlur.haloSampleStep * 3.2307692308).g +
    texture(
      interactionBlurSource,
      coordinate - interactionBlur.haloSampleStep * 3.2307692308).g
    ) * 0.0702702703;
  fragColor = vec4(edgeValue.x, haloValue, edgeValue.y, 1.0);
}
`;

const OUTLINE_FRAGMENT_SHADER = `\
#version 300 es
precision highp float;

uniform sampler2D interactionIdentityTexture;
uniform sampler2D interactionBlurTexture;

in vec2 coordinate;
out vec4 fragColor;

ivec4 interaction_object_id(vec2 uv) {
  return ivec4(floor(texture(interactionIdentityTexture, uv) * 255.0 + 0.5));
}

bool interaction_has_object(ivec4 objectId) {
  return any(notEqual(objectId, ivec4(0)));
}

void interaction_over(
    vec3 layerColor,
    float layerAlpha,
    inout vec3 premultipliedRgb,
    inout float alpha) {
  premultipliedRgb = layerColor * layerAlpha +
    premultipliedRgb * (1.0 - layerAlpha);
  alpha = layerAlpha + alpha * (1.0 - layerAlpha);
}

void main(void) {
  ivec4 centerId = interaction_object_id(coordinate);
  bool centerHasObject = interaction_has_object(centerId);
  bool haloOnly = interactionOutlinePhase.haloOnly > 0.5;
  vec3 softFields = texture(interactionBlurTexture, coordinate).rgb;
  float softCoverage = softFields.r;
  float softHaloBoundary = softFields.g;
  float softEdgeBoundary = softFields.b;
  float coverageAa = max(fwidth(softCoverage) * 1.25, 0.006);
  float edgeBoundaryAa = max(fwidth(softEdgeBoundary) * 1.25, 0.004);
  float semanticEdgeThreshold =
    max(0.035, (1.0 - interactionOutline.edgeThreshold) * 0.45);
  float edgeSignal = smoothstep(
    max(0.0, semanticEdgeThreshold - edgeBoundaryAa),
    semanticEdgeThreshold + edgeBoundaryAa,
    softEdgeBoundary);

  bool styleGlowOnly = interactionOutline.hasHalo > 0.5 &&
    interactionOutline.hasInteriorHalo < 0.5 &&
    interactionOutline.hasTint < 0.5 &&
    interactionOutline.hasStripe < 0.5;

  if (centerHasObject && !(haloOnly && styleGlowOnly)) {
    float stableInterior = smoothstep(0.9, 0.99, softCoverage);
    vec3 rgb = vec3(0.0);
    float alpha = 0.0;

    // A union-coverage mask has no silhouette around a nested selected area.
    // Its distinct identity does, so draw the semantic halo on top of the
    // surrounding selected object while reserving the core for the crisp edge.
    if (interactionOutline.hasHalo > 0.5 &&
        interactionOutline.hasInteriorHalo > 0.5) {
      float semanticHaloSignal = smoothstep(
        0.001,
        0.24,
        softHaloBoundary) * stableInterior * (1.0 - edgeSignal);
      interaction_over(
        interactionOutline.haloColor.rgb,
        semanticHaloSignal * interactionOutline.haloColor.a *
          interactionOutline.haloOpacity * interactionOutline.opacity,
        rgb,
        alpha);
    }

    // Screen-space hatching is confined to the stable interior. Thin paths and
    // points never have a high-coverage core and therefore remain solid-tinted.
    if (interactionOutline.hasStripe > 0.5 &&
        interactionOutline.stripeSpacing > 0.0) {
      float stripeCoordinate =
        dot(
          gl_FragCoord.xy - interactionOutline.stripeOrigin,
          interactionOutline.stripeAxis) +
        interactionOutline.stripeOffset;
      float phase = mod(
        stripeCoordinate,
        interactionOutline.stripeSpacing);
      float stripeDistance = min(
        phase,
        interactionOutline.stripeSpacing - phase);
      float stripeHalfWidth = interactionOutline.stripeWidth * 0.5;
      float stripeAa = max(
        fwidth(stripeCoordinate) * 0.5,
        interactionOutline.stripeSoftness * 0.5);
      float stripeCoverage = 1.0 - smoothstep(
        max(0.0, stripeHalfWidth - stripeAa),
        stripeHalfWidth + stripeAa,
        stripeDistance);
      float interiorSignal = smoothstep(
        interactionOutline.edgeThreshold + coverageAa,
        min(1.0, interactionOutline.edgeThreshold + 0.25),
        softCoverage);
      interaction_over(
        interactionOutline.stripeColor.rgb,
        stripeCoverage * interiorSignal *
          interactionOutline.stripeOpacity *
          interactionOutline.stripeColor.a * interactionOutline.opacity,
        rgb,
        alpha);
    }
    if (interactionOutline.hasTint > 0.5) {
      interaction_over(
        interactionOutline.tintColor.rgb,
        edgeSignal * interactionOutline.tintMix *
          interactionOutline.tintColor.a * interactionOutline.opacity,
        rgb,
        alpha);
    }
    if (alpha <= 0.001) {
      discard;
    }
    // Emit only the interaction delta. Re-emitting the authored source color
    // here would compound translucent polygons into an opaque gray fill.
    fragColor = vec4(rgb, alpha);
    return;
  }

  // The near part of the continuous field extends the tint through the
  // silhouette by a fractional pixel. The rest is one smooth shadow/glow.
  float borderSignal = edgeSignal;
  float borderAlpha = !haloOnly && interactionOutline.hasTint > 0.5
    ? borderSignal
      * interactionOutline.tintMix
      * interactionOutline.tintColor.a
      * interactionOutline.opacity
    : 0.0;
  // Exterior style glows carry a blurred coverage field. Preserve that
  // Gaussian profile instead of crushing it into a nearly opaque band.
  // Semantic interaction halos retain their stronger boundary response.
  float haloSignal = interactionOutline.hasInteriorHalo > 0.5
    ? smoothstep(0.001, 0.24, softHaloBoundary)
    : clamp(softHaloBoundary * 2.0, 0.0, 1.0);
  // Only an interaction tint needs a reserved antialiased edge band. Authored
  // style glows have no foreground fill for that band; carving it out would
  // leave a transparent moat between the source geometry and its own glow.
  float haloEdgeFactor = interactionOutline.hasTint > 0.5
    ? 1.0 - smoothstep(0.0, 0.85, borderSignal)
    : 1.0;
  float haloAlpha = haloOnly && interactionOutline.hasHalo > 0.5
    ? haloSignal
      * haloEdgeFactor
      * interactionOutline.haloColor.a
      * interactionOutline.haloOpacity
      * interactionOutline.opacity
    : 0.0;
  vec3 rgb = interactionOutline.haloColor.rgb * haloAlpha;
  float alpha = haloAlpha;
  if (borderAlpha > 0.0) {
    interaction_over(
      interactionOutline.tintColor.rgb,
      borderAlpha,
      rgb,
      alpha);
  }
  if (alpha <= 0.001) {
    discard;
  }
  fragColor = vec4(rgb, alpha);
}
`;

/** Returns true for layers that exist only as input to the interaction mask pass. */
export function isDeckInteractionMaskLayer(layerId: string): boolean {
    return layerId.startsWith(MASK_LAYER_PREFIX);
}

/** Normalizes a style interaction material into bounded pixel-space shader inputs. */
export function deckInteractionOutlineUniforms(
    effect: DeckInteractionEffect,
    textureSize: [number, number] = [1, 1],
    stripeOrigin: [number, number] = [0, 0]
): DeckInteractionOutlineUniforms {
    const edgeBlurRadius = interactionEdgeBlurRadius(effect);
    // A Gaussian coverage value is approximately 0.5 at the silhouette and
    // approaches one in a stable interior. Raising this threshold widens the
    // inner edge band without ever needing to know the primitive kind.
    const edgeThreshold = clamp(
        0.5 + 0.35 * effect.edgeWidth / edgeBlurRadius,
        0.5,
        0.85);
    const stripeColor = effect.stripeColor ?? effect.tint;
    const stripeRadians = effect.stripeAngle * Math.PI / 180;
    return {
        textureSize,
        tintColor: normalizedColor(effect.tint),
        haloColor: normalizedColor(effect.haloColor),
        stripeColor: normalizedColor(stripeColor),
        // Angle is the visible stripe direction in screen coordinates. This
        // normalized perpendicular axis makes spacing and width true pixels.
        stripeAxis: [
            Math.sin(stripeRadians),
            Math.cos(stripeRadians)
        ],
        stripeOrigin,
        tintMix: clamp(effect.tintMix, 0, 1),
        opacity: clamp(effect.opacity, 0, 1),
        edgeThreshold,
        haloOpacity: clamp(effect.haloOpacity, 0, 1),
        stripeSpacing: Math.max(0, effect.stripeSpacing),
        stripeWidth: Math.max(0, effect.stripeWidth),
        stripeOpacity: clamp(effect.stripeOpacity, 0, 1),
        stripeOffset: effect.stripeOffset,
        stripeSoftness: Math.max(0, effect.stripeSoftness),
        hasTint: effect.tint && effect.tintMix > 0 && effect.opacity > 0
            ? 1
            : 0,
        hasHalo: effect.haloColor && effect.haloRadius > 0 &&
            effect.haloOpacity > 0 ? 1 : 0,
        hasInteriorHalo: effect.interiorHalo === false ? 0 : 1,
        hasStripe: stripeColor && effect.stripeSpacing > 0 &&
            effect.stripeWidth > 0 && effect.stripeOpacity > 0 ? 1 : 0
    };
}

/** Exterior-only style glows blur solid coverage instead of a rasterized edge. */
export function deckInteractionHaloUsesCoverage(
    effect: DeckInteractionEffect
): boolean {
    return effect.interiorHalo === false;
}

/**
 * Projects one stable WGS84 anchor into drawing-buffer coordinates.
 *
 * The hatch remains screen-space (constant pixel width and spacing), while
 * subtracting this moving origin pins its phase to the map during a pan.
 */
export function deckInteractionStripeOrigin(
    viewport: PreRenderOptions["viewports"][number],
    anchor: [number, number, number],
    drawingBufferSize: [number, number],
    logicalCanvasSize: [number, number]
): [number, number] {
    if (logicalCanvasSize[0] <= 0 || logicalCanvasSize[1] <= 0) {
        return [0, 0];
    }
    const projected = viewport.project(anchor, {topLeft: false});
    if (!Number.isFinite(projected[0]) || !Number.isFinite(projected[1])) {
        return [0, 0];
    }
    return [
        (viewport.x + projected[0]) *
            drawingBufferSize[0] / logicalCanvasSize[0],
        (logicalCanvasSize[1] - viewport.y - viewport.height + projected[1]) *
            drawingBufferSize[1] / logicalCanvasSize[1]
    ];
}

/** Fullscreen compositor that turns one vector-coverage mask into an adaptive material. */
class DeckInteractionOutlineLayer extends Layer<Required<OutlineLayerProps>> {
    static override layerName = "DeckInteractionOutlineLayer";

    /** Create one raw fullscreen model without Deck's ordinary object attributes. */
    override initializeState(): void {
        // This fullscreen layer owns its model inputs directly. Deck's default
        // instanced picking attribute has no matching ClipSpace attribute.
        this.getAttributeManager()?.remove(["instancePickingColors"]);
        const model = new ClipSpace(this.context.device, {
            id: String(this.props.id),
            fs: OUTLINE_FRAGMENT_SHADER,
            modules: [outlineShaderModule, outlinePhaseShaderModule],
            parameters: deckInteractionOutlineBlendParameters(this.props.haloOnly)
        });
        this.setState({model} satisfies OutlineLayerState);
    }

    /** Deck pass modules do not apply to this raw fullscreen compositor. */
    override setShaderModuleProps(..._props: unknown[]): void {
        // The outline shader inputs are installed immediately before draw().
    }

    /** Release the fullscreen model when its semantic material group disappears. */
    override finalizeState(): void {
        (this.state as unknown as OutlineLayerState).model?.destroy();
    }

    /** Expose the raw model so Deck can schedule the fullscreen pass. */
    override getModels(): ClipSpace[] {
        const model = (this.state as unknown as OutlineLayerState).model;
        return model ? [model] : [];
    }

    /** Composite identity/blur textures using the group's current style uniforms. */
    override draw({renderPass}: {renderPass: unknown}): void {
        const model = (this.state as unknown as OutlineLayerState).model;
        const input = this.props.service.screenInput(this.props.groupId);
        if (!model || !input) {
            return;
        }
        model.setBindings({
            interactionIdentityTexture: input.identityTexture,
            interactionBlurTexture: input.blurTexture
        });
        model.shaderInputs.setProps({
            interactionOutline: input.uniforms,
            interactionOutlinePhase: {
                haloOnly: this.props.haloOnly ? 1 : 0
            }
        });
        if (!model.draw(renderPass as never)) {
            this.setNeedsRedraw();
        }
    }
}

/**
 * Per-view owner of the path/point/surface mask passes and their fullscreen
 * interaction compositor. No framebuffer or mask draw exists until at least
 * one visualization contributes a selected vector primitive.
 */
export class DeckInteractionOutlineService implements Effect {
    readonly id = "deck-interaction-outline-service";
    readonly props = null;
    readonly useInPicking = false;
    readonly order = -10;

    private context: EffectContext | null = null;
    private maskPass: LayersPass | null = null;
    private blurModel: ClipSpace | null = null;
    private readonly groups = new Map<string, OutlineGroup>();

    /** Bind all generated mask and screen layers to one view registry. */
    constructor(private readonly layerRegistry: DeckLayerRegistry) {}

    /** Allocate shared render passes and blur model after Deck provides a device. */
    setup(context: EffectContext): void {
        this.context = context;
        this.maskPass = new LayersPass(context.device, {
            id: "deck-interaction-outline-mask-pass"
        });
        this.blurModel = new ClipSpace(context.device, {
            id: "deck-interaction-coverage-blur",
            fs: BLUR_FRAGMENT_SHADER,
            modules: [blurShaderModule],
            parameters: {
                depthWriteEnabled: false,
                depthCompare: "always",
                cullMode: "none",
                blend: false
            }
        });
    }

    /** Allocates one stable non-zero RGB identity within an interaction material group. */
    identityColor(
        groupId: string,
        identityKey: string,
        effect: DeckInteractionEffect,
        order: number
    ): [number, number, number, number] {
        const group = this.ensureGroup(groupId, effect, order);
        let identity = group.identityIds.get(identityKey);
        if (identity === undefined) {
            identity = group.nextIdentityId++;
            if (identity > 0xffffff) {
                throw new Error(
                    `Interaction outline group '${groupId}' exhausted its RGB identity space.`);
            }
            group.identityIds.set(identityKey, identity);
        }
        return [
            identity & 0xff,
            (identity >>> 8) & 0xff,
            (identity >>> 16) & 0xff,
            255
        ];
    }

    /** Refresh one group's visual material, order, and world stripe anchor. */
    configureGroup(
        groupId: string,
        effect: DeckInteractionEffect,
        order: number,
        stripeAnchor: [number, number, number]
    ): void {
        const group = this.ensureGroup(groupId, effect, order);
        group.stripeAnchor = [...stripeAnchor];
        if (group.maskLayerKeys.size > 0) {
            this.upsertScreenLayers(groupId, group);
        }
    }

    /** Inserts or replaces one hidden vector-mask layer in a material group. */
    upsertMask(
        groupId: string,
        sourceId: string,
        effect: DeckInteractionEffect,
        order: number,
        stripeAnchor: [number, number, number],
        buildLayer: (layerId: string) => Layer
    ): void {
        const group = this.ensureGroup(groupId, effect, order);
        group.stripeAnchor = [...stripeAnchor];
        const layerKey = maskLayerKey(groupId, sourceId);
        group.maskLayerKeys.set(sourceId, layerKey);
        this.layerRegistry.upsert(layerKey, buildLayer(layerKey), -100_000);
        this.upsertScreenLayers(groupId, group);
    }

    /** Removes one visualization's mask and releases the whole group once it becomes empty. */
    removeMask(groupId: string, sourceId: string): boolean {
        const group = this.groups.get(groupId);
        if (!group) {
            return false;
        }
        const layerKey = group.maskLayerKeys.get(sourceId);
        if (!layerKey) {
            return false;
        }
        group.maskLayerKeys.delete(sourceId);
        this.layerRegistry.remove(layerKey);
        if (group.maskLayerKeys.size === 0) {
            this.layerRegistry.remove(screenLayerKey(groupId));
            this.layerRegistry.remove(haloLayerKey(groupId));
            this.destroyGroup(groupId, group);
        }
        return true;
    }

    /** Renders stable feature identities into a group-local coverage source. */
    preRender(options: PreRenderOptions): void {
        if (options.isPicking || !this.context || !this.maskPass ||
            this.groups.size === 0) {
            return;
        }
        const size = this.context.device.canvasContext?.getDrawingBufferSize();
        if (!size || size[0] <= 0 || size[1] <= 0) {
            return;
        }
        const layerById = new Map(options.layers.map(layer => [layer.id, layer]));
        for (const [groupId, group] of this.groups) {
            const maskLayers = [...group.maskLayerKeys.values()]
                .map(layerId => layerById.get(layerId))
                .filter((layer): layer is Layer => Boolean(layer));
            if (maskLayers.length === 0) {
                continue;
            }
            this.ensureFramebuffers(groupId, group, size);
            const viewport = options.viewports[0];
            if (viewport && group.stripeAnchor) {
                group.stripeOrigin = deckInteractionStripeOrigin(
                    viewport,
                    group.stripeAnchor,
                    size,
                    [this.context.deck.width, this.context.deck.height]);
            }
            const common = {
                layers: maskLayers,
                viewports: options.viewports,
                onViewportActive: options.onViewportActive,
                effects: [],
                layerFilter: null,
                clearCanvas: true,
                clearStack: true,
                clearColor: [0, 0, 0, 0]
            };
            this.maskPass.render({
                ...common,
                target: group.identityFramebuffer,
                pass: "interaction-outline-identity",
                isPicking: false,
                shaderModuleProps: {
                    lighting: {enabled: false}
                }
            });
            this.renderBlur(group);
        }
    }

    /** Supplies the current textures and resolved material to the fullscreen layer. */
    screenInput(groupId: string): {
        identityTexture: Texture;
        blurTexture: Texture;
        uniforms: DeckInteractionOutlineUniforms;
    } | null {
        const group = this.groups.get(groupId);
        const identityTexture = group?.identityFramebuffer
            ?.colorAttachments[0]?.texture;
        const finalBlurTexture = group?.blurTemporaryFramebuffer
            ?.colorAttachments[0]?.texture;
        if (!group || !identityTexture || !finalBlurTexture) {
            return null;
        }
        return {
            identityTexture,
            blurTexture: finalBlurTexture,
            uniforms: deckInteractionOutlineUniforms(
                group.effect,
                [identityTexture.width, identityTexture.height],
                group.stripeOrigin)
        };
    }

    /** Destroy every framebuffer, pass, model, and generated registry entry. */
    cleanup(): void {
        for (const [groupId, group] of this.groups) {
            this.destroyGroup(groupId, group);
        }
        this.groups.clear();
        this.maskPass?.cleanup();
        this.maskPass = null;
        this.blurModel?.destroy();
        this.blurModel = null;
        this.context = null;
    }

    /** Resolve or create one bounded material group and update its authored effect. */
    private ensureGroup(
        groupId: string,
        effect: DeckInteractionEffect,
        order: number
    ): OutlineGroup {
        let group = this.groups.get(groupId);
        if (!group) {
            group = {
                effect,
                order,
                maskLayerKeys: new Map(),
                identityIds: new Map(),
                nextIdentityId: 1,
                stripeAnchor: null,
                stripeOrigin: [0, 0],
                identityFramebuffer: null,
                blurTemporaryFramebuffer: null,
                blurFramebuffer: null
            };
            this.groups.set(groupId, group);
        }
        else {
            group.effect = effect;
            group.order = order;
        }
        return group;
    }

    /**
     * Publish the halo behind the existing framebuffer and foreground deltas above it.
     * Both passes stay at the authored order; their blend operators, not a redraw of
     * later geometry, establish the compositing relationship.
     */
    private upsertScreenLayers(groupId: string, group: OutlineGroup): void {
        const haloKey = haloLayerKey(groupId);
        if (hasExteriorHalo(group.effect)) {
            this.layerRegistry.upsert(haloKey, new DeckInteractionOutlineLayer({
                id: haloKey,
                groupId,
                service: this,
                haloOnly: true,
                pickable: false
            }), group.order);
        } else {
            this.layerRegistry.remove(haloKey);
        }

        const screenKey = screenLayerKey(groupId);
        if (hasForegroundMaterial(group.effect)) {
            this.layerRegistry.upsert(screenKey, new DeckInteractionOutlineLayer({
                id: screenKey,
                groupId,
                service: this,
                haloOnly: false,
                pickable: false
            }), group.order);
        } else {
            this.layerRegistry.remove(screenKey);
        }
    }

    /** Lazily allocate and resize full-resolution identity and blur targets. */
    private ensureFramebuffers(
        groupId: string,
        group: OutlineGroup,
        size: [number, number]
    ): void {
        if (!this.context) {
            return;
        }
        if (!group.identityFramebuffer) {
            group.identityFramebuffer = createOutlineFramebuffer(
                this.context,
                `${groupId}-identity`);
        }
        if (!group.blurTemporaryFramebuffer) {
            group.blurTemporaryFramebuffer = createOutlineFramebuffer(
                this.context,
                `${groupId}-blur-temporary`,
                true);
        }
        if (!group.blurFramebuffer) {
            group.blurFramebuffer = createOutlineFramebuffer(
                this.context,
                `${groupId}-blur`,
                true);
        }
        if (group.identityFramebuffer.width !== size[0] ||
            group.identityFramebuffer.height !== size[1]) {
            group.identityFramebuffer.resize({width: size[0], height: size[1]});
        }
        // Half-resolution upsampling made diagonal halos and narrow outlines
        // visibly stair-step. Interaction masks are sparse and short-lived, so
        // keep this one field at the drawing-buffer resolution.
        const blurWidth = Math.max(1, size[0]);
        const blurHeight = Math.max(1, size[1]);
        if (group.blurTemporaryFramebuffer.width !== blurWidth ||
            group.blurTemporaryFramebuffer.height !== blurHeight) {
            group.blurTemporaryFramebuffer.resize({
                width: blurWidth,
                height: blurHeight
            });
        }
        if (group.blurFramebuffer.width !== blurWidth ||
            group.blurFramebuffer.height !== blurHeight) {
            group.blurFramebuffer.resize({
                width: blurWidth,
                height: blurHeight
            });
        }
    }

    /** Builds soft union-coverage and per-object-boundary screen-space fields. */
    private renderBlur(group: OutlineGroup): void {
        if (!this.context || !this.blurModel ||
            !group.identityFramebuffer || !group.blurTemporaryFramebuffer ||
            !group.blurFramebuffer) {
            return;
        }
        const identityTexture =
            group.identityFramebuffer.colorAttachments[0]?.texture;
        const temporaryTexture =
            group.blurTemporaryFramebuffer.colorAttachments[0]?.texture;
        const horizontalTexture =
            group.blurFramebuffer.colorAttachments[0]?.texture;
        if (!identityTexture || !temporaryTexture || !horizontalTexture) {
            return;
        }
        const haloRadius = interactionHaloBlurRadius(group.effect);
        const edgeRadius = interactionEdgeBlurRadius(group.effect);
        // The outer optimized Gaussian tap is 3.2307 sample steps away. Scale
        // the step so the style's radius remains the approximate visible
        // extent instead of accidentally becoming three times as large.
        const haloSampleScale = haloRadius / GAUSSIAN_SAMPLE_EXTENT;
        const edgeSampleScale = edgeRadius / GAUSSIAN_SAMPLE_EXTENT;
        // Extract semantic boundaries once. Folding this into each Gaussian
        // tap would multiply the 3x3 identity comparison by five.
        this.renderBlurPass(
            identityTexture,
            group.blurTemporaryFramebuffer,
            [0, 0],
            [0, 0],
            true,
            deckInteractionHaloUsesCoverage(group.effect));
        this.renderBlurPass(
            temporaryTexture,
            group.blurFramebuffer,
            [haloSampleScale / Math.max(1, temporaryTexture.width), 0],
            [edgeSampleScale / Math.max(1, temporaryTexture.width), 0],
            false,
            false);
        this.renderBlurPass(
            horizontalTexture,
            group.blurTemporaryFramebuffer,
            [0, haloSampleScale / Math.max(1, temporaryTexture.height)],
            [0, edgeSampleScale / Math.max(1, temporaryTexture.height)],
            false,
            false);
        this.context.device.submit();
    }

    /** Execute one fullscreen extraction or separable Gaussian pass. */
    private renderBlurPass(
        source: Texture,
        target: Framebuffer,
        haloSampleStep: [number, number],
        edgeSampleStep: [number, number],
        extractIdentity: boolean,
        haloFromCoverage: boolean
    ): void {
        if (!this.context || !this.blurModel) {
            return;
        }
        this.blurModel.setBindings({interactionBlurSource: source});
        this.blurModel.shaderInputs.setProps({
            interactionBlur: {
                haloSampleStep,
                edgeSampleStep,
                extractIdentity: extractIdentity ? 1 : 0,
                haloFromCoverage: haloFromCoverage ? 1 : 0
            }
        });
        const pass = this.context.device.beginRenderPass({
            framebuffer: target,
            clearColor: [0, 0, 0, 0]
        });
        this.blurModel.draw(pass);
        pass.end();
    }

    /** Release all render targets belonging to a no-longer-demanded group. */
    private destroyGroup(groupId: string, group: OutlineGroup): void {
        destroyFramebuffer(group.identityFramebuffer);
        destroyFramebuffer(group.blurTemporaryFramebuffer);
        destroyFramebuffer(group.blurFramebuffer);
        group.identityFramebuffer = null;
        group.blurTemporaryFramebuffer = null;
        group.blurFramebuffer = null;
        this.groups.delete(groupId);
    }
}

/** Create one outline target with optional linear filtering and no depth buffer. */
function createOutlineFramebuffer(
    context: EffectContext,
    id: string,
    linear = false
): Framebuffer {
    const texture = context.device.createTexture({
        id: `interaction-outline-${id}`,
        format: "rgba8unorm",
        width: 1,
        height: 1,
        sampler: {
            minFilter: linear ? "linear" : "nearest",
            magFilter: linear ? "linear" : "nearest",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge"
        }
    });
    return context.device.createFramebuffer({
        id: `interaction-outline-${id}`,
        width: 1,
        height: 1,
        colorAttachments: [texture],
        depthStencilAttachment: linear ? null : "depth24plus"
    });
}

/** Bound edge anti-aliasing so pathological styles cannot explode blur cost. */
function interactionEdgeBlurRadius(effect: DeckInteractionEffect): number {
    return Math.max(1, Math.min(
        MAX_BLUR_RADIUS_PX,
        effect.edgeWidth * 2
    ));
}

/** Bound authored halo spread to the compositor's fixed kernel budget. */
function interactionHaloBlurRadius(effect: DeckInteractionEffect): number {
    return Math.max(1, Math.min(
        MAX_BLUR_RADIUS_PX,
        effect.haloRadius
    ));
}

/** Destroy both an owned color texture and its framebuffer wrapper. */
function destroyFramebuffer(framebuffer: Framebuffer | null): void {
    if (!framebuffer) {
        return;
    }
    framebuffer.colorAttachments[0]?.destroy();
    framebuffer.destroy();
}

/** Build a collision-safe registry key for one mask source. */
function maskLayerKey(groupId: string, sourceId: string): string {
    return `${MASK_LAYER_PREFIX}${encodeURIComponent(groupId)}/${encodeURIComponent(sourceId)}`;
}

/** Build the stable registry key for one group's fullscreen compositor. */
function screenLayerKey(groupId: string): string {
    return `${SCREEN_LAYER_PREFIX}${encodeURIComponent(groupId)}`;
}

/** Build the stable registry key for one destination-over halo pass. */
function haloLayerKey(groupId: string): string {
    return `${HALO_LAYER_PREFIX}${encodeURIComponent(groupId)}`;
}

/** Return whether an effect contributes a non-empty exterior halo. */
function hasExteriorHalo(effect: DeckInteractionEffect): boolean {
    return Boolean(effect.haloColor && effect.haloColor[3] > 0 &&
        effect.haloRadius > 0 && effect.haloOpacity > 0 && effect.opacity > 0);
}

/** Return whether an effect contributes tint, hatch, or a semantic inner halo. */
function hasForegroundMaterial(effect: DeckInteractionEffect): boolean {
    const tint = Boolean(effect.tint && effect.tint[3] > 0 &&
        effect.tintMix > 0 && effect.opacity > 0);
    const stripeColor = effect.stripeColor ?? effect.tint;
    const stripe = Boolean(stripeColor && stripeColor[3] > 0 &&
        effect.stripeSpacing > 0 && effect.stripeWidth > 0 &&
        effect.stripeOpacity > 0 && effect.opacity > 0);
    const interiorHalo = effect.interiorHalo !== false && hasExteriorHalo(effect);
    return tint || stripe || interiorHalo;
}

/** Convert optional byte RGBA into shader-ready normalized channels. */
function normalizedColor(color: DeckRgba | undefined): NormalizedColor {
    if (!color) {
        return [0, 0, 0, 0];
    }
    return [
        clamp(color[0] / 255, 0, 1),
        clamp(color[1] / 255, 0, 1),
        clamp(color[2] / 255, 0, 1),
        clamp(color[3] / 255, 0, 1)
    ];
}

/** Clamp one scalar without importing a heavier math helper. */
function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
}
