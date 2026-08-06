/** Immutable worker input for one Morton-aligned subset block render pass. */
export interface TileSubsetLayerRenderTask {
    type: "TileSubsetLayerRenderTask";
    taskId: string;
    visualizationId: string;
    renderSignature: string;
    viewIndex: number;
    blockKey: string;
    /** Output tile identities in the same order as `subsetBlobs`. */
    mapTileKeys: string[];
    tileIds: number[];
    /** Common WGS84 origin of the selected presentation block. */
    coordinateOrigin: [number, number, number];
    mapId: string;
    catalogRevision: number;
    /** Present only when this worker has not seen the catalog revision yet. */
    dataSourceInfoBlob?: Uint8Array;
    stringPoolId: string;
    /** Present only when this worker needs a newer dictionary snapshot. */
    fieldDictBlob?: Uint8Array;
    subsetBlobs: Uint8Array[];
    /** Exact number of geometry vertices stored across the input subsets. */
    inputGeometryVertexCount: number;
    styleKey: string;
    /** Present only when this worker has not compiled the style yet. */
    styleSource?: string;
    highlightModeValue: number;
    fidelityValue: number;
}

/** Handshake sent after the worker module and WASM runtime are ready. */
export interface TileSubsetLayerRenderWorkerReady {
    type: "TileSubsetLayerRenderWorkerReady";
}

export interface TileSubsetLayerRenderWorkerInit {
    type: "TileSubsetLayerRenderWorkerInit";
}

export interface TileSubsetLayerRenderTimings {
    deserializeMs: number;
    deserializeMsBySubset: number[];
    renderMs: number;
    totalMs: number;
}

export interface TileSubsetPointBuffers {
    positions: Float32Array;
    colors: Uint8Array;
    radii: Float32Array;
    depthTests: Uint8Array;
    featureAddresses: Uint32Array;
    glowColors: Uint8Array;
    glowRadii: Float32Array;
}

export interface TileSubsetSurfaceBuffers {
    positions: Float32Array;
    startIndices: Uint32Array;
    holeIndices: Uint32Array;
    holeIndexStarts: Uint32Array;
    colors: Uint8Array;
    depthTests: Uint8Array;
    featureAddresses: Uint32Array;
    glowColors: Uint8Array;
    glowRadii: Float32Array;
}

export interface TileSubsetPathBuffers {
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    widths: Float32Array;
    /** Absolute screen-space lateral displacement for every path vertex. */
    lateralOffsetsPx: Float32Array;
    /**
     * Transition-only local XY displacement vectors in absolute screen pixels.
     * Ordinary path buffers leave this empty and use Deck's stock offset path.
     */
    lateralOffsetVectorsPx: Float32Array;
    /** One adaptive metres-per-pixel displacement threshold per path. */
    lateralOffsetScaleThresholds: Float32Array;
    depthTests: Uint8Array;
    featureAddresses: Uint32Array;
    glowColors: Uint8Array;
    glowRadii: Float32Array;
    dashArrays?: Float32Array;
}

export interface TileSubsetGltfBuffers {
    nodeIndices: Uint32Array;
    colors: Uint8Array;
    depthTests: Uint8Array;
    featureAddresses: Uint32Array;
}

export interface TileSubsetGltfPickProxyBuffers {
    positions: Float32Array;
    startIndices: Uint32Array;
    nodeIndices: Uint32Array;
    featureAddresses: Uint32Array;
}

export interface TileSubsetLabelDatum {
    featureAddress: number;
    position: {x: number; y: number; z: number};
    text: string;
    fillColor: [number, number, number, number];
    backgroundColor?: [number, number, number, number];
    outlineColor: [number, number, number, number];
    outlineWidth: number;
    scale: number;
    pixelOffset?: [number, number];
    billboard: boolean;
    depthTest?: boolean;
}

/** Compact native runtime issue expanded into a full validation issue on the main thread. */
export interface TileSubsetRuntimeStyleIssue {
    property: string;
    expression: string;
    message: string;
    ruleIndex: number;
    occurrenceCount: number;
}

/** Pick identity resolved while the worker still owns the exact parsed subset. */
export interface TileSubsetPickResult {
    subsetOrdinal: number;
    featureId?: string;
    attributeIndex?: number;
    hasValidity?: boolean;
    validityIndex?: number;
    relationId?: string;
    relationSourceFeatureId?: string;
    relationIndex?: number;
    memberFeatureIds?: string[];
}

/** Native renderer output, still independent of any concrete Deck device. */
export interface TileSubsetLayerRenderBuffers {
    pointWorld: TileSubsetPointBuffers;
    pointBillboard: TileSubsetPointBuffers;
    labelWorld: TileSubsetLabelDatum[];
    labelBillboard: TileSubsetLabelDatum[];
    surface: TileSubsetSurfaceBuffers;
    pathWorld: TileSubsetPathBuffers;
    pathBillboard: TileSubsetPathBuffers;
    transitionPathWorld: TileSubsetPathBuffers;
    transitionPathBillboard: TileSubsetPathBuffers;
    arrowWorld: TileSubsetPathBuffers;
    arrowBillboard: TileSubsetPathBuffers;
    gltfNodes: TileSubsetGltfBuffers;
    gltfPickProxies: TileSubsetGltfPickProxyBuffers;
    coordinateOrigin: Float64Array;
    pickRefs: Uint32Array;
    pickResults: TileSubsetPickResult[];
    subsetVertexCounts: Uint32Array;
    glbAttachmentName?: string;
    vertexCount: number;
    styleIssues: TileSubsetRuntimeStyleIssue[];
    timings: TileSubsetLayerRenderTimings;
}

export interface TileSubsetLayerRenderResult extends TileSubsetLayerRenderBuffers {
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
