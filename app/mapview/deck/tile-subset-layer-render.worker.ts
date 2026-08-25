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
    TileSubsetLayerRenderResult,
    TileSubsetLayerRenderTask,
    TileSubsetLayerRenderWorkerInbound,
    TileSubsetLayerRenderWorkerReady
} from "./tile-subset-layer-render.worker.protocol";
import type {TileSubsetGpuIconCatalogEntry} from
    "./tile-subset-layer-render.worker.protocol";

const textEncoder = new TextEncoder();
interface ParserCacheEntry {
    parser: TileLayerParser;
    fieldDictSizes: Map<string, number>;
}

const parserCache = new Map<string, ParserCacheEntry>();
const styleCache = new Map<string, FeatureLayerStyle>();
const rendererCache = new Map<string, any>();
const maxRendererCacheEntries = 4;
const iconCatalog = new Map<string, TileSubsetGpuIconCatalogEntry>();
let iconCatalogVersion = -1;

/** Install a complete small catalog snapshot only when the main version advances. */
function installIconCatalog(task: TileSubsetLayerRenderTask): void {
    if (task.iconCatalogEntries) {
        iconCatalog.clear();
        for (const entry of task.iconCatalogEntries) {
            iconCatalog.set(entry.uri, entry);
        }
        iconCatalogVersion = task.iconCatalogVersion;
    }
    if (iconCatalogVersion !== task.iconCatalogVersion) {
        throw new Error(
            `Subset render worker has no icon catalog version ` +
            `${task.iconCatalogVersion}.`
        );
    }
}

/** Reuse one parser per map/catalog revision and retire superseded catalogs. */
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

/** Resolve an immutable compiled stylesheet, requiring source on the first use. */
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

/** Reuse native scratch and packet storage for one immutable style context. */
function rendererFor(task: TileSubsetLayerRenderTask): any {
    const key = JSON.stringify([
        task.styleKey,
        task.highlightModeValue,
        task.lod
    ]);
    const cached = rendererCache.get(key);
    if (cached) {
        rendererCache.delete(key);
        rendererCache.set(key, cached);
        return cached;
    }
    if (rendererCache.size >= maxRendererCacheEntries) {
        const oldest = rendererCache.entries().next().value as
            [string, any] | undefined;
        if (oldest) {
            oldest[1].delete();
            rendererCache.delete(oldest[0]);
        }
    }
    const renderer = new coreLib.TileSubsetLayerRenderer(
        task.viewIndex,
        task.renderKey,
        styleFor(task.styleKey, task.styleSource),
        task.highlightModeValue,
        task.lod
    );
    rendererCache.set(key, renderer);
    return renderer;
}

/** Deserialize and render exactly one tile contribution into bounded packet fragments. */
function render(task: TileSubsetLayerRenderTask): TileSubsetLayerRenderResult {
    const startedAt = performance.now();
    let subset: ReturnType<TileLayerParser["readTileSubsetLayer"]> | null = null;
    let renderer: any = null;
    let result: TileSubsetLayerRenderResult | null = null;
    try {
        const parserEntry = parserFor(task);
        installFieldDict(parserEntry, task);
        installIconCatalog(task);
        const parser = parserEntry.parser;
        const deserializeStartedAt = performance.now();
        subset = uint8ArrayToWasmOrThrow(
            data => parser.readTileSubsetLayer(data),
            task.subsetBlob
        );
        if (!subset) {
            throw new Error("Failed to deserialize TileSubsetLayer.");
        }
        const deserializeMs = performance.now() - deserializeStartedAt;

        const renderStartedAt = performance.now();
        renderer = rendererFor(task);
        renderer.setCoordinateOrigin(
            task.coordinateOrigin[0],
            task.coordinateOrigin[1],
            task.coordinateOrigin[2]
        );
        renderer.setLineSimplificationTolerance(
            task.lineSimplificationToleranceMeters
        );
        renderer.configureGpuPacket(
            task.sceneGeneration,
            task.packetSequence,
            task.iconCatalogVersion,
            task.originSlot,
            task.originKeyLow,
            task.originKeyHigh
        );
        for (const entry of iconCatalog.values()) {
            renderer.addGpuIconResource(
                entry.uri,
                entry.atlasPage,
                entry.uv[0],
                entry.uv[1],
                entry.uv[2],
                entry.uv[3],
                entry.pixelSize[0],
                entry.pixelSize[1]
            );
        }
        renderer.addTileSubsetContribution(
            subset,
            task.contribution.keyLow,
            task.contribution.keyHigh,
            task.contribution.revision,
            task.contribution.slot,
            task.contribution.activationToken
        );
        const runStartedAt = performance.now();
        renderer.run();
        const runMs = performance.now() - runStartedAt;
        const packetStartedAt = performance.now();
        const packets = Array.from(
            renderer.renderPackets() as ArrayLike<Uint8Array>
        );
        const packetMs = performance.now() - packetStartedAt;
        const bridgeStartedAt = performance.now();
        const bridge = renderer.renderBridgeResult();
        const bridgeMs = performance.now() - bridgeStartedAt;
        const renderMs = performance.now() - renderStartedAt;
        result = {
            type: "TileSubsetLayerRenderResult",
            taskId: task.taskId,
            visualizationId: task.visualizationId,
            renderSignature: task.renderSignature,
            packets,
            bridge,
            vertexCount: Number(renderer.vertexCount()),
            timings: {
                deserializeMs,
                runMs,
                packetMs,
                bridgeMs,
                renderMs,
                totalMs: performance.now() - startedAt
            }
        };
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = {
            type: "TileSubsetLayerRenderResult",
            taskId: task.taskId,
            visualizationId: task.visualizationId,
            renderSignature: task.renderSignature,
            error: `${message} [${task.mapTileKey}; ` +
                `${task.inputGeometryVertexCount} vertices; ` +
                `${task.subsetBlob.byteLength} subset bytes]`
        };
        return result;
    } finally {
        renderer?.resetForNextTile?.();
        subset?.delete();
        if (result?.timings) {
            result.timings.totalMs = performance.now() - startedAt;
        }
    }
}

/** Initialize WASM once, then transfer packet and bridge buffers without copies. */
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
    const transferables = result.packets && result.bridge
        ? [
            ...result.packets.map(packet => packet.buffer),
            result.bridge.gltfNodes.nodeIndices.buffer,
            result.bridge.gltfNodes.colors.buffer,
            result.bridge.gltfNodes.depthTests.buffer,
            result.bridge.gltfNodes.featureAddresses.buffer,
            result.bridge.gltfPickProxies.positions.buffer,
            result.bridge.gltfPickProxies.startIndices.buffer,
            result.bridge.gltfPickProxies.nodeIndices.buffer,
            result.bridge.gltfPickProxies.featureAddresses.buffer,
            result.bridge.coordinateOrigin.buffer
        ].filter(
            (buffer, index, buffers): buffer is ArrayBuffer =>
                buffer instanceof ArrayBuffer && buffers.indexOf(buffer) === index
        )
        : [];
    self.postMessage(result, transferables);
};
