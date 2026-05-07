import {
    COORDINATE_SYSTEM,
    fp64LowPart,
    Layer,
    picking,
    project32,
    type CoordinateSystem,
    type PickingInfo,
    type LayerProps,
    type UpdateParameters
} from "@deck.gl/core";
import type {Device, Texture} from "@luma.gl/core";
import {createScenegraphsFromGLTF} from "@luma.gl/gltf";
import {Geometry, GroupNode, Model, ModelNode} from "@luma.gl/engine";
import {type ShaderModule, pbrMaterial} from "@luma.gl/shadertools";
import {parse} from "@loaders.gl/core";
import {GLTFLoader, postProcessGLTF, type GLTFPostprocessed, type GLTFWithBuffers} from "@loaders.gl/gltf";
import {Matrix4} from "@math.gl/core";

import {FeatureTile} from "../../mapdata/features.model";

const GLTF_NODE_UNIFORM_BLOCK = `\
uniform gltfNodeUniforms {
  vec3 tilePosition;
  vec3 tilePosition64Low;
  vec4 tintColor;
  vec3 pickingColor;
  float flatTint;
} gltfNode;
`;

const SCENEGRAPH_UNIFORM_BLOCK = `\
uniform scenegraphUniforms {
  float sizeScale;
  float sizeMinPixels;
  float sizeMaxPixels;
  mat4 sceneModelMatrix;
  bool composeModelMatrix;
} scenegraph;
`;

const GLTF_NODE_VERTEX_SHADER = `\
#version 300 es

#define SHADER_NAME deck-gltf-node-layer-vertex-shader

in vec3 positions;
#ifdef HAS_UV
  in vec2 texCoords;
#endif
#ifdef LIGHTING_PBR
  #ifdef HAS_NORMALS
    in vec3 normals;
  #endif
#endif

out vec4 vColor;
#ifndef LIGHTING_PBR
  #ifdef HAS_UV
    out vec2 vTEXCOORD_0;
  #endif
#endif

void main(void) {
  #if defined(HAS_UV) && !defined(LIGHTING_PBR)
    vTEXCOORD_0 = texCoords;
    geometry.uv = texCoords;
  #endif

  geometry.worldPosition = gltfNode.tilePosition;
  geometry.pickingColor = gltfNode.pickingColor;

  vec3 normal = vec3(0.0, 0.0, 1.0);
  #ifdef LIGHTING_PBR
    #ifdef HAS_NORMALS
      normal = (scenegraph.sceneModelMatrix * vec4(normals, 0.0)).xyz;
    #endif
  #endif

  float originalSize = project_size_to_pixel(scenegraph.sizeScale);
  float clampedSize = clamp(originalSize, scenegraph.sizeMinPixels, scenegraph.sizeMaxPixels);

  vec3 pos = (scenegraph.sceneModelMatrix * vec4(positions, 1.0)).xyz;
  pos = pos * scenegraph.sizeScale * (clampedSize / originalSize);

  if (scenegraph.composeModelMatrix) {
    DECKGL_FILTER_SIZE(pos, geometry);
    geometry.normal = project_normal(normal);
    geometry.worldPosition += pos;
    gl_Position = project_position_to_clipspace(
      pos + gltfNode.tilePosition,
      gltfNode.tilePosition64Low,
      vec3(0.0),
      geometry.position
    );
  } else {
    pos = project_size(pos);
    DECKGL_FILTER_SIZE(pos, geometry);
    gl_Position = project_position_to_clipspace(
      gltfNode.tilePosition,
      gltfNode.tilePosition64Low,
      pos,
      geometry.position
    );
    geometry.normal = project_normal(normal);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);

  #ifdef LIGHTING_PBR
    pbr_vPosition = geometry.position.xyz;
    #ifdef HAS_NORMALS
      pbr_vNormal = geometry.normal;
    #endif
    #ifdef HAS_UV
      pbr_vUV = texCoords;
    #else
      pbr_vUV = vec2(0., 0.);
    #endif
    geometry.uv = pbr_vUV;
  #endif

  vColor = gltfNode.tintColor;
  DECKGL_FILTER_COLOR(vColor, geometry);
}
`;

const GLTF_NODE_FRAGMENT_SHADER = `\
#version 300 es

#define SHADER_NAME deck-gltf-node-layer-fragment-shader

in vec4 vColor;
#ifndef LIGHTING_PBR
  #if defined(HAS_UV) && defined(HAS_BASECOLORMAP)
    in vec2 vTEXCOORD_0;
  #endif
#endif
out vec4 fragColor;

void main(void) {
  vec4 baseColor;
  #ifdef LIGHTING_PBR
    baseColor = pbr_filterColor(vec4(0));
    geometry.uv = pbr_vUV;
  #else
    #if defined(HAS_UV) && defined(HAS_BASECOLORMAP)
      baseColor = texture(pbr_baseColorSampler, vTEXCOORD_0);
      geometry.uv = vTEXCOORD_0;
    #else
      baseColor = vec4(1.0);
    #endif
  #endif
  if (gltfNode.flatTint > 0.5) {
    float tintAlpha = clamp(vColor.a, 0.0, 1.0);
    fragColor = vec4(mix(baseColor.rgb, vColor.rgb, tintAlpha), tintAlpha);
    DECKGL_FILTER_COLOR(fragColor, geometry);
    return;
  }
  fragColor = vColor * baseColor;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

const GLTF_PICK_PROXY_UNIFORM_BLOCK = `\
uniform gltfPickProxyUniforms {
  vec3 coordinateOrigin;
  vec3 coordinateOrigin64Low;
} gltfPickProxy;
`;

const GLTF_PICK_PROXY_VERTEX_SHADER = `\
#version 300 es

#define SHADER_NAME deck-gltf-pick-proxy-layer-vertex-shader

in vec3 positions;
in vec3 pickingColors;

void main(void) {
  vec3 offset = project_size(positions);
  geometry.worldPosition = gltfPickProxy.coordinateOrigin;
  geometry.pickingColor = pickingColors;
  gl_Position = project_position_to_clipspace(
    gltfPickProxy.coordinateOrigin,
    gltfPickProxy.coordinateOrigin64Low,
    offset,
    geometry.position
  );
  vec4 color = vec4(1.0);
  DECKGL_FILTER_COLOR(color, geometry);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
}
`;

const GLTF_PICK_PROXY_FRAGMENT_SHADER = `\
#version 300 es

#define SHADER_NAME deck-gltf-pick-proxy-layer-fragment-shader

out vec4 fragColor;

void main(void) {
  if (picking.isActive < 0.5) {
    discard;
  }
  fragColor = picking_filterPickingColor(vec4(1.0));
}
`;

type GltfNodeUniformProps = {
    tilePosition: [number, number, number];
    tilePosition64Low: [number, number, number];
    tintColor: [number, number, number, number];
    pickingColor: [number, number, number];
    flatTint: number;
};

const gltfNodeUniforms = {
    name: "gltfNode",
    vs: GLTF_NODE_UNIFORM_BLOCK,
    fs: GLTF_NODE_UNIFORM_BLOCK,
    uniformTypes: {
        tilePosition: "vec3<f32>",
        tilePosition64Low: "vec3<f32>",
        tintColor: "vec4<f32>",
        pickingColor: "vec3<f32>",
        flatTint: "f32"
    }
} as const satisfies ShaderModule<GltfNodeUniformProps>;

type ScenegraphUniformProps = {
    sizeScale: number;
    sizeMinPixels: number;
    sizeMaxPixels: number;
    sceneModelMatrix: Matrix4;
    composeModelMatrix: boolean;
};

const scenegraphUniforms = {
    name: "scenegraph",
    vs: SCENEGRAPH_UNIFORM_BLOCK,
    fs: SCENEGRAPH_UNIFORM_BLOCK,
    uniformTypes: {
        sizeScale: "f32",
        sizeMinPixels: "f32",
        sizeMaxPixels: "f32",
        sceneModelMatrix: "mat4x4<f32>",
        composeModelMatrix: "f32"
    }
} as const satisfies ShaderModule<ScenegraphUniformProps>;

type GltfPickProxyUniformProps = {
    coordinateOrigin: [number, number, number];
    coordinateOrigin64Low: [number, number, number];
};

const gltfPickProxyUniforms = {
    name: "gltfPickProxy",
    vs: GLTF_PICK_PROXY_UNIFORM_BLOCK,
    fs: GLTF_PICK_PROXY_UNIFORM_BLOCK,
    uniformTypes: {
        coordinateOrigin: "vec3<f32>",
        coordinateOrigin64Low: "vec3<f32>"
    }
} as const satisfies ShaderModule<GltfPickProxyUniformProps>;

type ParsedTileGltf = GLTFPostprocessed & {
    nodes?: Array<{_node?: GroupNode}>;
};

type ParsedTileGltfNode = NonNullable<ParsedTileGltf["nodes"]>[number];
type ParseGLTFOptions = Parameters<typeof createScenegraphsFromGLTF>[2];

type ParsedTileGltfSnapshot = {
    name: string;
    bytes: Uint8Array;
    center: [number, number, number];
};

/** Parsed and normalized tile GLTF attachment cached per deck device and tile version. */
export interface DeckTileGltfAsset {
    readonly cacheKey: string;
    readonly attachmentName: string;
    readonly tilePosition: [number, number, number];
    readonly byteLength: number;
    readonly sceneCount: number;
    readonly modelNodeCount: number;
    readonly nodeRootCount: number;
    readonly processedGltf: ParsedTileGltf;
    destroy(): void;
}

interface DeckTileGltfAssetCacheEntry {
    refCount: number;
    asset: DeckTileGltfAsset | null | undefined;
    promise: Promise<DeckTileGltfAsset | null>;
}

/** One resolved GLTF-node style record emitted by wasm for a feature/node pair. */
export interface DeckGltfNodeDatum {
    nodeIndex: number;
    featureAddress: number;
    color: [number, number, number, number];
    depthTest: boolean;
    flatTint: boolean;
    renderPriority: number;
}

/** One style contribution pushed into the shared visible GLTF layer. */
export interface DeckGltfNodeStyleContribution {
    sourceId: string;
    priority: number;
    styleOrder: number;
    data: DeckGltfNodeDatum[];
}

/** Simplified box proxy used only for deck picking of GLTF-backed features. */
export interface DeckGltfPickProxyDatum {
    nodeIndex: number;
    featureAddress: number;
    positions: Float32Array;
}

/** One style contribution pushed into the shared invisible GLTF pick-proxy layer. */
export interface DeckGltfPickProxyStyleContribution {
    sourceId: string;
    data: DeckGltfPickProxyDatum[];
}

/** Shared visible GLTF layer props fed by all style contributions for one tile asset. */
export type DeckGltfNodeLayerProps = LayerProps & {
    contributions: DeckGltfNodeStyleContribution[];
    asset: DeckTileGltfAsset;
};

interface DeckGltfNodeBucketDatum {
    nodeIndex: number;
    featureAddress: number;
    color: [number, number, number, number];
}

type DeckGltfNodeBucket = {
    depthTest: boolean;
    flatTint: boolean;
    maxPriority: number;
    data: DeckGltfNodeBucketDatum[];
    models: Model[];
};

export type DeckGltfPickProxyLayerProps = LayerProps & {
    contributions: DeckGltfPickProxyStyleContribution[];
    coordinateOrigin: [number, number, number];
    tileKey: string;
};

const gltfAssetCacheByDevice = new WeakMap<Device, Map<string, DeckTileGltfAssetCacheEntry>>();
const ZERO_PICKING_COLOR: [number, number, number] = [0, 0, 0];

function gltfAssetCacheKey(tile: FeatureTile): string {
    return `${tile.mapTileKey}:${tile.dataVersion}`;
}

/** Returns the per-device GLTF asset cache shared by visible and picking layers. */
function getDeviceCache(device: Device): Map<string, DeckTileGltfAssetCacheEntry> {
    let cache = gltfAssetCacheByDevice.get(device);
    if (!cache) {
        cache = new Map<string, DeckTileGltfAssetCacheEntry>();
        gltfAssetCacheByDevice.set(device, cache);
    }
    return cache;
}

function normalizeColor(color: [number, number, number, number]): [number, number, number, number] {
    return [
        color[0] / 255,
        color[1] / 255,
        color[2] / 255,
        color[3] / 255
    ];
}

function tilePosition64Low(position: [number, number, number]): [number, number, number] {
    return [
        fp64LowPart(position[0]),
        fp64LowPart(position[1]),
        fp64LowPart(position[2])
    ];
}

/**
 * Mirrors deck's scenegraph transform behavior so we only compose the node-local matrix
 * when the layer is rendered in a local Cartesian or meter-offset frame.
 */
function shouldComposeModelMatrix(coordinateSystem: CoordinateSystem, isGeospatial: boolean): boolean {
    return coordinateSystem === COORDINATE_SYSTEM.CARTESIAN
        || coordinateSystem === COORDINATE_SYSTEM.METER_OFFSETS
        || (coordinateSystem === COORDINATE_SYSTEM.DEFAULT && !isGeospatial);
}

/** Builds the scenegraph `Model` options shared by every visible GLTF node draw. */
function buildModelOptions(layerId: string): ParseGLTFOptions {
    return {
        modelOptions: {
            id: layerId,
            isInstanced: false,
            vs: GLTF_NODE_VERTEX_SHADER,
            fs: GLTF_NODE_FRAGMENT_SHADER,
            modules: [project32, picking, scenegraphUniforms, gltfNodeUniforms, pbrMaterial]
        },
        useTangents: false
    };
}

async function readTileGltfSnapshot(tile: FeatureTile): Promise<ParsedTileGltfSnapshot | null> {
    return await tile.getGlbAttachmentSnapshot();
}

/** Parses one tile attachment into the immutable GLTF asset snapshot shared by all layer states. */
async function buildTileGltfAsset(
    device: Device,
    tile: FeatureTile,
    cacheKey: string
): Promise<DeckTileGltfAsset | null> {
    const snapshot = await readTileGltfSnapshot(tile);
    if (!snapshot) {
        return null;
    }

    const attachmentBuffer = snapshot.bytes.slice().buffer as ArrayBuffer;
    const parsed = await parse(attachmentBuffer, GLTFLoader) as GLTFWithBuffers;
    const processed = postProcessGLTF(parsed) as ParsedTileGltf;
    return {
        cacheKey,
        attachmentName: snapshot.name,
        tilePosition: snapshot.center,
        byteLength: snapshot.bytes.byteLength,
        sceneCount: processed.scenes?.length ?? 0,
        modelNodeCount: (processed.nodes ?? []).reduce((count, node) => count + (node.mesh ? 1 : 0), 0),
        nodeRootCount: processed.nodes?.length ?? 0,
        processedGltf: processed,
        destroy() {}
    };
}

/**
 * Walks the parsed scenegraph and records the subtree root for every glTF node index.
 *
 * The stored parent-world matrix intentionally excludes the root node's own local transform,
 * because `GroupNode.traverse()` reapplies that local matrix when descending the subtree.
 */
function mapNodeRoots(
    gltfNode: ParsedTileGltfNode,
    parsedNode: GroupNode,
    nodeIndexByRef: Map<object, number>,
    nodeRoots: Map<number, GroupNode>,
    nodeRootWorldMatrices: Map<number, Matrix4>,
    parentWorldMatrix: Matrix4
): void {
    const worldMatrix = new Matrix4(parentWorldMatrix).multiplyRight(parsedNode.matrix);
    const nodeIndex = nodeIndexByRef.get(gltfNode);
    if (nodeIndex !== undefined) {
        nodeRoots.set(nodeIndex, parsedNode);
        // GroupNode.traverse() multiplies the passed world matrix by the group's own matrix
        // before visiting descendants. Store the parent world transform here so the root
        // node's local transform is applied exactly once during filtered traversal.
        nodeRootWorldMatrices.set(nodeIndex, new Matrix4(parentWorldMatrix));
    }

    const gltfChildren = gltfNode.children ?? [];
    const parsedChildren = parsedNode.children;
    const childCount = Math.min(gltfChildren.length, parsedChildren.length);
    for (let childIndex = 0; childIndex < childCount; childIndex++) {
        const parsedChild = parsedChildren[childIndex];
        if (!(parsedChild instanceof GroupNode)) {
            continue;
        }
        mapNodeRoots(
            gltfChildren[childIndex],
            parsedChild,
            nodeIndexByRef,
            nodeRoots,
            nodeRootWorldMatrices,
            worldMatrix
        );
    }
}

type LayerScenegraphState = {
    assetCacheKey: string | null;
    scenes: GroupNode[];
    nodeDrawRecords: Map<number, Array<{model: Model; worldMatrix: Matrix4}>>;
    buckets: DeckGltfNodeBucket[];
    models: Model[];
    sharedTextureKeys: string[];
    textureCacheDevice: Device | null;
};

function createEmptyLayerScenegraphState(): LayerScenegraphState {
    return {
        assetCacheKey: null,
        scenes: [],
        nodeDrawRecords: new Map(),
        buckets: [],
        models: [],
        sharedTextureKeys: [],
        textureCacheDevice: null
    };
}

/** Orders contributions deterministically so later resolution is stable across rerenders. */
function sortContributions(
    left: DeckGltfNodeStyleContribution,
    right: DeckGltfNodeStyleContribution
): number {
    const priorityDiff = left.priority - right.priority;
    if (priorityDiff !== 0) {
        return priorityDiff;
    }
    const styleOrderDiff = left.styleOrder - right.styleOrder;
    if (styleOrderDiff !== 0) {
        return styleOrderDiff;
    }
    return left.sourceId.localeCompare(right.sourceId);
}

function makeResolvedDatumKey(datum: Pick<DeckGltfNodeDatum, "featureAddress" | "nodeIndex">): string {
    return `${datum.featureAddress}:${datum.nodeIndex}`;
}

/**
 * Resolves the contribution stack for one shared GLTF layer.
 *
 * Base contributions replace earlier base styling for the same feature/node, while flat-tint
 * contributions stay in a separate overlay stream so hover/selection can draw on top.
 */
function resolveContributionData(contributions: DeckGltfNodeStyleContribution[]): DeckGltfNodeDatum[] {
    const baseByKey = new Map<string, DeckGltfNodeDatum>();
    const overlayByKey = new Map<string, DeckGltfNodeDatum>();
    for (const contribution of [...contributions].sort(sortContributions)) {
        for (const datum of contribution.data) {
            const key = makeResolvedDatumKey(datum);
            if (datum.flatTint) {
                overlayByKey.set(key, datum);
            } else {
                baseByKey.set(key, datum);
            }
        }
    }
    return [...baseByKey.values(), ...overlayByKey.values()].sort((left, right) => {
        const priorityDiff = left.renderPriority - right.renderPriority;
        if (priorityDiff !== 0) {
            return priorityDiff;
        }
        const featureAddressDiff = left.featureAddress - right.featureAddress;
        if (featureAddressDiff !== 0) {
            return featureAddressDiff;
        }
        return left.nodeIndex - right.nodeIndex;
    });
}

function gltfCullMode(flatTint: boolean): "back" | "none" {
    // Selection/hover highlight meshes should stay visible even when imported winding is inconsistent.
    // For the textured base pass we still cull backfaces to avoid drawing both sides.
    return flatTint ? "none" : "back";
}

type SharedExternalTextureCacheEntry = {
    texture: Texture;
    refCount: number;
};

type SharedExternalTextureCache = {
    nextImageId: number;
    imageIds: WeakMap<object, number>;
    entries: Map<string, SharedExternalTextureCacheEntry>;
};

const sharedExternalTextureCaches = new WeakMap<Device, SharedExternalTextureCache>();

/** Returns the per-device cache that deduplicates repeated external-image texture uploads. */
function getSharedExternalTextureCache(device: Device): SharedExternalTextureCache {
    let cache = sharedExternalTextureCaches.get(device);
    if (!cache) {
        cache = {
            nextImageId: 1,
            imageIds: new WeakMap<object, number>(),
            entries: new Map()
        };
        sharedExternalTextureCaches.set(device, cache);
    }
    return cache;
}

/** Assigns a stable numeric identity to one decoded image object for cache-key generation. */
function textureCacheImageId(cache: SharedExternalTextureCache, image: object): number {
    let imageId = cache.imageIds.get(image);
    if (imageId === undefined) {
        imageId = cache.nextImageId++;
        cache.imageIds.set(image, imageId);
    }
    return imageId;
}

/**
 * Derives a cache key for textures backed by decoded external images.
 *
 * Buffer-backed uploads are ignored here because they typically carry unique payload bytes
 * already, while the expensive `copyExternalImage` path is driven by DOM/ImageBitmap sources.
 */
function sharedExternalTextureCacheKey(
    cache: SharedExternalTextureCache,
    props: Record<string, unknown>
): string | null {
    const image = props["data"];
    if (!image || typeof image !== "object" || ArrayBuffer.isView(image) || image instanceof ArrayBuffer) {
        return null;
    }
    const width = props["width"];
    const height = props["height"];
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
    }
    const samplerKey = JSON.stringify(props["sampler"] ?? null);
    const imageId = textureCacheImageId(cache, image);
    return `${imageId}:${width}x${height}:${samplerKey}`;
}

/**
 * Groups resolved feature/node draws into buckets with identical GL state and shared models.
 *
 * This keeps per-frame draw submission cheap while still allowing highlights to sort above
 * the textured base pass.
 */
function resolveBuckets(
    resolvedData: DeckGltfNodeDatum[],
    nodeDrawRecords: Map<number, Array<{model: Model; worldMatrix: Matrix4}>>
): {buckets: DeckGltfNodeBucket[]; models: Model[]} {
    const buckets = new Map<string, DeckGltfNodeBucket & {modelSet: Set<Model>}>();
    const models: Model[] = [];
    const seenModels = new Set<Model>();

    for (const datum of resolvedData) {
        const bucketKey = `${datum.renderPriority}:${datum.depthTest ? 1 : 0}:${datum.flatTint ? 1 : 0}`;
        let bucket = buckets.get(bucketKey);
        if (!bucket) {
            bucket = {
                depthTest: datum.depthTest,
                flatTint: datum.flatTint,
                maxPriority: datum.renderPriority,
                data: [],
                models: [],
                modelSet: new Set<Model>()
            };
            buckets.set(bucketKey, bucket);
        }
        bucket.data.push({
            nodeIndex: datum.nodeIndex,
            featureAddress: datum.featureAddress,
            color: datum.color
        });
        const drawRecords = nodeDrawRecords.get(datum.nodeIndex);
        if (!drawRecords) {
            continue;
        }
        for (const drawRecord of drawRecords) {
            if (!bucket.modelSet.has(drawRecord.model)) {
                bucket.modelSet.add(drawRecord.model);
                bucket.models.push(drawRecord.model);
            }
            if (!seenModels.has(drawRecord.model)) {
                seenModels.add(drawRecord.model);
                models.push(drawRecord.model);
            }
        }
    }

    return {
        buckets: [...buckets.values()]
            .sort((left, right) =>
                left.maxPriority - right.maxPriority
                || Number(right.depthTest) - Number(left.depthTest)
            )
            .map(({modelSet: _modelSet, ...bucket}) => bucket),
        models
    };
}

/** Clones the processed glTF tree so each layer state owns fresh luma scenegraph nodes. */
export function cloneProcessedGltfForScenegraph(processedGltf: ParsedTileGltf): ParsedTileGltf {
    const clonedNodes: any[] = [];
    const sourceScenes = processedGltf.scenes ?? [];
    const cloneNode = (node: any): any => {
        const clonedMesh = node.mesh ? {...node.mesh} : node.mesh;
        if (clonedMesh && "_mesh" in clonedMesh) {
            delete clonedMesh._mesh;
        }
        const clonedNode = {
            ...node,
            _node: undefined,
            mesh: clonedMesh,
            children: [] as any[]
        };
        clonedNodes.push(clonedNode);
        clonedNode.children = Array.isArray(node.children) ? node.children.map(cloneNode) : [];
        return clonedNode;
    };
    const clonedScenes = sourceScenes.map((scene: any, sceneIndex: number) => ({
        ...scene,
        id: scene.id ?? `scene-${sceneIndex}`,
        nodes: Array.isArray(scene.nodes) ? scene.nodes.map(cloneNode) : []
    }));
    const activeSceneIndex = processedGltf.scene ? sourceScenes.indexOf(processedGltf.scene) : 0;

    return {
        ...processedGltf,
        scene: clonedScenes[Math.max(0, activeSceneIndex)] ?? undefined,
        scenes: clonedScenes,
        nodes: clonedNodes
    };
}

/**
 * Builds the layer-local scenegraph state used by the visible GLTF renderer.
 *
 * The temporary `createTexture` override deduplicates repeated external-image uploads during
 * `createScenegraphsFromGLTF(...)`, which is where large shared texture sets previously froze
 * the UI in `copyExternalImage`.
 */
function buildLayerScenegraphState(
    device: Device,
    asset: DeckTileGltfAsset,
    layerId: string
): LayerScenegraphState {
    const processed = cloneProcessedGltfForScenegraph(asset.processedGltf);
    const sharedTextureCache = getSharedExternalTextureCache(device);
    const originalCreateTexture = (device as any).createTexture.bind(device);
    const usedTextureKeys = new Set<string>();
    const newlyCreatedTextureKeys = new Set<string>();
    let scenegraphs;
    try {
        (device as any).createTexture = (props: unknown) => {
            if (!props || typeof props !== "object") {
                return originalCreateTexture(props);
            }
            const key = sharedExternalTextureCacheKey(
                sharedTextureCache,
                props as Record<string, unknown>
            );
            if (!key) {
                return originalCreateTexture(props);
            }
            usedTextureKeys.add(key);
            const cached = sharedTextureCache.entries.get(key);
            if (cached) {
                return cached.texture;
            }
            const texture = originalCreateTexture(props);
            sharedTextureCache.entries.set(key, {
                texture,
                refCount: 0
            });
            newlyCreatedTextureKeys.add(key);
            return texture;
        };
        scenegraphs = createScenegraphsFromGLTF(
            device,
            processed,
            buildModelOptions(`deck-gltf:${layerId}:${asset.cacheKey}`)
        );
        for (const key of usedTextureKeys) {
            const entry = sharedTextureCache.entries.get(key);
            if (entry) {
                entry.refCount += 1;
            }
        }
    } finally {
        (device as any).createTexture = originalCreateTexture;
        if (!scenegraphs) {
            for (const key of newlyCreatedTextureKeys) {
                const entry = sharedTextureCache.entries.get(key);
                if (!entry || entry.refCount !== 0) {
                    continue;
                }
                entry.texture.destroy();
                sharedTextureCache.entries.delete(key);
            }
        }
    }

    const {scenes} = scenegraphs;
    const nodeRoots = new Map<number, GroupNode>();
    const nodeRootWorldMatrices = new Map<number, Matrix4>();
    const nodeIndexByRef = new Map<object, number>();
    processed.nodes?.forEach((node, nodeIndex) => nodeIndexByRef.set(node, nodeIndex));
    const sceneCount = Math.min(processed.scenes?.length ?? 0, scenes.length);
    for (let sceneIndex = 0; sceneIndex < sceneCount; sceneIndex++) {
        const processedSceneNodes = processed.scenes?.[sceneIndex]?.nodes ?? [];
        const sceneChildren = scenes[sceneIndex]?.children ?? [];
        const sceneWorldMatrix = new Matrix4(scenes[sceneIndex]?.matrix ?? new Matrix4());
        // loaders.gl and luma should stay aligned here, but we clamp defensively so a partially
        // processed scene does not crash the whole tile render.
        const nodeCount = Math.min(processedSceneNodes.length, sceneChildren.length);
        for (let nodePosition = 0; nodePosition < nodeCount; nodePosition++) {
            const sceneChild = sceneChildren[nodePosition];
            if (!(sceneChild instanceof GroupNode)) {
                continue;
            }
            mapNodeRoots(
                processedSceneNodes[nodePosition],
                sceneChild,
                nodeIndexByRef,
                nodeRoots,
                nodeRootWorldMatrices,
                sceneWorldMatrix
            );
        }
    }

    const nodeDrawRecords = new Map<number, Array<{model: Model; worldMatrix: Matrix4}>>();
    for (const [nodeIndex, nodeRoot] of nodeRoots) {
        const rootWorldMatrix = nodeRootWorldMatrices.get(nodeIndex) ?? new Matrix4();
        const drawRecords: Array<{model: Model; worldMatrix: Matrix4}> = [];
        nodeRoot.traverse((node, {worldMatrix}) => {
            if (!(node instanceof ModelNode)) {
                return;
            }
            drawRecords.push({
                model: node.model,
                worldMatrix: new Matrix4(worldMatrix)
            });
        }, {worldMatrix: new Matrix4(rootWorldMatrix)});
        nodeDrawRecords.set(nodeIndex, drawRecords);
    }

    return {
        assetCacheKey: asset.cacheKey,
        scenes,
        nodeDrawRecords,
        buckets: [],
        models: [],
        sharedTextureKeys: [...usedTextureKeys],
        textureCacheDevice: device
    };
}

/** Releases the layer-local scenegraph and decrements any shared texture cache references. */
function destroyLayerScenegraphState(state: LayerScenegraphState): void {
    for (const scene of state.scenes) {
        scene.destroy();
    }
    if (state.textureCacheDevice) {
        const cache = sharedExternalTextureCaches.get(state.textureCacheDevice);
        if (cache) {
            for (const key of state.sharedTextureKeys) {
                const entry = cache.entries.get(key);
                if (!entry) {
                    continue;
                }
                entry.refCount -= 1;
                if (entry.refCount <= 0) {
                    entry.texture.destroy();
                    cache.entries.delete(key);
                }
            }
        }
    }
}

/** Retains the parsed GLTF asset for one tile on a specific deck device. */
export async function retainDeckTileGltfAsset(
    tile: FeatureTile,
    device: Device
): Promise<DeckTileGltfAsset | null> {
    const cacheKey = gltfAssetCacheKey(tile);
    const cache = getDeviceCache(device);
    const cachedEntry = cache.get(cacheKey);
    if (cachedEntry) {
        cachedEntry.refCount += 1;
        return await cachedEntry.promise;
    }

    const entry: DeckTileGltfAssetCacheEntry = {
        refCount: 1,
        asset: undefined,
        promise: buildTileGltfAsset(device, tile, cacheKey).then((asset) => {
            entry.asset = asset;
            return asset;
        })
    };
    cache.set(cacheKey, entry);
    return await entry.promise;
}

/** Releases one retained GLTF asset reference and destroys it once the last user goes away. */
export function releaseDeckTileGltfAsset(
    tile: FeatureTile,
    device: Device | null | undefined
): void {
    if (!device) {
        return;
    }
    const cache = gltfAssetCacheByDevice.get(device);
    if (!cache) {
        return;
    }
    const cacheKey = gltfAssetCacheKey(tile);
    const entry = cache.get(cacheKey);
    if (!entry) {
        return;
    }
    entry.refCount -= 1;
    if (entry.refCount > 0) {
        return;
    }
    cache.delete(cacheKey);
    if (entry.asset) {
        entry.asset.destroy();
    }
}

/**
 * Shared GLTF layer that resolves per-feature style contributions once, buckets them by stable render
 * state, and renders them inside one primitive layer. This avoids sharing the same Model instances
 * across multiple deck sublayers while still applying GL state per bucket instead of per model.
 */
export class DeckGltfNodeLayer extends Layer<Required<DeckGltfNodeLayerProps>> {
    static override layerName = "DeckGltfNodeLayer";

    override initializeState(): void {
        this.setState(createEmptyLayerScenegraphState());
    }

    override finalizeState(): void {
        destroyLayerScenegraphState(this.state as LayerScenegraphState);
    }

    override getModels(): Model[] {
        return (this.state as LayerScenegraphState).models;
    }

    /** Rebuilds the layer-local scenegraph only when the underlying tile asset version changes. */
    override updateState({props}: UpdateParameters<this>): void {
        const device = this.context.device;
        if (!device) {
            const emptyState = createEmptyLayerScenegraphState();
            destroyLayerScenegraphState(this.state as LayerScenegraphState);
            this.setState(emptyState);
            return;
        }

        const currentState = this.state as LayerScenegraphState;
        let nextState = currentState;
        if (currentState.assetCacheKey !== props.asset.cacheKey) {
            destroyLayerScenegraphState(currentState);
            nextState = buildLayerScenegraphState(device, props.asset, String(this.props.id));
        }
        const resolvedData = resolveContributionData(props.contributions);
        const {buckets, models} = resolveBuckets(resolvedData, nextState.nodeDrawRecords);
        this.setState({
            ...nextState,
            buckets,
            models
        });
    }

    /** Draws all feature/node records bucketed by stable GL state inside one primitive layer. */
    override draw({renderPass}: {renderPass: unknown}): void {
        const state = this.state as LayerScenegraphState;
        const {asset, coordinateSystem = COORDINATE_SYSTEM.DEFAULT, modelMatrix} = this.props;
        if (state.assetCacheKey !== asset.cacheKey || !state.buckets.length) {
            return;
        }

        const tilePosition = asset.tilePosition;
        const tilePositionLow = tilePosition64Low(tilePosition);
        const composeTransforms = shouldComposeModelMatrix(
            coordinateSystem,
            Boolean(this.context.viewport?.isGeospatial)
        );
        const pbrProjectionProps = {
            camera: this.context.viewport.cameraPosition as [number, number, number]
        };
        const layerOpacity = Math.max(0, Math.min(1, Number(this.props.opacity ?? 1)));
        const device = this.context.device;

        for (const bucket of state.buckets) {
            // Highlights intentionally bypass depth writes/testing so they remain visible on top of
            // the textured base pass even when imported winding or coplanar triangles are messy.
            const parameters = {
                ...(this.props.parameters ?? {}),
                depthTest: bucket.depthTest,
                depthMask: bucket.depthTest,
                cullMode: gltfCullMode(bucket.flatTint)
            };
            device.withParametersWebGL(parameters, () => {
                for (const item of bucket.data) {
                    const drawRecords = state.nodeDrawRecords.get(item.nodeIndex);
                    if (!drawRecords || drawRecords.length === 0) {
                        continue;
                    }
                    const tintColor = normalizeColor(item.color);

                    for (const drawRecord of drawRecords) {
                        const node = drawRecord.model;
                        const worldMatrix = drawRecord.worldMatrix;
                        const sceneModelMatrix = modelMatrix
                            ? new Matrix4(modelMatrix).multiplyRight(worldMatrix)
                            : worldMatrix;

                        node.shaderInputs.setProps({
                            pbrProjection: pbrProjectionProps,
                            scenegraph: {
                                sizeScale: 1,
                                sizeMinPixels: 0,
                                sizeMaxPixels: Number.MAX_SAFE_INTEGER,
                                sceneModelMatrix,
                                composeModelMatrix: composeTransforms
                            },
                            gltfNode: {
                                tilePosition,
                                tilePosition64Low: tilePositionLow,
                                tintColor: [tintColor[0], tintColor[1], tintColor[2], tintColor[3] * layerOpacity],
                                pickingColor: ZERO_PICKING_COLOR,
                                flatTint: bucket.flatTint ? 1 : 0
                            }
                        });
                        if (!node.draw(renderPass as never)) {
                            this.setNeedsRedraw();
                        }
                    }
                }
            });
        }
    }
}

type GltfPickProxyState = {
    model: Model | null;
    resolvedData: DeckGltfPickProxyDatum[];
};

/** Returns the empty pick-proxy state used before the first contribution arrives. */
function createEmptyGltfPickProxyState(): GltfPickProxyState {
    return {
        model: null,
        resolvedData: []
    };
}

/** Resolves overlapping pick-proxy contributions to one deterministic feature/node record set. */
function resolvePickProxyData(contributions: DeckGltfPickProxyStyleContribution[]): DeckGltfPickProxyDatum[] {
    const resolved = new Map<string, DeckGltfPickProxyDatum>();
    for (const contribution of [...contributions].sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
        for (const datum of contribution.data) {
            resolved.set(makeResolvedDatumKey(datum), datum);
        }
    }
    return [...resolved.values()].sort((left, right) => {
        const featureAddressDiff = left.featureAddress - right.featureAddress;
        if (featureAddressDiff !== 0) {
            return featureAddressDiff;
        }
        return left.nodeIndex - right.nodeIndex;
    });
}

/** Builds the invisible triangle mesh used exclusively for cheap GLTF picking. */
function buildGltfPickProxyModel(
    layer: DeckGltfPickProxyLayer,
    resolvedData: DeckGltfPickProxyDatum[]
): Model | null {
    if (!resolvedData.length) {
        return null;
    }

    let vertexCount = 0;
    for (const datum of resolvedData) {
        vertexCount += Math.floor(datum.positions.length / 3);
    }
    if (vertexCount <= 0) {
        return null;
    }

    const positions = new Float32Array(vertexCount * 3);
    const pickingColors = new Float32Array(vertexCount * 3);
    let vertexOffset = 0;
    for (let itemIndex = 0; itemIndex < resolvedData.length; itemIndex++) {
        const datum = resolvedData[itemIndex];
        const pickingColorBytes = layer.encodePickingColor(itemIndex);
        const vertexBase = vertexOffset * 3;
        positions.set(datum.positions, vertexBase);
        const datumVertexCount = Math.floor(datum.positions.length / 3);
        for (let vertexIndex = 0; vertexIndex < datumVertexCount; vertexIndex++) {
            const colorOffset = vertexBase + vertexIndex * 3;
            pickingColors[colorOffset] = pickingColorBytes[0];
            pickingColors[colorOffset + 1] = pickingColorBytes[1];
            pickingColors[colorOffset + 2] = pickingColorBytes[2];
        }
        vertexOffset += datumVertexCount;
    }

    return new Model(layer.context.device, {
        id: String(layer.props.id),
        vs: GLTF_PICK_PROXY_VERTEX_SHADER,
        fs: GLTF_PICK_PROXY_FRAGMENT_SHADER,
        modules: [project32, picking, gltfPickProxyUniforms],
        geometry: new Geometry({
            topology: "triangle-list",
            attributes: {
                positions: {value: positions, size: 3},
                pickingColors: {value: pickingColors, size: 3}
            }
        })
    });
}

export class DeckGltfPickProxyLayer extends Layer<Required<DeckGltfPickProxyLayerProps>> {
    static override layerName = "DeckGltfPickProxyLayer";

    override initializeState(): void {
        this.setState(createEmptyGltfPickProxyState());
    }

    override finalizeState(): void {
        const state = this.state as GltfPickProxyState;
        state.model?.destroy();
    }

    override getModels(): Model[] {
        const model = (this.state as GltfPickProxyState).model;
        return model ? [model] : [];
    }

    /** Rebuilds the pick mesh whenever the resolved proxy geometry changes. */
    override updateState({props}: UpdateParameters<this>): void {
        const state = this.state as GltfPickProxyState;
        const resolvedData = resolvePickProxyData(props.contributions);
        const nextModel = buildGltfPickProxyModel(this, resolvedData);
        state.model?.destroy();
        this.setState({
            model: nextModel,
            resolvedData
        });
    }

    /** Reattaches the resolved datum so deck picking can map proxy hits back to feature ids. */
    override getPickingInfo({info}: {
        info: PickingInfo<DeckGltfPickProxyDatum>;
        mode: string;
    }): PickingInfo<DeckGltfPickProxyDatum> {
        const resolvedData = (this.state as GltfPickProxyState).resolvedData;
        const pickedDatum = info.index >= 0 ? resolvedData[info.index] : undefined;
        return {
            ...info,
            object: pickedDatum,
            sourceLayer: this
        };
    }

    /** Draws the invisible pick proxy only during deck's picking pass. */
    override draw({renderPass}: {renderPass: unknown}): void {
        const state = this.state as GltfPickProxyState;
        const model = state.model;
        if (!model || !state.resolvedData.length) {
            return;
        }

        const coordinateOrigin = this.props.coordinateOrigin;
        model.shaderInputs.setProps({
            gltfPickProxy: {
                coordinateOrigin,
                coordinateOrigin64Low: tilePosition64Low(coordinateOrigin)
            }
        });
        if (!model.draw(renderPass as never)) {
            this.setNeedsRedraw();
        }
    }
}
