import {initializeLibrary, coreLib, type ErdblickCore_, uint8ArrayFromWasm, uint8ArrayToWasm} from "../../integrations/wasm";
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
    DeckLowFiBundleResult,
    DeckTileRenderResult,
    DeckTileRenderTask,
    DeckWorkerInboundMessage,
    DeckWorkerReadyMessage
} from "./deck-render.worker.protocol";
import {collectLowFiRawBundles, type DeckLowFiRawAccessor} from "./deck-lowfi-bundle";

const styleTextEncoder = new TextEncoder();
const parserCache = new Map<string, TileLayerParser>();
const styleCache = new Map<string, FeatureLayerStyle>();

type DeckFeatureLayerVisualizationCtor = ErdblickCore_["DeckFeatureLayerVisualization"];
type RuleFidelityEnum = ErdblickCore_["RuleFidelity"];
type DeckVisualizationRawAccessor = DeckLowFiRawAccessor | "pathCoordinateOriginRaw";

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

function readRawBytes(deckVisu: DeckFeatureLayerVisualization, accessorName: DeckVisualizationRawAccessor): Uint8Array {
    return uint8ArrayFromWasm((shared) => {
        deckVisu[accessorName](shared);
        return true;
    }) as Uint8Array;
}

function readLowFiBundles(deckVisu: DeckFeatureLayerVisualization): DeckLowFiBundleResult[] {
    return collectLowFiRawBundles(
        deckVisu,
        (accessorName) => readRawBytes(deckVisu, accessorName)
    ).map((bundle) => ({
        lod: bundle.lod,
        pointPositions: bundle.pointPositions.buffer as ArrayBuffer,
        pointColors: bundle.pointColors.buffer as ArrayBuffer,
        pointRadii: bundle.pointRadii.buffer as ArrayBuffer,
        pointFeatureIds: bundle.pointFeatureIds.buffer as ArrayBuffer,
        pointBillboards: bundle.pointBillboards.buffer as ArrayBuffer,
        surfacePositions: bundle.surfacePositions.buffer as ArrayBuffer,
        surfaceStartIndices: bundle.surfaceStartIndices.buffer as ArrayBuffer,
        surfaceColors: bundle.surfaceColors.buffer as ArrayBuffer,
        surfaceFeatureIds: bundle.surfaceFeatureIds.buffer as ArrayBuffer,
        positions: bundle.positions.buffer as ArrayBuffer,
        startIndices: bundle.startIndices.buffer as ArrayBuffer,
        colors: bundle.colors.buffer as ArrayBuffer,
        widths: bundle.widths.buffer as ArrayBuffer,
        featureIds: bundle.featureIds.buffer as ArrayBuffer,
        billboards: bundle.billboards.buffer as ArrayBuffer,
        dashArrays: bundle.dashArrays.buffer as ArrayBuffer,
        dashOffsets: bundle.dashOffsets.buffer as ArrayBuffer,
        arrowPositions: bundle.arrowPositions.buffer as ArrayBuffer,
        arrowStartIndices: bundle.arrowStartIndices.buffer as ArrayBuffer,
        arrowColors: bundle.arrowColors.buffer as ArrayBuffer,
        arrowWidths: bundle.arrowWidths.buffer as ArrayBuffer,
        arrowFeatureIds: bundle.arrowFeatureIds.buffer as ArrayBuffer,
        arrowBillboards: bundle.arrowBillboards.buffer as ArrayBuffer
    }));
}

function attachOverlayChain(baseLayer: TileFeatureLayer, overlays: TileFeatureLayer[]): void {
    for (const overlay of overlays) {
        baseLayer.attachOverlay(overlay);
    }
}

function processTileRenderTask(task: DeckTileRenderTask): DeckTileRenderResult {
    const totalStart = performance.now();
    let deserializeMs = 0;
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
        deserializeMs = performance.now() - deserializeStart;
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

        const pointPositions = readRawBytes(deckVisu, "pointPositionsRaw");
        const pointColors = readRawBytes(deckVisu, "pointColorsRaw");
        const pointRadii = readRawBytes(deckVisu, "pointRadiiRaw");
        const pointFeatureIds = readRawBytes(deckVisu, "pointFeatureIdsRaw");
        const pointBillboards = readRawBytes(deckVisu, "pointBillboardsRaw");
        const coordinateOrigin = readRawBytes(deckVisu, "pathCoordinateOriginRaw");
        const surfacePositions = readRawBytes(deckVisu, "surfacePositionsRaw");
        const surfaceStartIndices = readRawBytes(deckVisu, "surfaceStartIndicesRaw");
        const surfaceColors = readRawBytes(deckVisu, "surfaceColorsRaw");
        const surfaceFeatureIds = readRawBytes(deckVisu, "surfaceFeatureIdsRaw");
        const positions = readRawBytes(deckVisu, "pathPositionsRaw");
        const startIndices = readRawBytes(deckVisu, "pathStartIndicesRaw");
        const colors = readRawBytes(deckVisu, "pathColorsRaw");
        const widths = readRawBytes(deckVisu, "pathWidthsRaw");
        const featureIds = readRawBytes(deckVisu, "pathFeatureIdsRaw");
        const billboards = readRawBytes(deckVisu, "pathBillboardsRaw");
        const dashArrays = readRawBytes(deckVisu, "pathDashArrayRaw");
        const dashOffsets = readRawBytes(deckVisu, "pathDashOffsetsRaw");
        const arrowPositions = readRawBytes(deckVisu, "arrowPositionsRaw");
        const arrowStartIndices = readRawBytes(deckVisu, "arrowStartIndicesRaw");
        const arrowColors = readRawBytes(deckVisu, "arrowColorsRaw");
        const arrowWidths = readRawBytes(deckVisu, "arrowWidthsRaw");
        const arrowFeatureIds = readRawBytes(deckVisu, "arrowFeatureIdsRaw");
        const arrowBillboards = readRawBytes(deckVisu, "arrowBillboardsRaw");
        const lowFiBundles = readLowFiBundles(deckVisu);
        const mergedPointFeatures = deckVisu.mergedPointFeatures() as Record<string, any[]>;
        const renderMs = performance.now() - renderStart;

        return {
            type: "DeckTileRenderResult",
            taskId: task.taskId,
            tileKey: task.tileKey,
            vertexCount,
            pointPositions: pointPositions.buffer as ArrayBuffer,
            pointColors: pointColors.buffer as ArrayBuffer,
            pointRadii: pointRadii.buffer as ArrayBuffer,
            pointFeatureIds: pointFeatureIds.buffer as ArrayBuffer,
            pointBillboards: pointBillboards.buffer as ArrayBuffer,
            coordinateOrigin: coordinateOrigin.buffer as ArrayBuffer,
            surfacePositions: surfacePositions.buffer as ArrayBuffer,
            surfaceStartIndices: surfaceStartIndices.buffer as ArrayBuffer,
            surfaceColors: surfaceColors.buffer as ArrayBuffer,
            surfaceFeatureIds: surfaceFeatureIds.buffer as ArrayBuffer,
            positions: positions.buffer as ArrayBuffer,
            startIndices: startIndices.buffer as ArrayBuffer,
            colors: colors.buffer as ArrayBuffer,
            widths: widths.buffer as ArrayBuffer,
            featureIds: featureIds.buffer as ArrayBuffer,
            billboards: billboards.buffer as ArrayBuffer,
            dashArrays: dashArrays.buffer as ArrayBuffer,
            dashOffsets: dashOffsets.buffer as ArrayBuffer,
            arrowPositions: arrowPositions.buffer as ArrayBuffer,
            arrowStartIndices: arrowStartIndices.buffer as ArrayBuffer,
            arrowColors: arrowColors.buffer as ArrayBuffer,
            arrowWidths: arrowWidths.buffer as ArrayBuffer,
            arrowFeatureIds: arrowFeatureIds.buffer as ArrayBuffer,
            arrowBillboards: arrowBillboards.buffer as ArrayBuffer,
            lowFiBundles,
            mergedPointFeatures,
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

function emptyResultBuffers() {
    return {
        pointPositions: new ArrayBuffer(0),
        pointColors: new ArrayBuffer(0),
        pointRadii: new ArrayBuffer(0),
        pointFeatureIds: new ArrayBuffer(0),
        pointBillboards: new ArrayBuffer(0),
        coordinateOrigin: new ArrayBuffer(0),
        surfacePositions: new ArrayBuffer(0),
        surfaceStartIndices: new ArrayBuffer(0),
        surfaceColors: new ArrayBuffer(0),
        surfaceFeatureIds: new ArrayBuffer(0),
        positions: new ArrayBuffer(0),
        startIndices: new ArrayBuffer(0),
        colors: new ArrayBuffer(0),
        widths: new ArrayBuffer(0),
        featureIds: new ArrayBuffer(0),
        billboards: new ArrayBuffer(0),
        dashArrays: new ArrayBuffer(0),
        dashOffsets: new ArrayBuffer(0),
        arrowPositions: new ArrayBuffer(0),
        arrowStartIndices: new ArrayBuffer(0),
        arrowColors: new ArrayBuffer(0),
        arrowWidths: new ArrayBuffer(0),
        arrowFeatureIds: new ArrayBuffer(0),
        arrowBillboards: new ArrayBuffer(0),
        lowFiBundles: [] as DeckLowFiBundleResult[],
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
        const lowFiBundleTransfers: ArrayBuffer[] = [];
        for (const bundle of result.lowFiBundles) {
            lowFiBundleTransfers.push(
                bundle.pointPositions,
                bundle.pointColors,
                bundle.pointRadii,
                bundle.pointFeatureIds,
                bundle.pointBillboards,
                bundle.surfacePositions,
                bundle.surfaceStartIndices,
                bundle.surfaceColors,
                bundle.surfaceFeatureIds,
                bundle.positions,
                bundle.startIndices,
                bundle.colors,
                bundle.widths,
                bundle.featureIds,
                bundle.billboards,
                bundle.dashArrays,
                bundle.dashOffsets,
                bundle.arrowPositions,
                bundle.arrowStartIndices,
                bundle.arrowColors,
                bundle.arrowWidths,
                bundle.arrowFeatureIds,
                bundle.arrowBillboards
            );
        }
        // @ts-expect-error: transfer list accepts ArrayBuffer entries extracted from the typed result payload.
        postMessage(result, [
            result.pointPositions,
            result.pointColors,
            result.pointRadii,
            result.pointFeatureIds,
            result.pointBillboards,
            result.coordinateOrigin,
            result.surfacePositions,
            result.surfaceStartIndices,
            result.surfaceColors,
            result.surfaceFeatureIds,
            result.positions,
            result.startIndices,
            result.colors,
            result.widths,
            result.featureIds,
            result.billboards,
            result.dashArrays,
            result.dashOffsets,
            result.arrowPositions,
            result.arrowStartIndices,
            result.arrowColors,
            result.arrowWidths,
            result.arrowFeatureIds,
            result.arrowBillboards,
            ...lowFiBundleTransfers
        ]);
    } catch (error) {
        const buffers = emptyResultBuffers();
        const failure: DeckTileRenderResult = {
            type: "DeckTileRenderResult",
            taskId: task.taskId,
            tileKey: task.tileKey,
            vertexCount: 0,
            ...buffers,
            error: toErrorMessage(error)
        };
        postMessage(failure);
    }
});
