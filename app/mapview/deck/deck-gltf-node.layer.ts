import {
    COORDINATE_SYSTEM,
    fp64LowPart,
    Layer,
    picking,
    project32,
    type CoordinateSystem,
    type LayerProps,
    type UpdateParameters
} from "@deck.gl/core";
import type {Device} from "@luma.gl/core";
import {createScenegraphsFromGLTF} from "@luma.gl/gltf";
import {GroupNode, ModelNode, type Model} from "@luma.gl/engine";
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
  if (gltfNode.flatTint > 0.5) {
    fragColor = vColor;
    DECKGL_FILTER_COLOR(fragColor, geometry);
    return;
  }
  #ifdef LIGHTING_PBR
    fragColor = vColor * pbr_filterColor(vec4(0));
    geometry.uv = pbr_vUV;
  #else
    #if defined(HAS_UV) && defined(HAS_BASECOLORMAP)
      fragColor = vColor * texture(pbr_baseColorSampler, vTEXCOORD_0);
      geometry.uv = vTEXCOORD_0;
    #else
      fragColor = vColor;
    #endif
  #endif
  DECKGL_FILTER_COLOR(fragColor, geometry);
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

export interface DeckGltfNodeDatum {
    nodeIndex: number;
    featureAddress: number;
    color: [number, number, number, number];
}

export type DeckGltfNodeLayerProps = LayerProps & {
    data: DeckGltfNodeDatum[];
    asset: DeckTileGltfAsset;
    tileKey: string;
    flatTint?: boolean;
};

const gltfAssetCacheByDevice = new WeakMap<Device, Map<string, DeckTileGltfAssetCacheEntry>>();

function gltfAssetCacheKey(tile: FeatureTile): string {
    return `${tile.mapTileKey}:${tile.dataVersion}`;
}

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

function shouldComposeModelMatrix(coordinateSystem: CoordinateSystem, isGeospatial: boolean): boolean {
    return coordinateSystem === COORDINATE_SYSTEM.CARTESIAN
        || coordinateSystem === COORDINATE_SYSTEM.METER_OFFSETS
        || (coordinateSystem === COORDINATE_SYSTEM.DEFAULT && !isGeospatial);
}

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
    nodeRoots: Map<number, GroupNode>;
    nodeRootWorldMatrices: Map<number, Matrix4>;
    models: Model[];
};

function createEmptyLayerScenegraphState(): LayerScenegraphState {
    return {
        assetCacheKey: null,
        scenes: [],
        nodeRoots: new Map(),
        nodeRootWorldMatrices: new Map(),
        models: []
    };
}

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

function buildLayerScenegraphState(
    device: Device,
    asset: DeckTileGltfAsset,
    layerId: string
): Omit<LayerScenegraphState, "models"> {
    const processed = cloneProcessedGltfForScenegraph(asset.processedGltf);
    const {scenes} = createScenegraphsFromGLTF(device, processed, buildModelOptions(`deck-gltf:${layerId}:${asset.cacheKey}`));
    const nodeRoots = new Map<number, GroupNode>();
    const nodeRootWorldMatrices = new Map<number, Matrix4>();
    const nodeIndexByRef = new Map<object, number>();
    processed.nodes?.forEach((node, nodeIndex) => nodeIndexByRef.set(node, nodeIndex));
    const sceneCount = Math.min(processed.scenes?.length ?? 0, scenes.length);
    for (let sceneIndex = 0; sceneIndex < sceneCount; sceneIndex++) {
        const processedSceneNodes = processed.scenes?.[sceneIndex]?.nodes ?? [];
        const sceneChildren = scenes[sceneIndex]?.children ?? [];
        const sceneWorldMatrix = new Matrix4(scenes[sceneIndex]?.matrix ?? new Matrix4());
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

    return {
        assetCacheKey: asset.cacheKey,
        scenes,
        nodeRoots,
        nodeRootWorldMatrices
    };
}

function destroyLayerScenegraphState(state: LayerScenegraphState): void {
    for (const scene of state.scenes) {
        scene.destroy();
    }
}

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
 * Primitive GLTF layer that renders selected cached node subtrees in one deck layer and
 * encodes picking identity per emitted feature/node item.
 */
export class DeckGltfNodeLayer extends Layer<Required<DeckGltfNodeLayerProps>> {
    static override layerName = "DeckGltfNodeLayer";

    override getModels(): Model[] {
        return (this.state as LayerScenegraphState).models;
    }

    override initializeState(): void {
        this.setState(createEmptyLayerScenegraphState());
    }

    override finalizeState(): void {
        destroyLayerScenegraphState(this.state as LayerScenegraphState);
    }

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
            nextState = {
                ...buildLayerScenegraphState(device, props.asset, String(this.props.id)),
                models: []
            };
        }

        const models: Model[] = [];
        const seen = new Set<Model>();
        for (const datum of props.data) {
            const nodeRoot = nextState.nodeRoots.get(datum.nodeIndex);
            if (!nodeRoot) {
                continue;
            }
            nodeRoot.traverse((node) => {
                if (node instanceof ModelNode && !seen.has(node.model)) {
                    seen.add(node.model);
                    models.push(node.model);
                }
            }, {worldMatrix: new Matrix4()});
        }
        this.setState({
            ...nextState,
            models
        });
    }

    override draw({renderPass}: {renderPass: unknown}): void {
        const {asset, data, coordinateSystem = COORDINATE_SYSTEM.DEFAULT, modelMatrix} = this.props;
        if (!asset || !data.length) {
            return;
        }
        const {nodeRoots, nodeRootWorldMatrices} = this.state as LayerScenegraphState;

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

        for (let itemIndex = 0; itemIndex < data.length; itemIndex++) {
            const item = data[itemIndex];
            const nodeRoot = nodeRoots.get(item.nodeIndex);
            const nodeRootWorldMatrix = nodeRootWorldMatrices.get(item.nodeIndex);
            if (!nodeRoot) {
                continue;
            }

            const rootWorldMatrix = nodeRootWorldMatrix ? new Matrix4(nodeRootWorldMatrix) : new Matrix4();
            const tintColor = normalizeColor(item.color);
            const pickingColor = this.encodePickingColor(itemIndex);

            nodeRoot.traverse((node, {worldMatrix}) => {
                if (!(node instanceof ModelNode)) {
                    return;
                }

                const sceneModelMatrix = modelMatrix
                    ? new Matrix4(modelMatrix).multiplyRight(worldMatrix)
                    : worldMatrix;

                node.model.shaderInputs.setProps({
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
                        pickingColor,
                        flatTint: this.props.flatTint ? 1 : 0
                    }
                });
                node.model.setParameters({
                    ...node.model.parameters,
                    ...(this.props.parameters ?? {}),
                    cullMode: "none"
                });
                if (!node.model.draw(renderPass as never)) {
                    this.setNeedsRedraw();
                }
            }, {worldMatrix: rootWorldMatrix});
        }
    }
}
