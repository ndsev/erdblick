/** Scene-owned identity assigned to one subset before worker rendering starts. */
export interface TileSubsetGpuContribution {
    keyLow: number;
    keyHigh: number;
    revision: number;
    slot: number;
    activationToken: number;
}

/** Immutable atlas metadata installed in a worker when the catalog advances. */
export interface TileSubsetGpuIconCatalogEntry {
    uri: string;
    atlasPage: number;
    uv: [number, number, number, number];
    pixelSize: [number, number];
}

/** Immutable worker input for one bounded subset packet render pass. */
export interface TileSubsetLayerRenderTask {
    type: "TileSubsetLayerRenderTask";
    taskId: string;
    visualizationId: string;
    renderSignature: string;
    viewIndex: number;
    renderKey: string;
    mapTileKey: string;
    tileId: number;
    /** Common WGS84 origin assigned by the persistent scene. */
    coordinateOrigin: [number, number, number];
    sceneGeneration: number;
    packetSequence: number;
    iconCatalogVersion: number;
    /** Present only when this worker has not seen the catalog version yet. */
    iconCatalogEntries?: TileSubsetGpuIconCatalogEntry[];
    originSlot: number;
    originKeyLow: number;
    originKeyHigh: number;
    contribution: TileSubsetGpuContribution;
    mapId: string;
    catalogRevision: number;
    /** Present only when this worker has not seen the catalog revision yet. */
    dataSourceInfoBlob?: Uint8Array;
    stringPoolId: string;
    /** Present only when this worker needs a newer dictionary snapshot. */
    fieldDictBlob?: Uint8Array;
    subsetBlob: Uint8Array;
    /** Exact number of geometry vertices stored in the input subset. */
    inputGeometryVertexCount: number;
    styleKey: string;
    /** Present only when this worker has not compiled the style yet. */
    styleSource?: string;
    highlightModeValue: number;
    lod: number;
    /** World-space RDP tolerance selected from the current view's pixel scale. */
    lineSimplificationToleranceMeters: number;
}

/** Handshake sent as soon as the worker module is loaded. */
export interface TileSubsetLayerRenderWorkerReady {
    type: "TileSubsetLayerRenderWorkerReady";
    /** Final bundled URL used by the browser, suitable for main-thread caching. */
    scriptUrl: string;
}

/** One-time worker initialization request. */
export interface TileSubsetLayerRenderWorkerInit {
    type: "TileSubsetLayerRenderWorkerInit";
}

/** Worker-side timing breakdown retained for diagnostics and tile statistics. */
export interface TileSubsetLayerRenderTimings {
    deserializeMs: number;
    runMs: number;
    packetMs: number;
    bridgeMs: number;
    renderMs: number;
    totalMs: number;
}

/** GLTF node material retained until GLTF rendering moves into persistent stores. */
export interface TileSubsetGltfBuffers {
    nodeIndices: Uint32Array;
    colors: Uint8Array;
    depthTests: Uint8Array;
    featureAddresses: Uint32Array;
}

/** Low-cost GLTF AABB triangles used only by the existing GLTF pick bridge. */
export interface TileSubsetGltfPickProxyBuffers {
    positions: Float32Array;
    startIndices: Uint32Array;
    nodeIndices: Uint32Array;
    featureAddresses: Uint32Array;
}

/** Pick identity retained only for the temporary GLTF bridge. */
export interface TileSubsetPickResult {
    featureId?: string;
    attributeIndex?: number;
    hasValidity?: boolean;
    validityIndex?: number;
    relationId?: string;
    relationSourceFeatureId?: string;
    relationIndex?: number;
    memberFeatureIds?: string[];
}

/** Small browser-owned payload that cannot yet be expressed as GPU records. */
export interface TileSubsetRenderBridge {
    gltfNodes: TileSubsetGltfBuffers;
    gltfPickProxies: TileSubsetGltfPickProxyBuffers;
    coordinateOrigin: Float64Array;
    pickResults: TileSubsetPickResult[];
    glbAttachmentName?: string;
}

/** Direct worker result: bounded packet fragments plus the temporary GLTF bridge. */
export interface TileSubsetLayerRenderBuffers {
    packets: Uint8Array[];
    bridge: TileSubsetRenderBridge;
    vertexCount: number;
    timings: TileSubsetLayerRenderTimings;
}

/** Tagged worker result used to match a response to the bounded service queue. */
export interface TileSubsetLayerRenderResult extends Partial<TileSubsetLayerRenderBuffers> {
    type: "TileSubsetLayerRenderResult";
    taskId: string;
    visualizationId: string;
    renderSignature: string;
    error?: string;
}

export type TileSubsetLayerRenderWorkerInbound =
    TileSubsetLayerRenderTask |
    TileSubsetLayerRenderWorkerInit;

export type TileSubsetLayerRenderWorkerOutbound =
    TileSubsetLayerRenderResult |
    TileSubsetLayerRenderWorkerReady;
