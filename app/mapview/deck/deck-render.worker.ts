import {coreLib, type ErdblickCore_, initializeLibrary, uint8ArrayToWasm} from "../../integrations/wasm";
import {
    DeckFeatureLayerVisualization,
    DeckTileSearchResultLayerVisualization,
    FeatureLayerStyle,
    HighlightMode,
    RuleFidelity,
    TileFeatureLayer,
    TileLayerParser,
    TileSearchResultLayer
} from "../../../build/libs/core/erdblick-core";
import {
    DECK_GEOMETRY_OUTPUT_ALL,
    DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY,
    DECK_GEOMETRY_OUTPUT_POINTS_ONLY,
    DeckGeometryBucketBuffers,
    DeckLowFiBundleBuffers,
    DeckSearchTileRenderTask,
    DeckTileRenderResult,
    DeckTileRenderTask,
    DeckVisualizationBufferResult,
    DeckWorkerDataSourceInfoMessage,
    DeckWorkerInboundMessage,
    DeckWorkerReadyMessage
} from "./deck-render.worker.protocol";
import {StyleValidationIssue} from "../../styledata/style-validation.model";

const styleTextEncoder = new TextEncoder();
/** Parser cache keyed by datasource metadata so workers do not rebuild parser state for every tile. */
const parserCache = new Map<string, TileLayerParser>();
/** Datasource metadata preloaded by map id before tile tasks use it. */
const dataSourceInfoByMapName = new Map<string, Uint8Array>();
/** Per-map generation number used to invalidate parser caches when datasource metadata changes. */
const dataSourceInfoRevisionByMapName = new Map<string, number>();
/** Style cache keyed by raw YAML source so repeated renders reuse parsed wasm style objects. */
const styleCache = new Map<string, FeatureLayerStyle>();

/** Strongly typed handle for the wasm deck visualization constructor exposed after init. */
type DeckFeatureLayerVisualizationCtor = ErdblickCore_["DeckFeatureLayerVisualization"];
/** Strongly typed handle for the wasm search-result visualization constructor exposed after init. */
type DeckTileSearchResultLayerVisualizationCtor = ErdblickCore_["DeckTileSearchResultLayerVisualization"];
/** Strongly typed handle for the wasm `RuleFidelity` enum object. */
type RuleFidelityEnum = ErdblickCore_["RuleFidelity"];

/** Returns the wasm constructor for deck feature visualizations after the core library is initialized. */
function deckFeatureLayerVisualizationCtor(): DeckFeatureLayerVisualizationCtor {
    return coreLib.DeckFeatureLayerVisualization as DeckFeatureLayerVisualizationCtor;
}

/** Returns the wasm constructor for deck search-result visualizations after the core library is initialized. */
function deckTileSearchResultLayerVisualizationCtor(): DeckTileSearchResultLayerVisualizationCtor {
    return coreLib.DeckTileSearchResultLayerVisualization as DeckTileSearchResultLayerVisualizationCtor;
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
        task.mapName,
        task.nodeId,
        blobSignature(task.fieldDictBlob),
        dataSourceInfoRevisionByMapName.get(task.mapName) ?? 0
    ].join("|");
}

/** Reuses parser instances that share identical field dictionaries and datasource metadata. */
function getOrCreateParser(task: DeckTileRenderTask): TileLayerParser {
    const key = parserCacheKey(task);
    const cached = parserCache.get(key);
    if (cached) {
        return cached;
    }
    const dataSourceInfoBlob = dataSourceInfoByMapName.get(task.mapName);
    if (!dataSourceInfoBlob) {
        throw new Error(`Deck render worker has no datasource info for map '${task.mapName}'.`);
    }
    const parser = new coreLib.TileLayerParser();
    uint8ArrayToWasm((data) => parser.setDataSourceInfo(data), dataSourceInfoBlob);
    uint8ArrayToWasm((data) => parser.addFieldDict(data), task.fieldDictBlob);
    parserCache.set(key, parser);
    return parser;
}

/** Drops parser cache entries for one map when its datasource metadata is refreshed. */
function clearParserCacheForMap(mapName: string): void {
    const keyPrefix = `${mapName}|`;
    for (const [key, parser] of parserCache.entries()) {
        if (!key.startsWith(keyPrefix)) {
            continue;
        }
        (parser as any).delete?.();
        parserCache.delete(key);
    }
}

/** Stores map-level datasource metadata sent separately from tile render tasks. */
function cacheDataSourceInfo(message: DeckWorkerDataSourceInfoMessage): void {
    dataSourceInfoByMapName.set(message.mapName, message.dataSourceInfoBlob);
    dataSourceInfoRevisionByMapName.set(
        message.mapName,
        (dataSourceInfoRevisionByMapName.get(message.mapName) ?? 0) + 1
    );
    clearParserCacheForMap(message.mapName);
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
    // Unknown values should degrade to the base pass, not create highlight-only render output.
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
    // Unknown values fall back to ANY so the worker keeps rendering instead of silently dropping geometry.
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

/** Collects transferable buffers for one packed GLTF picking-proxy bucket. */
function transferGltfPickProxyBucket(bucket: DeckGeometryBucketBuffers["gltfPickProxies"]): ArrayBuffer[] {
    return [
        bucket.positions.buffer,
        bucket.startIndices.buffer,
        bucket.nodeIndices.buffer,
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
        ...transferGltfBucket(buffers.gltfNodes),
        ...transferGltfPickProxyBucket(buffers.gltfPickProxies)
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

/** Reads runtime style validation issues from a render result. */
function readRuntimeStyleIssues(
    deckVisu: DeckFeatureLayerVisualization,
    task: DeckTileRenderTask
): StyleValidationIssue[] {
    const rawIssues = (deckVisu.runtimeStyleIssues() as StyleValidationIssue[]) ?? [];
    return rawIssues.map(issue => ({
        ...issue,
        source: {...(issue.source ?? {}), ...task.styleSourceRef},
        runtimeContext: {
            ...(issue.runtimeContext ?? {}),
            mapName: task.mapName,
            layerName: task.layerName,
            tileKey: task.tileKey,
            renderPath: "worker"
        }
    }));
}

/** Reads the binary render result from the wasm visualization wrapper. */
function readRenderResult(
    deckVisu: DeckFeatureLayerVisualization,
    task: DeckTileRenderTask
): DeckVisualizationBufferResult {
    const renderResult = deckVisu.renderResult() as DeckVisualizationBufferResult;
    return {
        ...renderResult,
        styleIssues: readRuntimeStyleIssues(deckVisu, task)
    };
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
        // Stage fusion happens inside the worker too so the wasm renderer sees the same merged tile view
        // as the main-thread path.
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
            // Guard against stale main-thread enums so the worker still produces a sane full render.
            : DECK_GEOMETRY_OUTPUT_ALL;
        deckVisu.setGeometryOutputMode(normalizedOutputMode);
        const renderStart = performance.now();
        deckVisu.addTileFeatureLayer(baseLayer);
        deckVisu.run();
        const renderResult = readRenderResult(deckVisu, task);
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

/** Executes one search-result tile render inside the worker and returns deck-ready buffers. */
function processSearchTileRenderTask(task: DeckSearchTileRenderTask): DeckTileRenderResult {
    const totalStart = performance.now();
    let searchLayer: TileSearchResultLayer | null = null;
    let deckVisu: DeckTileSearchResultLayerVisualization | null = null;
    try {
        const parser = getOrCreateParser({
            mapName: task.mapName,
            nodeId: task.nodeId,
            fieldDictBlob: task.fieldDictBlob
        } as DeckTileRenderTask);
        const deserializeStart = performance.now();
        searchLayer = uint8ArrayToWasm((data) => parser.readTileSearchResultLayer(data), task.searchResultLayerBlob) as
            TileSearchResultLayer | null;
        const deserializeMs = performance.now() - deserializeStart;
        if (!searchLayer) {
            throw new Error("Worker render requested with an invalid search-result layer.");
        }

        const renderStart = performance.now();
        const deckSearchCtor = deckTileSearchResultLayerVisualizationCtor();
        deckVisu = new deckSearchCtor(
            task.viewIndex,
            task.tileKey,
            task.styleSpecJson
        );
        deckVisu.addTileSearchResultLayer(searchLayer);
        deckVisu.run();
        const renderResult = deckVisu.renderResult() as DeckVisualizationBufferResult;
        const renderMs = performance.now() - renderStart;

        return {
            type: "DeckTileRenderResult",
            taskId: task.taskId,
            tileKey: task.tileKey,
            vertexCount: Math.max(0, Math.floor(Number(deckVisu.vertexCount()))),
            ...renderResult,
            timings: {
                deserializeMs,
                renderMs,
                totalMs: performance.now() - totalStart
            }
        };
    } finally {
        deckVisu?.delete();
        searchLayer?.delete();
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
        },
        gltfPickProxies: {
            positions: new Float32Array(),
            startIndices: new Uint32Array(),
            nodeIndices: new Uint32Array(),
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
        mergedPointFeatures: {} as Record<string, any[]>,
        resultFeatureIds: []
    };
}

/** Normalizes unknown worker exceptions to a readable error string for the main thread. */
function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message || error.toString();
    }
    return String(error);
}

/** Worker entry point for init, datasource-cache updates, and tile render tasks. */
addEventListener("message", async ({data}) => {
    const message = data as DeckWorkerInboundMessage;

    if (message.type === "DeckWorkerInit") {
        postMessage({
            type: "DeckWorkerReady",
            scriptUrl: self.location.href
        } as DeckWorkerReadyMessage);
        return;
    }
    if (message.type === "DeckWorkerDataSourceInfo") {
        cacheDataSourceInfo(message);
        return;
    }

    const task = message as DeckTileRenderTask | DeckSearchTileRenderTask;
    try {
        // `initializeLibrary()` is idempotent; awaiting it here keeps the worker bootstrap simple.
        await initializeLibrary();
        const result = task.type === "DeckSearchTileRenderTask"
            ? processSearchTileRenderTask(task)
            : processTileRenderTask(task);
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
