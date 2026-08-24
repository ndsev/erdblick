import type {Viewport} from "@deck.gl/core";
import type {
    Device,
    Framebuffer,
    RenderPipelineParameters,
    Texture,
    TextureFormatDepthStencil
} from "@luma.gl/core";
import {Model} from "@luma.gl/engine";
import type {ShaderModule} from "@luma.gl/shadertools";

interface ContactShadingShaderProps {
    projectionTerms: [number, number];
    opacity: number;
}

interface MutableWebGlTextureResource extends Texture {
    readonly handle: WebGLTexture;
    width: number;
    height: number;
}

interface ContactDepthFormat {
    texture: TextureFormatDepthStencil;
    renderbuffer: number;
    pixelType: number;
    samples: number;
}

const CONTACT_SHADING_OPACITY = 0.2;

const contactShadingShaderModule = {
    name: "contactShading",
    fs: `\
uniform contactShadingUniforms {
  vec2 projectionTerms;
  float opacity;
} contactShading;
`,
    uniformTypes: {
        projectionTerms: "vec2<f32>",
        opacity: "f32"
    }
} as const satisfies ShaderModule<ContactShadingShaderProps>;

const CONTACT_SHADING_PARAMETERS: RenderPipelineParameters = {
    depthWriteEnabled: false,
    depthCompare: "always",
    cullMode: "none",
    blend: false
};

const CONTACT_SHADING_VERTEX_SHADER = `\
#version 300 es
precision highp float;

void main(void) {
  vec2 position = vec2(
    gl_VertexID == 1 ? 3.0 : -1.0,
    gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const CONTACT_SHADING_FRAGMENT_SHADER = `\
#version 300 es
precision highp float;

uniform highp sampler2D contactDepthTexture;
uniform highp sampler2D contactColorTexture;

out vec4 fragColor;

float contact_view_depth(float depth) {
  float ndcDepth = depth * 2.0 - 1.0;
  float denominator = ndcDepth + contactShading.projectionTerms.x;
  return abs(contactShading.projectionTerms.y / denominator);
}

float contact_response(
    float expectedDepth,
    float sampledDepth,
    float oppositeDepth,
    float centerDepth) {
  float relativeDelta = max(expectedDepth - sampledDepth, 0.0) /
    max(centerDepth, 0.000001);
  // Perspective depth is curved across steeply sloped surfaces. Suppress that
  // predictable residual while retaining the much larger discontinuity where
  // an actual foreground surface meets the sampled receiver.
  float relativeSpan = abs(sampledDepth - oppositeDepth) /
    max(centerDepth, 0.000001);
  float slopeBias = 0.00015 + 0.08 * relativeSpan;
  float contact = smoothstep(slopeBias, slopeBias + 0.00235, relativeDelta);
  float silhouetteRejection = 1.0 - smoothstep(0.08, 0.25, relativeDelta);
  return contact * silhouetteRejection;
}

ivec2 contact_sample_coordinate(ivec2 pixel, ivec2 offset, ivec2 textureSize) {
  return clamp(pixel + offset, ivec2(0), textureSize - ivec2(1));
}

float contact_pair(
    ivec2 pixelOffset,
    ivec2 pixel,
    ivec2 depthTextureSize,
    float centerDepth) {
  float positiveRaw = texelFetch(
    contactDepthTexture,
    contact_sample_coordinate(pixel, pixelOffset, depthTextureSize),
    0).r;
  float negativeRaw = texelFetch(
    contactDepthTexture,
    contact_sample_coordinate(pixel, -pixelOffset, depthTextureSize),
    0).r;
  bool positiveValid = positiveRaw < 0.999999;
  bool negativeValid = negativeRaw < 0.999999;
  float positiveDepth = positiveValid
    ? contact_view_depth(positiveRaw)
    : centerDepth;
  float negativeDepth = negativeValid
    ? contact_view_depth(negativeRaw)
    : centerDepth;
  float positiveResponse = positiveValid
    ? contact_response(
        2.0 * centerDepth - negativeDepth,
        positiveDepth,
        negativeDepth,
        centerDepth)
    : 0.0;
  float negativeResponse = negativeValid
    ? contact_response(
        2.0 * centerDepth - positiveDepth,
        negativeDepth,
        positiveDepth,
        centerDepth)
    : 0.0;
  return max(positiveResponse, negativeResponse);
}

void main(void) {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  ivec2 depthTextureSize = textureSize(contactDepthTexture, 0);
  vec4 sceneColor = texelFetch(contactColorTexture, pixel, 0);
  float centerRaw = texelFetch(contactDepthTexture, pixel, 0).r;
  if (centerRaw >= 0.999999) {
    fragColor = sceneColor;
    return;
  }
  float centerDepth = contact_view_depth(centerRaw);
  float occlusion = 0.0;
  occlusion += contact_pair(ivec2(2, 0), pixel, depthTextureSize, centerDepth);
  occlusion += contact_pair(ivec2(0, 2), pixel, depthTextureSize, centerDepth);
  occlusion += contact_pair(ivec2(1, 1), pixel, depthTextureSize, centerDepth);
  occlusion += contact_pair(ivec2(1, -1), pixel, depthTextureSize, centerDepth);
  occlusion += 0.65 * contact_pair(
    ivec2(5, 0), pixel, depthTextureSize, centerDepth);
  occlusion += 0.65 * contact_pair(
    ivec2(0, 5), pixel, depthTextureSize, centerDepth);
  float shadow = 1.0 - exp(-0.7 * occlusion);
  float alpha = contactShading.opacity * smoothstep(0.04, 0.7, shadow);
  fragColor = vec4(sceneColor.rgb * (1.0 - alpha), sceneColor.a);
}
`;

/**
 * Owns an offscreen MSAA scene target whose color is presented unchanged while
 * its resolved depth drives an inexpensive screen-space contact-shading pass.
 */
export class DeckContactShadingService {
    private readonly depthFormat: ContactDepthFormat | null;
    private readonly model: Model;
    private sceneFramebuffer: WebGLFramebuffer | null = null;
    private sceneColorBuffer: WebGLRenderbuffer | null = null;
    private sceneDepthBuffer: WebGLRenderbuffer | null = null;
    private resolvedFramebuffer: WebGLFramebuffer | null = null;
    private colorTextureHandle: WebGLTexture | null = null;
    private depthTextureHandle: WebGLTexture | null = null;
    private colorTexture: Texture | null = null;
    private depthTexture: Texture | null = null;
    private deckFramebuffer: Framebuffer | null = null;
    private targetWidth = 0;
    private targetHeight = 0;
    private targetFailed = false;

    /** Creates the compositor and records formats compatible with the canvas framebuffer. */
    constructor(
        private readonly device: Device,
        private readonly gl: WebGL2RenderingContext
    ) {
        this.depthFormat = this.readCanvasFormat();
        this.model = new Model(device, {
            id: "deck-contact-shading",
            vs: CONTACT_SHADING_VERTEX_SHADER,
            fs: CONTACT_SHADING_FRAGMENT_SHADER,
            modules: [contactShadingShaderModule],
            parameters: CONTACT_SHADING_PARAMETERS,
            topology: "triangle-list",
            vertexCount: 3
        });
        this.model.predraw(device.commandEncoder);
    }

    /** Allocates or resizes Deck's offscreen scene target and returns it for the next frame. */
    prepare(): Framebuffer | null {
        if (!this.depthFormat || this.targetFailed) {
            return null;
        }
        if (!this.ensureTargetObjects()) {
            return null;
        }
        const width = this.gl.drawingBufferWidth;
        const height = this.gl.drawingBufferHeight;
        if (width <= 0 || height <= 0) {
            return null;
        }
        if (width !== this.targetWidth || height !== this.targetHeight) {
            this.allocateTargetStorage(width, height);
        }
        return this.targetFailed ? null : this.deckFramebuffer;
    }

    /** Resolves the completed scene and shades nearby lower surfaces when the pipeline is ready. */
    render(viewport: Viewport): void {
        if (this.targetFailed || !this.colorTexture || !this.depthTexture
            || !this.sceneFramebuffer || !this.resolvedFramebuffer) {
            return;
        }
        this.resolveScene();
        const projectionZ = viewport.projectionMatrix[10];
        const projectionW = viewport.projectionMatrix[14];
        if (!Number.isFinite(projectionZ) || !Number.isFinite(projectionW) || projectionW === 0) {
            return;
        }
        this.model.setBindings({
            contactColorTexture: this.colorTexture,
            contactDepthTexture: this.depthTexture
        });
        this.model.shaderInputs.setProps({
            contactShading: {
                projectionTerms: [projectionZ, projectionW],
                opacity: CONTACT_SHADING_OPACITY
            }
        });
        const pass = this.device.beginRenderPass({
            framebuffer: this.device.getDefaultCanvasContext().getCurrentFramebuffer(),
            clearColor: false,
            clearDepth: false,
            clearStencil: false
        });
        this.model.draw(pass);
        pass.end();
        this.device.submit();
    }

    /** Releases the fullscreen pipeline and every raw or luma-owned render target. */
    destroy(): void {
        this.deckFramebuffer?.destroy();
        this.deckFramebuffer = null;
        this.colorTexture?.destroy();
        this.colorTexture = null;
        this.depthTexture?.destroy();
        this.depthTexture = null;
        if (this.colorTextureHandle) {
            this.gl.deleteTexture(this.colorTextureHandle);
            this.colorTextureHandle = null;
        }
        if (this.depthTextureHandle) {
            this.gl.deleteTexture(this.depthTextureHandle);
            this.depthTextureHandle = null;
        }
        if (this.sceneFramebuffer) {
            this.gl.deleteFramebuffer(this.sceneFramebuffer);
            this.sceneFramebuffer = null;
        }
        if (this.resolvedFramebuffer) {
            this.gl.deleteFramebuffer(this.resolvedFramebuffer);
            this.resolvedFramebuffer = null;
        }
        if (this.sceneColorBuffer) {
            this.gl.deleteRenderbuffer(this.sceneColorBuffer);
            this.sceneColorBuffer = null;
        }
        if (this.sceneDepthBuffer) {
            this.gl.deleteRenderbuffer(this.sceneDepthBuffer);
            this.sceneDepthBuffer = null;
        }
        this.model.destroy();
    }

    /** Reads the canvas attachment layout needed for format-identical MSAA resolves. */
    private readCanvasFormat(): ContactDepthFormat | null {
        const previousReadFramebuffer = this.gl.getParameter(
            this.gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, null);
        try {
            const colorBits = [this.gl.RED_BITS, this.gl.GREEN_BITS, this.gl.BLUE_BITS, this.gl.ALPHA_BITS]
                .map(parameter => this.gl.getParameter(parameter) as number);
            if (colorBits.some(bits => bits !== 8)) {
                console.warn(`Contact shading disabled: unsupported canvas color bits ${colorBits}.`);
                return null;
            }
            const depthBits = this.gl.getParameter(this.gl.DEPTH_BITS) as number;
            const componentType = this.gl.getFramebufferAttachmentParameter(
                this.gl.READ_FRAMEBUFFER,
                this.gl.DEPTH,
                this.gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) as number;
            const samples = this.gl.getParameter(this.gl.SAMPLES) as number;
            if (componentType === this.gl.FLOAT && depthBits === 32) {
                return {
                    texture: "depth32float",
                    renderbuffer: this.gl.DEPTH_COMPONENT32F,
                    pixelType: this.gl.FLOAT,
                    samples
                };
            }
            if (componentType === this.gl.UNSIGNED_NORMALIZED && depthBits === 24) {
                return {
                    texture: "depth24plus",
                    renderbuffer: this.gl.DEPTH_COMPONENT24,
                    pixelType: this.gl.UNSIGNED_INT,
                    samples
                };
            }
            if (componentType === this.gl.UNSIGNED_NORMALIZED && depthBits === 16) {
                return {
                    texture: "depth16unorm",
                    renderbuffer: this.gl.DEPTH_COMPONENT16,
                    pixelType: this.gl.UNSIGNED_SHORT,
                    samples
                };
            }
            console.warn(
                `Contact shading disabled: unsupported canvas depth format ${depthBits}/${componentType}.`);
            return null;
        } finally {
            this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, previousReadFramebuffer);
        }
    }

    /** Creates stable framebuffer objects whose attachment storage can be resized in place. */
    private ensureTargetObjects(): boolean {
        if (this.deckFramebuffer) {
            return true;
        }
        this.sceneFramebuffer = this.gl.createFramebuffer();
        this.sceneColorBuffer = this.gl.createRenderbuffer();
        this.sceneDepthBuffer = this.gl.createRenderbuffer();
        this.resolvedFramebuffer = this.gl.createFramebuffer();
        this.colorTextureHandle = this.gl.createTexture();
        this.depthTextureHandle = this.gl.createTexture();
        if (!this.sceneFramebuffer || !this.sceneColorBuffer
            || !this.sceneDepthBuffer || !this.resolvedFramebuffer
            || !this.colorTextureHandle || !this.depthTextureHandle) {
            this.failTarget("failed to allocate framebuffer objects");
            return false;
        }
        this.colorTexture = this.device.createTexture({
            id: "deck-contact-color",
            handle: this.colorTextureHandle,
            _isHandleBorrowed: true,
            format: "rgba8unorm",
            width: 1,
            height: 1
        });
        this.depthTexture = this.device.createTexture({
            id: "deck-contact-depth",
            handle: this.depthTextureHandle,
            _isHandleBorrowed: true,
            format: this.depthFormat!.texture,
            width: 1,
            height: 1
        });
        this.deckFramebuffer = this.device.createFramebuffer({
            id: "deck-contact-scene",
            handle: this.sceneFramebuffer,
            width: 1,
            height: 1
        });
        return true;
    }

    /** Allocates color, depth, and resolved-depth storage for the current drawing buffer size. */
    private allocateTargetStorage(width: number, height: number): void {
        if (!this.depthFormat || !this.deckFramebuffer || !this.sceneFramebuffer
            || !this.sceneColorBuffer || !this.sceneDepthBuffer || !this.resolvedFramebuffer) {
            return;
        }
        const previousFramebuffer = this.gl.getParameter(
            this.gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        const previousRenderbuffer = this.gl.getParameter(
            this.gl.RENDERBUFFER_BINDING) as WebGLRenderbuffer | null;
        try {
            this.allocateTexture(
                this.colorTexture!,
                this.gl.RGBA8,
                this.gl.RGBA,
                this.gl.UNSIGNED_BYTE,
                width,
                height
            );
            this.allocateTexture(
                this.depthTexture!,
                this.depthFormat.renderbuffer,
                this.gl.DEPTH_COMPONENT,
                this.depthFormat.pixelType,
                width,
                height
            );
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.sceneFramebuffer);
            this.allocateRenderbuffer(this.sceneColorBuffer, this.gl.RGBA8, width, height);
            this.gl.framebufferRenderbuffer(
                this.gl.FRAMEBUFFER,
                this.gl.COLOR_ATTACHMENT0,
                this.gl.RENDERBUFFER,
                this.sceneColorBuffer
            );
            this.allocateRenderbuffer(
                this.sceneDepthBuffer,
                this.depthFormat.renderbuffer,
                width,
                height
            );
            this.gl.framebufferRenderbuffer(
                this.gl.FRAMEBUFFER,
                this.gl.DEPTH_ATTACHMENT,
                this.gl.RENDERBUFFER,
                this.sceneDepthBuffer
            );
            this.gl.drawBuffers([this.gl.COLOR_ATTACHMENT0]);
            this.gl.readBuffer(this.gl.COLOR_ATTACHMENT0);
            if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER)
                !== this.gl.FRAMEBUFFER_COMPLETE) {
                this.failTarget("scene framebuffer is incomplete");
                return;
            }

            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.resolvedFramebuffer);
            this.gl.framebufferTexture2D(
                this.gl.FRAMEBUFFER,
                this.gl.COLOR_ATTACHMENT0,
                this.gl.TEXTURE_2D,
                this.colorTextureHandle,
                0
            );
            this.gl.framebufferTexture2D(
                this.gl.FRAMEBUFFER,
                this.gl.DEPTH_ATTACHMENT,
                this.gl.TEXTURE_2D,
                this.depthTextureHandle,
                0
            );
            this.gl.drawBuffers([this.gl.COLOR_ATTACHMENT0]);
            this.gl.readBuffer(this.gl.COLOR_ATTACHMENT0);
            if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER)
                !== this.gl.FRAMEBUFFER_COMPLETE) {
                this.failTarget("resolved scene framebuffer is incomplete");
                return;
            }
            this.deckFramebuffer.width = width;
            this.deckFramebuffer.height = height;
            this.targetWidth = width;
            this.targetHeight = height;
        } finally {
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, previousFramebuffer);
            this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, previousRenderbuffer);
        }
    }

    /** Allocates one renderbuffer with the canvas sample count, including the non-MSAA case. */
    private allocateRenderbuffer(
        target: WebGLRenderbuffer,
        format: number,
        width: number,
        height: number
    ): void {
        this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, target);
        const samples = this.depthFormat?.samples ?? 0;
        if (samples > 0) {
            this.gl.renderbufferStorageMultisample(
                this.gl.RENDERBUFFER,
                samples,
                format,
                width,
                height
            );
        } else {
            this.gl.renderbufferStorage(this.gl.RENDERBUFFER, format, width, height);
        }
    }

    /** Resizes one stable borrowed texture without invalidating luma's tracked bindings. */
    private allocateTexture(
        texture: Texture,
        internalFormat: number,
        format: number,
        type: number,
        width: number,
        height: number
    ): void {
        const resource = texture as MutableWebGlTextureResource;
        const previousBinding = this.gl.getParameter(
            this.gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
        this.gl.bindTexture(this.gl.TEXTURE_2D, resource.handle);
        this.gl.texImage2D(
            this.gl.TEXTURE_2D,
            0,
            internalFormat,
            width,
            height,
            0,
            format,
            type,
            null
        );
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.bindTexture(this.gl.TEXTURE_2D, previousBinding);
        resource.width = width;
        resource.height = height;
        resource.updateTimestamp = this.device.incrementTimestamp();
    }

    /** Resolves multisampled scene color and depth into sampleable textures. */
    private resolveScene(): void {
        const previousReadFramebuffer = this.gl.getParameter(
            this.gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        const previousDrawFramebuffer = this.gl.getParameter(
            this.gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        const scissorEnabled = this.gl.isEnabled(this.gl.SCISSOR_TEST);
        try {
            this.gl.disable(this.gl.SCISSOR_TEST);
            this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, this.sceneFramebuffer);
            this.gl.bindFramebuffer(this.gl.DRAW_FRAMEBUFFER, this.resolvedFramebuffer);
            this.gl.blitFramebuffer(
                0, 0, this.targetWidth, this.targetHeight,
                0, 0, this.targetWidth, this.targetHeight,
                this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT,
                this.gl.NEAREST
            );
        } finally {
            this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, previousReadFramebuffer);
            this.gl.bindFramebuffer(this.gl.DRAW_FRAMEBUFFER, previousDrawFramebuffer);
            if (scissorEnabled) {
                this.gl.enable(this.gl.SCISSOR_TEST);
            }
        }
    }

    /** Permanently disables this optional pass after an allocation or completeness failure. */
    private failTarget(reason: string): void {
        this.targetFailed = true;
        console.warn(`Contact shading disabled: ${reason}.`);
    }
}
