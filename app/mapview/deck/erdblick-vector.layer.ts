import {
  COORDINATE_SYSTEM,
  Layer,
  picking,
  project32,
  type LayerProps,
  type PickingInfo,
  type UpdateParameters,
} from "@deck.gl/core";
import type {
  BufferLayout,
  RenderPipelineParameters,
  Texture,
} from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";

import { GpuMaterialFlag, GpuPrimitiveKind } from "./gpu-render-packet";
import { GpuScene, type GpuSceneMaterialStore } from "./gpu-scene";
import {
  ARROW_FRAGMENT_SHADER,
  ARROW_BILLBOARD_VERTEX_SHADER,
  ARROW_WORLD_VERTEX_SHADER,
  COMPACT_PATH_BILLBOARD_VERTEX_SHADER,
  COMPACT_PATH_FRAGMENT_SHADER,
  COMPACT_PATH_WORLD_VERTEX_SHADER,
  DUAL_COMPACT_PATH_BILLBOARD_VERTEX_SHADER,
  DUAL_COMPACT_PATH_FRAGMENT_SHADER,
  DUAL_COMPACT_PATH_WORLD_VERTEX_SHADER,
  DUAL_SIMPLE_PATH_BILLBOARD_VERTEX_SHADER,
  DUAL_SIMPLE_PATH_FRAGMENT_SHADER,
  DUAL_SIMPLE_PATH_WORLD_VERTEX_SHADER,
  GpuSceneMaskMode,
  type GpuSceneShaderProps,
  gpuSceneShaderModule,
  gpuSceneSemanticOverlayShaderModule,
  gpuSceneSemanticSupportShaderModule,
  gpuSceneMaskShaderModule,
  gpuSceneMaskFragmentShader,
  gpuSceneMaskVertexShader,
  ICON_BILLBOARD_VERTEX_SHADER,
  ICON_FRAGMENT_SHADER,
  ICON_VERTEX_SHADER,
  PATH_BILLBOARD_VERTEX_SHADER,
  PATH_FRAGMENT_SHADER,
  PATH_WORLD_VERTEX_SHADER,
  POINT_BILLBOARD_VERTEX_SHADER,
  POINT_FRAGMENT_SHADER,
  POINT_RING_FRAGMENT_SHADER,
  POINT_VERTEX_SHADER,
  SIMPLE_PATH_BILLBOARD_VERTEX_SHADER,
  SIMPLE_PATH_FRAGMENT_SHADER,
  SIMPLE_PATH_WORLD_VERTEX_SHADER,
  SURFACE_FRAGMENT_SHADER,
  SURFACE_VERTEX_SHADER,
} from "./erdblick-vector.shaders";
import { gpuIconAtlasService } from "./gpu-icon-atlas.service";
import { INTERACTION_STYLE_ORDER_BASE } from "./tile-subset-interaction.model";

const DEPTH_PARAMETERS: RenderPipelineParameters = {
  depthCompare: "less-equal",
  depthWriteEnabled: true,
};
const NO_DEPTH_PARAMETERS: RenderPipelineParameters = {
  depthCompare: "always",
  depthWriteEnabled: false,
};
const MASK_DEPTH_PARAMETERS: RenderPipelineParameters = {
  depthCompare: "less-equal",
  depthWriteEnabled: false,
};
const MASK_NO_DEPTH_PARAMETERS: RenderPipelineParameters = {
  depthCompare: "always",
  depthWriteEnabled: false,
};
const SEMANTIC_DEPTH_PARAMETERS: RenderPipelineParameters = {
  depthCompare: "less-equal",
  depthWriteEnabled: true,
  blend: false,
};
// WebGL presents a 24-bit depth buffer. Four quantized depth values separate
// primitive kinds inside the vector pass without changing physical deck order.
const PRIMITIVE_DEPTH_BIAS_STEP = 8 / 0x00ff_ffff;
// Drill picking disables every object already returned by the picker. Keep
// this above the configurable inspection limit so overlapping vector objects
// cannot reappear before Deck finishes one drill-pick operation.
const MAX_DISABLED_PICK_INDICES = 64;

const POINT_LAYOUT: BufferLayout[] = [
  {
    name: "instances",
    stepMode: "instance",
    byteStride: 40,
    attributes: [
      { attribute: "instancePosition", format: "float32x3", byteOffset: 0 },
      { attribute: "instanceRadius", format: "float32", byteOffset: 12 },
      { attribute: "instanceZIndex", format: "uint32", byteOffset: 16 },
      { attribute: "instanceColor", format: "unorm8x4", byteOffset: 20 },
      { attribute: "instanceMetadata", format: "uint32x4", byteOffset: 24 },
    ],
  },
];

const PATH_LAYOUT: BufferLayout[] = [
  {
    name: "instances",
    stepMode: "instance",
    byteStride: 148,
    attributes: [
      { attribute: "instancePrevious", format: "float32x3", byteOffset: 0 },
      { attribute: "instanceStart", format: "float32x3", byteOffset: 12 },
      { attribute: "instanceEnd", format: "float32x3", byteOffset: 24 },
      { attribute: "instanceNext", format: "float32x3", byteOffset: 36 },
      {
        attribute: "instanceOffsetVectors01",
        format: "float32x4",
        byteOffset: 48,
      },
      {
        attribute: "instanceOffsetVectors23",
        format: "float32x4",
        byteOffset: 64,
      },
      {
        attribute: "instanceScalarOffsets",
        format: "float32x4",
        byteOffset: 80,
      },
      { attribute: "instancePathStyle", format: "float32x4", byteOffset: 96 },
      {
        attribute: "instancePathMetrics",
        format: "float32x3",
        byteOffset: 112,
      },
      { attribute: "instanceZIndex", format: "uint32", byteOffset: 124 },
      { attribute: "instanceColor", format: "unorm8x4", byteOffset: 128 },
      { attribute: "instanceMetadata", format: "uint32x4", byteOffset: 132 },
    ],
  },
];

const COMPACT_PATH_LAYOUT: BufferLayout[] = [
  {
    name: "instances",
    stepMode: "instance",
    byteStride: 76,
    attributes: [
      { attribute: "instancePrevious", format: "float32x3", byteOffset: 0 },
      { attribute: "instanceStart", format: "float32x3", byteOffset: 12 },
      { attribute: "instanceEnd", format: "float32x3", byteOffset: 24 },
      { attribute: "instanceNext", format: "float32x3", byteOffset: 36 },
      { attribute: "instancePathWidth", format: "float32", byteOffset: 48 },
      { attribute: "instanceZIndex", format: "uint32", byteOffset: 52 },
      { attribute: "instanceColor", format: "unorm8x4", byteOffset: 56 },
      { attribute: "instanceMetadata", format: "uint32x4", byteOffset: 60 },
    ],
  },
];

const SIMPLE_PATH_LAYOUT: BufferLayout[] = [
  {
    name: "instances",
    stepMode: "instance",
    byteStride: 52,
    attributes: [
      { attribute: "instanceStart", format: "float32x3", byteOffset: 0 },
      { attribute: "instanceEnd", format: "float32x3", byteOffset: 12 },
      { attribute: "instancePathWidth", format: "float32", byteOffset: 24 },
      { attribute: "instanceZIndex", format: "uint32", byteOffset: 28 },
      { attribute: "instanceColor", format: "unorm8x4", byteOffset: 32 },
      { attribute: "instanceMetadata", format: "uint32x4", byteOffset: 36 },
    ],
  },
];

const DUAL_COMPACT_PATH_LAYOUT: BufferLayout[] = [
  {
    name: "instances",
    stepMode: "instance",
    byteStride: 84,
    attributes: [
      { attribute: "instancePrevious", format: "float32x3", byteOffset: 0 },
      { attribute: "instanceStart", format: "float32x3", byteOffset: 12 },
      { attribute: "instanceEnd", format: "float32x3", byteOffset: 24 },
      { attribute: "instanceNext", format: "float32x3", byteOffset: 36 },
      { attribute: "instancePathWidth", format: "float32", byteOffset: 48 },
      { attribute: "instanceZIndex", format: "uint32", byteOffset: 52 },
      { attribute: "instanceColor", format: "unorm8x4", byteOffset: 56 },
      { attribute: "instanceMetadata", format: "uint32x4", byteOffset: 60 },
      {
        attribute: "instanceInnerPathWidth",
        format: "float32",
        byteOffset: 76,
      },
      { attribute: "instanceInnerColor", format: "unorm8x4", byteOffset: 80 },
    ],
  },
];

const DUAL_SIMPLE_PATH_LAYOUT: BufferLayout[] = [
  {
    name: "instances",
    stepMode: "instance",
    byteStride: 60,
    attributes: [
      { attribute: "instanceStart", format: "float32x3", byteOffset: 0 },
      { attribute: "instanceEnd", format: "float32x3", byteOffset: 12 },
      { attribute: "instancePathWidth", format: "float32", byteOffset: 24 },
      { attribute: "instanceZIndex", format: "uint32", byteOffset: 28 },
      { attribute: "instanceColor", format: "unorm8x4", byteOffset: 32 },
      { attribute: "instanceMetadata", format: "uint32x4", byteOffset: 36 },
      {
        attribute: "instanceInnerPathWidth",
        format: "float32",
        byteOffset: 52,
      },
      { attribute: "instanceInnerColor", format: "unorm8x4", byteOffset: 56 },
    ],
  },
];

const ARROW_LAYOUT: BufferLayout[] = [
  {
    name: "instances",
    stepMode: "instance",
    byteStride: 68,
    attributes: [
      { attribute: "instancePrevious", format: "float32x3", byteOffset: 0 },
      { attribute: "instanceTip", format: "float32x3", byteOffset: 12 },
      {
        attribute: "instanceOffsetVector",
        format: "float32x2",
        byteOffset: 24,
      },
      { attribute: "instanceArrowStyle", format: "float32x3", byteOffset: 32 },
      { attribute: "instanceZIndex", format: "uint32", byteOffset: 44 },
      { attribute: "instanceColor", format: "unorm8x4", byteOffset: 48 },
      { attribute: "instanceMetadata", format: "uint32x4", byteOffset: 52 },
    ],
  },
];

const SURFACE_LAYOUT: BufferLayout[] = [
  {
    name: "instances",
    stepMode: "instance",
    byteStride: 60,
    attributes: [
      { attribute: "instancePosition0", format: "float32x3", byteOffset: 0 },
      { attribute: "instancePosition1", format: "float32x3", byteOffset: 12 },
      { attribute: "instancePosition2", format: "float32x3", byteOffset: 24 },
      { attribute: "instanceZIndex", format: "uint32", byteOffset: 36 },
      { attribute: "instanceColor", format: "unorm8x4", byteOffset: 40 },
      { attribute: "instanceMetadata", format: "uint32x4", byteOffset: 44 },
    ],
  },
];

const ICON_LAYOUT: BufferLayout[] = [
  {
    name: "instances",
    stepMode: "instance",
    byteStride: 68,
    attributes: [
      { attribute: "instancePosition", format: "float32x3", byteOffset: 0 },
      { attribute: "instancePixelSize", format: "float32x2", byteOffset: 12 },
      { attribute: "instancePixelOffset", format: "float32x2", byteOffset: 20 },
      { attribute: "instanceUv", format: "float32x4", byteOffset: 28 },
      { attribute: "instanceZIndex", format: "uint32", byteOffset: 44 },
      { attribute: "instanceColor", format: "unorm8x4", byteOffset: 48 },
      { attribute: "instanceMetadata", format: "uint32x4", byteOffset: 52 },
    ],
  },
];

/** Picking object returned without retaining a geometry-sized JavaScript data array. */
export interface ErdblickVectorPickObject {
  globalPickIndex: number;
}

/** Stable layer shell around one view-owned persistent GPU scene. */
export type ErdblickVectorLayerProps = LayerProps & {
  scene: GpuScene;
  flattenZ: boolean;
  primitiveKinds?: readonly GpuPrimitiveKind[];
  sharedDisabledPickIndices?: Set<number>;
  drillPickEligible?: boolean;
  navigationAnchorEligible?: boolean;
  navigationAltitudeResolver?: (globalPickIndex: number) => number | undefined;
  markerAnchorEligible?: boolean;
  renderMode?: ErdblickVectorRenderMode;
  minimumStyleOrder?: number;
  maximumStyleOrderExclusive?: number;
};

/** Select the visible, support-prepass, or overlay-resolution material subset. */
export enum ErdblickVectorRenderMode {
  Visible = "visible",
  SemanticSupport = "semantic-support",
  SemanticOverlay = "semantic-overlay",
}

interface MaterialModel {
  model: Model;
  source: GpuSceneMaterialStore;
  bufferRevision: number;
  shaderPropsRevision: number;
}

/** Test immutable scene bindings without making luma re-flatten equal props. */
function sameSceneShaderProps(
  left: GpuSceneShaderProps | null,
  right: GpuSceneShaderProps,
): boolean {
  return (
    !!left &&
    left.originTexture === right.originTexture &&
    left.contributionTexture === right.contributionTexture &&
    left.zIndexTexture === right.zIndexTexture &&
    left.lookupTextureWidth === right.lookupTextureWidth &&
    left.flattenZ === right.flattenZ &&
    left.primitiveDepthBias === right.primitiveDepthBias &&
    left.semanticRole === right.semanticRole &&
    left.disabledPickIndices.length === right.disabledPickIndices.length &&
    left.disabledPickIndices.every(
      (value, index) => value === right.disabledPickIndices[index],
    )
  );
}

/** Return the fixed semantic pass for one primitive kind. */
function primitiveRenderPass(kind: number): number {
  switch (kind) {
    case GpuPrimitiveKind.SurfaceTriangle:
      return 0;
    case GpuPrimitiveKind.PathSegment:
      return 1;
    case GpuPrimitiveKind.Point:
      return 2;
    case GpuPrimitiveKind.Arrow:
      return 3;
    case GpuPrimitiveKind.Icon:
      return 4;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

/** Separate coplanar primitive passes by four 24-bit depth-buffer values. */
function primitiveDepthBias(kind: number): number {
  const pass = primitiveRenderPass(kind);
  return pass === Number.MAX_SAFE_INTEGER
    ? 0
    : pass * PRIMITIVE_DEPTH_BIAS_STEP;
}

/** Order low-cardinality material models deterministically across packet arrival order. */
function compareMaterialModels(
  left: MaterialModel,
  right: MaterialModel,
): number {
  const primitivePass =
    primitiveRenderPass(left.source.kind) -
    primitiveRenderPass(right.source.kind);
  if (primitivePass !== 0) {
    // Draw coplanar semantic overlays after their supporting surfaces, but let
    // the depth buffer preserve the physical order of vertically stacked data.
    return primitivePass;
  }
  const styleOrder = left.source.styleOrder - right.source.styleOrder;
  if (styleOrder !== 0) {
    return styleOrder;
  }
  const ruleOrder = left.source.renderOrder - right.source.renderOrder;
  if (ruleOrder !== 0) {
    return ruleOrder;
  }
  const leftKey = left.source.store.materialKey;
  const rightKey = right.source.store.materialKey;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/** Returns fixed GPU parameters for the material's authored depth policy. */
function materialParameters(
  flags: number,
  mask = false,
): RenderPipelineParameters {
  const depthTest = (flags & GpuMaterialFlag.DepthTest) !== 0;
  return depthTest
    ? mask
      ? MASK_DEPTH_PARAMETERS
      : DEPTH_PARAMETERS
    : mask
      ? MASK_NO_DEPTH_PARAMETERS
      : NO_DEPTH_PARAMETERS;
}

/** Return the shader-side semantic role encoded by one immutable material. */
function semanticRole(flags: number): number {
  if ((flags & GpuMaterialFlag.SemanticSupport) !== 0) {
    return 1;
  }
  if ((flags & GpuMaterialFlag.SemanticOverlay) !== 0) {
    return 2;
  }
  return 0;
}

/** Neutralize Deck's layer-index bias because scene materials own depth ordering. */
export const NO_POLYGON_OFFSET = () => [0, 0] as [number, number];

/** Fixed-depth component of the established coplanar vector polygon offset. */
export const VECTOR_POLYGON_OFFSET_DEPTH_UNITS = 80;

/** Pull vector triangles over supporting surfaces with slope-aware hardware depth bias. */
export const VECTOR_POLYGON_OFFSET = () =>
  [-2, -VECTOR_POLYGON_OFFSET_DEPTH_UNITS] as [number, number];

/** Builds the immutable six-vertex mesh expanded into one path segment. */
function pathGeometry(): Geometry {
  return new Geometry({
    topology: "triangle-list",
    attributes: {
      indices: new Uint16Array([0, 1, 2, 1, 4, 2, 1, 3, 4, 3, 5, 4]),
      positions: {
        size: 2,
        value: new Float32Array([0, 0, 0, -1, 0, 1, 1, -1, 1, 1, 1, 0]),
      },
    },
  });
}

/** Build the four-corner strip used by complete two-point path segments. */
function fastPathGeometry(): Geometry {
  return new Geometry({
    topology: "triangle-strip",
    attributes: {
      positions: {
        size: 2,
        value: new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]),
      },
    },
  });
}

/** Builds the fixed unit mesh for one primitive stream. */
function primitiveGeometry(source: GpuSceneMaterialStore): Geometry {
  switch (source.kind) {
    case GpuPrimitiveKind.Point:
      return new Geometry({
        topology: "triangle-strip",
        attributes: {
          positions: {
            size: 3,
            value: new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]),
          },
        },
      });
    case GpuPrimitiveKind.PathSegment:
      return (source.flags & GpuMaterialFlag.SimplePath) !== 0
        ? fastPathGeometry()
        : pathGeometry();
    case GpuPrimitiveKind.Arrow:
      return new Geometry({
        topology: "triangle-list",
        attributes: {
          positions: {
            size: 2,
            value: new Float32Array([0, 0, -0.4375, -0.9375, 0.4375, -0.9375]),
          },
        },
      });
    case GpuPrimitiveKind.SurfaceTriangle:
      return new Geometry({
        topology: "triangle-list",
        attributes: {
          positions: {
            size: 1,
            value: new Float32Array([0, 1, 2]),
          },
        },
      });
    case GpuPrimitiveKind.Icon:
      return new Geometry({
        topology: "triangle-strip",
        attributes: {
          positions: {
            size: 2,
            value: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
          },
        },
      });
    default:
      throw new Error(`GPU primitive kind ${source.kind} has no vector model.`);
  }
}

/** Compile the stream-level endpoint anchor into minimum-length path shaders. */
function screenLengthShader(shader: string, flags: number): string {
  let define = "";
  if ((flags & GpuMaterialFlag.ScreenLengthStartAnchor) !== 0) {
    define = "#define ERDBLICK_SCREEN_LENGTH_START_ANCHOR";
  } else if ((flags & GpuMaterialFlag.ScreenLengthEndAnchor) !== 0) {
    define = "#define ERDBLICK_SCREEN_LENGTH_END_ANCHOR";
  } else if ((flags & GpuMaterialFlag.ScreenLengthCenterAnchor) !== 0) {
    define = "#define ERDBLICK_SCREEN_LENGTH_CENTER_ANCHOR";
  }
  return define
    ? shader.replace("#define SHADER_NAME", `${define}\n#define SHADER_NAME`)
    : shader;
}

/** Resolve the shader pair and direct interleaved layout for one primitive stream. */
function primitiveProgram(source: GpuSceneMaterialStore): {
  vertexShader: string;
  fragmentShader: string;
  layout: BufferLayout[];
} {
  const billboard = (source.flags & GpuMaterialFlag.Billboard) !== 0;
  switch (source.kind) {
    case GpuPrimitiveKind.Point:
      return {
        vertexShader: billboard
          ? POINT_BILLBOARD_VERTEX_SHADER
          : POINT_VERTEX_SHADER,
        fragmentShader:
          (source.flags & GpuMaterialFlag.PointRing) !== 0
            ? POINT_RING_FRAGMENT_SHADER
            : POINT_FRAGMENT_SHADER,
        layout: POINT_LAYOUT,
      };
    case GpuPrimitiveKind.PathSegment:
      if ((source.flags & GpuMaterialFlag.DualStrokePath) !== 0) {
        if ((source.flags & GpuMaterialFlag.SimplePath) !== 0) {
          return {
            vertexShader: billboard
              ? DUAL_SIMPLE_PATH_BILLBOARD_VERTEX_SHADER
              : DUAL_SIMPLE_PATH_WORLD_VERTEX_SHADER,
            fragmentShader: DUAL_SIMPLE_PATH_FRAGMENT_SHADER,
            layout: DUAL_SIMPLE_PATH_LAYOUT,
          };
        }
        return {
          vertexShader: billboard
            ? DUAL_COMPACT_PATH_BILLBOARD_VERTEX_SHADER
            : DUAL_COMPACT_PATH_WORLD_VERTEX_SHADER,
          fragmentShader: DUAL_COMPACT_PATH_FRAGMENT_SHADER,
          layout: DUAL_COMPACT_PATH_LAYOUT,
        };
      }
      if ((source.flags & GpuMaterialFlag.SimplePath) !== 0) {
        return {
          vertexShader: billboard
            ? SIMPLE_PATH_BILLBOARD_VERTEX_SHADER
            : SIMPLE_PATH_WORLD_VERTEX_SHADER,
          fragmentShader: SIMPLE_PATH_FRAGMENT_SHADER,
          layout: SIMPLE_PATH_LAYOUT,
        };
      }
      if ((source.flags & GpuMaterialFlag.CompactPath) !== 0) {
        return {
          vertexShader: billboard
            ? COMPACT_PATH_BILLBOARD_VERTEX_SHADER
            : COMPACT_PATH_WORLD_VERTEX_SHADER,
          fragmentShader: COMPACT_PATH_FRAGMENT_SHADER,
          layout: COMPACT_PATH_LAYOUT,
        };
      }
      return {
        vertexShader: screenLengthShader(
          billboard ? PATH_BILLBOARD_VERTEX_SHADER : PATH_WORLD_VERTEX_SHADER,
          source.flags,
        ),
        fragmentShader: PATH_FRAGMENT_SHADER,
        layout: PATH_LAYOUT,
      };
    case GpuPrimitiveKind.Arrow:
      return {
        vertexShader: screenLengthShader(
          billboard ? ARROW_BILLBOARD_VERTEX_SHADER : ARROW_WORLD_VERTEX_SHADER,
          source.flags,
        ),
        fragmentShader: ARROW_FRAGMENT_SHADER,
        layout: ARROW_LAYOUT,
      };
    case GpuPrimitiveKind.SurfaceTriangle:
      return {
        vertexShader: SURFACE_VERTEX_SHADER,
        fragmentShader: SURFACE_FRAGMENT_SHADER,
        layout: SURFACE_LAYOUT,
      };
    case GpuPrimitiveKind.Icon:
      return {
        vertexShader: billboard
          ? ICON_BILLBOARD_VERTEX_SHADER
          : ICON_VERTEX_SHADER,
        fragmentShader: ICON_FRAGMENT_SHADER,
        layout: ICON_LAYOUT,
      };
    default:
      throw new Error(`GPU primitive kind ${source.kind} is unsupported.`);
  }
}

/**
 * Draws every ordinary Erdblick vector contribution through persistent luma models.
 *
 * The layer object and model count stay stable while packets overwrite ranges in
 * the scene-owned buffers. Deck still installs projection and picking uniforms;
 * this class only binds scene lookup tables and direct interleaved instance data.
 */
export class ErdblickVectorLayer extends Layer<ErdblickVectorLayerProps> {
  static override layerName = "ErdblickVectorLayer";

  private readonly materialModels = new Map<bigint, MaterialModel>();
  private readonly disabledPickIndices: Set<number>;
  private sceneRevision = -1;
  private sceneShaderProps: GpuSceneShaderProps | null = null;
  private sceneShaderPropsRevision = 0;
  private semanticSupportTexture: Texture | null = null;
  private initialized = false;

  /** Retain a view-wide drill-pick suppression set across fixed render-pass shells. */
  constructor(props: ErdblickVectorLayerProps) {
    super(props);
    this.disabledPickIndices =
      props.sharedDisabledPickIndices ?? new Set<number>();
  }

  /** Disable Deck's geometry-sized attribute manager; scene buffers are authoritative. */
  protected override _getAttributeManager(): null {
    return null;
  }

  /** Create all material models already present when Deck initializes the layer. */
  override initializeState(): void {
    this.initialized = true;
    this.syncModels();
    this.bindSceneShaderProps();
  }

  /** Rebind the scene if Deck ever reconciles this shell with another view generation. */
  override updateState({ props, oldProps }: UpdateParameters<this>): void {
    if (props.scene !== oldProps.scene) {
      this.destroyModels();
      this.sceneRevision = -1;
    }
    this.syncModels();
    this.bindSceneShaderProps();
  }

  /** Destroy only model-owned static meshes; GpuScene owns all instance buffers. */
  override finalizeState(): void {
    this.initialized = false;
    this.destroyModels();
  }

  /** Return persistent models so Deck can apply projection and picking module props. */
  override getModels(): Model[] {
    return [...this.materialModels.values()]
      .sort(compareMaterialModels)
      .map((item) => item.model);
  }

  /** Notify the stable shell after a packet upload without replacing Deck's layer array. */
  sceneChanged(): void {
    if (!this.initialized) {
      return;
    }
    this.syncModels();
    // Rebind before GpuScene retires the previous presentation. A model
    // filtered out of the next frame cannot rely on draw() to drop its old
    // lookup texture references.
    this.bindSceneShaderProps();
    this.setNeedsRedraw();
  }

  /** Bind the completed support-group texture consumed by the overlay pass. */
  setSemanticSupportTexture(texture: Texture | null): void {
    if (this.semanticSupportTexture === texture) {
      return;
    }
    this.semanticSupportTexture = texture;
    this.sceneShaderPropsRevision += 1;
    this.bindSceneShaderProps();
  }

  /** Resolve Deck's decoded object index without constructing a CPU data mirror. */
  override getPickingInfo({
    info,
  }: {
    info: PickingInfo<ErdblickVectorPickObject>;
    mode: string;
  }): PickingInfo<ErdblickVectorPickObject> {
    return {
      ...info,
      object: info.index >= 0 ? { globalPickIndex: info.index } : undefined,
      sourceLayer: this,
    };
  }

  /** Temporarily suppress one scene-global object index during drill picking. */
  override disablePickingIndex(objectIndex: number): void {
    if (
      Number.isInteger(objectIndex) &&
      objectIndex >= 0 &&
      this.disabledPickIndices.size < MAX_DISABLED_PICK_INDICES
    ) {
      this.disabledPickIndices.add(objectIndex);
      this.setNeedsRedraw();
    }
  }

  /** Restore all scene-global object indices after Deck completes a drill pick. */
  override restorePickingColors(): void {
    if (this.disabledPickIndices.size) {
      this.disabledPickIndices.clear();
      this.setNeedsRedraw();
    }
  }

  /** Bind compact scene tables and issue exactly one draw per material model. */
  override draw({ renderPass }: { renderPass: unknown }): void {
    if (!this.bindSceneShaderProps()) {
      return;
    }
    for (const item of [...this.materialModels.values()].sort(
      compareMaterialModels,
    )) {
      if (item.source.store.presentedHighWaterRecord <= 0) {
        continue;
      }
      if (!item.model.draw(renderPass as never)) {
        this.setNeedsRedraw();
      }
    }
  }

  /**
   * Bind the current presentation to every retained model, including models
   * omitted from the next visible pass by Deck's layer filter.
   */
  private bindSceneShaderProps(): boolean {
    const shaderProps = this.currentSceneShaderProps();
    if (!shaderProps) {
      return false;
    }
    for (const item of this.materialModels.values()) {
      if (item.shaderPropsRevision === this.sceneShaderPropsRevision) {
        continue;
      }
      item.model.shaderInputs.setProps({
        gpuScene: {
          ...shaderProps,
          primitiveDepthBias: primitiveDepthBias(item.source.kind),
          semanticRole: semanticRole(item.source.flags),
        },
      });
      if (
        this.props.renderMode ===
          ErdblickVectorRenderMode.SemanticOverlay &&
        this.semanticSupportTexture
      ) {
        item.model.shaderInputs.setProps({
          gpuSceneSemanticOverlay: {
            supportGroupTexture: this.semanticSupportTexture,
          },
        });
      }
      // ShaderInputs is only the declarative source. Flush it into Model.bindings
      // now so a deferred picking/mask pass cannot retain the old texture after
      // GpuScene's end-of-frame retirement.
      item.model.updateShaderInputs();
      item.shaderPropsRevision = this.sceneShaderPropsRevision;
    }
    return true;
  }

  /** Reuse scene textures and static uniforms until their identity really changes. */
  private currentSceneShaderProps(): GpuSceneShaderProps | null {
    const originTexture = this.props.scene.originTexture;
    const contributionTexture = this.props.scene.contributionTexture;
    const zIndexTexture = this.props.scene.zIndexTexture;
    if (!originTexture || !contributionTexture || !zIndexTexture) {
      return null;
    }
    const next: GpuSceneShaderProps = {
      originTexture,
      contributionTexture,
      zIndexTexture,
      lookupTextureWidth: this.props.scene.lookupTextureWidth,
      flattenZ: this.props.flattenZ,
      primitiveDepthBias: 0,
      semanticRole: 0,
      disabledPickIndices: [...this.disabledPickIndices],
    };
    if (!sameSceneShaderProps(this.sceneShaderProps, next)) {
      this.sceneShaderProps = next;
      this.sceneShaderPropsRevision += 1;
    }
    return this.sceneShaderProps;
  }

  /** Create/rebind only low-cardinality material models after scene mutation. */
  private syncModels(): void {
    if (
      !this.initialized ||
      this.sceneRevision === this.props.scene.presentationRevision
    ) {
      return;
    }
    const desired = new Set<bigint>();
    for (const source of this.props.scene.materialStores()) {
      if (!this.acceptsRenderMode(source.flags)) {
        continue;
      }
      if (!this.acceptsStyleOrder(source.styleOrder)) {
        continue;
      }
      if (
        this.props.primitiveKinds &&
        !this.props.primitiveKinds.includes(source.kind)
      ) {
        continue;
      }
      const store = source.store;
      const buffer = store.presentedBuffer;
      if (!buffer) {
        continue;
      }
      desired.add(store.materialKey);
      let item = this.materialModels.get(store.materialKey);
      if (item && item.source.store !== store) {
        item.model.destroy();
        this.materialModels.delete(store.materialKey);
        item = undefined;
      }
      if (!item) {
        item = {
          model: this.createModel(source),
          source,
          bufferRevision: -1,
          shaderPropsRevision: -1,
        };
        this.materialModels.set(store.materialKey, item);
      }
      if (item.bufferRevision !== store.presentedBufferRevision) {
        item.model.setAttributes({ instances: buffer });
        item.bufferRevision = store.presentedBufferRevision;
      }
      if (source.kind === GpuPrimitiveKind.Icon) {
        item.model.setBindings({
          gpuIconAtlasTexture: gpuIconAtlasService.texture(
            this.context.device,
            source.atlasPage,
          ),
        });
      }
      item.model.setInstanceCount(store.presentedHighWaterRecord);
    }
    for (const [materialKey, item] of this.materialModels) {
      if (!desired.has(materialKey)) {
        item.model.destroy();
        this.materialModels.delete(materialKey);
      }
    }
    this.sceneRevision = this.props.scene.presentationRevision;
  }

  /** Restrict ordinary and hidden passes to their immutable semantic role. */
  private acceptsRenderMode(flags: number): boolean {
    switch (this.props.renderMode ?? ErdblickVectorRenderMode.Visible) {
      case ErdblickVectorRenderMode.Visible:
        return (flags & GpuMaterialFlag.SemanticOverlay) === 0;
      case ErdblickVectorRenderMode.SemanticSupport:
        return (flags & GpuMaterialFlag.SemanticSupport) !== 0;
      case ErdblickVectorRenderMode.SemanticOverlay:
        return (flags & GpuMaterialFlag.SemanticOverlay) !== 0;
    }
  }

  /** Partition ordinary and transient materials into stable physical Deck passes. */
  private acceptsStyleOrder(styleOrder: number): boolean {
    return (
      (this.props.minimumStyleOrder === undefined ||
        styleOrder >= this.props.minimumStyleOrder) &&
      (this.props.maximumStyleOrderExclusive === undefined ||
        styleOrder < this.props.maximumStyleOrderExclusive)
    );
  }

  /** Build one material model whose instance buffer remains scene-owned. */
  private createModel(source: GpuSceneMaterialStore): Model {
    const program = primitiveProgram(source);
    const mode = this.props.renderMode ?? ErdblickVectorRenderMode.Visible;
    // Dual-stroke fragments consult Deck's picking state to render their full
    // casing outside picking passes. Hidden semantic passes are ordinary color
    // passes too, so they need the module even though they are not pickable.
    const modules = [
      project32,
      picking as never,
      gpuSceneShaderModule as never,
    ];
    if (mode === ErdblickVectorRenderMode.SemanticSupport) {
      modules.push(gpuSceneSemanticSupportShaderModule as never);
    } else if (mode === ErdblickVectorRenderMode.SemanticOverlay) {
      modules.push(gpuSceneSemanticOverlayShaderModule as never);
    }
    return new Model(this.context.device, {
      ...this.getShaders({
        vs: program.vertexShader,
        fs: program.fragmentShader,
        modules,
      }),
      id: `${this.props.id}-${source.store.materialKey.toString(16)}`,
      bufferLayout: program.layout,
      geometry: primitiveGeometry(source),
      isInstanced: true,
      parameters:
        mode === ErdblickVectorRenderMode.Visible
          ? materialParameters(source.flags)
          : SEMANTIC_DEPTH_PARAMETERS,
      colorAttachmentFormats: ["rgba8unorm"],
    });
  }

  /** Dispose all model pipelines while leaving scene-owned instance buffers intact. */
  private destroyModels(): void {
    for (const item of this.materialModels.values()) {
      item.model.destroy();
    }
    this.materialModels.clear();
  }
}

/** Mutable state for one bounded mask layer over the scene's shared buffers. */
export interface ErdblickVectorMaskConfiguration {
  targetTexture: Texture;
  mode: GpuSceneMaskMode;
  identityColor: [number, number, number, number];
  materialKeys: ReadonlySet<bigint> | null;
}

/** Props for one hidden vector pass consumed only by the outline compositor. */
export type ErdblickVectorMaskLayerProps = LayerProps & {
  scene: GpuScene;
  flattenZ: boolean;
  configuration: ErdblickVectorMaskConfiguration;
};

/**
 * Reprojects existing persistent primitive stores into a sparse interaction mask.
 *
 * This layer owns pipelines and static unit meshes only. Its instance buffers
 * are the ordinary visible scene buffers; target changes update one compact
 * texture and never copy paths, triangles, points, or arrows.
 */
export class ErdblickVectorMaskLayer extends Layer<ErdblickVectorMaskLayerProps> {
  static override layerName = "ErdblickVectorMaskLayer";

  private readonly materialModels = new Map<bigint, MaterialModel>();
  private configuration: ErdblickVectorMaskConfiguration;
  private sceneRevision = -1;
  private configurationRevision = 0;
  private synchronizedConfigurationRevision = -1;
  private shaderPropsRevision = 0;
  private shaderPropsSceneRevision = -1;
  private shaderPropsConfigurationRevision = -1;
  private shaderPropsFlattenZ: boolean | null = null;
  private initialized = false;

  /** Bind a mask-pass configuration without taking ownership of scene buffers. */
  constructor(props: ErdblickVectorMaskLayerProps) {
    super(props);
    this.configuration = props.configuration;
  }

  /** Disable Deck attributes because scene-owned interleaved buffers are authoritative. */
  protected override _getAttributeManager(): null {
    return null;
  }

  /** Build mask models after Deck supplies the layer's graphics context. */
  override initializeState(): void {
    this.initialized = true;
    this.syncModels();
    this.bindShaderProps();
  }

  /** Release mask-only pipelines while preserving scene-owned instance buffers. */
  override finalizeState(): void {
    this.initialized = false;
    this.destroyModels();
  }

  /** Return current mask models to Deck's internal identity render pass. */
  override getModels(): Model[] {
    return [...this.materialModels.values()]
      .sort(compareMaterialModels)
      .map((item) => item.model);
  }

  /** Replace sparse target/union state without replacing the Deck layer object. */
  configure(configuration: ErdblickVectorMaskConfiguration): void {
    this.configuration = configuration;
    this.configurationRevision += 1;
    this.syncModels();
    this.bindShaderProps();
    this.setNeedsRedraw();
  }

  /** Rebind grown stores and include newly created matching materials. */
  sceneChanged(): void {
    this.syncModels();
    // Rebind eagerly so a hidden pass cannot retain a lookup texture after
    // GpuScene releases the previous presentation at the end of the frame.
    this.bindShaderProps();
    this.setNeedsRedraw();
  }

  /** Draw shared stores with mask filtering and identity-color shader inputs. */
  override draw({ renderPass }: { renderPass: unknown }): void {
    if (!this.bindShaderProps()) {
      return;
    }
    for (const item of [...this.materialModels.values()].sort(
      compareMaterialModels,
    )) {
      if (item.source.store.presentedHighWaterRecord <= 0) {
        continue;
      }
      if (!item.model.draw(renderPass as never)) {
        this.setNeedsRedraw();
      }
    }
  }

  /** Rebind current scene and sparse-target textures before either owner retires them. */
  private bindShaderProps(): boolean {
    const originTexture = this.props.scene.originTexture;
    const contributionTexture = this.props.scene.contributionTexture;
    const zIndexTexture = this.props.scene.zIndexTexture;
    if (!originTexture || !contributionTexture || !zIndexTexture) {
      return false;
    }
    if (
      this.shaderPropsSceneRevision !== this.props.scene.presentationRevision ||
      this.shaderPropsConfigurationRevision !== this.configurationRevision ||
      this.shaderPropsFlattenZ !== this.props.flattenZ
    ) {
      this.shaderPropsSceneRevision = this.props.scene.presentationRevision;
      this.shaderPropsConfigurationRevision = this.configurationRevision;
      this.shaderPropsFlattenZ = this.props.flattenZ;
      this.shaderPropsRevision += 1;
    }
    for (const item of this.materialModels.values()) {
      if (item.shaderPropsRevision === this.shaderPropsRevision) {
        continue;
      }
      item.model.shaderInputs.setProps({
        gpuScene: {
          originTexture,
          contributionTexture,
          zIndexTexture,
          lookupTextureWidth: this.props.scene.lookupTextureWidth,
          flattenZ: this.props.flattenZ,
          primitiveDepthBias: primitiveDepthBias(item.source.kind),
          semanticRole: semanticRole(item.source.flags),
          disabledPickIndices: [],
        },
        gpuSceneMask: {
          targetTexture: this.configuration.targetTexture,
          targetTextureWidth: this.configuration.targetTexture.width,
          mode: this.configuration.mode,
          identityColor: this.configuration.identityColor,
        },
      });
      item.model.updateShaderInputs();
      item.shaderPropsRevision = this.shaderPropsRevision;
    }
    return true;
  }

  /** Synchronize only low-cardinality material models after scene/config changes. */
  private syncModels(): void {
    if (
      !this.initialized ||
      (this.sceneRevision === this.props.scene.presentationRevision &&
        this.synchronizedConfigurationRevision === this.configurationRevision)
    ) {
      return;
    }
    const desired = new Set<bigint>();
    for (const source of this.props.scene.materialStores()) {
      if (!this.accepts(source) || !source.store.presentedBuffer) {
        continue;
      }
      const materialKey = source.store.materialKey;
      desired.add(materialKey);
      let item = this.materialModels.get(materialKey);
      if (item && item.source.store !== source.store) {
        item.model.destroy();
        this.materialModels.delete(materialKey);
        item = undefined;
      }
      if (!item) {
        item = {
          model: this.createModel(source),
          source,
          bufferRevision: -1,
          shaderPropsRevision: -1,
        };
        this.materialModels.set(materialKey, item);
      }
      if (item.bufferRevision !== source.store.presentedBufferRevision) {
        item.model.setAttributes({ instances: source.store.presentedBuffer });
        item.bufferRevision = source.store.presentedBufferRevision;
      }
      if (source.kind === GpuPrimitiveKind.Icon) {
        item.model.setBindings({
          gpuIconAtlasTexture: gpuIconAtlasService.texture(
            this.context.device,
            source.atlasPage,
          ),
        });
      }
      item.model.setInstanceCount(source.store.presentedHighWaterRecord);
    }
    for (const [materialKey, item] of this.materialModels) {
      if (!desired.has(materialKey)) {
        item.model.destroy();
        this.materialModels.delete(materialKey);
      }
    }
    this.sceneRevision = this.props.scene.presentationRevision;
    this.synchronizedConfigurationRevision = this.configurationRevision;
  }

  /** Test primitive/material eligibility for target or union passes. */
  private accepts(source: GpuSceneMaterialStore): boolean {
    return (
      !this.configuration.materialKeys ||
      this.configuration.materialKeys.has(source.store.materialKey)
    );
  }

  /** Build one mask pipeline over the same unit mesh and interleaved instance layout. */
  private createModel(source: GpuSceneMaterialStore): Model {
    const program = primitiveProgram(source);
    const parameters = materialParameters(source.flags, true);
    return new Model(this.context.device, {
      ...this.getShaders({
        vs: gpuSceneMaskVertexShader(program.vertexShader),
        fs: gpuSceneMaskFragmentShader(program.fragmentShader),
        modules: [
          project32,
          gpuSceneShaderModule as never,
          gpuSceneMaskShaderModule as never,
        ],
      }),
      id: `${this.props.id}-${source.store.materialKey.toString(16)}`,
      bufferLayout: program.layout,
      geometry: primitiveGeometry(source),
      isInstanced: true,
      parameters,
    });
  }

  /** Destroy every mask-owned model and static unit mesh. */
  private destroyModels(): void {
    for (const item of this.materialModels.values()) {
      item.model.destroy();
    }
    this.materialModels.clear();
  }
}

/**
 * Construct the stable ordinary and interaction vector pass shells for one
 * Deck view.
 *
 * Surfaces stay below GLTF and tile-state overlays while paths, points,
 * arrows, and icons retain their legacy position above those layers.
 * Transient authored hover/selection geometry is physically drawn after the
 * shader interaction compositor. Every shell shares drill-pick suppression.
 */
export function createErdblickVectorLayers(
  id: string,
  scene: GpuScene,
  flattenZ: boolean,
  sharedDisabledPickIndices = new Set<number>(),
): readonly [
  ErdblickVectorLayer,
  ErdblickVectorLayer,
  ErdblickVectorLayer,
  ErdblickVectorLayer,
] {
  const layer = (
    suffix: string,
    primitiveKinds: readonly GpuPrimitiveKind[],
    getPolygonOffset: () => [number, number],
    styleOrderRange: {
      minimumStyleOrder?: number;
      maximumStyleOrderExclusive?: number;
    },
    parameters?: RenderPipelineParameters,
  ) =>
    new ErdblickVectorLayer({
      id: `${id}-${suffix}`,
      data: [],
      scene,
      flattenZ,
      primitiveKinds,
      ...styleOrderRange,
      ...(parameters ? { parameters } : {}),
      sharedDisabledPickIndices,
      getPolygonOffset,
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
      pickable: true,
      drillPickEligible: true,
      navigationAnchorEligible: true,
      navigationAltitudeResolver: (globalPickIndex) =>
        scene.navigationAltitude(globalPickIndex),
      markerAnchorEligible: true,
    });
  return [
    layer(
      "surfaces",
      [GpuPrimitiveKind.SurfaceTriangle],
      NO_POLYGON_OFFSET,
      { maximumStyleOrderExclusive: INTERACTION_STYLE_ORDER_BASE },
    ),
    layer(
      "vectors",
      [
        GpuPrimitiveKind.PathSegment,
        GpuPrimitiveKind.Point,
        GpuPrimitiveKind.Arrow,
        GpuPrimitiveKind.Icon,
      ],
      VECTOR_POLYGON_OFFSET,
      { maximumStyleOrderExclusive: INTERACTION_STYLE_ORDER_BASE },
    ),
    layer(
      "interaction-surfaces",
      [GpuPrimitiveKind.SurfaceTriangle],
      NO_POLYGON_OFFSET,
      { minimumStyleOrder: INTERACTION_STYLE_ORDER_BASE },
      NO_DEPTH_PARAMETERS,
    ),
    layer(
      "interaction-vectors",
      [
        GpuPrimitiveKind.PathSegment,
        GpuPrimitiveKind.Point,
        GpuPrimitiveKind.Arrow,
        GpuPrimitiveKind.Icon,
      ],
      VECTOR_POLYGON_OFFSET,
      { minimumStyleOrder: INTERACTION_STYLE_ORDER_BASE },
      NO_DEPTH_PARAMETERS,
    ),
  ];
}
