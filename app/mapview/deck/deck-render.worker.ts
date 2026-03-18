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

function deckFeatureLayerVisualizationCtor(): DeckFeatureLayerVisualizationCtor {
    return coreLib.DeckFeatureLayerVisualization as DeckFeatureLayerVisualizationCtor;
}

function ruleFidelityEnum(): RuleFidelityEnum {
    return coreLib.RuleFidelity as RuleFidelityEnum;
}

function blobSignature(blob: Uint8Array): string {
    if (!blob.length) {
        return "0";
    }
    const mid = blob[blob.length >> 1];
    return `${blob.length}:${blob[0]}:${mid}:${blob[blob.length - 1]}`;
}

function parserCacheKey(task: DeckTileRenderTask): string {
    return [
        task.nodeId,
        task.mapName,
        blobSignature(task.fieldDictBlob),
        blobSignature(task.dataSourceInfoBlob)
    ].join("|");
}

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

function resolveHighlightMode(modeValue: number): HighlightMode {
    if (modeValue === coreLib.HighlightMode.HOVER_HIGHLIGHT.value) {
        return coreLib.HighlightMode.HOVER_HIGHLIGHT;
    }
    if (modeValue === coreLib.HighlightMode.SELECTION_HIGHLIGHT.value) {
        return coreLib.HighlightMode.SELECTION_HIGHLIGHT;
    }
    return coreLib.HighlightMode.NO_HIGHLIGHT;
}

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

function attachOverlayChain(baseLayer: TileFeatureLayer, overlays: TileFeatureLayer[]): void {
    for (const overlay of overlays) {
        baseLayer.attachOverlay(overlay);
    }
}

function transferPointBucket(bucket: DeckGeometryBucketBuffers["pointWorld"]): ArrayBuffer[] {
    return [bucket.positions.buffer, bucket.colors.buffer, bucket.radii.buffer, bucket.featureAddresses.buffer];
}

function transferSurfaceBucket(bucket: DeckGeometryBucketBuffers["surface"]): ArrayBuffer[] {
    return [bucket.positions.buffer, bucket.startIndices.buffer, bucket.colors.buffer, bucket.featureAddresses.buffer];
}

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

function transferGeometryBuffers(buffers: DeckGeometryBucketBuffers): ArrayBuffer[] {
    return [
        ...transferPointBucket(buffers.pointWorld),
        ...transferPointBucket(buffers.pointBillboard),
        ...transferSurfaceBucket(buffers.surface),
        ...transferPathBucket(buffers.pathWorld),
        ...transferPathBucket(buffers.pathBillboard),
        ...transferPathBucket(buffers.arrowWorld),
        ...transferPathBucket(buffers.arrowBillboard)
    ];
}

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

function readRenderResult(deckVisu: DeckFeatureLayerVisualization): DeckVisualizationBufferResult {
    return (deckVisu as DeckFeatureLayerVisualizationWithRenderResult).renderResult();
}

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
        }
    };
}

function emptyResult(): Omit<DeckTileRenderResult, "type" | "taskId" | "tileKey" | "error"> {
    return {
        ...emptyGeometryBuffers(),
        vertexCount: 0,
        coordinateOrigin: new Float64Array(),
        lowFiBundles: [] as DeckLowFiBundleBuffers[],
        mergedPointFeatures: {} as Record<string, any[]>
    };
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message || error.toString();
    }
    return String(error);
}

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
