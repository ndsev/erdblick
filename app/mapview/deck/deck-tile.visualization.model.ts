import {FeatureTile} from "../../mapdata/features.model";
import {FeatureLayerStyle, HighlightMode} from "../../../build/libs/core/erdblick-core";
import {ITileVisualization, IRenderSceneHandle} from "../render-view.model";
import {PathLayer} from "@deck.gl/layers";
import {PathStyleExtension} from "@deck.gl/extensions";
import {COORDINATE_SYSTEM} from "@deck.gl/core";
import {DeckLayerRegistry, makeDeckLayerKey} from "./deck-layer-registry";
import {coreLib, uint8ArrayFromWasm} from "../../integrations/wasm";
import {deckRenderWorkerPool, isDeckRenderWorkerPoolEnabled} from "./deck-render.worker.pool";
import {DeckWorkerTimings} from "./deck-render.worker.protocol";

interface StyleWithIsDeleted extends FeatureLayerStyle {
    isDeleted(): boolean;
}

interface DeckSceneHandle {
    deck?: unknown;
    layerRegistry?: DeckLayerRegistry;
}

interface DeckBinaryAttribute<T extends ArrayLike<number>> {
    value: T;
    size: number;
}

interface DeckPathLayerData {
    length: number;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureIds: Array<number | null>;
    featureIdsByVertex: Array<number | null>;
    attributes: {
        getPath: DeckBinaryAttribute<Float32Array>;
        instanceColors: DeckBinaryAttribute<Uint8Array>;
        instanceStrokeWidths: DeckBinaryAttribute<Float32Array>;
        instanceDashArrays: DeckBinaryAttribute<Float32Array>;
    };
}

interface DeckPathRawBuffers {
    coordinateOrigin: Float64Array;
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    widths: Float32Array;
    featureIds: Uint32Array;
    dashArrays: Float32Array;
    dashOffsets: Float32Array;
}

const MAX_DECK_PATH_COUNT = 1_000_000;
const MAX_DECK_VERTEX_COUNT = 20_000_000;
const DECK_UNSELECTABLE_FEATURE_INDEX = 0xffffffff;

/**
 * Deck tile visualization used during migration.
 * It currently renders line geometry from DeckFeatureLayerVisualization.
 */
export class DeckTileVisualization implements ITileVisualization {
    tile: FeatureTile;
    isHighDetail: boolean;
    showTileBorder: boolean = false;
    readonly viewIndex: number;
    public readonly styleId: string;

    private readonly style: StyleWithIsDeleted;
    private readonly styleSource: string;
    private readonly highlightMode: HighlightMode;
    private readonly featureIdSubset: string[];
    private readonly options: Record<string, boolean | number | string>;
    private renderQueued = false;
    private deleted = false;
    private rendered = false;
    private pathLayerKey: string | null = null;
    private lastSignature = "";
    private hadTileDataAtLastRender = false;
    private tileFeatureCountAtLastRender = 0;
    private latestWorkerTimings: DeckWorkerTimings | null = null;

    constructor(viewIndex: number,
                tile: FeatureTile,
                style: FeatureLayerStyle,
                styleSource: string,
                highDetail: boolean,
                highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
                featureIdSubset: string[] = [],
                boxGrid?: boolean,
                options?: Record<string, boolean | number | string>) {
        this.tile = tile;
        this.style = style as StyleWithIsDeleted;
        this.styleSource = styleSource;
        this.styleId = this.style.name();
        this.isHighDetail = highDetail;
        this.highlightMode = highlightMode;
        this.featureIdSubset = [...featureIdSubset];
        this.showTileBorder = boxGrid === undefined ? false : boxGrid;
        this.options = options || {};
        this.viewIndex = viewIndex;
    }

    async render(sceneHandle: IRenderSceneHandle): Promise<boolean> {
        const registry = this.resolveRegistry(sceneHandle);
        if (this.deleted || this.style.isDeleted()) {
            return false;
        }
        this.latestWorkerTimings = null;
        const startTime = performance.now();
        const pathLayerKey = makeDeckLayerKey({
            tileKey: this.tile.mapTileKey,
            styleId: this.styleId,
            hoverMode: this.highlightModeLabel(),
            kind: "path"
        });
        try {
            const pathLayerData = await this.renderWasm();
            if (this.deleted || this.style.isDeleted()) {
                return false;
            }
            if (pathLayerData && pathLayerData.length > 0) {
                const pathLayer = new PathLayer({
                    id: pathLayerKey,
                    data: pathLayerData as any,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: pathLayerData.coordinateOrigin,
                    _pathType: "open",
                    widthUnits: "pixels",
                    capRounded: true,
                    jointRounded: true,
                    pickable: true,
                    dashJustified: true,
                    extensions: [new PathStyleExtension({dash: true})],
                    tileKey: this.tile.mapTileKey,
                    featureIds: pathLayerData.featureIds,
                    featureIdsByVertex: pathLayerData.featureIdsByVertex
                } as any);
                registry.upsert(pathLayerKey, pathLayer as any, 400);
                this.pathLayerKey = pathLayerKey;
            } else if (this.pathLayerKey) {
                registry.remove(this.pathLayerKey);
                this.pathLayerKey = null;
            }
            this.rendered = true;
            this.renderQueued = false;
            this.deleted = false;
            this.lastSignature = this.renderSignature();
            this.hadTileDataAtLastRender = this.tileHasData();
            this.tileFeatureCountAtLastRender = this.tileFeatureCount();
            return true;
        } finally {
            const workerTimings = this.consumeLatestWorkerTimings();
            const wallTimeMs = performance.now() - startTime;
            this.recordRenderTimeSample(wallTimeMs, workerTimings?.totalMs);
            this.recordWorkerParseTimeSample(workerTimings?.deserializeMs);
        }
    }

    destroy(sceneHandle: IRenderSceneHandle): void {
        this.deleted = true;
        const registry = this.resolveRegistry(sceneHandle);
        if (this.pathLayerKey) {
            registry.remove(this.pathLayerKey);
        }
        this.pathLayerKey = null;
        this.rendered = false;
        this.hadTileDataAtLastRender = false;
        this.tileFeatureCountAtLastRender = 0;
    }

    isDirty(): boolean {
        return (
            !this.rendered ||
            this.lastSignature !== this.renderSignature() ||
            this.hadTileDataAtLastRender !== this.tileHasData() ||
            this.tileFeatureCountAtLastRender !== this.tileFeatureCount()
        );
    }

    updateStatus(renderQueued?: boolean): void {
        if (renderQueued !== undefined) {
            this.renderQueued = renderQueued;
        }
    }

    setStyleOption(optionId: string, value: string | number | boolean): boolean {
        this.options[optionId] = value;
        return true;
    }

    private highlightModeLabel(): string {
        switch (this.highlightMode.value) {
            case coreLib.HighlightMode.HOVER_HIGHLIGHT.value:
                return "hover";
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT.value:
                return "selection";
            default:
                return "base";
        }
    }

    private renderSignature(): string {
        return JSON.stringify({
            highDetail: this.isHighDetail,
            showTileBorder: this.showTileBorder,
            renderQueued: this.renderQueued,
            highlightMode: this.highlightMode.value,
            featureIdSubset: this.featureIdSubset,
            styleOptions: this.options
        });
    }

    private async renderWasm(): Promise<DeckPathLayerData | null> {
        if (isDeckRenderWorkerPoolEnabled()) {
            try {
                const workerResult = await this.renderWasmInWorker();
                if (workerResult) {
                    return workerResult;
                }
            } catch (error) {
                console.error("Deck worker rendering failed; falling back to main thread rendering.", error);
            }
        }
        return await this.renderWasmOnMainThread();
    }

    private async renderWasmInWorker(): Promise<DeckPathLayerData | null> {
        const tileBlob = this.tile.tileFeatureLayerBlob;
        if (!tileBlob) {
            return null;
        }
        const tileWithParserContext = this.tile as FeatureTile & {
            getFieldDictBlob?: () => Uint8Array | null;
            getDataSourceInfoBlob?: () => Uint8Array | null;
        };
        const fieldDictBlob = tileWithParserContext.getFieldDictBlob?.();
        const dataSourceInfoBlob = tileWithParserContext.getDataSourceInfoBlob?.();
        if (!fieldDictBlob || !dataSourceInfoBlob) {
            return null;
        }
        const pool = deckRenderWorkerPool();
        const result = await pool.renderPaths({
            viewIndex: this.viewIndex,
            tileKey: this.tile.mapTileKey,
            tileBlob,
            fieldDictBlob,
            dataSourceInfoBlob,
            nodeId: this.tile.nodeId,
            mapName: this.tile.mapName,
            styleSource: this.styleSource,
            styleOptions: this.copyStyleOptions(),
            highlightModeValue: this.highlightMode.value,
            featureIdSubset: [...this.featureIdSubset]
        });
        this.latestWorkerTimings = result.workerTimings ?? null;
        return this.buildPathLayerData(result);
    }

    private async renderWasmOnMainThread(): Promise<DeckPathLayerData | null> {
        this.latestWorkerTimings = null;
        let deckVisu: any;
        try {
            deckVisu = new (coreLib as any).DeckFeatureLayerVisualization(
                this.viewIndex,
                this.tile.mapTileKey,
                this.style,
                this.options,
                this.highlightMode,
                this.featureIdSubset
            );

            await this.tile.peekAsync(async (tileFeatureLayer) => {
                deckVisu.addTileFeatureLayer(tileFeatureLayer);
                deckVisu.run();
            });

            return this.buildPathLayerData({
                coordinateOrigin: this.readFloat64Array(deckVisu, "pathCoordinateOriginRaw"),
                positions: this.readFloat32Array(deckVisu, "pathPositionsRaw"),
                startIndices: this.readUint32Array(deckVisu, "pathStartIndicesRaw"),
                colors: this.readUint8Array(deckVisu, "pathColorsRaw"),
                widths: this.readFloat32Array(deckVisu, "pathWidthsRaw"),
                featureIds: this.readUint32Array(deckVisu, "pathFeatureIdsRaw"),
                dashArrays: this.readFloat32Array(deckVisu, "pathDashArrayRaw"),
                dashOffsets: this.readFloat32Array(deckVisu, "pathDashOffsetsRaw")
            });
        } finally {
            if (deckVisu && typeof deckVisu.delete === "function") {
                deckVisu.delete();
            }
        }
    }

    private buildPathLayerData(raw: DeckPathRawBuffers): DeckPathLayerData | null {
        if (raw.coordinateOrigin.length < 3) {
            return null;
        }
        if (raw.startIndices.length < 2) {
            return null;
        }

        const pathCount = raw.startIndices.length - 1;
        if (!pathCount || pathCount > MAX_DECK_PATH_COUNT) {
            return null;
        }

        const vertexCount = raw.startIndices[pathCount];
        if (!Number.isFinite(vertexCount) || !Number.isInteger(vertexCount) ||
            vertexCount <= 1 || vertexCount > MAX_DECK_VERTEX_COUNT) {
            return null;
        }

        if (raw.positions.length < vertexCount * 3) {
            return null;
        }
        if (raw.colors.length < pathCount * 4 || raw.widths.length < pathCount ||
            raw.dashArrays.length < pathCount * 2) {
            return null;
        }
        if (raw.featureIds.length < pathCount) {
            return null;
        }

        const instanceColors = new Uint8Array(vertexCount * 4);
        const instanceStrokeWidths = new Float32Array(vertexCount);
        const instanceDashArrays = new Float32Array(vertexCount * 2);
        const featureIds: Array<number | null> = new Array<number | null>(pathCount).fill(null);
        const featureIdsByVertex: Array<number | null> = new Array<number | null>(vertexCount).fill(null);

        for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
            const start = raw.startIndices[pathIndex];
            const end = raw.startIndices[pathIndex + 1];
            if (end <= start || end > vertexCount) {
                return null;
            }
            const colorOffset = pathIndex * 4;
            const r = raw.colors[colorOffset];
            const g = raw.colors[colorOffset + 1];
            const b = raw.colors[colorOffset + 2];
            const a = raw.colors[colorOffset + 3];
            const width = raw.widths[pathIndex];
            const dashArrayOffset = pathIndex * 2;
            const dashA = raw.dashArrays[dashArrayOffset] ?? 1;
            const dashB = raw.dashArrays[dashArrayOffset + 1] ?? 0;
            const featureId = raw.featureIds[pathIndex];
            const normalizedFeatureId =
                Number.isInteger(featureId) && featureId !== DECK_UNSELECTABLE_FEATURE_INDEX
                    ? featureId
                    : null;
            featureIds[pathIndex] = normalizedFeatureId;

            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                const colorTargetOffset = vertexIndex * 4;
                instanceColors[colorTargetOffset] = r;
                instanceColors[colorTargetOffset + 1] = g;
                instanceColors[colorTargetOffset + 2] = b;
                instanceColors[colorTargetOffset + 3] = a;
                instanceStrokeWidths[vertexIndex] = width;
                const dashTargetOffset = vertexIndex * 2;
                instanceDashArrays[dashTargetOffset] = dashA;
                instanceDashArrays[dashTargetOffset + 1] = dashB;
                featureIdsByVertex[vertexIndex] = normalizedFeatureId;
            }
        }

        return {
            length: pathCount,
            coordinateOrigin: [
                raw.coordinateOrigin[0],
                raw.coordinateOrigin[1],
                raw.coordinateOrigin[2]
            ],
            startIndices: raw.startIndices,
            featureIds,
            featureIdsByVertex,
            attributes: {
                getPath: {value: raw.positions, size: 3},
                instanceColors: {value: instanceColors, size: 4},
                instanceStrokeWidths: {value: instanceStrokeWidths, size: 1},
                instanceDashArrays: {value: instanceDashArrays, size: 2}
            }
        };
    }

    private readFloat32Array(deckVisu: any, rawAccessor: string): Float32Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT);
    }

    private readFloat64Array(deckVisu: any, rawAccessor: string): Float64Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        return new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / Float64Array.BYTES_PER_ELEMENT);
    }

    private readUint32Array(deckVisu: any, rawAccessor: string): Uint32Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        return new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    }

    private readUint8Array(deckVisu: any, rawAccessor: string): Uint8Array {
        return this.readRawBytes(deckVisu, rawAccessor);
    }

    private readRawBytes(deckVisu: any, rawAccessor: string): Uint8Array {
        return uint8ArrayFromWasm((shared) => {
            deckVisu[rawAccessor](shared);
            return true;
        }) as Uint8Array;
    }

    private tileHasData(): boolean {
        return this.tile.hasData();
    }

    private tileFeatureCount(): number {
        return (this.tile as any).numFeatures as number;
    }

    private copyStyleOptions(): Record<string, boolean | number | string> {
        return {...this.options};
    }

    private recordRenderTimeSample(durationMs: number, measuredDurationMs?: number): void {
        const sampleDuration = Number.isFinite(measuredDurationMs)
            ? measuredDurationMs as number
            : durationMs;
        const tileWithStats = this.tile as unknown as { stats: Map<string, number[]> };
        const timingListKey = `Rendering/${this.statsHighlightModeLabel()}/${this.styleId}#ms`;
        const timingList = tileWithStats.stats.get(timingListKey);
        if (timingList) {
            timingList.push(sampleDuration);
            return;
        }
        tileWithStats.stats.set(timingListKey, [sampleDuration]);
    }

    private recordWorkerParseTimeSample(durationMs?: number): void {
        if (!Number.isFinite(durationMs)) {
            return;
        }
        const tileWithStats = this.tile as unknown as { stats: Map<string, number[]> };
        const parseTimes = tileWithStats.stats.get(FeatureTile.statParseTime);
        if (parseTimes) {
            parseTimes.push(durationMs as number);
            return;
        }
        tileWithStats.stats.set(FeatureTile.statParseTime, [durationMs as number]);
    }

    private statsHighlightModeLabel(): string {
        switch (this.highlightMode.value) {
            case coreLib.HighlightMode.HOVER_HIGHLIGHT.value:
                return "Hover";
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT.value:
                return "Selection";
            default:
                return "Basic";
        }
    }

    private resolveRegistry(sceneHandle: IRenderSceneHandle): DeckLayerRegistry {
        const scene = sceneHandle.scene as DeckSceneHandle;
        return scene.layerRegistry!;
    }

    private consumeLatestWorkerTimings(): DeckWorkerTimings | null {
        const timings = this.latestWorkerTimings;
        this.latestWorkerTimings = null;
        return timings;
    }
}
