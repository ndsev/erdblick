import {
    LayerExtension,
    type Layer,
    type LayerContext
} from "@deck.gl/core";
import {PathLayer} from "@deck.gl/layers";

const PATH_WORLD_POSITION_MARKER =
    "geometry.worldPosition = currPosition;";
const PATH_BILLBOARD_PROJECTION_MARKER = `\
vec4 prevPositionScreen = project_position_to_clipspace(prevPosition, prevPosition64Low, ZERO_OFFSET);
vec4 currPositionScreen = project_position_to_clipspace(currPosition, currPosition64Low, ZERO_OFFSET, geometry.position);
vec4 nextPositionScreen = project_position_to_clipspace(nextPosition, nextPosition64Low, ZERO_OFFSET);`;
const PATH_COMMON_PROJECTION_MARKER = `\
prevPosition = project_position(prevPosition, prevPosition64Low);
currPosition = project_position(currPosition, currPosition64Low);
nextPosition = project_position(nextPosition, nextPosition64Low);`;

/**
 * Installs transition displacement before PathLayer computes its segment
 * normals and joins. A late gl_Position translation leaves the tessellator
 * looking at the unshifted path and necessarily tears at variable offsets.
 */
export function patchVariableOffsetPathVertexShader(shader: string): string {
    const withOffsets = shader.replace(
        PATH_WORLD_POSITION_MARKER,
        `\
${PATH_WORLD_POSITION_MARKER}

  // PathLayer tessellates one instance per segment. Both instances touching a
  // joint must see the identical displaced left/start/end/right centerline;
  // deriving either neighbour from this segment tears nonlinear offset bends.
  vec2 variableLeftOffsetPixels =
    variable_path_unpack_offset(instanceVariableOffsets.x);
  vec2 variableStartOffsetPixels =
    variable_path_unpack_offset(instanceVariableOffsets.y);
  vec2 variableEndOffsetPixels =
    variable_path_unpack_offset(instanceVariableOffsets.z);
  vec2 variableRightOffsetPixels =
    variable_path_unpack_offset(instanceVariableOffsets.w);
  float variableOffsetScale =
    variable_path_offset_scale(instanceVariableOffsets.y);
  variableLeftOffsetPixels *= variableOffsetScale;
  variableStartOffsetPixels *= variableOffsetScale;
  variableEndOffsetPixels *= variableOffsetScale;
  variableRightOffsetPixels *= variableOffsetScale;
  vec2 variablePrevOffsetPixels =
    mix(variableLeftOffsetPixels, variableStartOffsetPixels, isEnd);
  vec2 variableCurrentOffsetPixels =
    mix(variableStartOffsetPixels, variableEndOffsetPixels, isEnd);
  vec2 variableNextOffsetPixels =
    mix(variableEndOffsetPixels, variableRightOffsetPixels, isEnd);
`);
    const withBillboardOffsets = withOffsets.replace(
        PATH_BILLBOARD_PROJECTION_MARKER,
        `${PATH_BILLBOARD_PROJECTION_MARKER}

    prevPositionScreen.xy += project_pixel_size_to_clipspace(
      variable_path_project_screen_offset(
        prevPosition, prevPosition64Low, variablePrevOffsetPixels));
    currPositionScreen.xy += project_pixel_size_to_clipspace(
      variable_path_project_screen_offset(
        currPosition, currPosition64Low,
        variableCurrentOffsetPixels));
    nextPositionScreen.xy += project_pixel_size_to_clipspace(
      variable_path_project_screen_offset(
        nextPosition, nextPosition64Low, variableNextOffsetPixels));`);
    const result = withBillboardOffsets.replace(
        PATH_COMMON_PROJECTION_MARKER,
        `${PATH_COMMON_PROJECTION_MARKER}

    prevPosition += variable_path_project_common_offset(
      mix(instanceLeftPositions, instanceStartPositions, isEnd),
      mix(instanceLeftPositions64Low, instanceStartPositions64Low, isEnd),
      variablePrevOffsetPixels);
    currPosition += variable_path_project_common_offset(
      mix(instanceStartPositions, instanceEndPositions, isEnd),
      mix(instanceStartPositions64Low, instanceEndPositions64Low, isEnd),
      variableCurrentOffsetPixels);
    nextPosition += variable_path_project_common_offset(
      mix(instanceEndPositions, instanceRightPositions, isEnd),
      mix(instanceEndPositions64Low, instanceRightPositions64Low, isEnd),
      variableNextOffsetPixels);`);
    if (result === shader ||
        !result.includes("variablePrevOffsetPixels") ||
        !result.includes("variable_path_project_common_offset")) {
        throw new Error(
            "Deck PathLayer shader changed: transition offset hooks could not be installed.");
    }
    return result;
}

const variablePathOffsetShaderModule = {
    name: "variablePathOffset",
    inject: {
        "vs:#decl": `
in uvec4 instanceVariableOffsets;

const float VARIABLE_PATH_OFFSET_FIXED_SCALE = 8.0;
const uint VARIABLE_PATH_OFFSET_COMPONENT_MASK = 4095u;
const int VARIABLE_PATH_OFFSET_COMPONENT_SIGN = 2048;
const int VARIABLE_PATH_OFFSET_COMPONENT_RANGE = 4096;
const float VARIABLE_PATH_SCALE_MIN_EXPONENT = -12.0;
const float VARIABLE_PATH_SCALE_EXPONENT_STEP = 16.0 / 254.0;

vec2 variable_path_unpack_offset(uint packedOffset) {
  int offsetX = int(packedOffset & VARIABLE_PATH_OFFSET_COMPONENT_MASK);
  int offsetY = int(
    (packedOffset >> 12u) & VARIABLE_PATH_OFFSET_COMPONENT_MASK);
  offsetX = offsetX >= VARIABLE_PATH_OFFSET_COMPONENT_SIGN
    ? offsetX - VARIABLE_PATH_OFFSET_COMPONENT_RANGE
    : offsetX;
  offsetY = offsetY >= VARIABLE_PATH_OFFSET_COMPONENT_SIGN
    ? offsetY - VARIABLE_PATH_OFFSET_COMPONENT_RANGE
    : offsetY;
  return vec2(float(offsetX), float(offsetY)) /
    VARIABLE_PATH_OFFSET_FIXED_SCALE;
}

float variable_path_unpack_scale_threshold(uint packedOffset) {
  uint encoded = packedOffset >> 24u;
  return encoded == 0u
    ? 0.0
    : exp2(
        VARIABLE_PATH_SCALE_MIN_EXPONENT +
        float(encoded - 1u) * VARIABLE_PATH_SCALE_EXPONENT_STEP);
}

float variable_path_offset_scale(uint packedOffset) {
  float threshold = variable_path_unpack_scale_threshold(packedOffset);
  return threshold <= 0.0
    ? 1.0
    : min(1.0, project_size_to_pixel(threshold));
}

vec2 variable_path_screen_position(vec3 position, vec3 position64Low) {
  vec4 clipPosition = project_position_to_clipspace(
    position,
    position64Low,
    vec3(0.0));
  float reciprocalW = 1.0 / max(abs(clipPosition.w), 0.000001);
  return clipPosition.xy * reciprocalW *
    project.viewportSize * 0.5 / max(project.devicePixelRatio, 0.000001);
}

vec3 variable_path_project_common_direction(vec2 localDirection) {
  vec3 worldDirection =
    (project.modelMatrix * vec4(localDirection, 0.0, 0.0)).xyz;
  // Transform a direction directly. Subtracting two fully projected
  // positions loses a one-metre probe at Web-Mercator float precision and
  // silently collapses otherwise valid pixel offsets to zero.
  return project_offset_(vec4(worldDirection, 0.0)).xyz;
}

vec2 variable_path_project_screen_offset(
    vec3 position,
    vec3 position64Low,
    vec2 localOffsetPixels) {
  float magnitude = length(localOffsetPixels);
  if (magnitude <= 0.0001) {
    return vec2(0.0);
  }
  vec2 localDirection = localOffsetPixels / magnitude;
  vec4 originClip = project_position_to_clipspace(
    position,
    position64Low,
    vec3(0.0));
  vec3 commonDirection =
    variable_path_project_common_direction(localDirection);
  vec4 directionClip =
    project.viewProjectionMatrix * vec4(commonDirection, 0.0);
  vec2 origin = variable_path_screen_position(position, position64Low);
  vec4 shiftedClip = originClip + directionClip;
  float shiftedReciprocalW =
    1.0 / max(abs(shiftedClip.w), 0.000001);
  vec2 shifted = shiftedClip.xy * shiftedReciprocalW *
    project.viewportSize * 0.5 / max(project.devicePixelRatio, 0.000001);
  vec2 projectedDirection = shifted - origin;
  float projectedLength = length(projectedDirection);
  return projectedLength > 0.000000001
    ? projectedDirection / projectedLength * magnitude
    : vec2(0.0);
}

vec3 variable_path_project_common_offset(
    vec3 position,
    vec3 position64Low,
    vec2 localOffsetPixels) {
  float magnitude = length(localOffsetPixels);
  if (magnitude <= 0.0001) {
    return vec3(0.0);
  }
  vec2 localDirection = localOffsetPixels / magnitude;
  vec2 projectedDirection =
    variable_path_project_common_direction(localDirection).xy;
  float projectedLength = length(projectedDirection);
  return projectedLength > 0.000000001
    ? vec3(
        projectedDirection / projectedLength * project_pixel_size(magnitude),
        0.0)
    : vec3(0.0);
}

`
    }
};

/** PathLayer variant whose join calculation sees the displaced centerline. */
export class DeckVariableOffsetPathLayer extends PathLayer {
    static override layerName = "DeckVariableOffsetPathLayer";

    override getShaders(): unknown {
        const shaders = super.getShaders() as {vs: string};
        return {
            ...shaders,
            vs: patchVariableOffsetPathVertexShader(shaders.vs)
        };
    }
}

/**
 * One-attribute counterpart of Deck's constant path-offset extension.
 *
 * Each uvec4 stores a segment's exact left/start/end/right local XY
 * displacements in absolute pixels. Each word contains two signed 12-bit
 * fixed-point components plus the path-wide adaptive-scale threshold. The
 * native renderer owns the
 * transition bridge shape; this shader rotates those vectors into the current
 * view and translates PathLayer's real geometry. Adjacent segments therefore
 * feed identical triples to PathLayer's join calculation at their shared
 * vertex, at every zoom, while consuming only one attribute location.
 */
export class DeckVariablePathOffsetExtension extends LayerExtension {
    static override defaultProps = {
        getVariableOffset: {type: "accessor", value: [0, 0, 0, 0]}
    };
    static override extensionName = "DeckVariablePathOffsetExtension";

    override getShaders(this: Layer): unknown {
        return "pathTesselator" in this.state
            ? {modules: [variablePathOffsetShaderModule]}
            : null;
    }

    override initializeState(this: Layer, _context: LayerContext): void {
        if (!("pathTesselator" in this.state)) {
            return;
        }
        this.getAttributeManager()?.addInstanced({
            instanceVariableOffsets: {
                size: 4,
                type: "uint32",
                accessor: "getVariableOffset",
                defaultValue: [0, 0, 0, 0]
            }
        });
    }
}

const localPixelOffsetShaderModule = {
    name: "localPixelOffset",
    inject: {
        "vs:#decl": `
in vec3 instanceLocalPixelOffsets;

vec3 local_pixel_offset_project_common_direction(vec2 localDirection) {
  vec3 worldDirection =
    (project.modelMatrix * vec4(localDirection, 0.0, 0.0)).xyz;
  return project_offset_(vec4(worldDirection, 0.0)).xyz;
}

vec2 local_pixel_offset_screen_position(
    vec3 position,
    vec3 position64Low) {
  vec4 clipPosition = project_position_to_clipspace(
    position,
    position64Low,
    vec3(0.0));
  float reciprocalW = 1.0 / max(abs(clipPosition.w), 0.000001);
  return clipPosition.xy * reciprocalW *
    project.viewportSize * 0.5 / max(project.devicePixelRatio, 0.000001);
}

vec2 local_pixel_offset_project(
    vec3 position,
    vec3 position64Low,
    vec2 localOffsetPixels) {
  float magnitude = length(localOffsetPixels);
  if (magnitude <= 0.0001) {
    return vec2(0.0);
  }
  vec2 localDirection = localOffsetPixels / magnitude;
  vec4 originClip = project_position_to_clipspace(
    position,
    position64Low,
    vec3(0.0));
  vec4 directionClip = project.viewProjectionMatrix * vec4(
    local_pixel_offset_project_common_direction(localDirection),
    0.0);
  vec2 origin = local_pixel_offset_screen_position(position, position64Low);
  vec4 shiftedClip = originClip + directionClip;
  float shiftedReciprocalW =
    1.0 / max(abs(shiftedClip.w), 0.000001);
  vec2 shifted = shiftedClip.xy * shiftedReciprocalW *
    project.viewportSize * 0.5 / max(project.devicePixelRatio, 0.000001);
  vec2 projectedDirection = shifted - origin;
  float projectedLength = length(projectedDirection);
  return projectedLength > 0.000000001
    ? projectedDirection / projectedLength * magnitude
    : vec2(0.0);
}

vec3 local_pixel_offset_project_common(
    vec3 position,
    vec3 position64Low,
    vec2 localOffsetPixels) {
  float magnitude = length(localOffsetPixels);
  if (magnitude <= 0.0001) {
    return vec3(0.0);
  }
  vec2 localDirection = localOffsetPixels / magnitude;
  vec2 projectedDirection =
    local_pixel_offset_project_common_direction(localDirection).xy;
  float projectedLength = length(projectedDirection);
  return projectedLength > 0.000000001
    ? vec3(
        projectedDirection / projectedLength * project_pixel_size(magnitude),
        0.0)
    : vec3(0.0);
}

float local_pixel_offset_scale(float threshold) {
  return threshold <= 0.0
    ? 1.0
    : min(1.0, project_size_to_pixel(threshold));
}
`,
        "vs:DECKGL_FILTER_SIZE": `
  vec2 localPixelOffset = instanceLocalPixelOffsets.xy *
    local_pixel_offset_scale(instanceLocalPixelOffsets.z);
  if (icon.billboard) {
    size.xy += local_pixel_offset_project(
      geometry.worldPosition,
      vec3(0.0),
      localPixelOffset);
  } else {
    size += local_pixel_offset_project_common(
      geometry.worldPosition,
      vec3(0.0),
      localPixelOffset);
  }
`
    }
};

/** Applies a local-map XY displacement to an icon in absolute screen pixels. */
export class DeckLocalPixelOffsetExtension extends LayerExtension {
    static override defaultProps = {
        getLocalPixelOffset: {type: "accessor", value: [0, 0, 0]}
    };
    static override extensionName = "DeckLocalPixelOffsetExtension";

    override getShaders(): unknown {
        return {modules: [localPixelOffsetShaderModule]};
    }

    override initializeState(this: Layer, _context: LayerContext): void {
        this.getAttributeManager()?.addInstanced({
            instanceLocalPixelOffsets: {
                size: 3,
                accessor: "getLocalPixelOffset",
                defaultValue: [0, 0, 0]
            }
        });
    }
}

/**
 * Packs per-vertex local XY pixel vectors into the one uvec4 segment attribute
 * consumed by `DeckVariablePathOffsetExtension`.
 *
 * PathLayer instance i spans vertices i..i+1 and computes the joins at both
 * endpoints using vertices i-1..i+2. Consequently every packed row carries
 * all four exact offset vectors, with path-boundary values clamped. Packing a
 * Packing the vector and scale threshold into one uint32 keeps this at one
 * GPU attribute location.
 */
export function packVariablePathOffsetVectors(
    vectors: ArrayLike<number>,
    startIndices: ArrayLike<number>,
    offsetScaleThresholds?: ArrayLike<number>
): Uint32Array {
    const vertexCount = Math.floor(vectors.length / 2);
    const packed = new Uint32Array(vertexCount * 4);
    const quantize = (value: number): number => {
        const finiteValue = Number.isFinite(value) ? value : 0;
        const fixed = Math.round(finiteValue * 8);
        return Math.max(-2048, Math.min(2047, fixed)) & 0xfff;
    };
    for (let path = 0; path + 1 < startIndices.length; ++path) {
        const start = Number(startIndices[path]);
        const end = Number(startIndices[path + 1]);
        if (start < 0 || end <= start || end > vertexCount) {
            continue;
        }
        const encodedThreshold = encodeVariablePathOffsetScaleThreshold(
            Number(offsetScaleThresholds?.[path] ?? 0));
        const encodedVectors = new Uint32Array(end - start);
        for (let index = start; index < end; ++index) {
            const x = quantize(Number(vectors[index * 2]));
            const y = quantize(Number(vectors[index * 2 + 1]));
            encodedVectors[index - start] = (
                x |
                (y << 12) |
                (encodedThreshold << 24)
            ) >>> 0;
        }
        const encodedAt = (index: number) =>
            encodedVectors[index - start];
        for (let index = start; index < end; ++index) {
            packed[index * 4] = encodedAt(Math.max(index - 1, start));
            packed[index * 4 + 1] = encodedAt(index);
            packed[index * 4 + 2] = encodedAt(
                Math.min(index + 1, end - 1));
            packed[index * 4 + 3] = encodedAt(
                Math.min(index + 2, end - 1));
        }
    }
    return packed;
}

const VARIABLE_PATH_SCALE_MIN_EXPONENT = -12;
const VARIABLE_PATH_SCALE_MAX_EXPONENT = 4;
const VARIABLE_PATH_SCALE_STEPS = 254;

function encodeVariablePathOffsetScaleThreshold(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    const exponent = Math.max(
        VARIABLE_PATH_SCALE_MIN_EXPONENT,
        Math.min(VARIABLE_PATH_SCALE_MAX_EXPONENT, Math.log2(value)));
    return 1 + Math.round(
        (exponent - VARIABLE_PATH_SCALE_MIN_EXPONENT) /
        (VARIABLE_PATH_SCALE_MAX_EXPONENT -
            VARIABLE_PATH_SCALE_MIN_EXPONENT) *
        VARIABLE_PATH_SCALE_STEPS);
}

/** Quantizes a threshold exactly as the packed PathLayer shader payload does. */
export function quantizeVariablePathOffsetScaleThreshold(value: number): number {
    const encoded = encodeVariablePathOffsetScaleThreshold(value);
    if (!encoded) {
        return 0;
    }
    const exponent = VARIABLE_PATH_SCALE_MIN_EXPONENT +
        (encoded - 1) *
        (VARIABLE_PATH_SCALE_MAX_EXPONENT -
            VARIABLE_PATH_SCALE_MIN_EXPONENT) /
        VARIABLE_PATH_SCALE_STEPS;
    return 2 ** exponent;
}
