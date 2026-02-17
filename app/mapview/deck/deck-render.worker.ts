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

        deckVisu = new coreLib.DeckFeatureLayerVisualization(
            task.viewIndex,
            task.tileKey,
            style,
            task.styleOptions,
            resolveHighlightMode(task.highlightModeValue),
            task.featureIdSubset
        );
        const renderStart = performance.now();
        deckVisu.addTileFeatureLayer(tile);
        deckVisu.run();

        const coordinateOrigin = readRawBytes(deckVisu, "pathCoordinateOriginRaw");
        const positions = readRawBytes(deckVisu, "pathPositionsRaw");
        const startIndices = readRawBytes(deckVisu, "pathStartIndicesRaw");
        const colors = readRawBytes(deckVisu, "pathColorsRaw");
        const widths = readRawBytes(deckVisu, "pathWidthsRaw");
        const featureIds = readRawBytes(deckVisu, "pathFeatureIdsRaw");
        const dashArrays = readRawBytes(deckVisu, "pathDashArrayRaw");
        const dashOffsets = readRawBytes(deckVisu, "pathDashOffsetsRaw");
        const renderMs = performance.now() - renderStart;

        return {
            type: "DeckPathRenderResult",
            taskId: task.taskId,
            tileKey: task.tileKey,
            coordinateOrigin: coordinateOrigin.buffer,
            positions: positions.buffer,
            startIndices: startIndices.buffer,
            colors: colors.buffer,
            widths: widths.buffer,
            featureIds: featureIds.buffer,
            dashArrays: dashArrays.buffer,
            dashOffsets: dashOffsets.buffer,
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
        coordinateOrigin: new ArrayBuffer(0),
        positions: new ArrayBuffer(0),
        startIndices: new ArrayBuffer(0),
        colors: new ArrayBuffer(0),
        widths: new ArrayBuffer(0),
        featureIds: new ArrayBuffer(0),
        dashArrays: new ArrayBuffer(0),
        dashOffsets: new ArrayBuffer(0)
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
            result.coordinateOrigin,
            result.positions,
            result.startIndices,
            result.colors,
            result.widths,
            result.featureIds,
            result.dashArrays,
            result.dashOffsets
        ]);
    } catch (error) {
        const buffers = emptyResultBuffers();
        const failure: DeckPathRenderResult = {
            type: "DeckPathRenderResult",
            taskId: task.taskId,
            tileKey: task.tileKey,
            ...buffers,
            error: toErrorMessage(error)
        };
        postMessage(failure);
    }
});
