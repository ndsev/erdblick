import {initializeLibrary, coreLib, uint8ArrayFromWasm, uint8ArrayToWasm} from "../../integrations/wasm";
import {
    DeckPathRenderResult,
    DeckPathRenderTask,
    DeckWorkerInboundMessage,
    DeckWorkerReadyMessage
} from "./deck-render.worker.protocol";

const styleTextEncoder = new TextEncoder();
const parserCache = new Map<string, any>();
const styleCache = new Map<string, any>();

function blobSignature(blob: Uint8Array): string {
    if (!blob.length) {
        return "0";
    }
    const mid = blob[blob.length >> 1];
    return `${blob.length}:${blob[0]}:${mid}:${blob[blob.length - 1]}`;
}

function parserCacheKey(task: DeckPathRenderTask): string {
    return [
        task.nodeId,
        task.mapName,
        blobSignature(task.fieldDictBlob),
        blobSignature(task.dataSourceInfoBlob)
    ].join("|");
}

function getOrCreateParser(task: DeckPathRenderTask): any {
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

function getOrCreateStyle(styleSource: string): any {
    const cached = styleCache.get(styleSource);
    if (cached) {
        return cached;
    }
    const styleBytes = styleTextEncoder.encode(styleSource);
    const parsed = uint8ArrayToWasm((data) => new coreLib.FeatureLayerStyle(data), styleBytes) as any;
    styleCache.set(styleSource, parsed);
    return parsed;
}

function resolveHighlightMode(modeValue: number): any {
    if (modeValue === coreLib.HighlightMode.HOVER_HIGHLIGHT.value) {
        return coreLib.HighlightMode.HOVER_HIGHLIGHT;
    }
    if (modeValue === coreLib.HighlightMode.SELECTION_HIGHLIGHT.value) {
        return coreLib.HighlightMode.SELECTION_HIGHLIGHT;
    }
    return coreLib.HighlightMode.NO_HIGHLIGHT;
}

function createMergeCountProvider(snapshot: Record<string, number>): any {
    const table = snapshot ?? {};
    return {
        count: (_geoPos: any, hashPos: string, _level: number, mapViewLayerStyleRuleId: string) => {
            const value = table[`${mapViewLayerStyleRuleId}|${hashPos}`];
            return Number.isInteger(value) ? value : 0;
        }
    };
}

function readRawBytes(deckVisu: any, accessorName: string): Uint8Array {
    return uint8ArrayFromWasm((shared) => {
        deckVisu[accessorName](shared);
        return true;
    }) as Uint8Array;
}

function processPathRenderTask(task: DeckPathRenderTask): DeckPathRenderResult {
    const totalStart = performance.now();
    let deserializeMs = 0;
    let tile: any = null;
    let deckVisu: any = null;
    try {
        const parser = getOrCreateParser(task);
        const style = getOrCreateStyle(task.styleSource);
        const deserializeStart = performance.now();
        tile = uint8ArrayToWasm((data) => parser.readTileFeatureLayer(data), task.tileBlob) as any;
        deserializeMs = performance.now() - deserializeStart;
        const vertexCount = Math.max(0, Math.floor(Number(tile.numVertices())));

        deckVisu = new coreLib.DeckFeatureLayerVisualization(
            task.viewIndex,
            task.tileKey,
            style,
            task.styleOptions,
            createMergeCountProvider(task.mergeCountSnapshot),
            resolveHighlightMode(task.highlightModeValue),
            task.featureIdSubset
        );
        const renderStart = performance.now();
        deckVisu.addTileFeatureLayer(tile);
        deckVisu.run();

        const pointPositions = readRawBytes(deckVisu, "pointPositionsRaw");
        const pointColors = readRawBytes(deckVisu, "pointColorsRaw");
        const pointRadii = readRawBytes(deckVisu, "pointRadiiRaw");
        const pointFeatureIds = readRawBytes(deckVisu, "pointFeatureIdsRaw");
        const coordinateOrigin = readRawBytes(deckVisu, "pathCoordinateOriginRaw");
        const positions = readRawBytes(deckVisu, "pathPositionsRaw");
        const startIndices = readRawBytes(deckVisu, "pathStartIndicesRaw");
        const colors = readRawBytes(deckVisu, "pathColorsRaw");
        const widths = readRawBytes(deckVisu, "pathWidthsRaw");
        const featureIds = readRawBytes(deckVisu, "pathFeatureIdsRaw");
        const dashArrays = readRawBytes(deckVisu, "pathDashArrayRaw");
        const dashOffsets = readRawBytes(deckVisu, "pathDashOffsetsRaw");
        const arrowPositions = readRawBytes(deckVisu, "arrowPositionsRaw");
        const arrowStartIndices = readRawBytes(deckVisu, "arrowStartIndicesRaw");
        const arrowColors = readRawBytes(deckVisu, "arrowColorsRaw");
        const arrowWidths = readRawBytes(deckVisu, "arrowWidthsRaw");
        const arrowFeatureIds = readRawBytes(deckVisu, "arrowFeatureIdsRaw");
        const mergedPointFeatures = deckVisu.mergedPointFeatures() as Record<string, any[]>;
        const renderMs = performance.now() - renderStart;

        return {
            type: "DeckPathRenderResult",
            taskId: task.taskId,
            tileKey: task.tileKey,
            vertexCount,
            pointPositions: pointPositions.buffer,
            pointColors: pointColors.buffer,
            pointRadii: pointRadii.buffer,
            pointFeatureIds: pointFeatureIds.buffer,
            coordinateOrigin: coordinateOrigin.buffer,
            positions: positions.buffer,
            startIndices: startIndices.buffer,
            colors: colors.buffer,
            widths: widths.buffer,
            featureIds: featureIds.buffer,
            dashArrays: dashArrays.buffer,
            dashOffsets: dashOffsets.buffer,
            arrowPositions: arrowPositions.buffer,
            arrowStartIndices: arrowStartIndices.buffer,
            arrowColors: arrowColors.buffer,
            arrowWidths: arrowWidths.buffer,
            arrowFeatureIds: arrowFeatureIds.buffer,
            mergedPointFeatures,
            timings: {
                deserializeMs,
                renderMs,
                totalMs: performance.now() - totalStart
            }
        };
    } finally {
        if (deckVisu && typeof deckVisu.delete === "function") {
            deckVisu.delete();
        }
        if (tile && typeof tile.delete === "function") {
            tile.delete();
        }
    }
}

function emptyResultBuffers() {
    return {
        pointPositions: new ArrayBuffer(0),
        pointColors: new ArrayBuffer(0),
        pointRadii: new ArrayBuffer(0),
        pointFeatureIds: new ArrayBuffer(0),
        coordinateOrigin: new ArrayBuffer(0),
        positions: new ArrayBuffer(0),
        startIndices: new ArrayBuffer(0),
        colors: new ArrayBuffer(0),
        widths: new ArrayBuffer(0),
        featureIds: new ArrayBuffer(0),
        dashArrays: new ArrayBuffer(0),
        dashOffsets: new ArrayBuffer(0),
        arrowPositions: new ArrayBuffer(0),
        arrowStartIndices: new ArrayBuffer(0),
        arrowColors: new ArrayBuffer(0),
        arrowWidths: new ArrayBuffer(0),
        arrowFeatureIds: new ArrayBuffer(0),
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

    const task = message as DeckPathRenderTask;
    try {
        await initializeLibrary();

        const result = processPathRenderTask(task);
        postMessage(result, [
            result.pointPositions,
            result.pointColors,
            result.pointRadii,
            result.pointFeatureIds,
            result.coordinateOrigin,
            result.positions,
            result.startIndices,
            result.colors,
            result.widths,
            result.featureIds,
            result.dashArrays,
            result.dashOffsets,
            result.arrowPositions,
            result.arrowStartIndices,
            result.arrowColors,
            result.arrowWidths,
            result.arrowFeatureIds
        ]);
    } catch (error) {
        const buffers = emptyResultBuffers();
        const failure: DeckPathRenderResult = {
            type: "DeckPathRenderResult",
            taskId: task.taskId,
            tileKey: task.tileKey,
            vertexCount: 0,
            ...buffers,
            error: toErrorMessage(error)
        };
        postMessage(failure);
    }
});
