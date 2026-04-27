import {initializeLibrary, coreLib, type ErdblickCore_, uint8ArrayToWasm} from "../../integrations/wasm";
import {
    DeckFeatureLayerVisualization,
    FeatureLayerStyle,
    HighlightMode,
    RuleFidelity,
    TileFeatureLayer,
    TileLayerParser
} from "../../../build/libs/core/erdblick-core";
import {
    DECK_GEOMETRY_OUTPUT_ALL,
    DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY,
    DECK_GEOMETRY_OUTPUT_POINTS_ONLY,
    DeckGeometryBucketBuffers,
    DeckGeometryOutputMode,
    DeckLowFiBundleBuffers,
    DeckTileRenderResult,
    DeckTileRenderTask,
    DeckVisualizationBufferResult,
    DeckWorkerInboundMessage,
    DeckWorkerReadyMessage
} from "./deck-render.worker.protocol";

const styleTextEncoder = new TextEncoder();
const parserCache = new Map<string, TileLayerParser>();
const styleCache = new Map<string, FeatureLayerStyle>();

type DeckFeatureLayerVisualizationCtor = ErdblickCore_["DeckFeatureLayerVisualization"];
type RuleFidelityEnum = ErdblickCore_["RuleFidelity"];
type DeckFeatureLayerVisualizationWithRenderResult = DeckFeatureLayerVisualization & {
    renderResult(): DeckVisualizationBufferResult;
};

/** Returns the wasm constructor for deck feature visualizations after the core library is initialized. */
function deckFeatureLayerVisualizationCtor(): DeckFeatureLayerVisualizationCtor {
    return coreLib.DeckFeatureLayerVisualization as DeckFeatureLayerVisualizationCtor;
}

/** Returns the wasm fidelity enum used by the deck render worker. */
function ruleFidelityEnum(): RuleFidelityEnum {
    return coreLib.RuleFidelity as RuleFidelityEnum;
}

/** Cheap blob fingerprint used to cache parsers without hashing megabytes of tile metadata. */
function blobSignature(blob: Uint8Array): string {
    if (!blob.length) {
        return "0";
    }
    const mid = blob[blob.length >> 1];
    return `${blob.length}:${blob[0]}:${mid}:${blob[blob.length - 1]}`;
}

/** Builds the parser-cache key from the datasource node and parser-context blobs. */
function parserCacheKey(task: DeckTileRenderTask): string {
    return [
        task.nodeId,
        task.mapName,
        blobSignature(task.fieldDictBlob),
        blobSignature(task.dataSourceInfoBlob)
    ].join("|");
}

/** Reuses parser instances that share identical field dictionaries and datasource metadata. */
function getOrCreateParser(task: DeckTileRenderTask): TileLayerParser {
    const key = parserCacheKey(task);
    const cached = parserCache.get(key);
    if (cached) {
        return cached;
    }
    const parser = new coreLib.TileLayerParser();
    uint8ArrayToWasm((data) => parser.setDataSourceInfo(data), task.dataSourceInfoBlob);
    uint8ArrayToWasm((data) => parser.addFieldDict(data), task.fieldDictBlob);
    parserCache.set(key, parser);
    return parser;
}

/** Reuses parsed `FeatureLayerStyle` objects keyed by the raw style source text. */
function getOrCreateStyle(styleSource: string): FeatureLayerStyle {
    const cached = styleCache.get(styleSource);
    if (cached) {
        return cached;
    }
    const styleBytes = styleTextEncoder.encode(styleSource);
    const parsed = uint8ArrayToWasm((data) => new coreLib.FeatureLayerStyle(data), styleBytes);
    if (!parsed) {
        throw new Error("Failed to parse FeatureLayerStyle in deck render worker.");
    }
    styleCache.set(styleSource, parsed);
    return parsed;
}

/** Maps the serialized highlight-mode value back to the wasm enum expected by the renderer. */
function resolveHighlightMode(modeValue: number): HighlightMode {
    if (modeValue === coreLib.HighlightMode.HOVER_HIGHLIGHT.value) {
        return coreLib.HighlightMode.HOVER_HIGHLIGHT;
    }
    if (modeValue === coreLib.HighlightMode.SELECTION_HIGHLIGHT.value) {
        return coreLib.HighlightMode.SELECTION_HIGHLIGHT;
    }
    return coreLib.HighlightMode.NO_HIGHLIGHT;
}

/** Maps the serialized fidelity value back to the wasm enum expected by the renderer. */
function resolveFidelity(fidelityValue: number): RuleFidelity {
    const ruleFidelity = ruleFidelityEnum();
    if (fidelityValue === ruleFidelity.HIGH.value) {
        return ruleFidelity.HIGH;
    }
    if (fidelityValue === ruleFidelity.LOW.value) {
        return ruleFidelity.LOW;
    }
    return ruleFidelity.ANY;
}

/** Adapts the main thread's merge-count snapshot into the callback shape expected by wasm rendering. */
function createMergeCountProvider(snapshot: Record<string, number>): {
    count: (_geoPos: unknown, hashPos: string, _level: number, mapViewLayerStyleRuleId: string) => number
} {
    const table = snapshot ?? {};
    return {
        count: (_geoPos: unknown, hashPos: string, _level: number, mapViewLayerStyleRuleId: string) => {
            const value = table[`${mapViewLayerStyleRuleId}|${hashPos}`];
            return Number.isInteger(value) ? value : 0;
        }
    };
}

/** Attaches every higher-stage tile layer as an overlay to the base layer before rendering. */
function attachOverlayChain(baseLayer: TileFeatureLayer, overlays: TileFeatureLayer[]): void {
    for (const overlay of overlays) {
        baseLayer.attachOverlay(overlay);
    }
}

/** Collects transferable buffers for one packed point bucket. */
function transferPointBucket(bucket: DeckGeometryBucketBuffers["pointWorld"]): ArrayBuffer[] {
    return [bucket.positions.buffer, bucket.colors.buffer, bucket.radii.buffer, bucket.featureAddresses.buffer];
}

/** Collects transferable buffers for one packed surface bucket. */
function transferSurfaceBucket(bucket: DeckGeometryBucketBuffers["surface"]): ArrayBuffer[] {
    return [bucket.positions.buffer, bucket.startIndices.buffer, bucket.colors.buffer, bucket.featureAddresses.buffer];
}

/** Collects transferable buffers for one packed path or arrow bucket. */
function transferPathBucket(bucket: DeckGeometryBucketBuffers["pathWorld"]): ArrayBuffer[] {
    return [
        bucket.positions.buffer,
        bucket.startIndices.buffer,
        bucket.colors.buffer,
        bucket.widths.buffer,
        bucket.featureAddresses.buffer,
        ...(bucket.dashArrays ? [bucket.dashArrays.buffer] : [])
    ];
}

/** Collects transferable buffers for one packed GLTF-node bucket. */
function transferGltfBucket(bucket: DeckGeometryBucketBuffers["gltfNodes"]): ArrayBuffer[] {
    return [
        bucket.nodeIndices.buffer,
        bucket.colors.buffer,
        bucket.depthTests.buffer,
        bucket.featureAddresses.buffer
    ];
}

/** Flattens every transferable array buffer from one geometry result. */
function transferGeometryBuffers(buffers: DeckGeometryBucketBuffers): ArrayBuffer[] {
    return [
        ...transferPointBucket(buffers.pointWorld),
        ...transferPointBucket(buffers.pointBillboard),
        ...transferSurfaceBucket(buffers.surface),
        ...transferPathBucket(buffers.pathWorld),
        ...transferPathBucket(buffers.pathBillboard),
        ...transferPathBucket(buffers.arrowWorld),
        ...transferPathBucket(buffers.arrowBillboard),
        ...transferGltfBucket(buffers.gltfNodes)
    ];
}

/** Flattens every transferable array buffer from the full worker render result, including low-fi bundles. */
function transferVisualizationResult(result: DeckVisualizationBufferResult): ArrayBuffer[] {
    const lowFiTransfers: ArrayBuffer[] = [];
    for (const bundle of result.lowFiBundles) {
        lowFiTransfers.push(...transferGeometryBuffers(bundle));
    }
    return [
        ...transferGeometryBuffers(result),
        result.coordinateOrigin.buffer,
        ...lowFiTransfers
    ];
}

/** Reads the binary render result from the wasm visualization wrapper. */
function readRenderResult(deckVisu: DeckFeatureLayerVisualization): DeckVisualizationBufferResult {
    return (deckVisu as DeckFeatureLayerVisualizationWithRenderResult).renderResult();
}

/** Executes one full staged tile render inside the worker and returns deck-ready buffers. */
function processTileRenderTask(task: DeckTileRenderTask): DeckTileRenderResult {
    const totalStart = performance.now();
    let baseLayer: TileFeatureLayer | null = null;
    const overlays: TileFeatureLayer[] = [];
    let deckVisu: DeckFeatureLayerVisualization | null = null;
    try {
        const parser = getOrCreateParser(task);
        const style = getOrCreateStyle(task.styleSource);
        const deserializeStart = performance.now();
        const deserializedLayers: TileFeatureLayer[] = [];
        for (const tileBlob of task.tileStageBlobs) {
            const layer = uint8ArrayToWasm((data) => parser.readTileFeatureLayer(data), tileBlob) as TileFeatureLayer | null;
            if (layer) {
                deserializedLayers.push(layer);
            }
        }
        const deserializeMs = performance.now() - deserializeStart;
        if (!deserializedLayers.length) {
            throw new Error("Worker render requested without any deserializable tile layers.");
        }
        baseLayer = deserializedLayers[0];
        overlays.push(...deserializedLayers.slice(1));
        attachOverlayChain(baseLayer, overlays);
        const vertexCount = Math.max(0, Math.floor(Number(baseLayer.numVertices())));

        const deckCtor = deckFeatureLayerVisualizationCtor();
        deckVisu = new deckCtor(
            task.viewIndex,
            task.tileKey,
            style,
            task.styleOptions,
            createMergeCountProvider(task.mergeCountSnapshot),
            resolveHighlightMode(task.highlightModeValue),
            resolveFidelity(task.fidelityValue),
            task.highFidelityStage,
            task.maxLowFiLod,
            task.outputMode,
            task.featureIdSubset
        );
        const normalizedOutputMode = [
            DECK_GEOMETRY_OUTPUT_ALL,
            DECK_GEOMETRY_OUTPUT_POINTS_ONLY,
            DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY
        ].includes(task.outputMode)
            ? task.outputMode
            : DECK_GEOMETRY_OUTPUT_ALL;
        deckVisu.setGeometryOutputMode(normalizedOutputMode);
        const renderStart = performance.now();
        deckVisu.addTileFeatureLayer(baseLayer);
        deckVisu.run();
        const renderResult = readRenderResult(deckVisu);
        const renderMs = performance.now() - renderStart;

        return {
            type: "DeckTileRenderResult",
            taskId: task.taskId,
            tileKey: task.tileKey,
            vertexCount,
            ...renderResult,
            timings: {
                deserializeMs,
                renderMs,
                totalMs: performance.now() - totalStart
            }
        };
    } finally {
        if (deckVisu) {
            deckVisu.delete();
        }
        for (const overlay of overlays) {
            overlay.delete();
        }
        if (baseLayer) {
            baseLayer.delete();
        }
    }
}

/** Creates empty geometry buffers used in the worker error path. */
function emptyGeometryBuffers(): DeckGeometryBucketBuffers {
    return {
        pointWorld: {positions: new Float32Array(), colors: new Uint8Array(), radii: new Float32Array(), featureAddresses: new Uint32Array()},
        pointBillboard: {positions: new Float32Array(), colors: new Uint8Array(), radii: new Float32Array(), featureAddresses: new Uint32Array()},
        surface: {positions: new Float32Array(), startIndices: new Uint32Array(), colors: new Uint8Array(), featureAddresses: new Uint32Array()},
        pathWorld: {
            positions: new Float32Array(),
            startIndices: new Uint32Array(),
            colors: new Uint8Array(),
            widths: new Float32Array(),
            featureAddresses: new Uint32Array(),
            dashArrays: new Float32Array()
        },
        pathBillboard: {
            positions: new Float32Array(),
            startIndices: new Uint32Array(),
            colors: new Uint8Array(),
            widths: new Float32Array(),
            featureAddresses: new Uint32Array(),
            dashArrays: new Float32Array()
        },
        arrowWorld: {
            positions: new Float32Array(),
            startIndices: new Uint32Array(),
            colors: new Uint8Array(),
            widths: new Float32Array(),
            featureAddresses: new Uint32Array()
        },
        arrowBillboard: {
            positions: new Float32Array(),
            startIndices: new Uint32Array(),
            colors: new Uint8Array(),
            widths: new Float32Array(),
            featureAddresses: new Uint32Array()
        },
        gltfNodes: {
            nodeIndices: new Uint32Array(),
            colors: new Uint8Array(),
            depthTests: new Uint8Array(),
            featureAddresses: new Uint32Array()
        }
    };
}

/** Creates the zero-geometry result payload shared by worker failures. */
function emptyResult(): Omit<DeckTileRenderResult, "type" | "taskId" | "tileKey" | "error"> {
    return {
        ...emptyGeometryBuffers(),
        vertexCount: 0,
        coordinateOrigin: new Float64Array(),
        lowFiBundles: [] as DeckLowFiBundleBuffers[],
        mergedPointFeatures: {} as Record<string, any[]>
    };
}

/** Normalizes unknown worker exceptions to a readable error string for the main thread. */
function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message || error.toString();
    }
    return String(error);
}

/** Worker entry point: initialize on handshake, otherwise render one tile task and transfer its buffers. */
addEventListener("message", async ({data}) => {
    const message = data as DeckWorkerInboundMessage;

    if (message.type === "DeckWorkerInit") {
        postMessage({
            type: "DeckWorkerReady",
            scriptUrl: self.location.href
        } as DeckWorkerReadyMessage);
        return;
    }

    const task = message as DeckTileRenderTask;
    try {
        await initializeLibrary();
        const result = processTileRenderTask(task);
        postMessage(result, transferVisualizationResult(result));
    } catch (error) {
        const failure: DeckTileRenderResult = {
            type: "DeckTileRenderResult",
            taskId: task.taskId,
            tileKey: task.tileKey,
            ...emptyResult(),
            error: toErrorMessage(error)
        };
        postMessage(failure);
    }
});
