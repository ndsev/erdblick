import type { Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";

/** Runtime bindings shared by every primitive program in one GPU scene. */
export interface GpuSceneShaderProps {
  originTexture: Texture;
  contributionTexture: Texture;
  zIndexTexture: Texture;
  lookupTextureWidth: number;
  flattenZ: boolean;
  primitiveDepthBias: number;
  semanticRole: number;
  disabledPickIndices: readonly number[];
}

type GpuSceneShaderUniforms = {
  lookupTextureWidth: number;
  flattenZ: number;
  primitiveDepthBias: number;
  semanticRole: number;
  disabledPickCount: number;
  disabledPickIndices0: Matrix4Values;
  disabledPickIndices1: Matrix4Values;
  disabledPickIndices2: Matrix4Values;
  disabledPickIndices3: Matrix4Values;
};

type Matrix4Values = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const GPU_SCENE_VERTEX_SOURCE = `\
// ANGLE may otherwise lower the helper's sampler parameter to lowp. Tile
// origins need full RGBA32F precision on both the uniforms and the parameter.
uniform highp sampler2D gpuSceneOriginTexture;
uniform highp sampler2D gpuSceneContributionTexture;
uniform highp sampler2D gpuSceneZIndexTexture;

flat out float gpuScene_vSemanticGroup;
flat out float gpuScene_vSemanticDepth;

layout(std140) uniform gpuSceneUniforms {
  float lookupTextureWidth;
  float flattenZ;
  float primitiveDepthBias;
  float semanticRole;
  float disabledPickCount;
  mat4 disabledPickIndices0;
  mat4 disabledPickIndices1;
  mat4 disabledPickIndices2;
  mat4 disabledPickIndices3;
} gpuScene;

const uint GPU_SCENE_UNSELECTABLE = 0xffffffffu;
const uint GPU_SCENE_RECORD_FLAG_MASK = 0xffu;

ivec2 gpuScene_lookupCoordinate(uint texelIndex) {
  uint width = uint(gpuScene.lookupTextureWidth);
  return ivec2(int(texelIndex % width), int(texelIndex / width));
}

vec4 gpuScene_lookup(highp sampler2D lookupTexture, uint texelIndex) {
  return texelFetch(lookupTexture, gpuScene_lookupCoordinate(texelIndex), 0);
}

void gpuScene_origin(uint slot, out vec3 high, out vec3 low) {
  high = gpuScene_lookup(gpuSceneOriginTexture, slot * 2u).xyz;
  low = gpuScene_lookup(gpuSceneOriginTexture, slot * 2u + 1u).xyz;
  if (gpuScene.flattenZ > 0.5) {
    high.z = 0.0;
    low.z = 0.0;
  }
}

vec4 gpuScene_contribution(uint slot) {
  return gpuScene_lookup(gpuSceneContributionTexture, slot);
}

vec3 gpuScene_localPosition(vec3 localPosition) {
  return gpuScene.flattenZ > 0.5
    ? vec3(localPosition.xy, 0.0)
    : localPosition;
}

void gpuScene_projectLocal(
    vec3 localPosition,
    uint originSlot,
    out vec4 commonPosition,
    out vec4 clipPosition) {
  vec3 originHigh;
  vec3 originLow;
  gpuScene_origin(originSlot, originHigh, originLow);
  geometry.worldPosition = originHigh;
  // GpuScene packets always store meter offsets around an LNGLAT origin, so this
  // branch-free conversion is exact and does not depend on Deck's shared geometry
  // state while deciding whether to apply Web Mercator's latitude correction.
  float originScale = project_size_at_latitude(originHigh.y);
  if (project.projectionMode == PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET) {
    originScale /= project_size_at_latitude(project.coordinateOrigin.y);
  }
  vec3 localCommon = gpuScene_localPosition(localPosition) *
    project.commonUnitsPerMeter * originScale;
  clipPosition = project_position_to_clipspace(
    originHigh,
    originLow,
    localCommon,
    commonPosition);
}

vec3 gpuScene_rotateCommonOffset(vec4 commonPosition, vec3 commonOffset) {
  mat3 rotation;
  if (project_needs_rotation(commonPosition.xyz, rotation)) {
    return rotation * commonOffset;
  }
  return commonOffset;
}

vec2 gpuScene_clipToPixels(vec4 clipPosition) {
  float reciprocalW = 1.0 / max(abs(clipPosition.w), 0.000001);
  return clipPosition.xy * reciprocalW * project.viewportSize * 0.5 /
    max(project.devicePixelRatio, 0.000001);
}

vec2 gpuScene_localVectorToScreen(
    vec4 commonPosition,
    vec4 clipPosition,
    vec2 localVectorPixels) {
  float magnitude = length(localVectorPixels);
  if (magnitude <= 0.0001) {
    return vec2(0.0);
  }
  vec3 commonDirection = gpuScene_rotateCommonOffset(
    commonPosition,
    project_size(vec3(localVectorPixels / magnitude, 0.0)));
  vec4 shiftedClip = clipPosition +
    project.viewProjectionMatrix * vec4(commonDirection, 0.0);
  vec2 direction = gpuScene_clipToPixels(shiftedClip) -
    gpuScene_clipToPixels(clipPosition);
  float projectedLength = length(direction);
  return projectedLength > 0.000000001
    ? direction / projectedLength * magnitude
    : vec2(0.0);
}

vec3 gpuScene_localVectorToCommon(
    vec4 commonPosition,
    vec2 localVectorPixels) {
  float magnitude = length(localVectorPixels);
  if (magnitude <= 0.0001) {
    return vec3(0.0);
  }
  vec3 direction = gpuScene_rotateCommonOffset(
    commonPosition,
    project_size(vec3(localVectorPixels / magnitude, 0.0)));
  float projectedLength = length(direction.xy);
  return projectedLength > 0.000000001
    ? vec3(
        direction.xy / projectedLength * project_pixel_size(magnitude),
        0.0)
    : vec3(0.0);
}

float gpuScene_offsetScale(float threshold) {
  return threshold <= 0.0
    ? 1.0
    : min(1.0, project_size_to_pixel(threshold));
}

float gpuScene_disabledPick(int index) {
  int matrixIndex = index / 16;
  int localIndex = index - matrixIndex * 16;
  int column = localIndex / 4;
  int row = localIndex - column * 4;
  if (matrixIndex == 0) return gpuScene.disabledPickIndices0[column][row];
  if (matrixIndex == 1) return gpuScene.disabledPickIndices1[column][row];
  if (matrixIndex == 2) return gpuScene.disabledPickIndices2[column][row];
  return gpuScene.disabledPickIndices3[column][row];
}

bool gpuScene_isPickDisabled(uint globalPickIndex) {
  for (int index = 0; index < 64; ++index) {
    if (index >= int(gpuScene.disabledPickCount)) {
      break;
    }
    if (globalPickIndex == uint(gpuScene_disabledPick(index) + 0.5)) {
      return true;
    }
  }
  return false;
}

vec3 gpuScene_pickingColor(uint localPickIndex, vec4 contribution) {
  if (localPickIndex == GPU_SCENE_UNSELECTABLE || contribution.x < 0.0) {
    return vec3(0.0);
  }
  uint globalPickIndex = uint(contribution.x + 0.5) + localPickIndex;
  if (gpuScene_isPickDisabled(globalPickIndex)) {
    return vec3(0.0);
  }
  uint encoded = globalPickIndex + 1u;
  return vec3(
    float(encoded & 255u),
    float((encoded >> 8u) & 255u),
    float((encoded >> 16u) & 255u));
}

bool gpuScene_isActive(
    uint recordWord,
    vec4 contribution,
    uint localPickIndex) {
  // localPickIndex is part of the common signature because mask variants use
  // it for sparse target lookup. Ordinary rendering deliberately ignores it.
  uint recordFlags = recordWord & GPU_SCENE_RECORD_FLAG_MASK;
  uint activationToken = recordWord >> 8u;
  return (recordFlags & 1u) != 0u &&
    activationToken == uint(contribution.z + 0.5);
}

vec4 gpuScene_zIndexMetadata(
    uint localZIndex,
    vec4 contribution) {
  if (contribution.w < 0.0) {
    return vec4(0.0);
  }
  uint zIndexSlot = uint(contribution.w + 0.5) + localZIndex;
  return gpuScene_lookup(gpuSceneZIndexTexture, zIndexSlot);
}

void gpuScene_applyDepthBias(
    inout vec4 clipPosition,
    uint localZIndex,
    vec4 contribution,
    uint localPickIndex,
    uint contributionSlot,
    uint instanceIndex) {
  vec4 ranked = gpuScene_zIndexMetadata(localZIndex, contribution);
  gpuScene_vSemanticGroup = ranked.y;
  gpuScene_vSemanticDepth = ranked.z;
  if (gpuScene.semanticRole < 0.5) {
    float bias = gpuScene.primitiveDepthBias + ranked.x;
    clipPosition.z -= bias * clipPosition.w;
  }
}
`;

const GPU_SCENE_FRAGMENT_SOURCE = `\
flat in float gpuScene_vSemanticGroup;
flat in float gpuScene_vSemanticDepth;
`;

/** Pack one sixteen-index drill-picking suppression page into a shader matrix. */
function disabledMatrix(
  values: readonly number[],
  offset: number,
): Matrix4Values {
  return Array.from(
    { length: 16 },
    (_, index) => values[offset + index] ?? 0,
  ) as Matrix4Values;
}

/** Shader module that resolves scene origins, owners, activity, and picking. */
export const gpuSceneShaderModule = {
  name: "gpuScene",
  vs: GPU_SCENE_VERTEX_SOURCE,
  fs: GPU_SCENE_FRAGMENT_SOURCE,
  uniformTypes: {
    lookupTextureWidth: "f32",
    flattenZ: "f32",
    primitiveDepthBias: "f32",
    semanticRole: "f32",
    disabledPickCount: "f32",
    disabledPickIndices0: "mat4x4<f32>",
    disabledPickIndices1: "mat4x4<f32>",
    disabledPickIndices2: "mat4x4<f32>",
    disabledPickIndices3: "mat4x4<f32>",
  },
  getUniforms: (props?: Partial<GpuSceneShaderProps>) => {
    if (
      !props?.originTexture ||
      !props.contributionTexture ||
      !props.zIndexTexture ||
      props.lookupTextureWidth === undefined ||
      props.flattenZ === undefined ||
      props.primitiveDepthBias === undefined ||
      props.semanticRole === undefined ||
      !props.disabledPickIndices
    ) {
      return {};
    }
    const disabled = props.disabledPickIndices.slice(0, 64);
    return {
      lookupTextureWidth: props.lookupTextureWidth,
      flattenZ: props.flattenZ ? 1 : 0,
      primitiveDepthBias: props.primitiveDepthBias,
      semanticRole: props.semanticRole,
      disabledPickCount: disabled.length,
      disabledPickIndices0: disabledMatrix(disabled, 0),
      disabledPickIndices1: disabledMatrix(disabled, 16),
      disabledPickIndices2: disabledMatrix(disabled, 32),
      disabledPickIndices3: disabledMatrix(disabled, 48),
      gpuSceneOriginTexture: props.originTexture,
      gpuSceneContributionTexture: props.contributionTexture,
      gpuSceneZIndexTexture: props.zIndexTexture,
    };
  },
} as const satisfies ShaderModule<GpuSceneShaderProps, GpuSceneShaderUniforms>;

/** Replace ordinary color with a semantic-group id while hardware records depth. */
export const gpuSceneSemanticSupportShaderModule = {
  name: "gpuSceneSemanticSupport",
  fs: `\
vec3 gpuSceneSemantic_packUint24(uint value) {
  return vec3(
    float(value & 255u),
    float((value >> 8u) & 255u),
    float((value >> 16u) & 255u)) / 255.0;
}
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": {
      order: 99,
      injection: `\
  if (gpuScene_vSemanticGroup < 0.5) {
    discard;
  }
  uint semanticGroup = uint(gpuScene_vSemanticGroup + 0.5);
  color = vec4(gpuSceneSemantic_packUint24(semanticGroup), 1.0);
`,
    },
  },
} as const satisfies ShaderModule;

/** Runtime support-buffer binding used while resolving semantic overlays. */
export interface GpuSceneSemanticOverlayShaderProps {
  supportGroupTexture: Texture;
}

type GpuSceneSemanticOverlayShaderBindings = {
  gpuSceneSemanticOverlaySupportGroupTexture: Texture;
};

/** Keep only overlays whose group owns the physically nearest support pixel. */
export const gpuSceneSemanticOverlayShaderModule = {
  name: "gpuSceneSemanticOverlay",
  fs: `\
uniform highp sampler2D gpuSceneSemanticOverlaySupportGroupTexture;

uint gpuSceneSemantic_unpackUint24(vec3 packed) {
  uvec3 bytes = uvec3(floor(packed * 255.0 + 0.5));
  return bytes.r | (bytes.g << 8u) | (bytes.b << 16u);
}
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": {
      // Resolve group/depth before Deck replaces color with a pick identity.
      order: 98,
      injection: `\
  ivec2 semanticCoordinate = ivec2(gl_FragCoord.xy);
  uint supportGroup = gpuSceneSemantic_unpackUint24(texelFetch(
    gpuSceneSemanticOverlaySupportGroupTexture,
    semanticCoordinate,
    0).rgb);
  uint overlayGroup = uint(gpuScene_vSemanticGroup + 0.5);
  if (overlayGroup == 0u || overlayGroup != supportGroup) {
    discard;
  }
  gl_FragDepth = clamp(gpuScene_vSemanticDepth, 0.0, 1.0);
`,
    },
  },
  getUniforms: (props?: Partial<GpuSceneSemanticOverlayShaderProps>) =>
    props?.supportGroupTexture
      ? {
          gpuSceneSemanticOverlaySupportGroupTexture:
            props.supportGroupTexture,
        }
      : {},
} as const satisfies ShaderModule<
  GpuSceneSemanticOverlayShaderProps,
  Record<never, never>,
  GpuSceneSemanticOverlayShaderBindings
>;

/** Sparse mask mode installed on vector shaders without duplicating geometry. */
export enum GpuSceneMaskMode {
  Target = 1,
  Union = 2,
}

/** Runtime bindings for semantic-target and union-glow mask draws. */
export interface GpuSceneMaskShaderProps {
  targetTexture: Texture;
  targetTextureWidth: number;
  mode: GpuSceneMaskMode;
  identityColor: [number, number, number, number];
}

type GpuSceneMaskShaderUniforms = {
  targetTextureWidth: number;
  mode: number;
  identityColor: [number, number, number, number];
};

const GPU_SCENE_MASK_VERTEX_SOURCE = `\
uniform sampler2D gpuSceneMaskTargetTexture;

flat out vec4 gpuSceneMask_vIdentity;

layout(std140) uniform gpuSceneMaskUniforms {
  float targetTextureWidth;
  float mode;
  vec4 identityColor;
} gpuSceneMask;

ivec2 gpuSceneMask_coordinate(uint globalPickIndex) {
  uint width = uint(gpuSceneMask.targetTextureWidth);
  return ivec2(
    int(globalPickIndex % width),
    int(globalPickIndex / width));
}

vec4 gpuSceneMask_target(uint localPickIndex, vec4 contribution) {
  if (localPickIndex == GPU_SCENE_UNSELECTABLE || contribution.x < 0.0) {
    return vec4(0.0);
  }
  uint globalPickIndex = uint(contribution.x + 0.5) + localPickIndex;
  return texelFetch(
    gpuSceneMaskTargetTexture,
    gpuSceneMask_coordinate(globalPickIndex),
    0);
}

bool gpuSceneMask_isActive(
    uint recordFlags,
    vec4 contribution,
    uint localPickIndex) {
  if (!gpuScene_isActive(recordFlags, contribution, localPickIndex)) {
    return false;
  }
  return gpuSceneMask.mode > 1.5 ||
    gpuSceneMask_target(localPickIndex, contribution).a > 0.0;
}

vec3 gpuSceneMask_pickingColor(
    uint localPickIndex,
    vec4 contribution) {
  if (gpuSceneMask.mode < 1.5) {
    return gpuSceneMask_target(localPickIndex, contribution).rgb * 255.0;
  }
  if (gpuSceneMask.mode < 2.5) {
    return gpuSceneMask.identityColor.rgb;
  }
  return vec3(0.0);
}
`;

const GPU_SCENE_MASK_FRAGMENT_SOURCE = `\
flat in vec4 gpuSceneMask_vIdentity;
`;

/** Shader module that filters shared scene records through sparse mask state. */
export const gpuSceneMaskShaderModule = {
  name: "gpuSceneMask",
  vs: GPU_SCENE_MASK_VERTEX_SOURCE,
  fs: GPU_SCENE_MASK_FRAGMENT_SOURCE,
  inject: {
    "vs:DECKGL_FILTER_COLOR": `\
  gpuSceneMask_vIdentity = vec4(
    geometry.pickingColor / 255.0,
    float(dot(geometry.pickingColor, vec3(1.0)) > 0.00001));
`,
    "fs:DECKGL_FILTER_COLOR": {
      order: 99,
      injection: `\
  if (gpuSceneMask_vIdentity.a <= 0.0) {
    discard;
  } else {
    color = gpuSceneMask_vIdentity;
  }
`,
    },
  },
  uniformTypes: {
    targetTextureWidth: "f32",
    mode: "f32",
    identityColor: "vec4<f32>",
  },
  getUniforms: (props?: Partial<GpuSceneMaskShaderProps>) => {
    if (
      !props?.targetTexture ||
      props.targetTextureWidth === undefined ||
      props.mode === undefined ||
      !props.identityColor
    ) {
      return {};
    }
    return {
      targetTextureWidth: props.targetTextureWidth,
      mode: props.mode,
      identityColor: props.identityColor,
      gpuSceneMaskTargetTexture: props.targetTexture,
    };
  },
} as const satisfies ShaderModule<
  GpuSceneMaskShaderProps,
  GpuSceneMaskShaderUniforms
>;

/** Redirect one ordinary primitive vertex program through mask activity/identity. */
export function gpuSceneMaskVertexShader(source: string): string {
  return source
    .replaceAll("gpuScene_isActive(", "gpuSceneMask_isActive(")
    .replaceAll("gpuScene_pickingColor(", "gpuSceneMask_pickingColor(");
}

/** Mark a shared fragment program as a mask pass for pick-width semantics. */
export function gpuSceneMaskFragmentShader(source: string): string {
  return source.replace(
    "#version 300 es",
    "#version 300 es\n#define ERDBLICK_MASK_RENDER",
  );
}

export const POINT_VERTEX_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-point-vertex

in vec3 positions;
in vec3 instancePosition;
in float instanceRadius;
in uint instanceZIndex;
in vec4 instanceColor;
in uvec4 instanceMetadata;

out vec4 vColor;
out vec2 vUnitPosition;
out float vRadius;

void main(void) {
  vec4 commonPosition;
  vec4 clipPosition;
  gpuScene_projectLocal(
    instancePosition,
    instanceMetadata.x,
    commonPosition,
    clipPosition);
  vec4 contribution = gpuScene_contribution(instanceMetadata.y);
  bool recordActive = gpuScene_isActive(
    instanceMetadata.w, contribution, instanceMetadata.z);
  geometry.pickingColor = recordActive
    ? gpuScene_pickingColor(instanceMetadata.z, contribution)
    : vec3(0.0);

  vUnitPosition = positions.xy;
  geometry.uv = vUnitPosition;
  float radius = max(0.0, instanceRadius);
  vRadius = radius;
  vec3 offset = positions * project_pixel_size(radius);
  offset = gpuScene_rotateCommonOffset(commonPosition, offset);
  geometry.position = commonPosition + vec4(offset, 0.0);
  gl_Position = project_common_position_to_clipspace(geometry.position);
  gpuScene_applyDepthBias(
    gl_Position,
    instanceZIndex,
    contribution,
    instanceMetadata.z,
    instanceMetadata.y,
    uint(gl_InstanceID));
  if (!recordActive) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vColor = vec4(instanceColor.rgb, instanceColor.a * layer.opacity);
  DECKGL_FILTER_COLOR(vColor, geometry);
}
`;

export const POINT_BILLBOARD_VERTEX_SHADER = POINT_VERTEX_SHADER.replace(
  `vec3 offset = positions * project_pixel_size(radius);\n  offset = gpuScene_rotateCommonOffset(commonPosition, offset);\n  geometry.position = commonPosition + vec4(offset, 0.0);\n  gl_Position = project_common_position_to_clipspace(geometry.position);`,
  `geometry.position = commonPosition;\n  gl_Position = clipPosition;\n  gl_Position.xy += project_pixel_size_to_clipspace(positions.xy * radius) * gl_Position.w;`,
);

export const POINT_FRAGMENT_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-point-fragment
precision highp float;

in vec4 vColor;
in vec2 vUnitPosition;
layout(location = 0) out vec4 fragColor;

void main(void) {
  geometry.uv = vUnitPosition;
  float distanceToCenter = length(vUnitPosition);
  if (distanceToCenter > 1.0) {
    discard;
  }
  float alpha = 1.0 - smoothstep(0.96, 1.0, distanceToCenter);
  fragColor = vec4(vColor.rgb, vColor.a * alpha);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

/** Hollow point glyph used when a topology relation has no drawable direction. */
export const POINT_RING_FRAGMENT_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-point-ring-fragment
precision highp float;

in vec4 vColor;
in vec2 vUnitPosition;
in float vRadius;
layout(location = 0) out vec4 fragColor;

void main(void) {
  geometry.uv = vUnitPosition;
  float distanceToCenter = length(vUnitPosition);
  if (distanceToCenter > 1.0) {
    discard;
  }
  float feather = max(fwidth(distanceToCenter), 0.004);
  float strokePixels = clamp(vRadius * 0.2, 1.5, 3.5);
  float innerRadius = max(
    0.0,
    1.0 - strokePixels / max(vRadius, 0.0001));
  if (distanceToCenter < innerRadius - feather) {
    discard;
  }
  float outerAlpha = 1.0 - smoothstep(
    1.0 - feather,
    1.0,
    distanceToCenter);
  float innerAlpha = smoothstep(
    innerRadius - feather,
    innerRadius + feather,
    distanceToCenter);
  fragColor = vec4(vColor.rgb, vColor.a * outerAlpha * innerAlpha);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

export const ICON_VERTEX_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-icon-vertex

in vec2 positions;
in vec3 instancePosition;
in vec2 instancePixelSize;
in vec2 instancePixelOffset;
in vec4 instanceUv;
in uint instanceZIndex;
in vec4 instanceColor;
in uvec4 instanceMetadata;

out vec4 vColor;
out vec2 vUv;

void main(void) {
  vec4 commonPosition;
  vec4 clipPosition;
  gpuScene_projectLocal(
    instancePosition,
    instanceMetadata.x,
    commonPosition,
    clipPosition);
  vec4 contribution = gpuScene_contribution(instanceMetadata.y);
  bool recordActive = gpuScene_isActive(
    instanceMetadata.w, contribution, instanceMetadata.z);
  geometry.pickingColor = recordActive
    ? gpuScene_pickingColor(instanceMetadata.z, contribution)
    : vec3(0.0);

  vec2 unitPosition = positions * 0.5 + 0.5;
  vUv = mix(instanceUv.xy, instanceUv.zw, unitPosition);
  geometry.uv = unitPosition;
  vec2 pixelPosition = positions * instancePixelSize * 0.5 +
    instancePixelOffset;
  vec3 offset = vec3(pixelPosition * project_pixel_size(1.0), 0.0);
  offset = gpuScene_rotateCommonOffset(commonPosition, offset);
  geometry.position = commonPosition + vec4(offset, 0.0);
  gl_Position = project_common_position_to_clipspace(geometry.position);
  gpuScene_applyDepthBias(
    gl_Position,
    instanceZIndex,
    contribution,
    instanceMetadata.z,
    instanceMetadata.y,
    uint(gl_InstanceID));
  if (!recordActive) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vColor = vec4(instanceColor.rgb, instanceColor.a * layer.opacity);
  DECKGL_FILTER_COLOR(vColor, geometry);
}
`;

export const ICON_BILLBOARD_VERTEX_SHADER = ICON_VERTEX_SHADER.replace(
  `vec3 offset = vec3(pixelPosition * project_pixel_size(1.0), 0.0);\n  offset = gpuScene_rotateCommonOffset(commonPosition, offset);\n  geometry.position = commonPosition + vec4(offset, 0.0);\n  gl_Position = project_common_position_to_clipspace(geometry.position);`,
  `geometry.position = commonPosition;\n  gl_Position = clipPosition;\n  gl_Position.xy += project_pixel_size_to_clipspace(pixelPosition) * gl_Position.w;`,
);

export const ICON_FRAGMENT_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-icon-fragment
precision highp float;

uniform sampler2D gpuIconAtlasTexture;

in vec4 vColor;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

void main(void) {
  vec4 sampled = texture(gpuIconAtlasTexture, vUv);
  fragColor = vec4(sampled.rgb * vColor.rgb, sampled.a * vColor.a);
  if (fragColor.a <= 0.001) {
    discard;
  }
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

const BILLBOARD_MINIMUM_SCREEN_LENGTH_SHADER = `\
#if defined(ERDBLICK_SCREEN_LENGTH_START_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_END_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_CENTER_ANCHOR)
void gpuScene_applyMinimumScreenLength(
    inout vec4 startClip,
    inout vec4 endClip,
    float width) {
  vec2 segment = gpuScene_clipToPixels(endClip) -
    gpuScene_clipToPixels(startClip);
  float segmentLength = length(segment);
  if (segmentLength <= 0.000000001) {
    return;
  }
  float minimumLength = max(24.0, width * 6.0);
  float extension = max(0.0, minimumLength - segmentLength);
  vec2 extensionNdc = project_pixel_size_to_clipspace(
    segment / segmentLength * extension);
#ifdef ERDBLICK_SCREEN_LENGTH_START_ANCHOR
  endClip.xy += extensionNdc * endClip.w;
#elif defined(ERDBLICK_SCREEN_LENGTH_END_ANCHOR)
  startClip.xy -= extensionNdc * startClip.w;
#else
  startClip.xy -= extensionNdc * startClip.w * 0.5;
  endClip.xy += extensionNdc * endClip.w * 0.5;
#endif
}
#endif
`;

const WORLD_MINIMUM_SCREEN_LENGTH_SHADER = `\
#if defined(ERDBLICK_SCREEN_LENGTH_START_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_END_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_CENTER_ANCHOR)
void gpuScene_applyMinimumWorldLength(
    inout vec4 startCommon,
    inout vec4 startClip,
    inout vec4 endCommon,
    inout vec4 endClip,
    float width) {
  vec2 projectedSegment = gpuScene_clipToPixels(endClip) -
    gpuScene_clipToPixels(startClip);
  float projectedLength = length(projectedSegment);
  if (projectedLength <= 0.000000001) {
    return;
  }
  float minimumLength = max(24.0, width * 6.0);
  float extensionScale = max(0.0, minimumLength / projectedLength - 1.0);
  vec3 extension = (endCommon.xyz - startCommon.xyz) * extensionScale;
#ifdef ERDBLICK_SCREEN_LENGTH_START_ANCHOR
  endCommon.xyz += extension;
#elif defined(ERDBLICK_SCREEN_LENGTH_END_ANCHOR)
  startCommon.xyz -= extension;
#else
  startCommon.xyz -= extension * 0.5;
  endCommon.xyz += extension * 0.5;
#endif
  startClip = project_common_position_to_clipspace(startCommon);
  endClip = project_common_position_to_clipspace(endCommon);
}
#endif
`;

const PATH_VERTEX_PREFIX = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-path-vertex

in vec2 positions;
#ifdef ERDBLICK_SIMPLE_PATH
in vec3 instanceStart;
in vec3 instanceEnd;
#define instancePrevious instanceStart
#define instanceNext instanceEnd
#else
in vec3 instancePrevious;
in vec3 instanceStart;
in vec3 instanceEnd;
in vec3 instanceNext;
#endif
#if defined(ERDBLICK_COMPACT_PATH) || defined(ERDBLICK_SIMPLE_PATH)
in float instancePathWidth;
#define instanceOffsetVectors01 vec4(0.0)
#define instanceOffsetVectors23 vec4(0.0)
#define instanceScalarOffsets vec4(0.0)
#define instancePathStyle vec4(instancePathWidth, 1.0, 0.0, 0.0)
#define instanceTrim vec2(0.0)
#define instanceDashPhase 0.0
#else
in vec4 instanceOffsetVectors01;
in vec4 instanceOffsetVectors23;
in vec4 instanceScalarOffsets;
in vec4 instancePathStyle;
in vec3 instancePathMetrics;
#define instanceTrim instancePathMetrics.xy
#define instanceDashPhase instancePathMetrics.z
#endif
in uint instanceZIndex;
in vec4 instanceColor;
in uvec4 instanceMetadata;
#ifdef ERDBLICK_DUAL_STROKE
in float instanceInnerPathWidth;
in vec4 instanceInnerColor;
#endif

out vec4 vColor;
out vec2 vCornerOffset;
out float vMiterLength;
out vec2 vPathPosition;
out float vPathLength;
out float vJointType;
out vec2 vDashArray;
#if !defined(ERDBLICK_COMPACT_PATH) && !defined(ERDBLICK_SIMPLE_PATH)
out float vDashPosition;
#endif
flat out uint vPathFlags;
#ifdef ERDBLICK_DUAL_STROKE
flat out vec4 vInnerColor;
flat out float vInnerWidthRatio;
#endif

const float PATH_EPSILON = 0.001;
const uint PATH_START_CAP = 2u;
const uint PATH_END_CAP = 4u;
const uint PATH_VARIABLE_OFFSET = 8u;
const uint PATH_DASHED = 16u;
const uint PATH_TRIM_START = 32u;
const uint PATH_TRIM_END = 64u;
const uint PATH_DASH_METERS = 128u;

float pathFlipIfTrue(bool flag) {
  return -(float(flag) * 2.0 - 1.0);
}

vec3 pathJoinOffset(
    vec3 previousPoint,
    vec3 currentPoint,
    vec3 nextPoint,
    vec2 width,
    bool isEnd,
    uint flags,
    bool rotateCommon) {
  float sideOfPath = positions.y;
  float isJoint = float(sideOfPath == 0.0);
  vec3 deltaA3 = currentPoint - previousPoint;
  vec3 deltaB3 = nextPoint - currentPoint;
  mat3 rotationMatrix;
  bool needsRotation = rotateCommon &&
    project_needs_rotation(currentPoint, rotationMatrix);
  if (needsRotation) {
    deltaA3 = deltaA3 * rotationMatrix;
    deltaB3 = deltaB3 * rotationMatrix;
  }
  vec2 deltaA = deltaA3.xy / width;
  vec2 deltaB = deltaB3.xy / width;
  float lenA = length(deltaA);
  float lenB = length(deltaB);
  vec2 dirA = lenA > 0.0 ? normalize(deltaA) : vec2(0.0);
  vec2 dirB = lenB > 0.0 ? normalize(deltaB) : vec2(0.0);
  vec2 perpA = vec2(-dirA.y, dirA.x);
  vec2 perpB = vec2(-dirB.y, dirB.x);
  vec2 tangent = dirA + dirB;
  tangent = length(tangent) > 0.0 ? normalize(tangent) : perpA;
  vec2 miterVector = vec2(-tangent.y, tangent.x);
  vec2 direction = isEnd ? dirA : dirB;
  vec2 perpendicular = isEnd ? perpA : perpB;
  float sinHalfAngle = abs(dot(miterVector, perpendicular));
  float cosHalfAngle = abs(dot(dirA, miterVector));
  float turnDirection = pathFlipIfTrue(
    dirA.x * dirB.y >= dirA.y * dirB.x);
  float cornerPosition = sideOfPath * turnDirection;
  float miterSize = 1.0 / max(sinHalfAngle, PATH_EPSILON);
  miterSize = mix(
    min(miterSize, max(lenA, lenB) / max(cosHalfAngle, PATH_EPSILON)),
    miterSize,
    step(0.0, cornerPosition));
  vec2 offsetVector = mix(
    miterVector * miterSize,
    perpendicular,
    step(0.5, cornerPosition)) *
    (sideOfPath + isJoint * turnDirection);
  bool isStartCap = lenA == 0.0 ||
    (!isEnd && (flags & PATH_START_CAP) != 0u);
  bool isEndCap = lenB == 0.0 ||
    (isEnd && (flags & PATH_END_CAP) != 0u);
  bool isCap = isStartCap || isEndCap;
  bool isTrimmedCap =
    (isStartCap && (flags & PATH_TRIM_START) != 0u) ||
    (isEndCap && (flags & PATH_TRIM_END) != 0u);
  if (isCap) {
    if (isTrimmedCap) {
      // Arrow-adjacent shafts end at a butt cap. The arrow triangle covers a
      // one-pixel overlap without exposing a rounded-cap "ear" at its base.
      offsetVector = perpendicular * sideOfPath;
      vJointType = 0.0;
    } else {
#ifdef ERDBLICK_FAST_PATH
      offsetVector = perpendicular * sideOfPath +
        direction * pathFlipIfTrue(isStartCap);
      vJointType = 0.0;
#else
      offsetVector = mix(
        perpendicular * sideOfPath,
        direction * 4.0 * pathFlipIfTrue(isStartCap),
        isJoint);
      vJointType = 1.0;
#endif
    }
  } else {
    vJointType = 1.0;
  }
  vPathLength = isEnd ? lenA : lenB;
  vCornerOffset = offsetVector;
  vMiterLength = dot(vCornerOffset, miterVector * turnDirection);
  vMiterLength = isCap ? isJoint : vMiterLength;
  vec2 offsetFromStart = vCornerOffset + deltaA * float(isEnd);
  vPathPosition = vec2(
    dot(offsetFromStart, perpendicular),
    dot(offsetFromStart, direction));
  geometry.uv = vPathPosition;
  vec3 result = vec3(offsetVector * width, 0.0);
  return needsRotation ? rotationMatrix * result : result;
}

void pathClipLine(inout vec4 position, vec4 reference) {
  if (position.w < PATH_EPSILON) {
    float ratio = (PATH_EPSILON - reference.w) /
      (position.w - reference.w);
    position = reference + (position - reference) * ratio;
  }
}

${BILLBOARD_MINIMUM_SCREEN_LENGTH_SHADER}

vec2 pathScreenNormal(vec4 previous, vec4 next) {
  vec2 direction = gpuScene_clipToPixels(next) - gpuScene_clipToPixels(previous);
  float directionLength = length(direction);
  return directionLength > 0.000000001
    ? vec2(direction.y, -direction.x) / directionLength
    : vec2(0.0);
}

vec2 pathCommonNormal(vec4 previous, vec4 next) {
  vec2 direction = next.xy - previous.xy;
  float directionLength = length(direction);
  return directionLength > 0.000000001
    ? vec2(direction.y, -direction.x) / directionLength
    : vec2(0.0);
}

void pathSetColors() {
  vColor = vec4(instanceColor.rgb, instanceColor.a * layer.opacity);
#ifdef ERDBLICK_DUAL_STROKE
  vInnerColor = vec4(
    instanceInnerColor.rgb,
    instanceInnerColor.a * layer.opacity);
  vInnerWidthRatio = clamp(
    instanceInnerPathWidth / max(instancePathWidth, 0.0001),
    0.0,
    1.0);
#endif
  DECKGL_FILTER_COLOR(vColor, geometry);
#ifdef ERDBLICK_DUAL_STROKE
  DECKGL_FILTER_COLOR(vInnerColor, geometry);
#endif
}
`;

export const PATH_BILLBOARD_VERTEX_SHADER = `${PATH_VERTEX_PREFIX}
void main(void) {
  uint recordWord = instanceMetadata.w;
  uint flags = recordWord & GPU_SCENE_RECORD_FLAG_MASK;
  vPathFlags = flags;
  vec4 contribution = gpuScene_contribution(instanceMetadata.y);
  bool recordActive = gpuScene_isActive(
    recordWord, contribution, instanceMetadata.z);
  geometry.pickingColor = recordActive
    ? gpuScene_pickingColor(instanceMetadata.z, contribution)
    : vec3(0.0);

  vec4 common0; vec4 clip0;
  vec4 common1; vec4 clip1;
  vec4 common2; vec4 clip2;
  vec4 common3; vec4 clip3;
  gpuScene_projectLocal(instancePrevious, instanceMetadata.x, common0, clip0);
  gpuScene_projectLocal(instanceStart, instanceMetadata.x, common1, clip1);
  gpuScene_projectLocal(instanceEnd, instanceMetadata.x, common2, clip2);
  gpuScene_projectLocal(instanceNext, instanceMetadata.x, common3, clip3);

#if defined(ERDBLICK_SCREEN_LENGTH_START_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_END_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_CENTER_ANCHOR)
  gpuScene_applyMinimumScreenLength(clip1, clip2, instancePathStyle.x);
  clip0 = clip1;
  clip3 = clip2;
#endif

  float offsetScale = gpuScene_offsetScale(instancePathStyle.w);
  if ((flags & PATH_VARIABLE_OFFSET) != 0u) {
    clip0.xy += project_pixel_size_to_clipspace(gpuScene_localVectorToScreen(
      common0, clip0, instanceOffsetVectors01.xy * offsetScale)) * clip0.w;
    clip1.xy += project_pixel_size_to_clipspace(gpuScene_localVectorToScreen(
      common1, clip1, instanceOffsetVectors01.zw * offsetScale)) * clip1.w;
    clip2.xy += project_pixel_size_to_clipspace(gpuScene_localVectorToScreen(
      common2, clip2, instanceOffsetVectors23.xy * offsetScale)) * clip2.w;
    clip3.xy += project_pixel_size_to_clipspace(gpuScene_localVectorToScreen(
      common3, clip3, instanceOffsetVectors23.zw * offsetScale)) * clip3.w;
  } else {
    vec2 offset0 = pathScreenNormal(clip0, clip1) * instanceScalarOffsets.x;
    vec2 offset1 = pathScreenNormal(clip0, clip2) * instanceScalarOffsets.y;
    vec2 offset2 = pathScreenNormal(clip1, clip3) * instanceScalarOffsets.z;
    vec2 offset3 = pathScreenNormal(clip2, clip3) * instanceScalarOffsets.w;
    clip0.xy += project_pixel_size_to_clipspace(offset0) * clip0.w;
    clip1.xy += project_pixel_size_to_clipspace(offset1) * clip1.w;
    clip2.xy += project_pixel_size_to_clipspace(offset2) * clip2.w;
    clip3.xy += project_pixel_size_to_clipspace(offset3) * clip3.w;
  }

  if ((flags & PATH_TRIM_START) != 0u) {
    vec2 segment = gpuScene_clipToPixels(clip2) -
      gpuScene_clipToPixels(clip1);
    float segmentPixels = length(segment);
    vec2 direction = segmentPixels > 0.000000001
      ? segment / segmentPixels
      : vec2(0.0);
    vec2 trim = direction * min(instanceTrim.x, max(0.0, segmentPixels - 0.5));
    vec2 trimNdc = project_pixel_size_to_clipspace(trim);
    clip0.xy += trimNdc * clip0.w;
    clip1.xy += trimNdc * clip1.w;
  }
  if ((flags & PATH_TRIM_END) != 0u) {
    vec2 segment = gpuScene_clipToPixels(clip2) -
      gpuScene_clipToPixels(clip1);
    float segmentPixels = length(segment);
    vec2 direction = segmentPixels > 0.000000001
      ? segment / segmentPixels
      : vec2(0.0);
    vec2 trim = direction * min(instanceTrim.y, max(0.0, segmentPixels - 0.5));
    vec2 trimNdc = project_pixel_size_to_clipspace(trim);
    clip2.xy -= trimNdc * clip2.w;
    clip3.xy -= trimNdc * clip3.w;
  }

#ifndef ERDBLICK_COMPACT_PATH
  float dashSegmentPixels = length(
    gpuScene_clipToPixels(clip2) - gpuScene_clipToPixels(clip1));
#endif
  bool isEnd = positions.x > 0.0;
  vec4 previous = mix(clip0, clip1, float(isEnd));
  vec4 current = mix(clip1, clip2, float(isEnd));
  vec4 next = mix(clip2, clip3, float(isEnd));
  pathClipLine(previous, current);
  pathClipLine(next, current);
  pathClipLine(current, mix(next, previous, float(isEnd)));
  vec2 halfWidth = project_pixel_size_to_clipspace(
    vec2(max(0.0, instancePathStyle.x) * 0.5));
  vec3 offset = pathJoinOffset(
    previous.xyz / previous.w,
    current.xyz / current.w,
    next.xyz / next.w,
    halfWidth,
    isEnd,
    flags,
    false);
#ifndef ERDBLICK_COMPACT_PATH
  float dashPositionPixels = vPathLength > PATH_EPSILON
    ? vPathPosition.y * dashSegmentPixels / vPathLength
    : 0.0;
  float dashPositionMeters = instanceDashPhase +
    (vPathLength > PATH_EPSILON
      ? vPathPosition.y * length(instanceEnd.xy - instanceStart.xy) /
        vPathLength
      : 0.0);
#endif
  geometry.position = current;
  gl_Position = vec4(current.xyz + offset * current.w, current.w);
  gpuScene_applyDepthBias(
    gl_Position,
    instanceZIndex,
    contribution,
    instanceMetadata.z,
    instanceMetadata.y,
    uint(gl_InstanceID));
  if (!recordActive) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
#ifndef ERDBLICK_COMPACT_PATH
  // Meter coordinates use ordinary perspective interpolation. Pixel
  // coordinates are pre-multiplied so the fragment can recover screen-linear
  // distance after interpolation.
  vDashPosition = (flags & PATH_DASH_METERS) != 0u
    ? dashPositionMeters
    : dashPositionPixels * gl_Position.w;
#endif
  vDashArray = (flags & PATH_DASHED) != 0u
    ? instancePathStyle.yz
    : vec2(1.0, 0.0);
  pathSetColors();
}
`;

export const PATH_WORLD_VERTEX_SHADER = `${PATH_VERTEX_PREFIX}
${WORLD_MINIMUM_SCREEN_LENGTH_SHADER}

void main(void) {
  uint recordWord = instanceMetadata.w;
  uint flags = recordWord & GPU_SCENE_RECORD_FLAG_MASK;
  vPathFlags = flags;
  vec4 contribution = gpuScene_contribution(instanceMetadata.y);
  bool recordActive = gpuScene_isActive(
    recordWord, contribution, instanceMetadata.z);
  geometry.pickingColor = recordActive
    ? gpuScene_pickingColor(instanceMetadata.z, contribution)
    : vec3(0.0);

  vec4 point0; vec4 clip0;
  vec4 point1; vec4 clip1;
  vec4 point2; vec4 clip2;
  vec4 point3; vec4 clip3;
  gpuScene_projectLocal(instancePrevious, instanceMetadata.x, point0, clip0);
  gpuScene_projectLocal(instanceStart, instanceMetadata.x, point1, clip1);
  gpuScene_projectLocal(instanceEnd, instanceMetadata.x, point2, clip2);
  gpuScene_projectLocal(instanceNext, instanceMetadata.x, point3, clip3);

#if defined(ERDBLICK_SCREEN_LENGTH_START_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_END_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_CENTER_ANCHOR)
  gpuScene_applyMinimumWorldLength(
    point1,
    clip1,
    point2,
    clip2,
    instancePathStyle.x);
  point0 = point1;
  clip0 = clip1;
  point3 = point2;
  clip3 = clip2;
#endif

  float offsetScale = gpuScene_offsetScale(instancePathStyle.w);
  if ((flags & PATH_VARIABLE_OFFSET) != 0u) {
    point0.xyz += gpuScene_localVectorToCommon(
      point0, instanceOffsetVectors01.xy * offsetScale);
    point1.xyz += gpuScene_localVectorToCommon(
      point1, instanceOffsetVectors01.zw * offsetScale);
    point2.xyz += gpuScene_localVectorToCommon(
      point2, instanceOffsetVectors23.xy * offsetScale);
    point3.xyz += gpuScene_localVectorToCommon(
      point3, instanceOffsetVectors23.zw * offsetScale);
  } else {
    vec2 offset0 = pathCommonNormal(point0, point1) *
      project_pixel_size(instanceScalarOffsets.x);
    vec2 offset1 = pathCommonNormal(point0, point2) *
      project_pixel_size(instanceScalarOffsets.y);
    vec2 offset2 = pathCommonNormal(point1, point3) *
      project_pixel_size(instanceScalarOffsets.z);
    vec2 offset3 = pathCommonNormal(point2, point3) *
      project_pixel_size(instanceScalarOffsets.w);
    point0.xy += offset0;
    point1.xy += offset1;
    point2.xy += offset2;
    point3.xy += offset3;
  }

  vec2 segment = point2.xy - point1.xy;
  float segmentLength = length(segment);
  vec2 segmentDirection = segmentLength > 0.000000001
    ? segment / segmentLength
    : vec2(0.0);
  if ((flags & PATH_TRIM_START) != 0u) {
    vec2 trim = segmentDirection * min(
      project_pixel_size(instanceTrim.x),
      max(0.0, segmentLength - project_pixel_size(0.5)));
    point0.xy += trim;
    point1.xy += trim;
  }
  if ((flags & PATH_TRIM_END) != 0u) {
    vec2 trim = segmentDirection * min(
      project_pixel_size(instanceTrim.y),
      max(0.0, segmentLength - project_pixel_size(0.5)));
    point2.xy -= trim;
    point3.xy -= trim;
  }

#ifndef ERDBLICK_COMPACT_PATH
  vec4 dashStartClip = project_common_position_to_clipspace(point1);
  vec4 dashEndClip = project_common_position_to_clipspace(point2);
  float dashSegmentPixels = length(
    gpuScene_clipToPixels(dashEndClip) -
    gpuScene_clipToPixels(dashStartClip));
#endif
  bool isEnd = positions.x > 0.0;
  vec4 previous = mix(point0, point1, float(isEnd));
  vec4 current = mix(point1, point2, float(isEnd));
  vec4 next = mix(point2, point3, float(isEnd));
  vec2 halfWidth = vec2(project_pixel_size(
    max(0.0, instancePathStyle.x) * 0.5));
  vec3 offset = pathJoinOffset(
    previous.xyz,
    current.xyz,
    next.xyz,
    halfWidth,
    isEnd,
    flags,
    true);
#ifndef ERDBLICK_COMPACT_PATH
  float dashPositionPixels = vPathLength > PATH_EPSILON
    ? vPathPosition.y * dashSegmentPixels / vPathLength
    : 0.0;
  float dashPositionMeters = instanceDashPhase +
    (vPathLength > PATH_EPSILON
      ? vPathPosition.y * length(instanceEnd.xy - instanceStart.xy) /
        vPathLength
      : 0.0);
#endif
  geometry.position = current + vec4(offset, 0.0);
  gl_Position = project_common_position_to_clipspace(geometry.position);
  gpuScene_applyDepthBias(
    gl_Position,
    instanceZIndex,
    contribution,
    instanceMetadata.z,
    instanceMetadata.y,
    uint(gl_InstanceID));
  if (!recordActive) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
#ifndef ERDBLICK_COMPACT_PATH
  // Meter coordinates use ordinary perspective interpolation. Pixel
  // coordinates are pre-multiplied so the fragment can recover screen-linear
  // distance after interpolation.
  vDashPosition = (flags & PATH_DASH_METERS) != 0u
    ? dashPositionMeters
    : dashPositionPixels * gl_Position.w;
#endif
  vDashArray = (flags & PATH_DASHED) != 0u
    ? instancePathStyle.yz
    : vec2(1.0, 0.0);
  pathSetColors();
}
`;

/** Compile the common path shader against the bandwidth-saving record layout. */
function compactPathShader(shader: string): string {
  return shader.replace(
    "#define SHADER_NAME",
    "#define ERDBLICK_COMPACT_PATH\n#define SHADER_NAME",
  );
}

export const COMPACT_PATH_BILLBOARD_VERTEX_SHADER = compactPathShader(
  PATH_BILLBOARD_VERTEX_SHADER,
);

export const COMPACT_PATH_WORLD_VERTEX_SHADER = compactPathShader(
  PATH_WORLD_VERTEX_SHADER,
);

export const COMPACT_PATH_FRAGMENT_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-compact-path-fragment
precision highp float;

in vec4 vColor;
in vec2 vCornerOffset;
in float vMiterLength;
in vec2 vPathPosition;
in float vPathLength;
in float vJointType;
flat in uint vPathFlags;
#ifdef ERDBLICK_DUAL_STROKE
flat in vec4 vInnerColor;
flat in float vInnerWidthRatio;
#endif
layout(location = 0) out vec4 fragColor;

const uint PATH_START_CAP = 2u;
const uint PATH_END_CAP = 4u;

void main(void) {
  geometry.uv = vPathPosition;
  float strokeDistance = abs(vPathPosition.x);
  if (vPathPosition.y < 0.0) {
    if ((vPathFlags & PATH_START_CAP) != 0u) {
      strokeDistance = length(vPathPosition);
      if (strokeDistance > 1.0) {
        discard;
      }
    } else if (vJointType > 0.5 && length(vCornerOffset) > 1.0) {
      discard;
    } else if (vJointType < 0.5 && vMiterLength > 5.0) {
      discard;
    }
  } else if (vPathPosition.y > vPathLength) {
    if ((vPathFlags & PATH_END_CAP) != 0u) {
      strokeDistance = length(vec2(
          vPathPosition.x,
          vPathPosition.y - vPathLength));
      if (strokeDistance > 1.0) {
        discard;
      }
    } else if (vJointType > 0.5 && length(vCornerOffset) > 1.0) {
      discard;
    } else if (vJointType < 0.5 && vMiterLength > 5.0) {
      discard;
    }
  }
#ifdef ERDBLICK_DUAL_STROKE
#ifdef ERDBLICK_MASK_RENDER
  bool innerOnly = true;
#else
  bool innerOnly = picking.isActive > 0.5;
#endif
  if (innerOnly && strokeDistance > vInnerWidthRatio) {
    discard;
  }
  if (innerOnly) {
    fragColor = vInnerColor;
  } else {
    float feather = max(fwidth(strokeDistance) * 0.5, 0.00001);
    float innerCoverage = 1.0 - smoothstep(
      vInnerWidthRatio - feather,
      vInnerWidthRatio + feather,
      strokeDistance);
    float innerAlpha = vInnerColor.a * innerCoverage;
    float combinedAlpha = innerAlpha + vColor.a * (1.0 - innerAlpha);
    vec3 premultiplied =
      vInnerColor.rgb * innerAlpha +
      vColor.rgb * vColor.a * (1.0 - innerAlpha);
    fragColor = vec4(
      combinedAlpha > 0.0 ? premultiplied / combinedAlpha : vec3(0.0),
      combinedAlpha);
  }
#else
  fragColor = vColor;
#endif
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

/** Compile one compact path that paints a second stroke in the same fragment pass. */
function dualStrokePathShader(shader: string): string {
  return shader.replace(
    "#define ERDBLICK_COMPACT_PATH",
    "#define ERDBLICK_COMPACT_PATH\n#define ERDBLICK_DUAL_STROKE",
  );
}

export const DUAL_COMPACT_PATH_BILLBOARD_VERTEX_SHADER = dualStrokePathShader(
  COMPACT_PATH_BILLBOARD_VERTEX_SHADER,
);

export const DUAL_COMPACT_PATH_WORLD_VERTEX_SHADER = dualStrokePathShader(
  COMPACT_PATH_WORLD_VERTEX_SHADER,
);

export const DUAL_COMPACT_PATH_FRAGMENT_SHADER =
  COMPACT_PATH_FRAGMENT_SHADER.replace(
    "#define SHADER_NAME",
    "#define ERDBLICK_DUAL_STROKE\n#define SHADER_NAME",
  );

/** Compile a complete two-point path against the reduced record declaration. */
function simplePathShader(main: string): string {
  return (
    PATH_VERTEX_PREFIX.replace(
      "#define SHADER_NAME",
      "#define ERDBLICK_SIMPLE_PATH\n#define SHADER_NAME",
    ) + main
  );
}

export const SIMPLE_PATH_BILLBOARD_VERTEX_SHADER = simplePathShader(
  `\
void main(void) {
  vec4 startCommon; vec4 startClip;
  vec4 endCommon; vec4 endClip;
  gpuScene_projectLocal(
    instanceStart, instanceMetadata.x, startCommon, startClip);
  gpuScene_projectLocal(instanceEnd, instanceMetadata.x, endCommon, endClip);
  vec4 contribution = gpuScene_contribution(instanceMetadata.y);
  bool recordActive = gpuScene_isActive(
    instanceMetadata.w, contribution, instanceMetadata.z);
  geometry.pickingColor = recordActive
    ? gpuScene_pickingColor(instanceMetadata.z, contribution)
    : vec3(0.0);

  vec2 segment = gpuScene_clipToPixels(endClip) -
    gpuScene_clipToPixels(startClip);
  float segmentPixels = length(segment);
  vec2 direction = segmentPixels > 0.000000001
    ? segment / segmentPixels
    : vec2(0.0, 1.0);
  vec2 normal = vec2(-direction.y, direction.x);
  float halfWidth = max(0.0001, instancePathWidth * 0.5);
  bool isEnd = positions.x > 0.5;
  float side = positions.y;
  vec2 offsetPixels = normal * side * halfWidth +
    direction * (isEnd ? halfWidth : -halfWidth);
  vec4 currentClip = mix(startClip, endClip, float(isEnd));
  geometry.position = mix(startCommon, endCommon, float(isEnd));
  gl_Position = currentClip;
  gl_Position.xy += project_pixel_size_to_clipspace(offsetPixels) *
    gl_Position.w;
  gpuScene_applyDepthBias(
    gl_Position,
    instanceZIndex,
    contribution,
    instanceMetadata.z,
    instanceMetadata.y,
    uint(gl_InstanceID));
  if (!recordActive) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vPathPosition = vec2(
    side,
    isEnd ? segmentPixels / halfWidth + 1.0 : -1.0);
  vPathLength = segmentPixels / halfWidth;
  pathSetColors();
}
`,
);

export const SIMPLE_PATH_WORLD_VERTEX_SHADER = simplePathShader(
  `\
void main(void) {
  vec4 startCommon; vec4 unusedStart;
  vec4 endCommon; vec4 unusedEnd;
  gpuScene_projectLocal(
    instanceStart, instanceMetadata.x, startCommon, unusedStart);
  gpuScene_projectLocal(instanceEnd, instanceMetadata.x, endCommon, unusedEnd);
  vec4 contribution = gpuScene_contribution(instanceMetadata.y);
  bool recordActive = gpuScene_isActive(
    instanceMetadata.w, contribution, instanceMetadata.z);
  geometry.pickingColor = recordActive
    ? gpuScene_pickingColor(instanceMetadata.z, contribution)
    : vec3(0.0);

  vec2 segment = endCommon.xy - startCommon.xy;
  float segmentLength = length(segment);
  vec2 direction = segmentLength > 0.000000001
    ? segment / segmentLength
    : vec2(0.0, 1.0);
  vec2 normal = vec2(-direction.y, direction.x);
  float halfWidth = max(
    0.000000001,
    project_pixel_size(max(0.0, instancePathWidth) * 0.5));
  bool isEnd = positions.x > 0.5;
  float side = positions.y;
  vec2 offset = normal * side * halfWidth +
    direction * (isEnd ? halfWidth : -halfWidth);
  vec4 current = mix(startCommon, endCommon, float(isEnd));
  geometry.position = current + vec4(offset, 0.0, 0.0);
  gl_Position = project_common_position_to_clipspace(geometry.position);
  gpuScene_applyDepthBias(
    gl_Position,
    instanceZIndex,
    contribution,
    instanceMetadata.z,
    instanceMetadata.y,
    uint(gl_InstanceID));
  if (!recordActive) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vPathPosition = vec2(
    side,
    isEnd ? segmentLength / halfWidth + 1.0 : -1.0);
  vPathLength = segmentLength / halfWidth;
  pathSetColors();
}
`,
);

export const SIMPLE_PATH_FRAGMENT_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-simple-path-fragment
precision highp float;

in vec4 vColor;
in vec2 vPathPosition;
in float vPathLength;
#ifdef ERDBLICK_DUAL_STROKE
flat in vec4 vInnerColor;
flat in float vInnerWidthRatio;
#endif
layout(location = 0) out vec4 fragColor;

void main(void) {
  geometry.uv = vPathPosition;
  float nearestPathPosition = clamp(vPathPosition.y, 0.0, vPathLength);
  float strokeDistance = length(vec2(
      vPathPosition.x,
      vPathPosition.y - nearestPathPosition));
  if (strokeDistance > 1.0) {
    discard;
  }
#ifdef ERDBLICK_DUAL_STROKE
#ifdef ERDBLICK_MASK_RENDER
  bool innerOnly = true;
#else
  bool innerOnly = picking.isActive > 0.5;
#endif
  if (innerOnly && strokeDistance > vInnerWidthRatio) {
    discard;
  }
  if (innerOnly) {
    fragColor = vInnerColor;
  } else {
    float feather = max(fwidth(strokeDistance) * 0.5, 0.00001);
    float innerCoverage = 1.0 - smoothstep(
      vInnerWidthRatio - feather,
      vInnerWidthRatio + feather,
      strokeDistance);
    float innerAlpha = vInnerColor.a * innerCoverage;
    float combinedAlpha = innerAlpha + vColor.a * (1.0 - innerAlpha);
    vec3 premultiplied =
      vInnerColor.rgb * innerAlpha +
      vColor.rgb * vColor.a * (1.0 - innerAlpha);
    fragColor = vec4(
      combinedAlpha > 0.0 ? premultiplied / combinedAlpha : vec3(0.0),
      combinedAlpha);
  }
#else
  fragColor = vColor;
#endif
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

/** Compile a two-point dual stroke against the shortest path record. */
function dualSimplePathShader(shader: string): string {
  return shader.replace(
    "#define ERDBLICK_SIMPLE_PATH",
    "#define ERDBLICK_SIMPLE_PATH\n#define ERDBLICK_DUAL_STROKE",
  );
}

export const DUAL_SIMPLE_PATH_BILLBOARD_VERTEX_SHADER = dualSimplePathShader(
  SIMPLE_PATH_BILLBOARD_VERTEX_SHADER,
);

export const DUAL_SIMPLE_PATH_WORLD_VERTEX_SHADER = dualSimplePathShader(
  SIMPLE_PATH_WORLD_VERTEX_SHADER,
);

export const DUAL_SIMPLE_PATH_FRAGMENT_SHADER =
  SIMPLE_PATH_FRAGMENT_SHADER.replace(
    "#define SHADER_NAME",
    "#define ERDBLICK_DUAL_STROKE\n#define SHADER_NAME",
  );

export const PATH_FRAGMENT_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-path-fragment
precision highp float;

in vec4 vColor;
in vec2 vCornerOffset;
in float vMiterLength;
in vec2 vPathPosition;
in float vPathLength;
in float vJointType;
in vec2 vDashArray;
in float vDashPosition;
flat in uint vPathFlags;
layout(location = 0) out vec4 fragColor;

const uint PATH_DASH_METERS = 128u;

void main(void) {
  geometry.uv = vPathPosition;
  if (vPathPosition.y < 0.0 || vPathPosition.y > vPathLength) {
    if (vJointType > 0.5 && length(vCornerOffset) > 1.0) {
      discard;
    }
    if (vJointType < 0.5 && vMiterLength > 5.0) {
      discard;
    }
  }
  float dashUnit = vDashArray.x + vDashArray.y;
  float dashPosition = (vPathFlags & PATH_DASH_METERS) != 0u
    ? vDashPosition
    : vDashPosition * gl_FragCoord.w;
  if (dashUnit > 0.0 && vDashArray.y > 0.0 &&
      mod(dashPosition, dashUnit) > vDashArray.x) {
    discard;
  }
  fragColor = vColor;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

export const ARROW_BILLBOARD_VERTEX_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-arrow-billboard-vertex

in vec2 positions;
in vec3 instancePrevious;
in vec3 instanceTip;
in vec2 instanceOffsetVector;
in vec3 instanceArrowStyle;
in uint instanceZIndex;
in vec4 instanceColor;
in uvec4 instanceMetadata;

out vec4 vColor;

${BILLBOARD_MINIMUM_SCREEN_LENGTH_SHADER}

void main(void) {
  vec4 previousCommon; vec4 previousClip;
  vec4 tipCommon; vec4 tipClip;
  gpuScene_projectLocal(
    instancePrevious, instanceMetadata.x, previousCommon, previousClip);
  gpuScene_projectLocal(instanceTip, instanceMetadata.x, tipCommon, tipClip);
#if defined(ERDBLICK_SCREEN_LENGTH_START_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_END_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_CENTER_ANCHOR)
  gpuScene_applyMinimumScreenLength(
    previousClip,
    tipClip,
    instanceArrowStyle.y);
#endif
  vec4 contribution = gpuScene_contribution(instanceMetadata.y);
  bool recordActive = gpuScene_isActive(
    instanceMetadata.w, contribution, instanceMetadata.z);
  geometry.pickingColor = recordActive
    ? gpuScene_pickingColor(instanceMetadata.z, contribution)
    : vec3(0.0);

  float offsetScale = gpuScene_offsetScale(instanceArrowStyle.z);
  vec2 offsetPixels;
  uint flags = instanceMetadata.w & GPU_SCENE_RECORD_FLAG_MASK;
  if ((flags & 2u) != 0u) {
    offsetPixels = gpuScene_localVectorToScreen(
      tipCommon, tipClip, instanceOffsetVector * offsetScale);
  } else {
    vec2 direction = gpuScene_clipToPixels(tipClip) -
      gpuScene_clipToPixels(previousClip);
    float directionLength = length(direction);
    offsetPixels = directionLength > 0.000000001
      ? vec2(direction.y, -direction.x) / directionLength * instanceArrowStyle.x
      : vec2(0.0);
  }
  previousClip.xy += project_pixel_size_to_clipspace(offsetPixels) *
    previousClip.w;
  tipClip.xy += project_pixel_size_to_clipspace(offsetPixels) * tipClip.w;
  vec2 tangent = gpuScene_clipToPixels(tipClip) -
    gpuScene_clipToPixels(previousClip);
  float tangentLength = length(tangent);
  tangent = tangentLength > 0.000000001
    ? tangent / tangentLength
    : vec2(0.0, 1.0);
  vec2 normal = vec2(-tangent.y, tangent.x);
  float arrowSize = max(8.0, instanceArrowStyle.y * 4.0);
  vec2 triangleOffset =
    normal * positions.x * arrowSize + tangent * positions.y * arrowSize;
  geometry.position = tipCommon;
  gl_Position = tipClip;
  gl_Position.xy += project_pixel_size_to_clipspace(triangleOffset) *
    gl_Position.w;
  gpuScene_applyDepthBias(
    gl_Position,
    instanceZIndex,
    contribution,
    instanceMetadata.z,
    instanceMetadata.y,
    uint(gl_InstanceID));
  if (!recordActive) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vColor = vec4(instanceColor.rgb, instanceColor.a * layer.opacity);
  DECKGL_FILTER_COLOR(vColor, geometry);
}
`;

export const ARROW_WORLD_VERTEX_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-arrow-world-vertex

in vec2 positions;
in vec3 instancePrevious;
in vec3 instanceTip;
in vec2 instanceOffsetVector;
in vec3 instanceArrowStyle;
in uint instanceZIndex;
in vec4 instanceColor;
in uvec4 instanceMetadata;

out vec4 vColor;

${WORLD_MINIMUM_SCREEN_LENGTH_SHADER}

void main(void) {
  vec4 previousCommon; vec4 previousClip;
  vec4 tipCommon; vec4 tipClip;
  gpuScene_projectLocal(
    instancePrevious, instanceMetadata.x, previousCommon, previousClip);
  gpuScene_projectLocal(instanceTip, instanceMetadata.x, tipCommon, tipClip);
#if defined(ERDBLICK_SCREEN_LENGTH_START_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_END_ANCHOR) || \
    defined(ERDBLICK_SCREEN_LENGTH_CENTER_ANCHOR)
  gpuScene_applyMinimumWorldLength(
    previousCommon,
    previousClip,
    tipCommon,
    tipClip,
    instanceArrowStyle.y);
#endif
  vec4 contribution = gpuScene_contribution(instanceMetadata.y);
  bool recordActive = gpuScene_isActive(
    instanceMetadata.w, contribution, instanceMetadata.z);
  geometry.pickingColor = recordActive
    ? gpuScene_pickingColor(instanceMetadata.z, contribution)
    : vec3(0.0);

  vec2 tangent = tipCommon.xy - previousCommon.xy;
  float tangentLength = length(tangent);
  tangent = tangentLength > 0.000000001
    ? tangent / tangentLength
    : vec2(0.0, 1.0);
  vec2 normal = vec2(-tangent.y, tangent.x);
  float offsetScale = gpuScene_offsetScale(instanceArrowStyle.z);
  vec3 commonOffset;
  uint flags = instanceMetadata.w & GPU_SCENE_RECORD_FLAG_MASK;
  if ((flags & 2u) != 0u) {
    commonOffset = gpuScene_localVectorToCommon(
      tipCommon,
      instanceOffsetVector * offsetScale);
  } else {
    vec2 offsetNormal = vec2(tangent.y, -tangent.x);
    commonOffset = vec3(
      offsetNormal * project_pixel_size(instanceArrowStyle.x),
      0.0);
  }
  previousCommon.xyz += commonOffset;
  tipCommon.xyz += commonOffset;

  float arrowSize = project_pixel_size(
    max(8.0, instanceArrowStyle.y * 4.0));
  vec2 triangleOffset =
    normal * positions.x * arrowSize + tangent * positions.y * arrowSize;
  geometry.position = tipCommon + vec4(triangleOffset, 0.0, 0.0);
  gl_Position = project_common_position_to_clipspace(geometry.position);
  gpuScene_applyDepthBias(
    gl_Position,
    instanceZIndex,
    contribution,
    instanceMetadata.z,
    instanceMetadata.y,
    uint(gl_InstanceID));
  if (!recordActive) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vColor = vec4(instanceColor.rgb, instanceColor.a * layer.opacity);
  DECKGL_FILTER_COLOR(vColor, geometry);
}
`;

export const ARROW_FRAGMENT_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-arrow-fragment
precision highp float;
in vec4 vColor;
layout(location = 0) out vec4 fragColor;
void main(void) {
  fragColor = vColor;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

export const SURFACE_VERTEX_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-surface-vertex

in float positions;
in vec3 instancePosition0;
in vec3 instancePosition1;
in vec3 instancePosition2;
in uint instanceZIndex;
in vec4 instanceColor;
in uvec4 instanceMetadata;

out vec4 vColor;
#ifdef ERDBLICK_SURFACE_SHADING
flat out vec3 vSurfaceNormal;
#endif

void main(void) {
  vec3 localPosition = positions < 0.5
    ? instancePosition0
    : positions < 1.5 ? instancePosition1 : instancePosition2;
#ifdef ERDBLICK_SURFACE_SHADING
  vSurfaceNormal = vec3(0.0);
  // Semantic support is a material role; support surfaces remain visible.
  if (gpuScene.flattenZ < 0.5) {
    vec3 faceNormal = cross(
      instancePosition1 - instancePosition0,
      instancePosition2 - instancePosition0);
    float normalLength = length(faceNormal);
    if (normalLength > 0.000001) {
      vSurfaceNormal = faceNormal / normalLength;
    }
  }
#endif
  vec4 commonPosition;
  vec4 clipPosition;
  gpuScene_projectLocal(
    localPosition, instanceMetadata.x, commonPosition, clipPosition);
  vec4 contribution = gpuScene_contribution(instanceMetadata.y);
  bool recordActive = gpuScene_isActive(
    instanceMetadata.w, contribution, instanceMetadata.z);
  geometry.pickingColor = recordActive
    ? gpuScene_pickingColor(instanceMetadata.z, contribution)
    : vec3(0.0);
  geometry.position = commonPosition;
  gl_Position = clipPosition;
  gpuScene_applyDepthBias(
    gl_Position,
    instanceZIndex,
    contribution,
    instanceMetadata.z,
    instanceMetadata.y,
    uint(gl_InstanceID));
  if (!recordActive) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vColor = vec4(instanceColor.rgb, instanceColor.a * layer.opacity);
  DECKGL_FILTER_COLOR(vColor, geometry);
}
`;

export const SURFACE_FRAGMENT_SHADER = `\
#version 300 es
#define SHADER_NAME erdblick-gpu-surface-fragment
precision highp float;
in vec4 vColor;
#ifdef ERDBLICK_SURFACE_SHADING
flat in vec3 vSurfaceNormal;
#endif
layout(location = 0) out vec4 fragColor;
void main(void) {
#if defined(ERDBLICK_SURFACE_SHADING) && !defined(ERDBLICK_MASK_RENDER)
  float light = 1.0;
  if (dot(vSurfaceNormal, vSurfaceNormal) > 0.5) {
    vec3 normal = gl_FrontFacing ? vSurfaceNormal : -vSurfaceNormal;
    vec3 lightDirection = normalize(vec3(-0.45, 0.35, 0.82));
    float diffuse = max(dot(normal, lightDirection), 0.0);
    float hemisphere = 0.5 + 0.5 * clamp(normal.z, -1.0, 1.0);
    light = clamp(0.76 + 0.24 * diffuse + 0.04 * hemisphere, 0.78, 1.0);
  }
  fragColor = vec4(vColor.rgb * light, vColor.a);
#else
  fragColor = vColor;
#endif
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;
