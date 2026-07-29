import {
    coreLib,
    initializeLibrary,
    uint8ArrayToWasmOrThrow
} from "../../integrations/wasm";
import type {
    FeatureLayerStyle,
    TileLayerParser
} from "../../../build/libs/core/erdblick-core";
import type {
    TileSubsetLayerRenderBuffers,
    TileSubsetLayerRenderResult,
    TileSubsetLayerRenderTask,
    TileSubsetLayerRenderWorkerInbound,
    TileSubsetLayerRenderWorkerReady
} from "./tile-subset-layer-render.worker.protocol";

const textEncoder = new TextEncoder();
interface ParserCacheEntry {
    parser: TileLayerParser;
    fieldDictSizes: Map<string, number>;
}

const parserCache = new Map<string, ParserCacheEntry>();
const styleCache = new Map<string, FeatureLayerStyle>();

function parserFor(task: TileSubsetLayerRenderTask): ParserCacheEntry {
    const key = `${task.catalogRevision}:${task.mapId}`;
    const cached = parserCache.get(key);
    if (cached) {
        return cached;
    }
    if (!task.dataSourceInfoBlob) {
        throw new Error(
            `Subset render worker has no catalog '${key}'.`
        );
    }
    const parser = new coreLib.TileLayerParser() as TileLayerParser;
    const configured = uint8ArrayToWasmOrThrow(
        data => parser.setDataSourceInfo(data),
        task.dataSourceInfoBlob
    );
    if (configured === null) {
        parser.delete();
        throw new Error("Failed to configure the subset render worker parser.");
    }
    for (const [existingKey, existing] of parserCache) {
        if (existingKey.endsWith(`:${task.mapId}`)) {
            existing.parser.delete();
            parserCache.delete(existingKey);
        }
    }
    const entry = {
        parser,
        fieldDictSizes: new Map<string, number>()
    };
    parserCache.set(key, entry);
    return entry;
}

/**
 * Installs the main-thread dictionary snapshot before parsing an isolated
 * subset payload. A datasource dictionary is append-only within one catalog
 * revision, so byte size is a sufficient cheap high-watermark here.
 */
function installFieldDict(
    entry: ParserCacheEntry,
    task: TileSubsetLayerRenderTask
): void {
    const previousSize = entry.fieldDictSizes.get(task.stringPoolId);
    if (!task.fieldDictBlob) {
        if (previousSize !== undefined) {
            return;
        }
        throw new Error(
            `Subset render worker has no field dictionary '${task.stringPoolId}'.`
        );
    }
    if (previousSize === task.fieldDictBlob.byteLength) {
        return;
    }
    uint8ArrayToWasmOrThrow(
        data => entry.parser.addFieldDict(data),
        task.fieldDictBlob
    );
    entry.fieldDictSizes.set(
        task.stringPoolId,
        task.fieldDictBlob.byteLength
    );
}

function styleFor(key: string, source?: string): FeatureLayerStyle {
    const cached = styleCache.get(key);
    if (cached) {
        return cached;
    }
    if (source === undefined) {
        throw new Error(
            `Subset render worker has no stylesheet '${key}'.`
        );
    }
    const style = uint8ArrayToWasmOrThrow(
        data => new coreLib.FeatureLayerStyle(data) as FeatureLayerStyle,
        textEncoder.encode(source)
    );
    if (!style) {
        throw new Error("Failed to parse the stylesheet in the subset render worker.");
    }
    styleCache.set(key, style);
    return style;
}

function render(task: TileSubsetLayerRenderTask): TileSubsetLayerRenderResult {
    const startedAt = performance.now();
    const subsets: Array<
        ReturnType<TileLayerParser["readTileSubsetLayer"]>
    > = [];
    let renderer: any = null;
    try {
        const parserEntry = parserFor(task);
        installFieldDict(parserEntry, task);
        const parser = parserEntry.parser;
        const deserializeStartedAt = performance.now();
        const deserializeMsBySubset: number[] = [];
        for (const subsetBlob of task.subsetBlobs) {
            const subsetStartedAt = performance.now();
            const subset = uint8ArrayToWasmOrThrow(
                data => parser.readTileSubsetLayer(data),
                subsetBlob
            );
            if (!subset) {
                throw new Error("Failed to deserialize TileSubsetLayer.");
            }
            subsets.push(subset);
            deserializeMsBySubset.push(
                performance.now() - subsetStartedAt
            );
        }
        const deserializeMs = performance.now() - deserializeStartedAt;

        const renderStartedAt = performance.now();
        renderer = new coreLib.TileSubsetLayerRenderer(
            task.viewIndex,
            task.blockKey,
            styleFor(task.styleKey, task.styleSource),
            task.highlightModeValue,
            task.fidelityValue
        );
        renderer.setCoordinateOrigin(
            task.coordinateOrigin[0],
            task.coordinateOrigin[1],
            task.coordinateOrigin[2]
        );
        for (const subset of subsets) {
            renderer.addTileSubsetLayer(subset);
        }
        renderer.run();
        const raw = renderer.renderResult() as Omit<
            TileSubsetLayerRenderBuffers,
            "vertexCount" | "styleIssues" | "timings"
        >;
        const renderMs = performance.now() - renderStartedAt;
        return {
            type: "TileSubsetLayerRenderResult",
            taskId: task.taskId,
            visualizationId: task.visualizationId,
            renderSignature: task.renderSignature,
            ...raw,
            vertexCount: Number(renderer.vertexCount()),
            styleIssues: renderer.runtimeStyleIssues() ?? [],
            timings: {
                deserializeMs,
                deserializeMsBySubset,
                renderMs,
                totalMs: performance.now() - startedAt
            }
        };
    } catch (error) {
        return {
            type: "TileSubsetLayerRenderResult",
            taskId: task.taskId,
            visualizationId: task.visualizationId,
            renderSignature: task.renderSignature,
            error: error instanceof Error ? error.message : String(error)
        } as TileSubsetLayerRenderResult;
    } finally {
        renderer?.delete?.();
        for (const subset of subsets) {
            subset?.delete();
        }
    }
}

self.onmessage = async (event: MessageEvent<TileSubsetLayerRenderWorkerInbound>) => {
    if (event.data.type === "TileSubsetLayerRenderWorkerInit") {
        await initializeLibrary();
        const ready: TileSubsetLayerRenderWorkerReady = {
            type: "TileSubsetLayerRenderWorkerReady"
        };
        self.postMessage(ready);
        return;
    }
    await initializeLibrary();
    const result = render(event.data);
    const transferables = new Set<ArrayBuffer>();
    const collectTransferables = (value: unknown): void => {
        if (ArrayBuffer.isView(value)) {
            if (value.buffer instanceof ArrayBuffer) {
                transferables.add(value.buffer);
            }
            return;
        }
        if (!value || typeof value !== "object") {
            return;
        }
        for (const child of Object.values(value)) {
            collectTransferables(child);
        }
    };
    collectTransferables(result);
    self.postMessage(result, [...transferables]);
};
