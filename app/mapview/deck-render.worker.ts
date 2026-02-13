import {initializeLibrary, coreLib, uint8ArrayFromWasm, uint8ArrayToWasm} from "../integrations/wasm";
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
    const mid = blob[blob.length >> 1] ?? 0;
    return `${blob.length}:${blob[0] ?? 0}:${mid}:${blob[blob.length - 1] ?? 0}`;
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
    const parsed = uint8ArrayToWasm((data) => new coreLib.FeatureLayerStyle(data), styleBytes);
    if (!parsed) {
        return null;
    }
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
    try {
        return uint8ArrayFromWasm((shared) => {
            deckVisu[accessorName](shared);
            return true;
        }) ?? new Uint8Array();
    } catch (_err) {
        return new Uint8Array();
    }
}

function processPathRenderTask(task: DeckPathRenderTask): DeckPathRenderResult {
    const empty: DeckPathRenderResult = {
        type: "DeckPathRenderResult",
        taskId: task.taskId,
        tileKey: task.tileKey,
        positions: new ArrayBuffer(0),
        startIndices: new ArrayBuffer(0),
        colors: new ArrayBuffer(0),
        widths: new ArrayBuffer(0)
    };
    if (!task.tileBlob?.length) {
        return empty;
    }
    if (!task.styleSource?.length) {
        return {...empty, error: "Missing style source."};
    }

    let tile: any = null;
    let deckVisu: any = null;
    try {
        const parser = getOrCreateParser(task);
        const style = getOrCreateStyle(task.styleSource);
        if (!style) {
            return {...empty, error: "Failed to parse style source."};
        }

        tile = uint8ArrayToWasm((data) => parser.readTileFeatureLayer(data), task.tileBlob);
        if (!tile) {
            return {...empty, error: "Failed to parse tile blob."};
        }

        deckVisu = new coreLib.DeckFeatureLayerVisualization(
            task.viewIndex,
            task.tileKey,
            style,
            task.styleOptions ?? {},
            resolveHighlightMode(task.highlightModeValue),
            []
        );
        deckVisu.addTileFeatureLayer(tile);
        deckVisu.run();

        const positions = readRawBytes(deckVisu, "pathPositionsRaw");
        const startIndices = readRawBytes(deckVisu, "pathStartIndicesRaw");
        const colors = readRawBytes(deckVisu, "pathColorsRaw");
        const widths = readRawBytes(deckVisu, "pathWidthsRaw");

        return {
            type: "DeckPathRenderResult",
            taskId: task.taskId,
            tileKey: task.tileKey,
            positions: positions.buffer,
            startIndices: startIndices.buffer,
            colors: colors.buffer,
            widths: widths.buffer
        };
    } catch (exc) {
        const message = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
        return {...empty, error: message};
    } finally {
        if (deckVisu && typeof deckVisu.delete === "function") {
            deckVisu.delete();
        }
        if (tile && typeof tile.delete === "function") {
            tile.delete();
        }
    }
}

addEventListener("message", async ({data}) => {
    const message = data as DeckWorkerInboundMessage;

    if (message?.type === "DeckWorkerInit") {
        postMessage({
            type: "DeckWorkerReady",
            scriptUrl: self.location.href
        } as DeckWorkerReadyMessage);
        return;
    }

    if (message?.type !== "DeckPathRenderTask") {
        return;
    }

    await initializeLibrary();

    const result = processPathRenderTask(message);
    postMessage(result, [result.positions, result.startIndices, result.colors, result.widths]);
});
