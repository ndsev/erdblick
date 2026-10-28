import {
    coreLib,
    initializeLibrary,
    uint8ArrayToWasmOrThrow,
    type ErdblickCore_
} from "../../integrations/wasm.adapter";
import type {
    FeatureLayerStyle,
    TileLayerParser,
    TileSubsetLayerRenderer
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
const rendererCache = new Map<string, TileSubsetLayerRenderer>();
const maxRendererCacheEntries = 4;
const iconCatalog = new Map<string, TileSubsetGpuIconCatalogEntry>();
let iconCatalogVersion = -1;
let cachedPointCloudInput: {key: string; subset: ReturnType<TileLayerParser["readTileSubsetLayer"]>} | null = null;

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
function rendererFor(task: TileSubsetLayerRenderTask): TileSubsetLayerRenderer {
    const key = JSON.stringify([
        task.styleKey,
        task.highlightModeValue,
        task.lod,
        task.pointCloud?.cacheKey
    ]);
    const cached = rendererCache.get(key);
    if (cached) {
        rendererCache.delete(key);
        rendererCache.set(key, cached);
        return cached;
    }
    while (rendererCache.size >= (task.pointCloud ? 1 : maxRendererCacheEntries)) {
        const oldest = rendererCache.entries().next().value as
            [string, TileSubsetLayerRenderer] | undefined;
        if (oldest) {
            oldest[1].delete();
            rendererCache.delete(oldest[0]);
        }
    }
    const module: ErdblickCore_ = coreLib;
    const renderer = new module.TileSubsetLayerRenderer(
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
    let renderer: TileSubsetLayerRenderer | null = null;
    let result: TileSubsetLayerRenderResult | null = null;
    try {
        const parserEntry = parserFor(task);
        installFieldDict(parserEntry, task);
        installIconCatalog(task);
        const parser = parserEntry.parser;
        const deserializeStartedAt = performance.now();
        if (task.reusePointCloudInput) {
            if (!task.pointCloud || cachedPointCloudInput?.key !== task.pointCloud.cacheKey)
                throw new Error("Point-cloud input cache does not match the requested revision.");
            subset = cachedPointCloudInput.subset;
        } else {
            cachedPointCloudInput?.subset.delete();
            cachedPointCloudInput = null;
            subset = uint8ArrayToWasmOrThrow(
                data => parser.readTileSubsetLayer(data), task.subsetBlob);
            if (!subset) throw new Error("Failed to deserialize TileSubsetLayer.");
            if (task.pointCloud) cachedPointCloudInput = {key: task.pointCloud.cacheKey, subset};
        }
        const deserializeMs = performance.now() - deserializeStartedAt;

        const renderStartedAt = performance.now();
        renderer = rendererFor(task);
        if (task.coordinateOrigin) {
            renderer.setCoordinateOrigin(
                task.coordinateOrigin[0],
                task.coordinateOrigin[1],
                task.coordinateOrigin[2]
            );
        }
        renderer.setLineSimplificationTolerance(
            task.lineSimplificationToleranceMeters
        );
        renderer.setPointCloudPolicy(task.pointCloud?.enabled ?? true, task.pointCloud?.maxPoints ?? 262144,
            task.pointCloud?.spacingMeters ?? 0, task.pointCloud?.cacheKey ?? task.taskId);
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
            pointCloudDeliveredCount: Number(renderer.pointCloudDeliveredCount()),
            pointCloudRenderedCount: Number(renderer.pointCloudRenderedCount()),
            wasmMemoryBytes: Number(coreLib.getTotalMemory()),
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
        renderer?.resetForNextTile();
        if (subset !== cachedPointCloudInput?.subset) subset?.delete();
        if (result) result.wasmMemoryBytes = Number(coreLib.getTotalMemory());
        if (result?.timings) {
            result.timings.totalMs = performance.now() - startedAt;
        }
    }
}

/** Acknowledge module loading before lazily initializing WASM for the first render. */
self.onmessage = async (event: MessageEvent<TileSubsetLayerRenderWorkerInbound>) => {
    if (event.data.type === "TileSubsetLayerRenderWorkerInit") {
        const ready: TileSubsetLayerRenderWorkerReady = {
            type: "TileSubsetLayerRenderWorkerReady",
            scriptUrl: self.location.href
        };
        self.postMessage(ready);
        return;
    }
    let result: TileSubsetLayerRenderResult;
    try {
        await initializeLibrary();
        result = render(event.data);
    } catch (error) {
        // Initialization failures must return the task's admission credit too.
        result = {
            type: "TileSubsetLayerRenderResult",
            taskId: event.data.taskId,
            visualizationId: event.data.visualizationId,
            renderSignature: event.data.renderSignature,
            error: error instanceof Error ? error.message : String(error)
        };
    }
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
